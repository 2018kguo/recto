mod image;
mod mask;

pub(crate) use image::{DecodedImage, decode_image};
pub(crate) use mask::{DecodedMask, decode_mask};

use crate::InterpreterWarning;
use crate::color::ColorSpace;
use crate::function::interpolate;
use crate::x_object::image::{ImageKind, ImageXObject};
use hayro_syntax::bit_reader::BitReader;
use hayro_syntax::object::Array;
use hayro_syntax::object::dict::keys::*;
use hayro_syntax::object::stream::{FilterResult, ImageColorSpace, ImageDecodeParams};
use smallvec::SmallVec;
use std::iter;

struct DecodeContext<'a> {
    decoded: FilterResult<'a>,
    width: u32,
    height: u32,
    scale_factors: (f32, f32),
    color_space: ColorSpace,
    bits_per_component: u8,
    decode_arr: SmallVec<[(f32, f32); 4]>,
}

fn decode_context<'a>(
    obj: &ImageXObject<'a>,
    target_dimension: Option<(u32, u32)>,
) -> Option<DecodeContext<'a>> {
    let dict = obj.stream.dict();
    let dict_bpc = dict
        .get::<u8>(BPC)
        .or_else(|| dict.get::<u8>(BITS_PER_COMPONENT));
    let color_space = obj.color_space.clone();
    let is_indexed = obj.color_space.as_ref().is_some_and(|cs| cs.is_indexed());

    let decode_params = ImageDecodeParams {
        is_indexed,
        bpc: dict_bpc,
        num_components: color_space.as_ref().map(|c| c.num_components()),
        target_dimension,
        width: obj.width(),
        height: obj.height(),
    };

    let mut decoded = obj
        .stream
        .decoded_image(&decode_params)
        .map_err(|_| (obj.warning_sink)(InterpreterWarning::ImageDecodeFailure))
        .ok()?;

    // recto: samples of a byte each, as a filter other than DCT or JPX leaves them, averaged in
    // 2x2, 4x4 or 8x8 blocks when the image is drawn at under half of that, as a JPEG is decoded
    // smaller (`dct_scale_shift`, here for twice the target); what's left to convert and resize is
    // a quarter to a 64th. Twice: the resize after a box at the target's own size filters as the
    // box does, sharper than the resize alone, which shows on hairlines. The callers pass no target
    // where pixels can't be averaged (an index, a colour key, a `/Matte`), and a `/Decode` maps
    // each sample linearly, so it commutes with the average.
    if decoded.image_data.is_none()
        && dict_bpc == Some(8)
        && let Some(components) = color_space.as_ref().map(|c| usize::from(c.num_components()))
        && let shift = hayro_syntax::dct_scale_shift(
            obj.width(),
            obj.height(),
            target_dimension.map(|(w, h)| (w.saturating_mul(2), h.saturating_mul(2))),
        )
        && shift > 0
        && let Some(reduced) = box_reduce(&decoded.data, obj.width(), obj.height(), components, shift)
    {
        decoded.image_data = Some(hayro_syntax::object::stream::ImageData {
            alpha: None,
            color_space: None,
            bits_per_component: 8,
            width: obj.width().div_ceil(1 << shift),
            height: obj.height().div_ceil(1 << shift),
        });
        decoded.data = reduced.into();
    }

    let (mut scale_x, mut scale_y) = (1.0, 1.0);

    let (width, height) = decoded
        .image_data
        .as_ref()
        .map(|d| {
            scale_x = obj.width() as f32 / d.width as f32;
            scale_y = obj.height() as f32 / d.height as f32;

            (d.width, d.height)
        })
        .unwrap_or((obj.width(), obj.height()));

    let color_space = color_space
        .or_else(|| {
            decoded
                .image_data
                .as_ref()
                .map(|i| i.color_space)
                .and_then(|c| {
                    c.and_then(|c| match c {
                        ImageColorSpace::Gray => Some(ColorSpace::device_gray()),
                        ImageColorSpace::Rgb => Some(ColorSpace::device_rgb()),
                        ImageColorSpace::Cmyk => Some(ColorSpace::device_cmyk()),
                        ImageColorSpace::Unknown(_) => None,
                    })
                })
        })
        .unwrap_or(ColorSpace::device_gray());

    let fallback_bpc = if obj.kind == ImageKind::StencilMask {
        1
    } else {
        8
    };

    let bits_per_component = decoded
        .image_data
        .as_ref()
        .map(|i| i.bits_per_component)
        .or(dict_bpc)
        .unwrap_or(fallback_bpc);

    // recto: an image is unpacked to a byte a component, and padded to its height: that too is
    // limited, so a few bytes of data can't declare a gigabyte of pixels.
    let unpacked = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(usize::from(color_space.num_components()).max(1));
    if !hayro_syntax::fits_decoded(unpacked) {
        return None;
    }

    let decode_arr = dict
        .get::<Array<'_>>(D)
        .or_else(|| dict.get::<Array<'_>>(DECODE))
        .map(|a| a.iter::<(f32, f32)>().collect::<SmallVec<_>>())
        .unwrap_or(color_space.default_decode_arr(bits_per_component as f32));

    Some(DecodeContext {
        decoded,
        width,
        height,
        scale_factors: (scale_x, scale_y),
        color_space,
        bits_per_component,
        decode_arr,
    })
}

#[must_use]
fn fix_image_length<T: Copy>(
    image: &mut Vec<T>,
    width: u32,
    height: &mut u32,
    filler: T,
    num_components: usize,
) -> Option<()> {
    let row_len = width as usize * num_components;

    if (row_len * *height as usize) <= image.len() {
        // Too much data (or just the right amount), truncate it.
        image.truncate(row_len * *height as usize);
    } else {
        // Too little data, adapt the height and pad.
        *height = image.len().div_ceil(row_len) as u32;

        if !image.len().is_multiple_of(row_len) {
            image.extend(iter::repeat_n(filler, row_len - (image.len() % row_len)));
        }
    }

    if width == 0 || *height == 0 {
        None
    } else {
        Some(())
    }
}

fn decode_u8_samples(
    data: &[u8],
    width: u32,
    height: u32,
    color_space: &ColorSpace,
    bits_per_component: u8,
    decode: &[(f32, f32)],
) -> Option<Vec<u8>> {
    let source_max = 2.0_f32.powi(bits_per_component as i32) - 1.0;
    let num_components = color_space.num_components() as usize;
    let capacity = width as usize * height as usize * num_components;
    let ranges = color_space.component_ranges();
    let indexed_hival = color_space.indexed_hival();

    if num_components == 0 {
        return Some(Vec::new());
    }

    let decode_component = |value: u32, component_index: usize| {
        let (decode_min, decode_max) = *decode.get(component_index)?;
        let decoded = interpolate(value as f32, 0.0, source_max, decode_min, decode_max);

        if let Some(hival) = indexed_hival {
            Some((decoded + 0.5).clamp(0.0, hival as f32) as u8)
        } else {
            let (range_min, range_max) = *ranges.get(component_index)?;
            let normalized = if range_min == range_max {
                0.0
            } else {
                (decoded - range_min) / (range_max - range_min)
            };
            Some((normalized * 255.0 + 0.5) as u8)
        }
    };

    match bits_per_component {
        1 | 2 | 4 | 8 => {
            let num_values = 1_usize << bits_per_component;
            let lut = (0..num_components)
                .flat_map(|component| {
                    (0..num_values).map(move |value| decode_component(value as u32, component))
                })
                .collect::<Option<Vec<_>>>()?;

            Some(if bits_per_component == 8 {
                decode_8bit_samples(data, num_components, &lut)
            } else {
                decode_packed_samples(
                    data,
                    width,
                    height,
                    num_components,
                    bits_per_component,
                    &lut,
                )
            })
        }
        1..16 => {
            let mut buf = Vec::with_capacity(capacity);
            for_each_sample(
                data,
                width,
                height,
                num_components,
                bits_per_component,
                |value, index| {
                    buf.push(decode_component(value, index % num_components)?);
                    Some(())
                },
            )?;

            Some(buf)
        }
        16 => Some(
            data.as_chunks::<2>()
                .0
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    decode_component(
                        u16::from_be_bytes([value[0], value[1]]) as u32,
                        index % num_components,
                    )
                })
                .collect::<Option<Vec<_>>>()?,
        ),
        _ => None,
    }
}

fn decode_8bit_samples(data: &[u8], num_components: usize, lut: &[u8]) -> Vec<u8> {
    if num_components == 1 {
        return data.iter().map(|value| lut[*value as usize]).collect();
    }

    let mut buf = Vec::with_capacity(data.len());
    for pixel in data.chunks(num_components) {
        for (component, value) in pixel.iter().enumerate() {
            buf.push(lut[component * 256 + *value as usize]);
        }
    }

    buf
}

fn decode_packed_samples(
    data: &[u8],
    width: u32,
    height: u32,
    num_components: usize,
    bits_per_component: u8,
    lut: &[u8],
) -> Vec<u8> {
    let bpc = bits_per_component as usize;
    let samples_per_byte = 8 / bpc;
    let num_values = 1 << bpc;
    let mask = num_values as u8 - 1;
    let row_samples = width as usize * num_components;
    let row_bytes = (row_samples * bpc).div_ceil(8);
    let row_data = |row: usize| data.get(row * row_bytes..).unwrap_or_default();

    if row_samples == 0 {
        return Vec::new();
    }

    if num_components == 1 {
        let mut expanded = [[0_u8; 8]; 256];
        for (byte, samples) in expanded.iter_mut().enumerate() {
            for (i, sample) in samples.iter_mut().take(samples_per_byte).enumerate() {
                let value = (byte >> (8 - bpc * (i + 1))) as u8 & mask;
                *sample = lut[value as usize];
            }
        }

        let mut buf = vec![0; row_samples * height as usize];
        for (index, out) in buf.chunks_exact_mut(row_samples).enumerate() {
            let row = row_data(index);
            match samples_per_byte {
                8 => expand_row::<8>(row, out, &expanded),
                4 => expand_row::<4>(row, out, &expanded),
                _ => expand_row::<2>(row, out, &expanded),
            }
        }

        return buf;
    }

    let mut buf = Vec::with_capacity(row_samples * height as usize);
    for row in 0..height as usize {
        let row = row_data(row);
        let mut component = 0;
        for sample in 0..row_samples {
            let bit = sample * bpc;
            let byte = row.get(bit / 8).copied().unwrap_or(0);
            let value = (byte >> (8 - bpc - bit % 8)) & mask;
            buf.push(lut[component * num_values + value as usize]);
            component += 1;
            if component == num_components {
                component = 0;
            }
        }
    }

    buf
}

fn expand_row<const N: usize>(row: &[u8], out: &mut [u8], expanded: &[[u8; 8]; 256]) {
    let (chunks, remainder) = out.as_chunks_mut::<N>();
    let available = chunks.len().min(row.len());

    for (chunk, byte) in chunks[..available].iter_mut().zip(row) {
        chunk.copy_from_slice(&expanded[*byte as usize][..N]);
    }
    for chunk in &mut chunks[available..] {
        chunk.copy_from_slice(&expanded[0][..N]);
    }

    if !remainder.is_empty() {
        let byte = row.get(chunks.len()).copied().unwrap_or(0);
        remainder.copy_from_slice(&expanded[byte as usize][..remainder.len()]);
    }
}

fn unpack_samples(
    data: &[u8],
    width: u32,
    height: u32,
    num_components: usize,
    bits_per_component: u8,
) -> Option<Vec<u16>> {
    let capacity = width as usize * height as usize * num_components;

    match bits_per_component {
        1..8 | 9..16 => {
            let mut buf = Vec::with_capacity(capacity);
            for_each_sample(
                data,
                width,
                height,
                num_components,
                bits_per_component,
                |value, _| {
                    buf.push(value as u16);
                    Some(())
                },
            )?;

            Some(buf)
        }
        8 => Some(data.iter().map(|value| *value as u16).collect()),
        16 => Some(
            data.as_chunks::<2>()
                .0
                .iter()
                .map(|value| u16::from_be_bytes([value[0], value[1]]))
                .collect(),
        ),
        _ => None,
    }
}

fn for_each_sample(
    data: &[u8],
    width: u32,
    height: u32,
    num_components: usize,
    bits_per_component: u8,
    mut visit: impl FnMut(u32, usize) -> Option<()>,
) -> Option<()> {
    let mut reader = BitReader::new(data);
    let mut index = 0;

    for _ in 0..height {
        for _ in 0..width {
            for _ in 0..num_components {
                // See `stream_ccit_not_enough_data`, some images seemingly don't have
                // enough data, so we just pad with zeroes in this case.
                visit(reader.read(bits_per_component).unwrap_or(0), index)?;
                index += 1;
            }
        }

        reader.align();
    }

    Some(())
}

/// recto: `data`, `width` by `height` pixels of `components` bytes, averaged in blocks of
/// `1 << shift` pixels a side (fewer at the right and bottom edges), rounded to nearest. None
/// where the data is short of the image, which is padded as it's drawn instead.
fn box_reduce(data: &[u8], width: u32, height: u32, components: usize, shift: u8) -> Option<Vec<u8>> {
    let (width, height) = (width as usize, height as usize);
    let row = width.checked_mul(components)?;
    if components == 0 || data.len() < row.checked_mul(height)? {
        return None;
    }
    let block = 1usize << shift;
    let out_width = width.div_ceil(block);
    let mut out = Vec::with_capacity(out_width * components * height.div_ceil(block));
    // Each band's columns summed first, at most 8 x 255 a sample, then each block's columns.
    let mut columns = vec![0u16; row];
    for band in data[..row * height].chunks(row * block) {
        columns.fill(0);
        for line in band.chunks_exact(row) {
            for (sum, &value) in columns.iter_mut().zip(line) {
                *sum += u16::from(value);
            }
        }
        let rows = band.len() / row;
        for (x, pixels) in columns.chunks(block * components).enumerate() {
            let count = (rows * block.min(width - x * block)) as u32;
            for c in 0..components {
                let sum: u32 = pixels[c..].iter().step_by(components).map(|&v| u32::from(v)).sum();
                out.push(((sum + count / 2) / count) as u8);
            }
        }
    }
    Some(out)
}
