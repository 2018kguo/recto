use super::xobject_oc;
use crate::context::Context;
use crate::device::Device;
use crate::interpret::page_run::{Close, Frame, FrameData};
use crate::{BlendMode, ClipPath, FillRule, interpret};
use hayro_syntax::content::TypedIter;
use hayro_syntax::object::Dict;
use hayro_syntax::object::{Name, Object, Stream};
use hayro_syntax::object::dict::keys::*;
use hayro_syntax::page::Resources;
use kurbo::{Affine, Rect, Shape};
use std::borrow::Cow;

pub(crate) struct FormXObject<'a> {
    pub(crate) decoded: Cow<'a, [u8]>,
    /// recto: `decoded` counts against the limit on decoding while the form is held.
    pub(crate) held: hayro_syntax::HeldDecoded,
    pub(crate) matrix: Affine,
    pub(crate) bbox: [f32; 4],
    is_transparency_group: bool,
    // recto: the two flags of /Group, which upstream treats as always isolated, never knockout.
    pub(crate) isolated: bool,
    knockout: bool,
    pub(crate) dict: Dict<'a>,
    pub(crate) resources: Option<Resources<'a>>,
}

/// recto: what a form's dictionary says, read once per form in a context however often it's
/// drawn: reading a form's resources, matrix, box and group cost a page that draws one small form
/// a thousand times more than drawing it. The contents are still decoded at each use, so what a
/// decode may hold and cut is as it was. Only the first `MAX_KEPT_FORMS` forms a context draws get
/// an entry.
#[derive(Default)]
pub(crate) struct XObjectInfo<'a> {
    /// Read after the decode of the contents, as `FormXObject::new` reads it.
    form: Option<Option<FormDict<'a>>>,
}

const MAX_KEPT_FORMS: usize = 256;

/// A form's dictionary as `FormXObject::new` reads it; `None` without a `/BBox`.
#[derive(Clone)]
struct FormDict<'a> {
    matrix: Affine,
    bbox: [f32; 4],
    is_transparency_group: bool,
    isolated: bool,
    knockout: bool,
    dict: Dict<'a>,
    resources: Option<Resources<'a>>,
}

/// recto: each form's `XObjectInfo`, by where its dictionary is in the file, its object number
/// (which its strings are decrypted with) and whether the file's table has been repaired since,
/// after which a reference in it may read something else. A list rather than a map, at most
/// `MAX_KEPT_FORMS` long, as a map's code would cost the wasm more than the scan costs a page.
pub(crate) type XObjectInfos<'a> =
    Vec<((usize, Option<hayro_syntax::object::ObjectIdentifier>, bool), XObjectInfo<'a>)>;

impl<'a> FormDict<'a> {
    fn read(dict: &Dict<'a>) -> Option<Self> {
        let resources = dict.get(RESOURCES).map(Resources::new);

        let matrix = Affine::new(
            dict.get::<[f64; 6]>(MATRIX)
                .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
        );
        // recto: any two opposite corners make a rectangle. Everything after this expects the low
        // corner first, and a mask's group with the corners the other way round masked everything.
        let [x0, y0, x1, y1] = dict.get::<[f32; 4]>(BBOX)?;
        let bbox = [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)];
        let group = dict.get::<Dict<'_>>(GROUP);
        let is_transparency_group = group.is_some();
        let isolated = group.as_ref().and_then(|g| g.get::<bool>(I)).unwrap_or(false);
        let knockout = group.as_ref().and_then(|g| g.get::<bool>(K)).unwrap_or(false);

        Some(Self {
            matrix,
            bbox,
            is_transparency_group,
            isolated,
            knockout,
            dict: dict.clone(),
            resources,
        })
    }
}

impl<'a> FormXObject<'a> {
    pub(crate) fn new(stream: &Stream<'a>) -> Option<Self> {
        // recto: as `cached` with an info drawn nowhere else, which keeps nothing.
        Self::cached(stream, &mut XObjectInfo::default())
    }

    /// recto: `None` if `stream` isn't a form, and otherwise `new`, with what `infos` keeps of
    /// it. A form's `/Subtype` is read the first time only; another XObject's, each time.
    pub(crate) fn drawn(
        stream: &Stream<'a>,
        infos: &mut XObjectInfos<'a>,
        xref: &hayro_syntax::xref::XRef,
    ) -> Option<Option<Self>> {
        let dict = stream.dict();
        let key = (dict.data().as_ptr() as usize, dict.obj_id(), xref.is_repaired());
        if let Some((_, info)) = infos.iter_mut().find(|(k, _)| *k == key) {
            return Some(Self::cached(stream, info));
        }
        crate::context::count_dictionary_read();
        let (is_form, cut) = hayro_syntax::noting_cuts(|| {
            dict.get::<Name<'_>>(SUBTYPE).as_deref() == Some(b"Form".as_slice())
        });
        if !is_form {
            return None;
        }
        // As in `cached`: what a limit cut is read again next time.
        if cut || infos.len() >= MAX_KEPT_FORMS {
            return Some(Self::new(stream));
        }
        infos.push((key, XObjectInfo::default()));
        Some(Self::cached(stream, &mut infos.last_mut()?.1))
    }

    /// recto: `new`, with the dictionary kept in `info`. A read that a limit cut short isn't
    /// kept: read again, with less held, it can succeed.
    fn cached(stream: &Stream<'a>, info: &mut XObjectInfo<'a>) -> Option<Self> {
        let decoded = stream.decoded_data().ok()?;
        let held = hayro_syntax::hold_decoded(decoded.len());
        let form = match &info.form {
            Some(form) => form.clone(),
            None => {
                crate::context::count_dictionary_read();
                let (form, cut) = hayro_syntax::noting_cuts(|| FormDict::read(stream.dict()));
                if !cut {
                    info.form = Some(form.clone());
                }
                form
            }
        };
        let form = form?;
        Some(Self {
            decoded,
            held,
            matrix: form.matrix,
            is_transparency_group: form.is_transparency_group,
            isolated: form.isolated,
            knockout: form.knockout,
            bbox: form.bbox,
            dict: form.dict,
            resources: form.resources,
        })
    }

    /// recto: `draw`, but when the contents can be run a slice at a time by `PageRun`, this does
    /// only what comes before them, and says what to do after. A knockout element and a group that
    /// needs its backdrop go through the contents more than once, so they're drawn here, whole.
    pub(crate) fn enter(
        self,
        parent: &Resources<'a>,
        context: &mut Context<'a>,
        device: &mut impl Device<'a>,
    ) -> Option<Frame<'a>> {
        if !context.ocg_state.is_visible() {
            return None;
        }
        let resources = self.resources.clone().unwrap_or_else(|| parent.clone());
        let mut group = false;
        if self.is_transparency_group {
            let plain = context.fill_paint().alpha == 1.0
                && context.compositing_mut().soft_mask.is_none()
                && matches!(context.compositing_mut().blend_mode, BlendMode::Normal);
            let direct = !self.isolated && !self.knockout && plain && !device.in_knockout();
            if !direct {
                if device.in_knockout() || (!self.isolated && uses_blend_mode(&resources, 0, &mut 0)) {
                    self.draw(parent, context, device);
                    return None;
                }
                group = true;
            }
        }

        if !context.begin_nested_interpretation() {
            return None;
        }
        let has_oc = xobject_oc(&self.dict, context);
        if !context.ocg_state.is_visible() {
            if has_oc {
                context.ocg_state.end_marked_content();
            }
            context.end_nested_interpretation();
            return None;
        }

        context.clear_path();
        context.save_state();
        context.pre_concat_affine(self.matrix);
        context.push_root_transform();

        if self.is_transparency_group {
            if group {
                let opacity = context.fill_paint().alpha;
                let mask = std::mem::take(&mut context.compositing_mut().soft_mask);
                let blend_mode = std::mem::take(&mut context.compositing_mut().blend_mode);
                device.push_transparency_group(opacity, mask, blend_mode);
                if self.knockout {
                    device.set_group_knockout();
                }
            }
            context.fill_paint_mut().alpha = 1.0;
            context.stroke_paint_mut().alpha = 1.0;
        }

        device.push_clip_path(&ClipPath {
            path: context.ctm()
                * Rect::new(
                    self.bbox[0] as f64,
                    self.bbox[1] as f64,
                    self.bbox[2] as f64,
                    self.bbox[3] as f64,
                )
                .to_path(0.1),
            fill: FillRule::NonZero,
        });
        let states = context.num_states();
        context.save_state();
        // recto: this path doesn't go through `interpret`, which pays for a nested stream.
        let affordable = context.charge_nested();
        Some(Frame {
            data: FrameData::Form(if affordable { self.decoded } else { Default::default() }),
            _held: self.held,
            pos: 0,
            resources,
            states,
            close: Close::Form { group, has_oc },
        })
    }

    pub(crate) fn draw(
        &self,
        resources: &Resources<'a>,
        context: &mut Context<'a>,
        device: &mut impl Device<'a>,
    ) {
        if !context.ocg_state.is_visible() {
            return;
        }

        if !context.begin_nested_interpretation() {
            return;
        }

        let has_oc = xobject_oc(&self.dict, context);
        if !context.ocg_state.is_visible() {
            if has_oc {
                context.ocg_state.end_marked_content();
            }
            context.end_nested_interpretation();
            return;
        }

        context.clear_path();
        context.save_state();
        context.pre_concat_affine(self.matrix);
        context.push_root_transform();

        let resources = self.resources.as_ref().unwrap_or(resources);
        if self.is_transparency_group {
            self.draw_group(resources, context, device);
        } else {
            self.draw_contents(resources, context, device);
        }

        context.pop_root_transform();
        context.restore_state(device);

        if has_oc {
            context.ocg_state.end_marked_content();
        }

        context.end_nested_interpretation();
    }

    fn draw_contents(
        &self,
        resources: &Resources<'a>,
        context: &mut Context<'a>,
        device: &mut impl Device<'a>,
    ) {
        device.push_clip_path(&ClipPath {
            path: context.ctm()
                * Rect::new(
                    self.bbox[0] as f64,
                    self.bbox[1] as f64,
                    self.bbox[2] as f64,
                    self.bbox[3] as f64,
                )
                .to_path(0.1),
            fill: FillRule::NonZero,
        });

        if context
            .settings
            .render_content
            .contains(crate::RenderContent::TEXT_ONLY)
        {
            interpret::text_only::interpret(&self.decoded, resources, context, device);
        } else {
            interpret(TypedIter::new(self.decoded.as_ref()), resources, context, device);
        }

        device.pop_clip();
    }

    /// recto: what the group's two flags mean. Without them everything is an isolated layer.
    fn draw_group(
        &self,
        resources: &Resources<'a>,
        context: &mut Context<'a>,
        device: &mut impl Device<'a>,
    ) {
        let opacity = context.fill_paint().alpha;
        let plain = opacity == 1.0
            && context.compositing_mut().soft_mask.is_none()
            && matches!(context.compositing_mut().blend_mode, BlendMode::Normal);
        let is_element = device.in_knockout();

        // A non-isolated, non-knockout group at full strength with no mask is the same as painting
        // its contents directly (ISO 32000-2, 11.4.6). Most groups are this, and their blend modes
        // then see the backdrop without any more work.
        if !self.isolated && !self.knockout && plain && !is_element {
            context.fill_paint_mut().alpha = 1.0;
            context.stroke_paint_mut().alpha = 1.0;
            self.draw_contents(resources, context, device);
            return;
        }

        // An element of a knockout group: first take away what the group holds where this paints.
        if is_element {
            context.save_state();
            context.fill_paint_mut().alpha = 1.0;
            context.stroke_paint_mut().alpha = 1.0;
            device.push_knockout_erase();
            self.draw_contents(resources, context, device);
            device.pop_knockout_erase();
            context.restore_state(device);
        }

        let needs_backdrop = !self.isolated && !is_element && uses_blend_mode(resources, 0, &mut 0);
        let mask = std::mem::take(&mut context.compositing_mut().soft_mask);
        let blend_mode = std::mem::take(&mut context.compositing_mut().blend_mode);
        context.fill_paint_mut().alpha = 1.0;
        context.stroke_paint_mut().alpha = 1.0;

        if needs_backdrop && device.begin_backdrop_group(opacity, &mask, blend_mode, self.knockout) {
            if !device.backdrop_group_known() {
                context.save_state();
                self.draw_contents(resources, context, device);
                context.restore_state(device);
                device.next_backdrop_pass();
                self.draw_contents(resources, context, device);
            }
            device.end_backdrop_group();
        } else {
            device.push_transparency_group(opacity, mask, blend_mode);
            if self.knockout {
                device.set_group_knockout();
            }
            self.draw_contents(resources, context, device);
            device.pop_transparency_group();
        }
    }
}

/// recto: whether this content can paint with a blend mode other than Normal, the only case where
/// a non-isolated group's backdrop changes its result. It looks at what the resources offer, not
/// at what is used: being wrong costs time, not correctness.
fn uses_blend_mode(resources: &Resources<'_>, depth: u32, visited: &mut u32) -> bool {
    *visited += 1;
    if depth > 8 || *visited > 256 {
        return true;
    }
    let states = &resources.ext_g_states;
    for key in states.keys() {
        let Some(state) = states.get::<Dict<'_>>(key.clone()) else {
            continue;
        };
        let names: Vec<Name<'_>> = match state.get::<Object<'_>>(BM) {
            Some(Object::Name(name)) => vec![name],
            Some(Object::Array(list)) => list.iter::<Name<'_>>().collect(),
            _ => vec![],
        };
        if names.iter().any(|n| !matches!(n.as_str(), "Normal" | "Compatible")) {
            return true;
        }
    }
    let objects = &resources.x_objects;
    for key in objects.keys() {
        let Some(stream) = objects.get::<Stream<'_>>(key.clone()) else {
            continue;
        };
        let inner = stream.dict().get::<Dict<'_>>(RESOURCES).map(Resources::new);
        if inner.is_some_and(|inner| uses_blend_mode(&inner, depth + 1, visited)) {
            return true;
        }
    }
    false
}
