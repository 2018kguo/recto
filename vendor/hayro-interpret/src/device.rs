use crate::font::GlyphRun;
use crate::x_object::soft_mask::SoftMask;
use crate::{BlendMode, ClipPath, FillRule, Image};
use crate::{DrawMode, DrawProps, ImageDrawProps};
use hayro_syntax::object::Dict;
use kurbo::{BezPath, Rect, Shape};

/// A trait for a device that can be used to process PDF drawing instructions.
pub trait Device<'a> {
    /// Draw a path.
    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, draw_mode: &DrawMode);
    /// Push a new clip path to the clip stack.
    fn push_clip_path(&mut self, clip_path: &ClipPath);
    /// Push a rectangular clip to the clip stack.
    fn push_clip_rect(&mut self, rect: &Rect) {
        self.push_clip_path(&ClipPath {
            path: rect.to_path(0.1),
            fill: FillRule::NonZero,
        });
    }
    /// Push a new transparency group to the blend stack.
    fn push_transparency_group(
        &mut self,
        opacity: f32,
        mask: Option<SoftMask<'a>>,
        blend_mode: BlendMode,
    );
    /// Draw a run of positioned glyphs.
    fn draw_glyph_run(
        &mut self,
        glyph_run: &GlyphRun<'_, 'a>,
        props: DrawProps<'a>,
        draw_mode: &DrawMode,
    );
    /// Draw an image.
    fn draw_image(&mut self, image: Image<'a, '_>, props: ImageDrawProps<'a>);
    /// Pop the last clip path or clip rectangle from the clip stack.
    fn pop_clip(&mut self);
    /// Pop the last transparency group from the blend stack.
    fn pop_transparency_group(&mut self);
    /// recto: called before the current path is drawn (`draw_path` or
    /// `draw_rect`): where in it each rectangle `re` drew starts (element
    /// indices, ascending). A rect drawn by `draw_rect` is element 0.
    fn path_rects(&mut self, _starts: &[u32]) {}
    /// recto: true just before the fill that paints an `sh` operator (hayro
    /// draws it as a fill of the clip box), false right after it.
    fn shading_fill(&mut self, _on: bool) {}
    /// Draw a rectangle directly, without going through the general path pipeline.
    fn draw_rect(&mut self, rect: &Rect, props: DrawProps<'a>, draw_mode: &DrawMode) {
        self.draw_path(&rect.to_path(0.1), props, draw_mode);
    }
    /// recto: the transparency group just pushed is a knockout group.
    fn set_group_knockout(&mut self) {}
    /// recto: the next thing painted is an element of a knockout group.
    fn in_knockout(&self) -> bool {
        false
    }
    /// recto: a non-isolated group whose result needs its backdrop (see `x_object::form`). A
    /// device that returns true gets the contents twice, with `next_backdrop_pass` between and
    /// `end_backdrop_group` after. One that returns false gets an ordinary pushed group.
    fn begin_backdrop_group(
        &mut self,
        _opacity: f32,
        _mask: &Option<SoftMask<'a>>,
        _blend_mode: BlendMode,
        _knockout: bool,
    ) -> bool {
        false
    }
    /// recto: after `begin_backdrop_group` returned true, whether the device has the group's result
    /// from an earlier drawing of the page: then `end_backdrop_group` follows at once, without the
    /// contents.
    fn backdrop_group_known(&self) -> bool {
        false
    }
    /// recto: see `begin_backdrop_group`.
    fn next_backdrop_pass(&mut self) {}
    /// recto: see `begin_backdrop_group`.
    fn end_backdrop_group(&mut self) {}
    /// recto: what is painted until `pop_knockout_erase` removes what the group holds there, not
    /// adding to it: how an element too complex for a clip path knocks out what's under it.
    fn push_knockout_erase(&mut self) {}
    /// recto: see `push_knockout_erase`.
    fn pop_knockout_erase(&mut self) {}
    /// Called at the beginning of a marked content sequence (BMC/BDC).
    ///
    /// The tag is the marked content tag (e.g. b"P", b"Span"). The properties are the property list
    /// dictionary.
    fn begin_marked_content(&mut self, _tag: &[u8], _properties: Option<&Dict<'_>>) {}
    /// Called at the end of a marked content sequence (EMC).
    fn end_marked_content(&mut self) {}
}

