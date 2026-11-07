//! recto: isolated and knockout transparency groups, which upstream draws all as isolated layers.
//!
//! A layer can't see what is under it, and a non-isolated group has to. Most of them don't need to
//! draw differently (`hayro_interpret::x_object::form` paints them directly when it can), so what
//! comes here is rare: a non-isolated group with a blend mode inside and an opacity, mask, blend
//! mode or knockout of its own. For those, the backdrop comes from drawing the page again up to the
//! group, and the group's contents are drawn twice: over that backdrop, for colour, and on nothing,
//! for alpha. The group colour is then worked out with the formula that removes the backdrop's
//! contribution (ISO 32000-2, 11.4.8), and the result painted as an image in the group's place.
//!
//! Elements of a knockout group replace what the group holds where they paint: a layer in `Copy`
//! mode clipped to the element's shape. Images and groups have no shape to hand, so they are painted
//! once to erase and then again for real.

use crate::{GlobalState, RenderCache, Renderer, convert_blend_mode, derive_settings, draw_page};
use hayro_interpret::hayro_syntax::page::Page;
use hayro_interpret::{BlendMode, FillRule, InterpreterSettings, SoftMask};
use kurbo::{Affine, BezPath, Rect};
use rustc_hash::FxHashMap;
use std::rc::Rc;
use std::cell::RefCell;
use std::sync::Arc;
use vello_cpu::color::palette::css::TRANSPARENT;
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::kurbo::Affine as VelloAffine;
use vello_cpu::peniko::{Compose, Extend, ImageQuality, ImageSampler, Mix};
use vello_cpu::{Image, ImageSource, Mask, Pixmap, RenderContext, peniko};

/// Past this many on one page, a group is drawn as an isolated layer: each costs up to a drawing of
/// the page, and a hostile page can hold thousands.
const MAX_CAPTURES: u32 = 32;

pub(crate) struct GroupFrame {
    /// Whether a layer was pushed for this group in this drawing of the page.
    pub(crate) real: bool,
    pub(crate) knockout: bool,
    /// Under the elements of a knockout group while the backdrop is being drawn in.
    pub(crate) backdrop: Option<Arc<Pixmap>>,
    pub(crate) event: u32,
}

pub(crate) struct Capture {
    /// The context the page was being drawn into, while this group draws into its own. None when
    /// this drawing of the page mutes the group.
    parent: Option<RenderContext>,
    backdrop: Option<Arc<Pixmap>>,
    over_backdrop: Option<Pixmap>,
    opacity: f32,
    mask: Option<Mask>,
    blend_mode: BlendMode,
}

pub(crate) trait Backdrop {
    /// The page as it stands at group event `to`, with only what was drawn since event `from` when
    /// `from` isn't zero.
    fn snapshot(&self, from: u32, to: u32) -> Arc<Pixmap>;
}

pub(crate) struct PageReplay<'a, 'c> {
    page: &'a Page<'a>,
    cache: &'c RenderCache<'a>,
    settings: InterpreterSettings,
    global: Rc<GlobalState>,
    transform: Affine,
    width: u16,
    height: u16,
    render_settings: vello_cpu::RenderSettings,
    background: AlphaColor<Srgb>,
    memo: RefCell<FxHashMap<(u32, u32), Arc<Pixmap>>>,
}

impl<'a, 'c> PageReplay<'a, 'c> {
    pub(crate) fn new(
        page: &'a Page<'a>,
        cache: &'c RenderCache<'a>,
        settings: &InterpreterSettings,
        global: Rc<GlobalState>,
        transform: Affine,
        ctx: &RenderContext,
        background: AlphaColor<Srgb>,
    ) -> Self {
        Self {
            page,
            cache,
            settings: settings.clone(),
            global,
            transform,
            width: ctx.width(),
            height: ctx.height(),
            render_settings: derive_settings(ctx.render_settings()),
            background,
            memo: RefCell::default(),
        }
    }
}

impl Backdrop for PageReplay<'_, '_> {
    fn snapshot(&self, from: u32, to: u32) -> Arc<Pixmap> {
        if let Some(found) = self.memo.borrow().get(&(from, to)) {
            return found.clone();
        }
        let mut ctx = RenderContext::new_with(self.width, self.height, self.render_settings);
        draw_page(
            self.page,
            self.cache,
            &self.settings,
            self.global.aliasing_threshold,
            &mut ctx,
            self.transform,
            &self.global,
            self,
            (from, to),
        );
        ctx.flush();
        let mut pixmap = Pixmap::new(self.width, self.height);
        ctx.render_with(
            &mut pixmap,
            &mut vello_cpu::Resources::default(),
            vello_cpu::RasterizerSettings {
                target_init: vello_cpu::TargetInit::Clear(if from == 0 {
                    self.background
                } else {
                    TRANSPARENT
                }),
                ..Default::default()
            },
        );
        let pixmap = Arc::new(pixmap);
        self.memo.borrow_mut().insert((from, to), pixmap.clone());
        pixmap
    }
}

impl Renderer<'_> {
    pub(crate) fn next_event(&mut self) -> u32 {
        self.events += 1;
        self.events
    }

    /// In a drawing for a backdrop, only what happened in its range reaches the pixels.
    pub(crate) fn muted(&self) -> bool {
        self.events < self.range.0 || self.events >= self.range.1
    }

    /// The group that starts the range is the one the backdrop is the contents of: no layer for it.
    pub(crate) fn pushes_layer(&self, event: u32) -> bool {
        event > self.range.0 && event < self.range.1
    }

    pub(crate) fn in_knockout_group(&self) -> bool {
        self.groups.last().is_some_and(|g| g.knockout)
    }

    fn full_page(&self) -> Rect {
        Rect::new(0.0, 0.0, self.ctx.width() as f64, self.ctx.height() as f64)
    }

    /// Stamps a page-sized image at the current layer. The context's blend mode is reset for it.
    fn paint_pixmap(&mut self, pixmap: Arc<Pixmap>) {
        self.ctx.set_transform(VelloAffine::IDENTITY);
        self.ctx.reset_mask();
        self.ctx.set_blend_mode(peniko::BlendMode::default());
        self.ctx.set_paint(Image {
            image: ImageSource::Pixmap(pixmap),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        });
        self.ctx.reset_paint_transform();
        let page = self.full_page();
        self.ctx.fill_rect(&page);
    }

    /// Everything until the matching `pop_layer` replaces what this group holds inside `shape`.
    pub(crate) fn begin_knockout_element(&mut self, shape: &BezPath, rule: FillRule) {
        self.ctx.set_fill_rule(crate::convert_fill_rule(rule));
        self.ctx.set_transform(VelloAffine::IDENTITY);
        self.ctx.push_layer(
            Some(shape),
            Some(peniko::BlendMode::new(Mix::Normal, Compose::Copy)),
            None,
            None,
            None,
        );
        if let Some(backdrop) = self.groups.last().and_then(|g| g.backdrop.clone()) {
            self.paint_pixmap(backdrop);
        }
    }

    pub(crate) fn push_erase(&mut self) {
        let event = self.events;
        let real = !self.muted();
        self.groups.push(GroupFrame {
            real,
            knockout: false,
            backdrop: None,
            event,
        });
        if real {
            self.ctx.push_layer(
                None,
                Some(peniko::BlendMode::new(Mix::Normal, Compose::DestOut)),
                None,
                None,
                None,
            );
        }
    }

    pub(crate) fn pop_erase(&mut self) {
        if !self.groups.pop().is_some_and(|g| g.real) {
            return;
        }
        self.ctx.pop_layer();
        // Over a backdrop, the hole goes back to what was there before the group began.
        if let Some(backdrop) = self.groups.last().and_then(|g| g.backdrop.clone()) {
            self.ctx.push_layer(
                None,
                Some(peniko::BlendMode::new(Mix::Normal, Compose::DestOver)),
                None,
                None,
                None,
            );
            self.paint_pixmap(backdrop);
            self.ctx.pop_layer();
        }
    }

    pub(crate) fn begin_capture(
        &mut self,
        opacity: f32,
        mask: Option<&SoftMask<'_>>,
        blend_mode: BlendMode,
        knockout: bool,
    ) -> bool {
        // Decided the same way however the page is being drawn, or events would stop lining up.
        // A capture inside a capture has no single backdrop to replay: that one stays a layer.
        if self.replay.is_none() || !self.captures.is_empty() || self.in_knockout_group() {
            return false;
        }
        if self.captures_seen >= MAX_CAPTURES {
            self.global.degraded.set(true);
            return false;
        }
        self.captures_seen += 1;
        let from = self.groups.last().map_or(0, |g| g.event);
        let event = self.next_event();
        let drawn = self.pushes_layer(event);
        let backdrop = drawn.then(|| self.replay.unwrap().snapshot(from, event));
        let mask = if drawn { mask.map(|m| self.resolve_mask(m)) } else { None };
        let parent = drawn.then(|| {
            let mut child = self.child_context(self.ctx.width(), self.ctx.height());
            std::mem::swap(self.ctx, &mut child);
            child
        });
        self.groups.push(GroupFrame {
            real: false,
            knockout,
            backdrop: backdrop.clone(),
            event,
        });
        if let Some(backdrop) = backdrop.clone() {
            self.paint_pixmap(backdrop);
        }
        self.captures.push(Capture {
            parent,
            backdrop,
            over_backdrop: None,
            opacity,
            mask,
            blend_mode,
        });
        true
    }

    fn finish_child(&mut self) -> Pixmap {
        self.ctx.flush();
        let mut pixmap = Pixmap::new(self.ctx.width(), self.ctx.height());
        self.ctx.render(&mut pixmap, &mut vello_cpu::Resources::default());
        pixmap
    }

    pub(crate) fn next_capture_pass(&mut self) {
        let drawn = self.captures.last().is_some_and(|c| c.parent.is_some());
        if let Some(group) = self.groups.last_mut() {
            group.backdrop = None;
        }
        if !drawn {
            return;
        }
        let over_backdrop = self.finish_child();
        *self.ctx = self.child_context(self.ctx.width(), self.ctx.height());
        if let Some(capture) = self.captures.last_mut() {
            capture.over_backdrop = Some(over_backdrop);
        }
    }

    pub(crate) fn end_capture(&mut self) {
        self.groups.pop();
        let Some(capture) = self.captures.pop() else {
            return;
        };
        let Capture {
            parent: Some(mut parent),
            backdrop: Some(backdrop),
            over_backdrop: Some(over_backdrop),
            opacity,
            mask,
            blend_mode,
        } = capture
        else {
            return;
        };
        let on_nothing = self.finish_child();
        std::mem::swap(self.ctx, &mut parent);
        let group = remove_backdrop(&backdrop, &over_backdrop, &on_nothing);
        self.ctx.push_layer(
            None,
            Some(convert_blend_mode(blend_mode)),
            Some(opacity),
            mask,
            None,
        );
        self.paint_pixmap(Arc::new(group));
        self.ctx.pop_layer();
    }
}

/// ISO 32000-2, 11.4.8: C = Cn + (Cn - C0) x (a0 / ag - a0), with the group's own alpha ag.
fn remove_backdrop(backdrop: &Pixmap, over_backdrop: &Pixmap, on_nothing: &Pixmap) -> Pixmap {
    let mut out = Pixmap::new(on_nothing.width(), on_nothing.height());
    let pixels = out.data_mut().iter_mut();
    let sources = backdrop.data().iter().zip(over_backdrop.data()).zip(on_nothing.data());
    for (pixel, ((b, n), g)) in pixels.zip(sources) {
        if g.a == 0 {
            continue;
        }
        let a0 = b.a as f32 / 255.0;
        let ag = g.a as f32 / 255.0;
        let straight = |premultiplied: u8, alpha: u8| {
            if alpha == 0 { 0.0 } else { premultiplied as f32 / alpha as f32 }
        };
        let channel = |c0: u8, cn: u8| {
            let c0 = straight(c0, b.a);
            let cn = straight(cn, n.a);
            let color = (cn + (cn - c0) * (a0 / ag - a0)).clamp(0.0, 1.0);
            (color * ag * 255.0 + 0.5) as u8
        };
        pixel.r = channel(b.r, n.r);
        pixel.g = channel(b.g, n.g);
        pixel.b = channel(b.b, n.b);
        pixel.a = g.a;
    }
    out
}
