//! recto: a page interpreted a slice at a time. The operator loop returns when its time is up and
//! starts again where it stopped, and the forms it enters are frames on a stack here instead of
//! calls on the machine's stack, so nothing has to unwind to give the thread back. What a form's
//! recursion would have done before and after its contents happens when its frame is pushed and
//! popped. Patterns, soft masks, Type 3 glyphs and groups drawn in more than one pass are still
//! calls, and each runs whole inside one slice.

use super::{interpret_annotation, run_ops};
use crate::context::Context;
use crate::device::Device;
use crate::x_object::form::FormXObject;
use hayro_syntax::content::TypedIter;
use hayro_syntax::object::dict::keys::ANNOTS;
use hayro_syntax::object::{Array, Dict};
use hayro_syntax::page::{Page, Resources};
use std::borrow::Cow;

/// Asks the clock every this many operators: an operator is usually far under a microsecond.
const OPERATORS_PER_CHECK: u32 = 64;

pub(crate) struct Slice<'c> {
    expired: &'c dyn Fn() -> bool,
    until_check: u32,
}

impl Slice<'_> {
    /// Whether this slice is over.
    pub(crate) fn tick(&mut self) -> bool {
        if self.until_check > 0 {
            self.until_check -= 1;
            return false;
        }
        self.until_check = OPERATORS_PER_CHECK;
        (self.expired)()
    }

    /// The operator just run might have been a slow one, such as an image.
    pub(crate) fn check_next(&mut self) {
        self.until_check = 0;
    }
}

pub(crate) enum Step<'a> {
    Done,
    Paused,
    Enter(FormXObject<'a>),
}

pub(crate) enum Close {
    Page,
    Form { group: bool, has_oc: bool },
}

pub(crate) struct Frame<'a> {
    pub(crate) data: Cow<'a, [u8]>,
    pub(crate) pos: usize,
    pub(crate) resources: Resources<'a>,
    pub(crate) states: usize,
    pub(crate) close: Close,
}

/// What's left of a page: the content streams in progress, and the annotations after them.
pub struct PageRun<'a> {
    frames: Vec<Frame<'a>>,
    annotations: Vec<Dict<'a>>,
    resources: Resources<'a>,
}

impl<'a> PageRun<'a> {
    /// `page` is drawn by repeated calls to `step`, with the same context and device.
    pub fn new(page: &'a Page<'a>, context: &mut Context<'a>) -> Self {
        let resources = page.resources().clone();
        let states = context.num_states();
        context.save_state();
        let annotations = if context
            .settings
            .render_content
            .contains(crate::RenderContent::ANNOTATIONS)
        {
            page.raw()
                .get::<Array<'_>>(ANNOTS)
                .map(|list| list.iter::<Dict<'_>>().collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        // Reversed: popped from the end, in order.
        let mut annotations: Vec<Dict<'a>> = annotations;
        annotations.reverse();
        Self {
            frames: vec![Frame {
                data: Cow::Borrowed(page.page_stream().unwrap_or_default()),
                pos: 0,
                resources: resources.clone(),
                states,
                close: Close::Page,
            }],
            annotations,
            resources,
        }
    }

    /// Runs until `expired` says so or the page is done, and says whether it's done. Only ever
    /// stops between operators.
    pub fn step(
        &mut self,
        context: &mut Context<'a>,
        device: &mut impl Device<'a>,
        expired: &dyn Fn() -> bool,
    ) -> bool {
        let mut slice = Slice {
            expired,
            until_check: OPERATORS_PER_CHECK,
        };
        while let Some(frame) = self.frames.last_mut() {
            let mut ops = TypedIter::new(&frame.data[frame.pos..]);
            let floor = frame.states + 1;
            let step = run_ops(&mut ops, &frame.resources, context, device, Some(&mut slice), floor);
            frame.pos += ops.offset();
            match step {
                Step::Paused => return false,
                Step::Enter(form) => {
                    let parent = frame.resources.clone();
                    if let Some(entered) = form.enter(&parent, context, device) {
                        self.frames.push(entered);
                    }
                    slice.check_next();
                }
                Step::Done => {
                    let Some(done) = self.frames.pop() else {
                        break;
                    };
                    finish(done, context, device);
                }
            }
        }
        while let Some(annotation) = self.annotations.pop() {
            interpret_annotation(&annotation, &self.resources, context, device);
            if expired() {
                return self.annotations.is_empty();
            }
        }
        true
    }
}

/// The end of `interpret`, and of `FormXObject::draw` for a form.
fn finish<'a>(frame: Frame<'a>, context: &mut Context<'a>, device: &mut impl Device<'a>) {
    // A path object, including a pending `W` or `W*`, can't continue beyond the content
    // stream it starts in.
    context.clear_path();
    *(context.clip_mut()) = None;
    while context.num_states() > frame.states {
        context.restore_state(device);
    }
    if let Close::Form { group, has_oc } = frame.close {
        device.pop_clip();
        if group {
            device.pop_transparency_group();
        }
        context.pop_root_transform();
        context.restore_state(device);
        if has_oc {
            context.ocg_state.end_marked_content();
        }
        context.end_nested_interpretation();
    }
}
