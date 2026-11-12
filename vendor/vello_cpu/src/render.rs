// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Basic render operations.

use crate::dispatch::Dispatcher;

use crate::dispatch::single_threaded::SingleThreadedDispatcher;
use crate::kurbo::{PathEl, Point};
use alloc::boxed::Box;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use hashbrown::HashMap;
use vello_common::blurred_rounded_rect::BlurredRoundedRectangle;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::encode::{EncodeExt, EncodedPaint, invert_paint_transform};
use vello_common::fearless_simd::Level;
use vello_common::filter::FilterData;
use vello_common::filter_effects::Filter;
use vello_common::kurbo::{Affine, BezPath, Rect, Stroke};
use vello_common::mask::Mask;
use vello_common::paint::{ImageId, ImageResolver, Paint, PaintType, Tint};
use vello_common::peniko::color::palette::css::BLACK;
use vello_common::peniko::{BlendMode, Fill};
use vello_common::pixmap::{Pixmap, PixmapMut};
use vello_common::render_state::RenderState;
use vello_common::transforms::{RootTransforms, Transforms};
use vello_common::util::into_fast_path_rect;

// Why do we need this? The reason is that the way uploaded images work in Vello GPU
// is different from how they work in Vello CPU.
//
// In Vello GPU, all images, regardless of whether they are user-uploaded
// images or cached glyphs, are stored in an image atlas at a certain location. An image ID then
// uniquely resolves to an atlas page index + a location on that page. Whenever we want to
// cache a new glyph, we simply allocate a location in the image atlas and then return the image
// ID associated with that location.
//
// On Vello CPU, it works differently: An image ID is associated with a complete pixmap.
// If a user uploads an image, instead of blitting it into a bigger image atlas, we just
// store the user-provided pixmap and associate an image ID with the whole pixmap. However,
// for glyph caching to work we need the same semantics as in Vello GPU. Therefore, we
// use a marker to determine whether an image ID refers to a normal uploaded image or a cached
// glyph and apply special handling based on that.
//
// All IDs < than this value are reserved for normal images, all IDs >= this value are
// reserved for atlas pages.
pub(crate) const ATLAS_IMAGE_ID_BASE: u32 = u32::MAX / 2;

/// Persistent resources required by Vello CPU for rendering.
///
/// You should create one such instance per renderer.
#[derive(Debug, Default)]
pub struct Resources {
    pub(crate) image_registry: ImageRegistry,
}

impl Resources {
    /// Create a new set of renderer resources.
    pub fn new() -> Self {
        Self::default()
    }
}

/// How the destination pixmap is initialized before rendering.
pub type TargetInit = vello_common::TargetInit<AlphaColor<Srgb>>;

/// The pixel format to assume for the destination pixmap.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub enum PixelFormat {
    /// Premultiplied RGBA8.
    #[default]
    Rgba8,
}

/// Settings used when rasterizing a scene into a pixmap.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct RasterizerSettings {
    /// How the destination is initialized before drawing.
    pub target_init: TargetInit,
    /// Pixel format of the destination.
    pub pixel_format: PixelFormat,
    /// Offset in destination pixels where the render context origin is placed.
    ///
    /// See [`RenderContext::render_with`] for more information.
    pub offset: (u16, u16),
}

impl Default for RasterizerSettings {
    fn default() -> Self {
        Self {
            target_init: TargetInit::Clear(AlphaColor::TRANSPARENT),
            pixel_format: PixelFormat::Rgba8,
            offset: (0, 0),
        }
    }
}

/// A render context for CPU-based 2D graphics rendering.
///
/// This is the main entry point for drawing operations. It maintains the current
/// rendering state (transforms, paint, stroke, etc.) and dispatches drawing commands
/// to the underlying rasterization engine.
#[derive(Debug)]
pub struct RenderContext {
    /// Width of the render target in pixels.
    pub(crate) width: u16,
    /// Height of the render target in pixels.
    pub(crate) height: u16,
    /// The current rendering state.
    pub(crate) state: RenderState,
    root_transforms: RootTransforms,
    /// The current mask in place.
    pub(crate) mask: Option<Mask>,
    /// Temporary path buffer to avoid repeated allocations.
    pub(crate) temp_path: BezPath,
    /// Optional threshold for aliasing.
    pub(crate) aliasing_threshold: Option<u8>,
    pub(crate) encoded_paints: Vec<EncodedPaint>,
    pub(crate) filter: Option<Filter>,
    pub(crate) render_settings: RenderSettings,
    dispatcher: Box<dyn Dispatcher>,
}

/// Settings to apply to the render context.
#[derive(Copy, Clone, Debug)]
pub struct RenderSettings {
    /// The SIMD level that should be used for rendering operations.
    pub level: Level,
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            level: Level::try_detect().unwrap_or(Level::baseline()),
        }
    }
}

impl RenderContext {
    /// Create a new render context with the given width and height in pixels.
    pub fn new(width: u16, height: u16) -> Self {
        Self::new_with(width, height, RenderSettings::default())
    }

    /// Create a new render context with specific settings.
    pub fn new_with(width: u16, height: u16, settings: RenderSettings) -> Self {
        let dispatcher: Box<dyn Dispatcher> =
            Box::new(SingleThreadedDispatcher::new(width, height, settings.level));

        let encoded_paints = vec![];
        let temp_path = BezPath::new();
        let aliasing_threshold = None;

        Self {
            width,
            height,
            dispatcher,
            state: RenderState::default(),
            root_transforms: RootTransforms::default(),
            aliasing_threshold,
            render_settings: settings,
            mask: None,
            temp_path,
            encoded_paints,
            filter: None,
        }
    }

    fn transforms(&self) -> &Transforms {
        &self.state.transforms
    }

    fn transforms_mut(&mut self) -> &mut Transforms {
        &mut self.state.transforms
    }

    /// Returns `None` if the current paint cannot cover any pixels (see [`Self::paint_has_area`]).
    fn encode_current_paint(&mut self) -> Option<Paint> {
        match self.state.paint.clone() {
            PaintType::Solid(s) => Some(s.into()),
            PaintType::Gradient(g) => {
                let transform = self
                    .root_transforms
                    .effective_paint_transform(self.transforms());
                // TODO: Add caching?
                g.encode_into(&mut self.encoded_paints, transform, None)
            }
            PaintType::Image(i) => {
                let transform = self
                    .root_transforms
                    .effective_paint_transform(self.transforms());
                i.encode_into(&mut self.encoded_paints, transform, self.state.tint)
            }
        }
    }

    /// Whether the effective paint transform maps paint space onto a non-zero area.
    ///
    /// A singular transform collapses images, gradients and blurred rectangles onto a line or a
    /// point, so drawing with it must not touch any pixel. Checked before pushing a filter layer
    /// so that a skipped draw does not leave an empty layer behind.
    fn paint_transform_has_area(&self) -> bool {
        let transform = self
            .root_transforms
            .effective_paint_transform(self.transforms());
        invert_paint_transform(transform).is_some()
    }

    /// Whether drawing with the current paint can produce any pixels.
    fn paint_has_area(&self) -> bool {
        matches!(self.state.paint, PaintType::Solid(_)) || self.paint_transform_has_area()
    }

    /// Fill a path.
    pub fn fill_path(&mut self, path: &BezPath) {
        if !self.paint_has_area() {
            return;
        }

        // TODO: Similarly to Vello GPU, make sure that inline blend + filter are applied
        // to the same layer.
        self.with_optional_filter(|ctx| {
            let Some(paint) = ctx.encode_current_paint() else {
                return;
            };
            let transform = ctx
                .root_transforms
                .effective_path_transform(ctx.transforms());
            ctx.dispatcher.fill_path(
                path,
                ctx.state.fill_rule,
                transform,
                paint,
                ctx.state.blend_mode,
                ctx.aliasing_threshold,
                ctx.mask.clone(),
            );
        });
    }

    /// Stroke a path.
    pub fn stroke_path(&mut self, path: &BezPath) {
        if !self.paint_has_area() {
            return;
        }

        self.with_optional_filter(|ctx| {
            let Some(paint) = ctx.encode_current_paint() else {
                return;
            };
            let transform = ctx
                .root_transforms
                .effective_path_transform(ctx.transforms());
            ctx.dispatcher.stroke_path(
                path,
                &ctx.state.stroke,
                transform,
                paint,
                ctx.state.blend_mode,
                ctx.aliasing_threshold,
                ctx.mask.clone(),
            );
        });
    }

    /// Fill a rectangle.
    pub fn fill_rect(&mut self, rect: &Rect) {
        if !self.paint_has_area() {
            return;
        }

        self.with_optional_filter(|ctx| {
            let Some(paint) = ctx.encode_current_paint() else {
                return;
            };
            let transform = ctx
                .root_transforms
                .effective_path_transform(ctx.transforms());

            // Fast path: Use optimized rect filling if we have no skew in the path transform
            // and anti-aliasing is enabled.
            // TODO: Maybe also support no anti-aliasing in the fast path
            if let Some(transformed_rect) =
                into_fast_path_rect(*rect, &transform, ctx.aliasing_threshold)
            {
                ctx.dispatcher.fill_rect_fast(
                    &transformed_rect,
                    paint,
                    ctx.state.blend_mode,
                    ctx.mask.clone(),
                );
            } else {
                // Fall back to path-based rendering for rotated/skewed transforms.
                ctx.rect_to_temp_path(rect);
                ctx.dispatcher.fill_path(
                    &ctx.temp_path,
                    ctx.state.fill_rule,
                    transform,
                    paint,
                    ctx.state.blend_mode,
                    ctx.aliasing_threshold,
                    ctx.mask.clone(),
                );
            }
        });
    }

    /// recto: fill a coverage mask, `width` columns of `height` bytes each, column by column (as
    /// strips keep their alphas), at the current transform's origin, with the current paint: each pixel as a path's fill covering it by that much would be.
    /// One byte a pixel where an image paint takes four, and it's drawn as the strips' alphas, so
    /// nothing is encoded per draw and no image is sampled.
    ///
    /// Only for a solid paint at a whole-pixel translation, in the normal blend mode with no mask,
    /// filter or aliasing threshold, and a clip rectangle that cuts it on whole pixels if any. Says
    /// whether it drew; where it didn't, nothing is drawn, and an image paint draws the same.
    pub fn fill_coverage(&mut self, width: u16, height: u16, coverage: &[u8]) -> bool {
        let PaintType::Solid(color) = self.state.paint else {
            return false;
        };
        if self.filter.is_some()
            || self.mask.is_some()
            || self.aliasing_threshold.is_some()
            || self.state.blend_mode != BlendMode::default()
            || coverage.len() != usize::from(width) * usize::from(height)
        {
            return false;
        }
        let transform = self
            .root_transforms
            .effective_path_transform(self.transforms());
        let [a, b, c, d, e, f] = transform.as_coeffs();
        if [a, b, c, d] != [1.0, 0.0, 0.0, 1.0] || e.fract() != 0.0 || f.fract() != 0.0 {
            return false;
        }
        // Saturating, as a cast from a float is: far from the target is clamped to its edge.
        let (x, y) = (e as i64, f as i64);
        let clamp = |v: i64, max: u16| v.clamp(0, i64::from(max)) as u16;
        let placed = crate::coverage::PlacedCoverage {
            coverage,
            height: usize::from(height),
            x,
            y,
            x0: clamp(x, self.width),
            y0: clamp(y, self.height),
            x1: clamp(x.saturating_add(i64::from(width)), self.width),
            y1: clamp(y.saturating_add(i64::from(height)), self.height),
        };
        self.dispatcher
            .fill_coverage(placed, Paint::from(color), self.state.blend_mode, None)
    }

    /// Stroke a rectangle.
    pub fn stroke_rect(&mut self, rect: &Rect) {
        if !self.paint_has_area() {
            return;
        }

        self.with_optional_filter(|ctx| {
            ctx.rect_to_temp_path(rect);
            let Some(paint) = ctx.encode_current_paint() else {
                return;
            };
            let transform = ctx
                .root_transforms
                .effective_path_transform(ctx.transforms());
            ctx.dispatcher.stroke_path(
                &ctx.temp_path,
                &ctx.state.stroke,
                transform,
                paint,
                ctx.state.blend_mode,
                ctx.aliasing_threshold,
                ctx.mask.clone(),
            );
        });
    }

    fn rect_to_temp_path(&mut self, rect: &Rect) {
        self.temp_path.truncate(0);
        self.temp_path
            .push(PathEl::MoveTo(Point::new(rect.x0, rect.y0)));
        self.temp_path
            .push(PathEl::LineTo(Point::new(rect.x1, rect.y0)));
        self.temp_path
            .push(PathEl::LineTo(Point::new(rect.x1, rect.y1)));
        self.temp_path
            .push(PathEl::LineTo(Point::new(rect.x0, rect.y1)));
        self.temp_path.push(PathEl::ClosePath);
    }

    /// Fill a blurred rectangle with the given corner radius and standard deviation.
    ///
    /// When `invert` is `true`, the inverse (`1 - alpha`) of the blur coverage is painted: the
    /// paint is fully opaque outside the blurred rectangle and fades to transparent inside it. This
    /// can be used to implement inset box shadows.
    ///
    /// Note that this only works properly if the current paint is set to a solid color.
    /// If not, it will fall back to using black as the fill color.
    pub fn fill_blurred_rounded_rect(
        &mut self,
        rect: &Rect,
        radius: f32,
        std_dev: f32,
        invert: bool,
    ) {
        let rect = rect.abs();
        let color = match self.state.paint {
            PaintType::Solid(s) => s,
            // Fallback to black when attempting to blur a rectangle with an image/gradient paint
            _ => BLACK,
        };

        let blurred_rect = BlurredRoundedRectangle {
            rect,
            color,
            radius,
            std_dev,
            invert,
        };

        // The actual rectangle we paint needs to be larger so that the blurring effect
        // is not cut off.
        // The impulse response of a gaussian filter is infinite.
        // For performance reason we cut off the filter at some extent where the response is close to zero.
        let kernel_size = 2.5 * std_dev;
        let inflated_rect = rect.inflate(f64::from(kernel_size), f64::from(kernel_size));
        let transform = self
            .root_transforms
            .effective_path_transform(self.transforms());
        let paint_transform = self
            .root_transforms
            .effective_paint_transform(self.transforms());

        let Some(paint) = blurred_rect.encode_into(&mut self.encoded_paints, paint_transform, None)
        else {
            return;
        };

        self.rect_to_temp_path(&inflated_rect);
        self.dispatcher.fill_path(
            &self.temp_path,
            Fill::NonZero,
            transform,
            paint,
            self.state.blend_mode,
            self.aliasing_threshold,
            self.mask.clone(),
        );
    }

    /// Push a new layer with the given properties.
    ///
    /// Note that the mask, if provided, needs to have the same size as the render context. Otherwise,
    /// it will be ignored. In addition to that, the mask will not be affected by the current
    /// transformation matrix in place.
    ///
    /// # Panics
    ///
    /// Panics if `filter` is provided when this context uses multi-threaded rendering.
    pub fn push_layer(
        &mut self,
        clip_path: Option<&BezPath>,
        blend_mode: Option<BlendMode>,
        opacity: Option<f32>,
        mask: Option<Mask>,
        filter: Option<Filter>,
    ) {
        let mask = mask.and_then(|m| {
            if m.width() != self.width || m.height() != self.height {
                None
            } else {
                Some(m)
            }
        });

        let blend_mode = blend_mode.unwrap_or_default();
        let opacity = opacity.unwrap_or(1.0).clamp(0.0, 1.0);
        let layer_transform = self
            .root_transforms
            .effective_path_transform(self.transforms());
        let filter_data = filter.map(|filter| FilterData::new(filter, layer_transform));

        // The important part! Let's say we have an element placed in a way such that
        // its drop shadow starts at (0, 0). In order for it to render correctly, we would
        // have to render parts of the shape that at negative viewport coordinates, which is
        // not supported. Therefore, we instead shift everything down such that we can assume
        // everything left/above (0, 0) is not needed for correct rendering, and simply
        // shift everything back when actually compositing the rendered filter layer.
        let relative_transform = filter_data.as_ref().map_or(Affine::IDENTITY, |data| {
            let (shift_x, shift_y) = data.source_shift();
            Affine::translate((f64::from(shift_x), f64::from(shift_y)))
        });
        self.root_transforms.push_root(relative_transform);

        self.dispatcher.push_layer(
            clip_path,
            self.state.fill_rule,
            layer_transform,
            blend_mode,
            opacity,
            self.aliasing_threshold,
            mask,
            filter_data,
        );
    }

    /// Push a new clip layer.
    ///
    /// See the explanation in the [clipping](https://github.com/linebender/vello/tree/main/vello_cpu/examples)
    /// example for how this method differs from `push_clip_path`.
    pub fn push_clip_layer(&mut self, path: &BezPath) {
        self.push_layer(Some(path), None, None, None, None);
    }

    /// Push a new blend layer.
    pub fn push_blend_layer(&mut self, blend_mode: BlendMode) {
        self.push_layer(None, Some(blend_mode), None, None, None);
    }

    /// Push a new opacity layer.
    pub fn push_opacity_layer(&mut self, opacity: f32) {
        self.push_layer(None, None, Some(opacity), None, None);
    }

    /// Push a new mask layer. The mask needs to have the same dimensions as the
    /// render context. The mask will not be affected by the current transform
    /// in place.
    ///
    /// See the explanation in the [masking](https://github.com/linebender/vello/blob/main/vello_cpu/examples/masking.rs)
    /// example for how this method differs from `set_mask`.
    pub fn push_mask_layer(&mut self, mask: Mask) {
        self.push_layer(None, None, None, Some(mask), None);
    }

    /// Push a filter layer that affects all subsequent drawing operations.
    ///
    /// WARNING: Note that filters are currently incomplete and experimental. In
    /// particular, they will lead to a panic when used in combination with
    /// multi-threaded rendering.
    ///
    /// # Panics
    ///
    /// Panics when this context uses multi-threaded rendering.
    pub fn push_filter_layer(&mut self, filter: Filter) {
        self.push_layer(None, None, None, None, Some(filter));
    }

    /// Set the aliasing threshold.
    ///
    /// If set to `None` (which is the recommended option in nearly all cases),
    /// anti-aliasing will be applied.
    ///
    /// If instead set to some value, then a pixel will be fully painted if
    /// the coverage is bigger than the threshold (between 0 and 255), otherwise
    /// it will not be painted at all.
    ///
    /// Note that there is no performance benefit to disabling anti-aliasing and
    /// this functionality is simply provided for compatibility.
    pub fn set_aliasing_threshold(&mut self, aliasing_threshold: Option<u8>) {
        self.aliasing_threshold = aliasing_threshold;
    }

    /// Pop the last-pushed layer.
    pub fn pop_layer(&mut self) {
        self.dispatcher.pop_layer();
        self.root_transforms.pop_root();
    }

    /// Set the current stroke.
    pub fn set_stroke(&mut self, stroke: Stroke) {
        self.state.stroke = stroke;
    }

    /// Get the current stroke.
    pub fn stroke(&self) -> &Stroke {
        &self.state.stroke
    }

    /// Set the current paint.
    ///
    /// If the paint is an image with `ImageSource::OpaqueId`, it will be
    /// resolved to the corresponding pixmap at rasterization time.
    /// Make sure to register images with [`Resources::register_image`] first.
    pub fn set_paint(&mut self, paint: impl Into<PaintType>) {
        self.state.paint = paint.into();
    }

    /// Get the current paint.
    pub fn paint(&self) -> &PaintType {
        &self.state.paint
    }

    /// Set the tint for subsequent image paint operations.
    pub fn set_tint(&mut self, tint: Option<Tint>) {
        self.state.tint = tint;
    }

    /// Clear the tint, so subsequent image paints are drawn without tinting.
    pub fn reset_tint(&mut self) {
        self.state.tint = None;
    }

    /// Set the blend mode that should be used when drawing objects.
    pub fn set_blend_mode(&mut self, blend_mode: BlendMode) {
        self.state.blend_mode = blend_mode;
    }

    /// Get the currently active blend mode.
    pub fn blend_mode(&self) -> BlendMode {
        self.state.blend_mode
    }

    /// Set the current paint transform.
    ///
    /// The paint transform is applied to the paint after the transform of the geometry the paint
    /// is drawn in, i.e., the paint transform is applied after the global transform. This allows
    /// transforming the paint independently from the drawn geometry.
    pub fn set_paint_transform(&mut self, paint_transform: Affine) {
        self.transforms_mut().set_paint_transform(paint_transform);
    }

    /// Get the current paint transform.
    pub fn paint_transform(&self) -> &Affine {
        self.transforms().paint_transform()
    }

    /// Reset the current paint transform.
    pub fn reset_paint_transform(&mut self) {
        self.transforms_mut().reset_paint_transform();
    }

    /// Set the current fill rule.
    pub fn set_fill_rule(&mut self, fill_rule: Fill) {
        self.state.fill_rule = fill_rule;
    }

    /// Set the mask to use for path-painting operations. The mask needs to
    /// have the same dimensions as the render context. The mask will not be
    /// affected by the current transform in place.
    ///
    /// See the explanation in the [masking](https://github.com/linebender/vello/blob/main/vello_cpu/examples/masking.rs)
    /// example for how this method differs from `push_mask_layer`.
    pub fn set_mask(&mut self, mask: Mask) {
        self.mask = Some(mask);
    }

    /// Reset the mask that is used for path-painting operations.
    pub fn reset_mask(&mut self) {
        self.mask = None;
    }

    /// Get the current fill rule.
    pub fn fill_rule(&self) -> &Fill {
        &self.state.fill_rule
    }

    /// Set the current transform.
    pub fn set_transform(&mut self, transform: Affine) {
        self.transforms_mut().set_transform(transform);
    }

    /// Get the current transform.
    pub fn transform(&self) -> &Affine {
        self.transforms().transform()
    }

    /// Reset the current transform.
    pub fn reset_transform(&mut self) {
        self.transforms_mut().reset_transform();
    }

    /// Apply filter to the current paint (affects next drawn elements).
    ///
    /// This sets a filter that will be applied to the next drawn element.
    /// To apply a filter to multiple elements, use `push_filter_layer` instead.
    /// # Panics
    ///
    /// When this context uses multi-threaded rendering.
    pub fn set_filter_effect(&mut self, filter: Filter) {
        self.filter = Some(filter);
    }

    /// Reset the current filter effect.
    pub fn reset_filter_effect(&mut self) {
        self.filter = None;
    }

    /// Reset the render context and update the scene size.
    pub fn reset_and_resize(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;

        self.reset();
    }

    /// Reset the render context.
    pub fn reset(&mut self) {
        self.dispatcher.reset(self.width, self.height);
        self.encoded_paints.clear();
        self.mask = None;
        self.root_transforms.reset();
        self.state.reset();
        self.aliasing_threshold = None;
    }

    /// Push a new clip path to the clip stack.
    ///
    /// See the explanation in the [clipping](https://github.com/linebender/vello/tree/main/vello_cpu/examples)
    /// example for how this method differs from `push_clip_layer`.
    pub fn push_clip_path(&mut self, path: &BezPath) {
        let transform = self.transforms().clip_path_transform();
        self.dispatcher.push_clip_path(
            path,
            self.state.fill_rule,
            transform,
            self.aliasing_threshold,
        );
    }

    /// Push a rectangular clip path.
    pub fn push_clip_rect(&mut self, rect: &Rect) {
        let transform = self.transforms().clip_path_transform();

        if let Some(rect) = into_fast_path_rect(*rect, &transform, self.aliasing_threshold) {
            self.dispatcher.push_clip_rect(&rect);
        } else {
            self.rect_to_temp_path(rect);
            self.dispatcher.push_clip_path(
                &self.temp_path,
                self.state.fill_rule,
                transform,
                self.aliasing_threshold,
            );
        }
    }

    /// Pop the most recently pushed clip path or clip rectangle from the clip stack.
    ///
    /// Note that unlike `push_clip_layer`, it is permissible to have pending
    /// pushed clips before finishing the rendering operation.
    pub fn pop_clip(&mut self) {
        self.dispatcher.pop_clip();
    }

    /// Flush any pending operations.
    ///
    /// This is a no-op when using the single-threaded render mode, and can be ignored.
    /// For multi-threaded rendering, you _have_ to call this before rasterizing, otherwise
    /// the program will panic.
    pub fn flush(&mut self) {
        self.dispatcher.flush();
    }

    /// Render the current context into a target using default rasterizer settings.
    ///
    /// See the documentation of [`RenderContext::render_with`] for more information.
    pub fn render<'a>(&self, target: impl Into<PixmapMut<'a>>, resources: &mut Resources) {
        self.render_with(target, resources, RasterizerSettings::default());
    }

    /// Render the current context into a target using custom rasterizer settings.
    ///
    /// See the documentation of [`RasterizerSettings`] to understand the tunable parameters for
    /// rasterization.
    ///
    /// There is an important note to make about render sizes. [`RenderContext`] can be configured with
    /// a specific width/height, but so can [`Pixmap`]. In the vast majority of cases, you will simply
    /// want to configure them both to have the same size. However, it _is_ very much possible for them
    /// to have different sizes, which can be useful in certain situations. In principle, the size
    /// that you specify when creating a [`RenderContext`] defines the bound of the scene itself. Any
    /// content that is to the top/left of (0, 0) and to the right/bottom of (width/height) will be
    /// removed. However, the offset in [`RasterizerSettings`] as well as the width/height of
    /// the [`PixmapMut`] define at which location the scene will be rasterized into, and allows
    /// for further clipping certain parts of the scene away. The semantics are defined as follows:
    ///
    /// 1. [`RasterizerSettings::offset`] defines the where the top-left corner will be positioned
    ///    on the pixmap, assuming a y-down coordinate system. In most cases (0, 0) will be the
    ///    appropriate choice, but other values are certainly sensible. For example, if you want to
    ///    implement a custom glyph-atlas, you can construct the scene assuming (0, 0) as the origin
    ///    and then position the glyphs at rasterization time using this feature.
    ///
    /// 2. In case the pixmap width/height is larger than the offset plus the width/height of the
    ///    [`RenderContext`], any remaining rows/columns are simply treated as padding (**however**,
    ///    when using [`TargetInit::Clear`], then the _whole_ destination pixmap will
    ///    be cleared to the requested color, not just the area covered by the scene). One potential reason for doing this
    ///    is that certain platforms, for example macOS, require a specific byte stride for buffers.
    ///    For example, let's say that a byte stride of 128 is imposed by the platform, but the actual
    ///    size of the scene you are drawing is only 20x20. In this case, you can create a pixmap
    ///    of size 32x20, and the last 12 columns are essentially treated as padding.
    ///
    /// 3. In case the width/height of the pixmap is _smaller_ than the offset + width/height of the
    ///    scene, then anything that exceeds the pixmap boundaries is simply cut off. This can be useful
    ///    if for some reason you only want to rasterize a small cut-out of the original scene.
    pub fn render_with<'a>(
        &self,
        target: impl Into<PixmapMut<'a>>,
        resources: &mut Resources,
        settings: RasterizerSettings,
    ) {
        // TODO: Maybe we should move those checks into the dispatcher.
        assert!(
            !self.dispatcher.has_layers(),
            "some layers haven't been popped yet"
        );

        let mut target = target.into();
        let target_fully_covered = settings.offset == (0, 0)
            && self.width >= target.width()
            && self.height >= target.height();
        // If the scene covers the whole pixmap than packing will take care
        // of clearing everything anyway, so no reason to clear it explicitly
        // here.
        if let TargetInit::Clear(color) = settings.target_init
            && !target_fully_covered
        {
            let color = color.premultiply().to_rgba8().to_u32();
            let data = target.data_mut();
            if color == 0 {
                data.fill(0);
            } else {
                // TODO: Optimize with SIMD? Unfortunately we can't just cast to u32 and use
                // `fill` because the user-provided slice might not have the correct alignment.
                let color = color.to_ne_bytes();
                for pixel in data.chunks_exact_mut(4) {
                    pixel.copy_from_slice(&color);
                }
            }
        }

        // The background is always isolated, so we don't need to worry about destructive
        // blend modes.
        match settings.target_init {
            TargetInit::Clear(color) => {
                target.set_may_have_transparency(color.components[3] != 1.0);
            }
            // Whatever is the current hint can be preserved.
            TargetInit::SrcOver => {}
        }

        self.dispatcher.rasterize(
            target,
            self.width,
            self.height,
            settings,
            &self.encoded_paints,
            &resources.image_registry,
        );
    }

    /// recto: the bytes held for what's been drawn and not yet rasterized: its strips, their alphas,
    /// the draws and their paints. A page records everything before it rasterizes any of it, so
    /// this grows with what it draws, however little of the target that covers.
    pub fn recorded_bytes(&self) -> usize {
        self.dispatcher.recorded_bytes() + self.encoded_paints.len() * size_of::<EncodedPaint>()
    }

    /// recto: rasterizes what's been drawn into `target`, as `render_with` does, and forgets it,
    /// keeping the state and the clips, so that what's drawn next can go over it with
    /// [`TargetInit::SrcOver`] and the scene be rasterized a part at a time, holding only a part.
    /// Not while a layer is open, or where the dispatcher can't: false, and nothing is done.
    ///
    /// A part rasterized over another is what one rasterization of both gives, except that a part
    /// with a non-default blend mode at its root blends over the parts before it, which one
    /// rasterization keeps apart from its target as it does from the background.
    pub fn render_and_clear<'a>(
        &mut self,
        target: impl Into<PixmapMut<'a>>,
        resources: &mut Resources,
        settings: RasterizerSettings,
    ) -> bool {
        if !self.can_render_and_clear() {
            return false;
        }
        self.flush();
        self.render_with(target, resources, settings);
        self.dispatcher.clear_recorded(self.width, self.height);
        self.encoded_paints.clear();
        true
    }

    /// recto: whether [`Self::render_and_clear`] would: no layer is open, and something's recorded.
    pub fn can_render_and_clear(&self) -> bool {
        !self.dispatcher.has_layers() && self.dispatcher.recorded_bytes() != 0
    }

    /// Return the width of the scene.
    pub fn width(&self) -> u16 {
        self.width
    }

    /// Return the height of the scene.
    pub fn height(&self) -> u16 {
        self.height
    }

    /// Return the render settings used by the `RenderContext`.
    pub fn render_settings(&self) -> &RenderSettings {
        &self.render_settings
    }

    /// Execute a drawing operation, optionally wrapping it in a filter layer.
    fn with_optional_filter<F>(&mut self, mut f: F)
    where
        F: FnMut(&mut Self),
    {
        if let Some(filter) = self.filter.clone() {
            self.push_filter_layer(filter);
            f(self);
            self.pop_layer();
        } else {
            f(self);
        }
    }

    /// Take current rendering state and reset the existing state to its default.
    pub fn take_current_state(&mut self) -> RenderState {
        core::mem::take(&mut self.state)
    }

    /// Save a copy of the current rendering state.
    pub fn save_current_state(&mut self) -> RenderState {
        self.state.clone()
    }

    /// Restore rendering state.
    pub fn restore_state(&mut self, state: RenderState) {
        self.state = state;
    }
}

/// Image registry implementation.
impl Resources {
    /// Register a pixmap in the image registry and return its [`ImageId`].
    pub fn register_image(&mut self, pixmap: Arc<Pixmap>) -> ImageId {
        self.image_registry.register(pixmap)
    }

    /// Remove an image from the registry.
    pub fn destroy_image(&mut self, id: ImageId) -> bool {
        self.image_registry.destroy(id)
    }

    /// Resolve an `ImageId` to its pixmap data.
    pub fn resolve_image(&self, id: ImageId) -> Option<Arc<Pixmap>> {
        self.image_registry.resolve(id)
    }

    /// Clear the image registry.
    pub fn clear_images(&mut self) {
        self.image_registry.clear();
    }
}

/// Registry that maps opaque [`ImageId`]s to [`Pixmap`] data.
///
/// Used by [`RenderContext`] to resolve `ImageSource::OpaqueId` at rasterization time.
#[derive(Debug, Default)]
pub(crate) struct ImageRegistry {
    images: HashMap<u32, Arc<Pixmap>>,
    next_id: u32,
}

impl ImageRegistry {
    fn register(&mut self, pixmap: Arc<Pixmap>) -> ImageId {
        let id = self.next_id;
        assert!(
            id < ATLAS_IMAGE_ID_BASE,
            "image registry exhausted non-atlas image IDs"
        );

        self.next_id += 1;
        self.images.insert(id, pixmap);
        ImageId::new(id)
    }

    pub(crate) fn destroy(&mut self, id: ImageId) -> bool {
        self.images.remove(&id.as_u32()).is_some()
    }

    fn resolve(&self, id: ImageId) -> Option<Arc<Pixmap>> {
        self.images.get(&id.as_u32()).cloned()
    }

    fn clear(&mut self) {
        self.images.clear();
        self.next_id = 0;
    }
}

impl ImageResolver for ImageRegistry {
    fn resolve(&self, id: ImageId) -> Option<Arc<Pixmap>> {
        self.images.get(&id.as_u32()).cloned()
    }
}
