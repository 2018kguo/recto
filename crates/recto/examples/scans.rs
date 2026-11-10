//! Writes the scanned pages `bench/scans.mjs` renders: a Letter page scanned at 300 dpi as a
//! baseline, a progressive and a gray JPEG, and for the time each stage takes, the same pixels
//! uncompressed at full size, at 1/2, 1/4 and 1/8, and at each width's device size.
//! `cargo run --release -p recto --example scans -- out/dir`
#[path = "../tests/support/scans.rs"]
mod scans;

use scans::{full_page, jpeg, scan_pixels, shrink, Jpeg, PdfWriter, LETTER, SCAN};
use std::{env, fs, path::Path};

/// `pixels` resampled to `nw` by `nh`, nearest.
fn resample(pixels: &[u8], w: usize, h: usize, channels: usize, nw: usize, nh: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(nw * nh * channels);
    for y in 0..nh {
        let sy = y * h / nh;
        for x in 0..nw {
            let sx = x * w / nw;
            out.extend_from_slice(&pixels[(sy * w + sx) * channels..][..channels]);
        }
    }
    out
}

fn main() {
    let dir = env::args().nth(1).expect("usage: scans <out dir>");
    let dir = Path::new(&dir);
    fs::create_dir_all(dir).unwrap();
    let write = |name: &str, bytes: Vec<u8>| {
        println!("{name}: {} bytes", bytes.len());
        fs::write(dir.join(name), bytes).unwrap();
    };
    let (w, h) = SCAN;
    let rgb = scan_pixels(w, h, 3, 7);
    let gray = scan_pixels(w, h, 1, 7);
    let jpg = |pixels: &[u8], kind, progressive| jpeg(pixels, w, h, kind, progressive, 85);
    let dct = |data: Vec<u8>, cs: &'static str| move |pdf: &mut PdfWriter| pdf.image(w, h, cs, "/Filter /DCTDecode", "", &data);
    write("scan-baseline.pdf", full_page(dct(jpg(&rgb, Jpeg::Color420, false), "/DeviceRGB")));
    write("scan-progressive.pdf", full_page(dct(jpg(&rgb, Jpeg::Color420, true), "/DeviceRGB")));
    write("scan-gray.pdf", full_page(dct(jpg(&gray, Jpeg::Gray, false), "/DeviceGray")));

    // The stages: raw pixels skip the decode, and raw pixels at the device size skip the scaling too.
    let raw = |pixels: Vec<u8>, iw: usize, ih: usize| {
        full_page(move |pdf: &mut PdfWriter| pdf.image(iw, ih, "/DeviceRGB", "", "", &pixels))
    };
    for f in [1, 2, 4, 8] {
        let (pixels, iw, ih) = shrink(&rgb, w, h, 3, f);
        write(&format!("raw-{f}.pdf"), raw(pixels, iw, ih));
    }
    for width in [1600, 1024, 400] {
        let height = (LETTER.1 * f64::from(width) / LETTER.0).ceil() as usize;
        let pixels = resample(&rgb, w, h, 3, width as usize, height);
        write(&format!("raw-device-{width}.pdf"), raw(pixels, width as usize, height));
    }

    // One image on every page: a full-page letterhead scan on 6 pages, and a logo on 12.
    let mut pdf = PdfWriter::default();
    let im = pdf.image(w, h, "/DeviceRGB", "/Filter /DCTDecode", "", &jpg(&rgb, Jpeg::Color420, false));
    let page = (format!("q {} 0 0 {} 0 0 cm /Im0 Do Q", LETTER.0, LETTER.1), vec![im]);
    write("letterhead-6-pages.pdf", pdf.pages(LETTER, &vec![page; 6]));

    let (lw, lh) = (900, 300);
    let logo = resample(&rgb, w, h, 3, lw, lh);
    let mut pdf = PdfWriter::default();
    let im = pdf.image(lw, lh, "/DeviceRGB", "/Filter /DCTDecode", "", &jpeg(&logo, lw, lh, Jpeg::Color420, false, 85));
    let page = ("q 180 0 0 60 40 712 cm /Im0 Do Q q 180 0 0 60 392 20 cm /Im0 Do Q".to_string(), vec![im]);
    write("logo-12-pages.pdf", pdf.pages(LETTER, &vec![page; 12]));

    // A logo with a soft mask, and a stencil mask, each on 3 pages.
    let mut pdf = PdfWriter::default();
    let alpha: Vec<u8> = (0..lw * lh).map(|i| ((i % lw) * 255 / lw) as u8).collect();
    let mask = pdf.image(lw, lh, "/DeviceGray", "", "", &alpha);
    let im = pdf.image(lw, lh, "/DeviceRGB", "/Filter /DCTDecode", &format!("/SMask {mask} 0 R"), &jpeg(&logo, lw, lh, Jpeg::Color420, false, 85));
    let bits: Vec<u8> = (0..lw.div_ceil(8) * lh).map(|i| if (i / lw.div_ceil(8)) % 7 < 3 { 0x0F } else { 0xF0 }).collect();
    let stencil = pdf.stream(&format!("/Type /XObject /Subtype /Image /Width {lw} /Height {lh} /ImageMask true /BitsPerComponent 1"), &bits);
    let page = ("q 180 0 0 60 40 712 cm /Im0 Do Q q 0 0 1 rg 180 0 0 60 392 20 cm /Im1 Do Q".to_string(), vec![im, stencil]);
    write("masked-3-pages.pdf", pdf.pages(LETTER, &vec![page; 3]));
}
