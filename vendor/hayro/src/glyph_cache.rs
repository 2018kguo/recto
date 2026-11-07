use crate::Renderer;
use ab_glyph_rasterizer::{Rasterizer, point};
use kurbo::{Affine, BezPath, PathEl, Point, Rect, Shape};
use rustc_hash::FxHashMap;
use std::sync::Arc;
use vello_cpu::color::palette::css::BLACK;
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::peniko::{self, ImageAlphaType, ImageQuality, ImageSampler};
use vello_cpu::{Image, ImageSource, PixelMetadata, Pixmap, Tint, TintMode};

const SUBPIXEL_STEPS: f64 = 4.0;
const MAX_CACHED_SIZE: f64 = 128.0;

pub(crate) type GlyphCache = FxHashMap<GlyphKey, Option<Arc<CachedGlyph>>>;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct GlyphKey {
    glyph: u128,
    hinted: bool,
    linear: [u64; 4],
    subpixel: u8,
}

pub(crate) struct CachedGlyph {
    pixmap: Arc<Pixmap>,
    x: i32,
    y: i32,
}

impl Renderer<'_> {
    pub(crate) fn fill_cached_glyph(
        &mut self,
        glyph: u128,
        hinted: bool,
        outline: &BezPath,
        transform: Affine,
        color: AlphaColor<Srgb>,
    ) -> bool {
        let [a, b, c, d, e, f] = transform.as_coeffs();
        let steps = (e * SUBPIXEL_STEPS).round() as i64;
        let x = steps.div_euclid(SUBPIXEL_STEPS as i64) as i32;
        let subpixel = steps.rem_euclid(SUBPIXEL_STEPS as i64) as u8;
        let y = f.round() as i32;
        let key = GlyphKey {
            glyph,
            hinted,
            linear: [a.to_bits(), b.to_bits(), c.to_bits(), d.to_bits()],
            subpixel,
        };

        let cached = self.global.glyph_cache.borrow().get(&key).cloned();
        let cached = match cached {
            Some(cached) => cached,
            None => {
                let offset = f64::from(subpixel) / SUBPIXEL_STEPS;
                let Some(rasterized) = rasterize(outline, Affine::new([a, b, c, d, offset, 0.0]))
                else {
                    return false;
                };
                let rasterized = rasterized.map(Arc::new);
                self.global
                    .glyph_cache
                    .borrow_mut()
                    .insert(key, rasterized.clone());
                rasterized
            }
        };

        let Some(cached) = cached else {
            return true;
        };

        let (width, height) = (cached.pixmap.width(), cached.pixmap.height());
        self.ctx.set_transform(Affine::translate((
            f64::from(x + cached.x),
            f64::from(y + cached.y),
        )));
        self.ctx.set_paint_transform(Affine::IDENTITY);
        self.ctx.set_paint(Image {
            image: ImageSource::Pixmap(cached.pixmap.clone()),
            sampler: ImageSampler {
                x_extend: peniko::Extend::Pad,
                y_extend: peniko::Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        });
        let tint = color != BLACK;
        if tint {
            self.ctx.set_tint(Some(Tint {
                color,
                mode: TintMode::AlphaMask,
            }));
        }
        self.ctx
            .fill_rect(&Rect::new(0.0, 0.0, f64::from(width), f64::from(height)));
        if tint {
            self.ctx.set_tint(None);
        }

        true
    }
}

fn rasterize(outline: &BezPath, transform: Affine) -> Option<Option<CachedGlyph>> {
    let path = transform * outline.clone();
    let bbox = path.bounding_box();

    if bbox.width() > MAX_CACHED_SIZE || bbox.height() > MAX_CACHED_SIZE {
        return None;
    }

    if bbox.is_zero_area() {
        return Some(None);
    }

    let x0 = bbox.x0.floor();
    let y0 = bbox.y0.floor();
    let width = (bbox.x1.ceil() - x0) as u16;
    let height = (bbox.y1.ceil() - y0) as u16;

    let mut rasterizer = Rasterizer::new(usize::from(width), usize::from(height));
    let to_point = |p: Point| point((p.x - x0) as f32, (p.y - y0) as f32);
    let mut start = Point::ZERO;
    let mut last = Point::ZERO;

    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                if last != start {
                    rasterizer.draw_line(to_point(last), to_point(start));
                }
                start = p;
                last = p;
            }
            PathEl::LineTo(p) => {
                rasterizer.draw_line(to_point(last), to_point(p));
                last = p;
            }
            PathEl::QuadTo(p1, p2) => {
                rasterizer.draw_quad(to_point(last), to_point(p1), to_point(p2));
                last = p2;
            }
            PathEl::CurveTo(p1, p2, p3) => {
                rasterizer.draw_cubic(to_point(last), to_point(p1), to_point(p2), to_point(p3));
                last = p3;
            }
            PathEl::ClosePath => {
                if last != start {
                    rasterizer.draw_line(to_point(last), to_point(start));
                }
                last = start;
            }
        }
    }

    if last != start {
        rasterizer.draw_line(to_point(last), to_point(start));
    }

    // TODO: Store a single coverage channel once vello supports one-channel images.
    let mut data = vec![0; usize::from(width) * usize::from(height) * 4];
    rasterizer.for_each_pixel(|idx, coverage| {
        data[idx * 4 + 3] = round_coverage(coverage.min(1.0) * 255.0);
    });

    let pixmap = Pixmap::from_parts(
        data,
        width,
        height,
        PixelMetadata {
            may_have_transparency: true,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
        },
    );

    Some(Some(CachedGlyph {
        pixmap: Arc::new(pixmap),
        x: x0 as i32,
        y: y0 as i32,
    }))
}

/// recto: `x.round() as u8` without a call to `roundf`, once per pixel of every glyph. `trunc` is one
/// wasm instruction, and `x - t` is exact, so this agrees wherever `round` does.
#[inline]
fn round_coverage(x: f32) -> u8 {
    let t = x.trunc();
    (t + if x - t >= 0.5 { 1.0 } else { 0.0 }) as u8
}

#[cfg(test)]
mod round_tests {
    #[test]
    fn round_coverage_is_round_for_every_f32() {
        // Every 4,099th bit pattern, and all of them around each half from 0 to 255.
        let check = |x: f32| assert_eq!(super::round_coverage(x), x.round() as u8, "{x:?}");
        (0..=u32::MAX).step_by(4099).map(f32::from_bits).for_each(check);
        for half in 0..256 {
            let bits = (half as f32 + 0.5).to_bits();
            (bits - 4096..bits + 4096).map(f32::from_bits).for_each(check);
        }
        [-0.0, -0.3, -0.5, -0.7, -1.5, f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.49999997].map(check);
    }
}
