// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

#[cfg(feature = "multithreading")]
pub(crate) mod multi_threaded;
pub(crate) mod single_threaded;

use crate::RasterizerSettings;
use crate::kurbo::{Affine, BezPath, Rect, Stroke};
use crate::peniko::{BlendMode, Fill};
use core::fmt::Debug;
use vello_common::encode::EncodedPaint;
use vello_common::filter::FilterData;
use vello_common::mask::Mask;
use vello_common::paint::{ImageResolver, Paint};
use vello_common::pixmap::PixmapMut;

pub(crate) trait Dispatcher: Debug + Send {
    fn has_layers(&self) -> bool;
    fn fill_path(
        &mut self,
        path: &BezPath,
        fill_rule: Fill,
        transform: Affine,
        paint: Paint,
        blend_mode: BlendMode,
        aliasing_threshold: Option<u8>,
        mask: Option<Mask>,
    );
    fn stroke_path(
        &mut self,
        path: &BezPath,
        stroke: &Stroke,
        transform: Affine,
        paint: Paint,
        blend_mode: BlendMode,
        aliasing_threshold: Option<u8>,
        mask: Option<Mask>,
    );
    /// Fill a pixel-aligned rectangle with the current paint.
    fn fill_rect_fast(
        &mut self,
        rect: &Rect,
        paint: Paint,
        blend_mode: BlendMode,
        mask: Option<Mask>,
    );
    /// recto: fill a coverage mask as the strips' alphas, with a solid paint. False where this
    /// dispatcher can't, and nothing is drawn: see `RenderContext::fill_coverage`.
    fn fill_coverage(
        &mut self,
        _placed: crate::coverage::PlacedCoverage<'_>,
        _paint: Paint,
        _blend_mode: BlendMode,
        _mask: Option<Mask>,
    ) -> bool {
        false
    }
    /// recto: the bytes held for what's recorded and not yet rasterized; see
    /// `RenderContext::recorded_bytes`. 0 where this dispatcher can't forget it.
    fn recorded_bytes(&self) -> usize {
        0
    }
    /// recto: forgets what's recorded, keeping the clips; see `RenderContext::render_and_clear`.
    fn clear_recorded(&mut self, _width: u16, _height: u16) {}
    fn push_clip_path(
        &mut self,
        path: &BezPath,
        fill_rule: Fill,
        transform: Affine,
        aliasing_threshold: Option<u8>,
    );
    fn push_clip_rect(&mut self, rect: &Rect);
    fn pop_clip(&mut self);
    fn push_layer(
        &mut self,
        clip_path: Option<&BezPath>,
        fill_rule: Fill,
        clip_transform: Affine,
        blend_mode: BlendMode,
        opacity: f32,
        aliasing_threshold: Option<u8>,
        mask: Option<Mask>,
        filter_data: Option<FilterData>,
    );
    fn pop_layer(&mut self);
    fn reset(&mut self, width: u16, height: u16);
    fn flush(&mut self);
    fn rasterize(
        &self,
        target: PixmapMut<'_>,
        scene_width: u16,
        scene_height: u16,
        settings: RasterizerSettings,
        encoded_paints: &[EncodedPaint],
        image_resolver: &dyn ImageResolver,
    );
    fn is_multi_threaded(&self) -> bool;
}
