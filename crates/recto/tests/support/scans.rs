//! Scanned pages made here, for `tests/scans.rs` and `examples/scans.rs`: paper with noise, lines of
//! glyph-like strokes, a photo, encoded as JPEG by `jpeg-encoder`. Deterministic; nothing
//! third-party.
#![allow(dead_code)]

use jpeg_encoder::{ColorType, Encoder, SamplingFactor};

/// xorshift32: the same numbers every run.
pub struct Random(u32);

impl Random {
    pub fn new(seed: u32) -> Self {
        Self(seed | 1)
    }

    pub fn next(&mut self) -> u32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        s
    }

    pub fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
}

/// A page scanned at `w` by `h`, in gray (`channels` 1), RGB (3) or CMYK (4): off-white paper with
/// grain, ten-point text at 300 dpi as strokes three pixels wide, a stamp in colour and a photo.
pub fn scan_pixels(w: usize, h: usize, channels: usize, seed: u32) -> Vec<u8> {
    let mut rng = Random::new(seed);
    // Gray first, then colour from it.
    let mut ink = vec![0u8; w * h]; // 0 paper .. 255 ink
    let mut photo = vec![None::<u8>; 0];
    let margin = w / 9;
    let line = (h / 66).max(6);
    let glyph_w = (line * 11 / 25).max(3);
    let glyph_h = (line * 3 / 5).max(3);
    let stroke = (line / 16).max(1);
    let mut y = margin;
    while y + line < h - margin {
        let mut x = margin;
        // A paragraph break now and then.
        if rng.below(9) == 0 {
            y += line;
            continue;
        }
        let end = w - margin - rng.below((w / 6) as u32) as usize;
        while x + glyph_w < end {
            let word = 2 + rng.below(8) as usize;
            for _ in 0..word {
                if x + glyph_w >= end {
                    break;
                }
                // A glyph: two or three strokes in its box.
                let tall = rng.below(4) == 0;
                let top = if tall { y } else { y + glyph_h / 3 };
                for _ in 0..2 + rng.below(2) {
                    let vertical = rng.below(2) == 0;
                    let (x0, y0, x1, y1) = if vertical {
                        let sx = x + rng.below((glyph_w - stroke) as u32) as usize;
                        (sx, top, sx + stroke, y + glyph_h)
                    } else {
                        let sy = top + rng.below((y + glyph_h - top - stroke).max(1) as u32) as usize;
                        (x, sy, x + glyph_w, sy + stroke)
                    };
                    for yy in y0..y1.min(h) {
                        for xx in x0..x1.min(w) {
                            ink[yy * w + xx] = 255;
                        }
                    }
                }
                x += glyph_w + glyph_w / 4;
            }
            x += glyph_w;
        }
        y += line;
    }
    // Soften edges as a scanner's optics do: a 3x3 box over the ink.
    let mut soft = ink.clone();
    for yy in 1..h - 1 {
        for xx in 1..w - 1 {
            let mut sum = 0u32;
            for dy in 0..3 {
                for dx in 0..3 {
                    sum += u32::from(ink[(yy + dy - 1) * w + xx + dx - 1]);
                }
            }
            soft[yy * w + xx] = (sum / 9) as u8;
        }
    }
    let ink = soft;
    // A photo in the lower third.
    let (px0, py0, pw, ph) = (margin, h * 2 / 3, w / 3, h / 6);
    photo.resize(w * h, None);
    for yy in py0..(py0 + ph).min(h) {
        for xx in px0..(px0 + pw).min(w) {
            let (u, v) = ((xx - px0) as f32 / pw as f32, (yy - py0) as f32 / ph as f32);
            let value = 128.0 + 90.0 * ((u * 9.0).sin() * (v * 7.0).cos()) - 40.0 * u + 30.0 * v;
            photo[yy * w + xx] = Some(value.clamp(0.0, 255.0) as u8);
        }
    }
    let mut out = Vec::with_capacity(w * h * channels);
    for (i, &k) in ink.iter().enumerate() {
        let grain = rng.below(11) as i32 - 5;
        let paper = 242 + grain;
        let gray = match photo[i] {
            Some(p) => i32::from(p) + grain,
            None => paper - (paper - 28) * i32::from(k) / 255,
        }
        .clamp(0, 255);
        let (xx, yy) = (i % w, i / w);
        // A red stamp, top right.
        let stamp = xx > w * 3 / 4 && yy < h / 8 && yy > h / 20 && (xx + yy) % 23 < 9;
        match channels {
            1 => out.push(gray as u8),
            3 => {
                let (r, g, b) = if stamp {
                    (200, 40 + grain, 50)
                } else if photo[i].is_some() {
                    (gray, (gray * 9 / 10), (gray * 3 / 4 + 30))
                } else {
                    (gray + 3, gray, gray - 8)
                };
                out.extend([r, g, b].map(|c: i32| c.clamp(0, 255) as u8));
            }
            _ => {
                let (c, m, y, k) = if stamp {
                    (20, 200, 180, 10)
                } else {
                    (5, 5, 18, 255 - gray)
                };
                out.extend([c, m, y, k].map(|c: i32| c.clamp(0, 255) as u8));
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Jpeg {
    Gray,
    /// YCbCr, 4:2:0.
    Color420,
    /// YCbCr, 4:4:4.
    Color444,
    /// YCbCr, 4:2:2.
    Color422,
    /// CMYK as stored, with Adobe's marker (transform 0).
    Cmyk,
    /// CMYK as YCCK, with Adobe's marker (transform 2).
    Ycck,
}

/// `pixels` (1 channel for `Gray`, 3 for colour, 4 for CMYK) as a JPEG.
pub fn jpeg(pixels: &[u8], w: usize, h: usize, kind: Jpeg, progressive: bool, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, quality);
    encoder.set_progressive(progressive);
    let color = match kind {
        Jpeg::Gray => ColorType::Luma,
        Jpeg::Color420 | Jpeg::Color444 | Jpeg::Color422 => ColorType::Rgb,
        Jpeg::Cmyk => ColorType::Cmyk,
        Jpeg::Ycck => ColorType::CmykAsYcck,
    };
    encoder.set_sampling_factor(match kind {
        Jpeg::Color420 => SamplingFactor::F_2_2,
        Jpeg::Color422 => SamplingFactor::F_2_1,
        _ => SamplingFactor::F_1_1,
    });
    encoder.encode(pixels, w as u16, h as u16, color).unwrap();
    out
}

/// Objects into a file; object 1 is the catalog, written by `pages`.
pub struct PdfWriter {
    objects: Vec<Vec<u8>>,
}

impl Default for PdfWriter {
    fn default() -> Self {
        Self { objects: vec![Vec::new()] }
    }
}

impl PdfWriter {
    /// Adds an object, returning its number.
    pub fn add(&mut self, body: impl Into<Vec<u8>>) -> usize {
        self.objects.push(body.into());
        self.objects.len()
    }

    /// Reserves a number, for an object written later with `set`.
    pub fn reserve(&mut self) -> usize {
        self.add(Vec::new())
    }

    pub fn set(&mut self, number: usize, body: impl Into<Vec<u8>>) {
        self.objects[number - 1] = body.into();
    }

    pub fn stream(&mut self, dict: &str, data: &[u8]) -> usize {
        let mut body = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\nendstream");
        self.add(body)
    }

    pub fn image(&mut self, w: usize, h: usize, color_space: &str, filter: &str, extra: &str, data: &[u8]) -> usize {
        self.stream(
            &format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace {color_space} /BitsPerComponent 8 {filter} {extra}"),
            data,
        )
    }

    /// Pages of `size` points, each with its content and the image objects it names `/Im0`, `/Im1`...
    pub fn pages(mut self, size: (f64, f64), pages: &[(String, Vec<usize>)]) -> Vec<u8> {
        let tree = self.reserve();
        let mut kids = Vec::new();
        for (content, images) in pages {
            let contents = self.stream("", content.as_bytes());
            let xobjects: String = images.iter().enumerate().map(|(i, n)| format!("/Im{i} {n} 0 R ")).collect();
            kids.push(self.add(format!(
                "<< /Type /Page /Parent {tree} 0 R /MediaBox [0 0 {} {}] /Contents {contents} 0 R /Resources << /XObject << {xobjects}>> >> >>",
                size.0, size.1
            )));
        }
        let kids_list: String = kids.iter().map(|k| format!("{k} 0 R ")).collect();
        self.set(tree, format!("<< /Type /Pages /Kids [{kids_list}] /Count {} >>", kids.len()));
        self.set(1, format!("<< /Type /Catalog /Pages {tree} 0 R >>"));
        self.finish()
    }

    pub fn finish(self) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in self.objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", self.objects.len() + 1).as_bytes());
        for o in offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", self.objects.len() + 1).as_bytes(),
        );
        out
    }
}

/// US Letter, in points.
pub const LETTER: (f64, f64) = (612.0, 792.0);
/// A scan of a Letter page at 300 dpi.
pub const SCAN: (usize, usize) = (2550, 3300);

/// One page, the image drawn over all of it.
pub fn full_page(image: impl FnOnce(&mut PdfWriter) -> usize) -> Vec<u8> {
    let mut pdf = PdfWriter::default();
    let im = image(&mut pdf);
    let content = format!("q {} 0 0 {} 0 0 cm /Im0 Do Q", LETTER.0, LETTER.1);
    pdf.pages(LETTER, &[(content, vec![im])])
}

/// `pixels` (`channels` a pixel) box-averaged to `w / f` by `h / f`, rounded up.
pub fn shrink(pixels: &[u8], w: usize, h: usize, channels: usize, f: usize) -> (Vec<u8>, usize, usize) {
    let (nw, nh) = (w.div_ceil(f), h.div_ceil(f));
    let mut out = vec![0u8; nw * nh * channels];
    for y in 0..nh {
        for x in 0..nw {
            for c in 0..channels {
                let (mut sum, mut n) = (0u32, 0u32);
                for yy in y * f..((y + 1) * f).min(h) {
                    for xx in x * f..((x + 1) * f).min(w) {
                        sum += u32::from(pixels[(yy * w + xx) * channels + c]);
                        n += 1;
                    }
                }
                out[(y * nw + x) * channels + c] = ((sum + n / 2) / n) as u8;
            }
        }
    }
    (out, nw, nh)
}
