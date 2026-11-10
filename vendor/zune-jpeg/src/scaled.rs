//! recto: decoding at 1/2, 1/4 or 1/8 of the size, in the IDCT, as libjpeg's `scale_denom` does.
//!
//! Each 8x8 block becomes `n` by `n` pixels by an `n`-point inverse DCT of its lowest `n` by `n`
//! coefficients (libjpeg's `jidctred`): the block's picture sampled at the centres of `n` by `n`
//! pixels once what can't be told apart at that spacing is dropped. A block with only its DC is one
//! value. A component sampled at half the rate gives twice as many pixels a block, so that every
//! component comes out the same size and needs no upsampling; a block of eight a side is the
//! decoder's own IDCT. The entropy decode is the same work as at full size; the IDCT, upsampling,
//! colour conversion and every buffer after it shrink.
//!
//! The planes, one a component at the output's size, are converted with the full-size decoder's own
//! `color_convert`, so colour comes out as it would at full size.

use alloc::vec;
use alloc::vec::Vec;

use zune_core::colorspace::ColorSpace;

use crate::components::Components;
use crate::decoder::{ColorConvert16Ptr, IDCTPtr, MAX_COMPONENTS};
use crate::errors::DecodeErrors;
use crate::worker::color_convert;

/// `C(u) cos((2x + 1) u pi / 2n)` in 1/2048ths: `COS[log2 n][x][u]`.
#[rustfmt::skip]
const COS: [[[i32; 8]; 8]; 4] = [
    [
        [1448, 0, 0, 0, 0, 0, 0, 0],
        [0; 8], [0; 8], [0; 8], [0; 8], [0; 8], [0; 8], [0; 8],
    ],
    [
        [1448, 1448, 0, 0, 0, 0, 0, 0],
        [1448, -1448, 0, 0, 0, 0, 0, 0],
        [0; 8], [0; 8], [0; 8], [0; 8], [0; 8], [0; 8],
    ],
    [
        [1448, 1892, 1448, 784, 0, 0, 0, 0],
        [1448, 784, -1448, -1892, 0, 0, 0, 0],
        [1448, -784, -1448, 1892, 0, 0, 0, 0],
        [1448, -1892, 1448, -784, 0, 0, 0, 0],
        [0; 8], [0; 8], [0; 8], [0; 8],
    ],
    [
        [1448, 2009, 1892, 1703, 1448, 1138, 784, 400],
        [1448, 1703, 784, -400, -1448, -2009, -1892, -1138],
        [1448, 1138, -784, -2009, -1448, 400, 1892, 1703],
        [1448, 400, -1892, -1138, 1448, 1703, -784, -2009],
        [1448, -400, -1892, 1138, 1448, -1703, -784, 2009],
        [1448, -1138, -784, 2009, -1448, -400, 1892, -1703],
        [1448, -1703, 784, 400, -1448, 2009, -1892, 1138],
        [1448, -2009, 1892, -1703, 1448, -1138, 784, -400],
    ],
];

/// One component's share of a scaled decode: its plane, and how many pixels a block gives it across
/// and down, as log2 (0 to 3).
#[derive(Default, Clone)]
pub(crate) struct ScaledPlane {
    pub(crate) plane:  Vec<i16>,
    pub(crate) stride: usize,
    pub(crate) log_x:  u8,
    pub(crate) log_y:  u8,
}

/// The size a decode at `1 / 2^shift` comes out at: each side divided, rounded up.
#[must_use]
pub fn scaled_size(width: usize, height: usize, shift: u8) -> (usize, usize) {
    let d = 1usize << shift;
    (width.div_ceil(d), height.div_ceil(d))
}

/// log2 of `a / b`, if that's a power of two.
fn log2_ratio(a: usize, b: usize) -> Option<u8> {
    (b != 0 && a % b == 0 && (a / b).is_power_of_two()).then(|| (a / b).trailing_zeros() as u8)
}

/// Each component's block size across and down, as log2, for a decode at `1 / 2^shift` with these
/// sampling factors (`(h, v)` a component), or `None` if some component would need more than eight
/// pixels a block or a ratio that isn't a power of two.
pub(crate) fn block_sizes(
    shift: u8, factors: &[(usize, usize)]
) -> Option<[(u8, u8); MAX_COMPONENTS]> {
    let h_max = factors.iter().map(|f| f.0).max()?;
    let v_max = factors.iter().map(|f| f.1).max()?;
    let base = 3u8.checked_sub(shift)?;
    let mut sizes = [(0, 0); MAX_COMPONENTS];
    for (size, &(h, v)) in sizes.iter_mut().zip(factors) {
        let x = base + log2_ratio(h_max, h)?;
        let y = base + log2_ratio(v_max, v)?;
        if x > 3 || y > 3 {
            return None;
        }
        *size = (x, y);
    }
    Some(sizes)
}

/// Gives each needed component a plane `stride` wide and `rows` high, mid-gray, so what a short
/// file doesn't reach comes out gray as it does at full size.
pub(crate) fn allocate_planes(
    components: &mut [Components], sizes: &[(u8, u8); MAX_COMPONENTS], blocks: &[(usize, usize)]
) -> Result<(), DecodeErrors> {
    let mut stride = 0;
    let mut rows = 0;
    for (&(across, down), size) in blocks.iter().zip(sizes) {
        stride = stride.max(across << size.0);
        rows = rows.max(down << size.1);
    }
    let len = stride
        .checked_mul(rows)
        .ok_or(DecodeErrors::FormatStatic("Scaled planes too large"))?;
    for (c, size) in components.iter_mut().zip(sizes) {
        c.scaled = ScaledPlane {
            plane:  if c.needed { vec![128; len] } else { Vec::new() },
            stride,
            log_x:  size.0,
            log_y:  size.1
        };
    }
    Ok(())
}

/// Writes block (`bx`, `by`) of `coeffs` (dequantized, in natural order; `len` is how far the
/// zig-zag order reached, as the full-size decoder counts it) into the component's plane. Reads
/// `coeffs` without changing it, except where it hands an 8x8 block to the decoder's own IDCT as the
/// full-size decoder does, which keeps its own contract with the caller.
#[allow(clippy::too_many_arguments)]
pub(crate) fn idct_block(
    coeffs: &mut [i32; 64], len: usize, scaled: &mut ScaledPlane, bx: usize, by: usize,
    idct: IDCTPtr, idct_4x4: IDCTPtr, idct_1x1: IDCTPtr
) {
    let (lx, ly) = (scaled.log_x, scaled.log_y);
    let (nx, ny) = (1usize << lx, 1usize << ly);
    let stride = scaled.stride;
    let at = by * ny * stride + bx * nx;
    let Some(out) = scaled.plane.get_mut(at..) else {
        return;
    };
    // The last row of the block must be in the plane.
    if out.len() < (ny - 1) * stride + nx {
        return;
    }
    if nx == 8 && ny == 8 {
        if len <= 1 {
            idct_1x1(coeffs, out, stride);
        } else if len <= 10 {
            idct_4x4(coeffs, out, stride);
        } else {
            idct(coeffs, out, stride);
        }
        return;
    }
    if len <= 1 || (nx == 1 && ny == 1) {
        // As the full-size decoder rounds its DC-only blocks.
        let value = ((coeffs[0].wrapping_add(4).wrapping_add(1024)) >> 3).clamp(0, 255) as i16;
        for row in out.chunks_mut(stride).take(ny) {
            row[..nx].fill(value);
        }
        return;
    }
    let (cos_x, cos_y) = (&COS[lx as usize], &COS[ly as usize]);
    // Across the first `ny` rows of coefficients, to 1/8 of a level, then down. Wrapping, as the
    // decoder's own IDCTs are: a corrupt block comes out wrong, never a panic. A valid one stays
    // under 2^29.
    let mut across = [[0i32; 8]; 8];
    for v in 0..ny {
        for x in 0..nx {
            let mut sum = 0i32;
            for u in 0..nx {
                sum = sum.wrapping_add(coeffs[v * 8 + u].wrapping_mul(cos_x[x][u]));
            }
            across[v][x] = sum.wrapping_add(128) >> 8;
        }
    }
    for (y, row) in out.chunks_mut(stride).take(ny).enumerate() {
        for (x, pixel) in row[..nx].iter_mut().enumerate() {
            let mut sum = 0i32;
            for v in 0..ny {
                sum = sum.wrapping_add(cos_y[y][v].wrapping_mul(across[v][x]));
            }
            // 2^11 twice, less the 2^8 above, and the DCT's 1/4: 2^16, rounded; then the level shift.
            *pixel = ((sum.wrapping_add(1 << 15) >> 16) + 128).clamp(0, 255) as i16;
        }
    }
}

/// The planes converted into `pixels`, `width` by `height`, by the full-size decoder's own colour
/// conversion.
pub(crate) fn convert(
    components: &[Components], color_convert_16: ColorConvert16Ptr, input: ColorSpace,
    output: ColorSpace, pixels: &mut [u8], width: usize, height: usize
) -> Result<(), DecodeErrors> {
    let stride = components.first().map_or(0, |c| c.scaled.stride);
    if stride < width {
        return Err(DecodeErrors::FormatStatic("Scaled planes too narrow"));
    }
    let mut planes: [&[i16]; MAX_COMPONENTS] = [&[]; MAX_COMPONENTS];
    for (plane, c) in planes.iter_mut().zip(components) {
        *plane = &c.scaled.plane;
        if c.needed && c.scaled.plane.len() < stride * height {
            return Err(DecodeErrors::FormatStatic("Scaled planes too short"));
        }
    }
    let row_bytes = width * output.num_components();
    let pixels = pixels
        .get_mut(..row_bytes * height)
        .ok_or(DecodeErrors::FormatStatic("Output too small for scaled decode"))?;
    color_convert(&planes, color_convert_16, input, output, pixels, width, stride)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dct(pixels: &[[f64; 8]; 8]) -> [i32; 64] {
        let mut out = [0; 64];
        for v in 0..8 {
            for u in 0..8 {
                let c = |k: usize| if k == 0 { core::f64::consts::FRAC_1_SQRT_2 } else { 1.0 };
                let mut sum = 0.0;
                for y in 0..8 {
                    for x in 0..8 {
                        sum += (pixels[y][x] - 128.0)
                            * (((2 * x + 1) as f64 * u as f64 * core::f64::consts::PI) / 16.0).cos()
                            * (((2 * y + 1) as f64 * v as f64 * core::f64::consts::PI) / 16.0).cos();
                    }
                }
                out[v * 8 + u] = (0.25 * c(u) * c(v) * sum).round() as i32;
            }
        }
        out
    }

    fn reduced(coeffs: &[i32; 64], log: u8) -> Vec<i16> {
        use crate::idct::scalar::{idct4x4, idct_int, idct_int_1x1};
        let n = 1 << log;
        let mut scaled = ScaledPlane { plane: vec![0; n * n], stride: n, log_x: log, log_y: log };
        idct_block(&mut coeffs.clone(), 64, &mut scaled, 0, 0, idct_int, idct4x4, idct_int_1x1);
        scaled.plane
    }

    #[test]
    fn a_flat_block_stays_flat_at_every_size() {
        let coeffs = dct(&[[200.0; 8]; 8]);
        for log in 0..3 {
            assert!(reduced(&coeffs, log).iter().all(|&p| p == 200), "{log}");
        }
    }

    /// The definition, in floating point: the block's lowest `n` by `n` frequencies, sampled at
    /// the centres of `n` by `n` pixels.
    fn reference(coeffs: &[i32; 64], n: usize) -> Vec<f64> {
        let c = |k: usize| if k == 0 { core::f64::consts::FRAC_1_SQRT_2 } else { 1.0 };
        let basis = |p: usize, k: usize| (((2 * p + 1) * k) as f64 * core::f64::consts::PI / (2 * n) as f64).cos();
        let mut out = Vec::new();
        for y in 0..n {
            for x in 0..n {
                let mut sum = 0.0;
                for v in 0..n {
                    for u in 0..n {
                        sum += c(u) * c(v) * f64::from(coeffs[v * 8 + u]) * basis(x, u) * basis(y, v);
                    }
                }
                out.push(128.0 + sum / 4.0);
            }
        }
        out
    }

    #[test]
    fn reduced_blocks_match_the_definition() {
        let mut rng = 12345u32;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng
        };
        for case in 0..200 {
            let mut pixels = [[0.0; 8]; 8];
            for (y, row) in pixels.iter_mut().enumerate() {
                for (x, p) in row.iter_mut().enumerate() {
                    // Ramps, noise and edges.
                    *p = 60.0 + (next() % 15) as f64 * x as f64 + (next() % 9) as f64 * y as f64;
                    if case % 3 == 0 {
                        *p = (next() % 256) as f64;
                    } else if case % 3 == 1 && x > 3 {
                        *p = 30.0;
                    }
                }
            }
            let coeffs = dct(&pixels);
            for log in 0..3u8 {
                let n = 1usize << log;
                let got = reduced(&coeffs, log);
                for (g, r) in got.iter().zip(reference(&coeffs, n)) {
                    assert!((f64::from(*g) - r.clamp(0.0, 255.0)).abs() <= 1.0, "1/{}: {g} against {r}", 8 / n);
                }
            }
        }
    }

    #[test]
    fn block_sizes_follow_the_sampling() {
        // 4:2:0 at 1/2: luma 4 a block, chroma 8.
        let sizes = block_sizes(1, &[(2, 2), (1, 1), (1, 1)]).unwrap();
        assert_eq!(&sizes[..3], &[(2, 2), (3, 3), (3, 3)]);
        // 4:2:2 at 1/4: luma 2 by 2, chroma 4 across and 2 down.
        let sizes = block_sizes(2, &[(2, 1), (1, 1), (1, 1)]).unwrap();
        assert_eq!(&sizes[..3], &[(1, 1), (2, 1), (2, 1)]);
        // 4:1:1 at 1/2 would need 16 pixels a chroma block.
        assert!(block_sizes(1, &[(4, 1), (1, 1), (1, 1)]).is_none());
        assert!(block_sizes(2, &[(4, 1), (1, 1), (1, 1)]).is_some());
        // A factor of 3 isn't a power of two.
        assert!(block_sizes(3, &[(3, 1), (1, 1), (1, 1)]).is_none());
    }
}
