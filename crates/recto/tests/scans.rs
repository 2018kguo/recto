//! JPEGs drawn smaller than their size are decoded at 1/2, 1/4 or 1/8 of it, and an image drawn
//! again at the same size comes from the document's cache. Each test renders with scaled decoding
//! and without (`set_scaled_dct_decode`), on scanned pages made in `support/scans.rs`.
mod support;

use hayro::hayro_syntax::object::Stream;
use hayro::hayro_syntax::object::stream::ImageDecodeParams;
use hayro::hayro_syntax::{Pdf, dct_scale_shift, set_max_decoded_bytes, set_scaled_dct_decode, DEFAULT_MAX_DECODED_BYTES};
use recto::{Bitmap, Document, Region};
use support::scans::{full_page, jpeg, scan_pixels, Jpeg, PdfWriter, LETTER};

/// Letter at 96 dpi: big enough that every width below picks a different scale, small enough to
/// decode quickly in a debug build.
const W: usize = 816;
const H: usize = 1056;

fn render(bytes: &[u8], width: f32, scaled: bool) -> Bitmap {
    set_scaled_dct_decode(scaled);
    let doc = Document::open(bytes.to_vec(), "").unwrap();
    let bitmap = doc.render(0, width, f32::INFINITY).unwrap();
    set_scaled_dct_decode(true);
    bitmap
}

/// How two renders of the same size differ, as `bench/scorecard.mjs` measures it and finer: per
/// pixel, the mean error of 255 per channel, the largest, and the % of pixels a channel more than
/// 48 out; over 4x4 cells averaged first, the mean error and the % of cells a channel more than 16
/// out (the scorecard counts past 32).
#[derive(Debug)]
#[allow(dead_code)]
struct Diff {
    mae: f64,
    max: u8,
    over_48: f64,
    cell_mae: f64,
    cells_16: f64,
}

fn diff(a: &Bitmap, b: &Bitmap) -> Diff {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let (w, h) = (a.width as usize, a.height as usize);
    let (mut sum, mut max, mut over) = (0u64, 0u8, 0usize);
    for (p, q) in a.rgba.chunks(4).zip(b.rgba.chunks(4)) {
        let d = [0, 1, 2].map(|c| p[c].abs_diff(q[c]));
        sum += d.iter().map(|&x| u64::from(x)).sum::<u64>();
        let worst = *d.iter().max().unwrap();
        max = max.max(worst);
        over += usize::from(worst > 48);
    }
    let (mut cell_sum, mut cells_off, mut cells) = (0.0, 0usize, 0usize);
    for row in 0..h / 4 {
        for column in 0..w / 4 {
            let mut totals = [0i32; 3];
            for y in row * 4..row * 4 + 4 {
                for x in column * 4..column * 4 + 4 {
                    for (c, total) in totals.iter_mut().enumerate() {
                        *total += i32::from(a.rgba[(y * w + x) * 4 + c]) - i32::from(b.rgba[(y * w + x) * 4 + c]);
                    }
                }
            }
            let d = totals.map(|t| f64::from(t.abs()) / 16.0);
            cell_sum += d.iter().sum::<f64>();
            cells_off += usize::from(d.iter().any(|&x| x > 16.0));
            cells += 1;
        }
    }
    let pixels = w * h;
    Diff {
        mae: sum as f64 / (pixels * 3) as f64,
        max,
        over_48: over as f64 * 100.0 / pixels as f64,
        cell_mae: cell_sum / (cells.max(1) * 3) as f64,
        cells_16: cells_off as f64 * 100.0 / cells.max(1) as f64,
    }
}

/// The tolerance (see docs/benchmarks.md#scanned-pages). Over 4x4 cells, as the scorecard
/// compares pages: a mean error under 1 of 255 a channel and at most 0.1% of cells more than 16
/// out (the scorecard's "agree" is a mean under 3 and under 1% of cells past 32). Per pixel: at most
/// 0.1% of pixels a channel more than 48 out, and a mean under 5. A scaled decode and the full one
/// scaled down filter differently on the edges of strokes, and these pages are all strokes a pixel
/// or two wide: per pixel that's a few levels on average, on a 100 px thumbnail of one up to 4.7,
/// and over a cell it averages out.
fn assert_close(label: &str, d: &Diff) {
    println!("{label}: {d:?}");
    assert!(d.cell_mae < 1.0 && d.cells_16 <= 0.1 && d.over_48 <= 0.1 && d.mae < 5.0, "{label}: {d:?}");
}

/// The width a page renders at for each decode scale of a `W`-wide image over the whole page.
const WIDTHS: [(f32, u8); 4] = [(500.0, 0), (400.0, 1), (200.0, 2), (100.0, 3)];

/// The decode, through the stream's own decoder: its size for a target.
fn decoded_size(bytes: &[u8], target: Option<(u32, u32)>) -> (u32, u32) {
    let pdf = Pdf::new(bytes.to_vec()).unwrap();
    let page = &pdf.pages()[0];
    let stream = page.resources().x_objects.get::<Stream<'_>>(b"Im0").unwrap();
    let dict = stream.dict();
    let params = ImageDecodeParams {
        width: dict.get::<u32>(b"Width").unwrap(),
        height: dict.get::<u32>(b"Height").unwrap(),
        num_components: None,
        target_dimension: target,
        ..Default::default()
    };
    let image = stream.decoded_image(&params).ok().unwrap().image_data.unwrap();
    (image.width, image.height)
}

fn page_with(kind: Jpeg, progressive: bool, color_space: &str, extra: &str) -> Vec<u8> {
    let channels = match kind {
        Jpeg::Gray => 1,
        Jpeg::Cmyk | Jpeg::Ycck => 4,
        _ => 3,
    };
    let pixels = scan_pixels(W, H, channels, 3);
    let data = jpeg(&pixels, W, H, kind, progressive, 85);
    full_page(|pdf| pdf.image(W, H, color_space, "/Filter /DCTDecode", extra, &data))
}

#[test]
fn the_decode_is_the_largest_reduction_still_at_or_above_the_drawn_size() {
    assert_eq!(dct_scale_shift(2550, 3300, None), 0);
    assert_eq!(dct_scale_shift(2550, 3300, Some((1600, 2071))), 0);
    assert_eq!(dct_scale_shift(2550, 3300, Some((1024, 1326))), 1);
    assert_eq!(dct_scale_shift(2550, 3300, Some((1275, 1650))), 1);
    assert_eq!(dct_scale_shift(2550, 3300, Some((1276, 1650))), 0);
    assert_eq!(dct_scale_shift(2550, 3300, Some((400, 518))), 2);
    assert_eq!(dct_scale_shift(2550, 3300, Some((160, 208))), 3);
    // Squeezed on one axis only: the other axis decides.
    assert_eq!(dct_scale_shift(2550, 3300, Some((100, 3300))), 0);
    // Never past 1/8, however small it's drawn.
    assert_eq!(dct_scale_shift(2550, 3300, Some((1, 1))), 3);

    let bytes = page_with(Jpeg::Color420, false, "/DeviceRGB", "");
    assert_eq!(decoded_size(&bytes, None), (816, 1056));
    assert_eq!(decoded_size(&bytes, Some((409, 528))), (816, 1056));
    assert_eq!(decoded_size(&bytes, Some((400, 518))), (408, 528));
    assert_eq!(decoded_size(&bytes, Some((200, 259))), (204, 264));
    assert_eq!(decoded_size(&bytes, Some((100, 130))), (102, 132));
    set_scaled_dct_decode(false);
    assert_eq!(decoded_size(&bytes, Some((100, 130))), (816, 1056));
    set_scaled_dct_decode(true);
}

#[test]
fn every_kind_of_jpeg_renders_as_its_full_decode_does() {
    for (label, kind, progressive, cs, extra) in [
        ("4:2:0", Jpeg::Color420, false, "/DeviceRGB", ""),
        ("4:2:0 progressive", Jpeg::Color420, true, "/DeviceRGB", ""),
        ("4:4:4", Jpeg::Color444, false, "/DeviceRGB", ""),
        ("4:2:2 progressive", Jpeg::Color422, true, "/DeviceRGB", ""),
        ("gray", Jpeg::Gray, false, "/DeviceGray", ""),
        ("gray progressive", Jpeg::Gray, true, "/DeviceGray", ""),
        // Adobe's CMYK is stored inverted; PDFs undo it with /Decode.
        ("CMYK, Adobe", Jpeg::Cmyk, false, "/DeviceCMYK", "/Decode [1 0 1 0 1 0 1 0]"),
        ("YCCK, Adobe", Jpeg::Ycck, false, "/DeviceCMYK", "/Decode [1 0 1 0 1 0 1 0]"),
        ("gray, /Decode inverted", Jpeg::Gray, false, "/DeviceGray", "/Decode [1 0]"),
    ] {
        let bytes = page_with(kind, progressive, cs, extra);
        for (width, shift) in WIDTHS {
            // Drawn larger than half its size, nothing changes; once is enough to check.
            if shift == 0 && label != "4:2:0" {
                continue;
            }
            let (scaled, full) = (render(&bytes, width, true), render(&bytes, width, false));
            if shift == 0 {
                assert_eq!(scaled.rgba, full.rgba, "{label} at {width}: drawn larger, nothing changes");
            } else {
                assert_close(&format!("{label} at {width} (1/{})", 1 << shift), &diff(&scaled, &full));
            }
        }
    }
}

/// A page with `content` drawing `/Im0`, the scan.
fn page_drawing(content: &str, extra: &str) -> Vec<u8> {
    let pixels = scan_pixels(W, H, 3, 5);
    let data = jpeg(&pixels, W, H, Jpeg::Color420, false, 85);
    let mut pdf = PdfWriter::default();
    let im = pdf.image(W, H, "/DeviceRGB", "/Filter /DCTDecode", extra, &data);
    pdf.pages(LETTER, &[(content.to_string(), vec![im])])
}

#[test]
fn rotated_skewed_and_twice_drawn_images_keep_their_detail() {
    for (label, content) in [
        ("rotated 90°", "q 0 396 -306 0 459 198 cm /Im0 Do Q"),
        ("rotated 30°", "q 265 153 -153 265 300 100 cm /Im0 Do Q"),
        ("skewed", "q 306 0 200 396 50 200 cm /Im0 Do Q"),
        ("twice, large and small", "q 400 0 0 518 0 274 cm /Im0 Do Q q 100 0 0 130 450 20 cm /Im0 Do Q"),
    ] {
        let bytes = page_drawing(content, "");
        for width in [612.0, 300.0] {
            assert_close(&format!("{label} at {width}"), &diff(&render(&bytes, width, true), &render(&bytes, width, false)));
        }
    }
    // Squeezed across only: down, it's drawn at full size, so the decode is too, pixel for pixel.
    let bytes = page_drawing("q 100 0 0 792 0 0 cm /Im0 Do Q", "");
    assert_eq!(render(&bytes, 612.0 * 1.4, true).rgba, render(&bytes, 612.0 * 1.4, false).rgba);
}

#[test]
fn soft_masks_and_colour_keys() {
    // A soft mask, a gradient, as Flate and as a JPEG of its own; and one with /Matte.
    let (w, h) = (W, H);
    let mask: Vec<u8> = (0..w * h).map(|i| ((i % w) * 255 / w) as u8).collect();
    let mask_jpeg = jpeg(&mask, w, h, Jpeg::Gray, false, 90);
    let pixels = scan_pixels(w, h, 3, 9);
    let data = jpeg(&pixels, w, h, Jpeg::Color420, false, 85);
    for (label, smask, matte) in [("flate mask", false, ""), ("jpeg mask", true, ""), ("matte", false, "/Matte [1 1 1]")] {
        let mut pdf = PdfWriter::default();
        let m = if smask {
            pdf.image(w, h, "/DeviceGray", "/Filter /DCTDecode", "", &mask_jpeg)
        } else {
            pdf.image(w, h, "/DeviceGray", "", matte, &mask)
        };
        let im = pdf.image(w, h, "/DeviceRGB", "/Filter /DCTDecode", &format!("/SMask {m} 0 R"), &data);
        let bytes = pdf.pages(LETTER, &[(format!("q {} 0 0 {} 0 0 cm /Im0 Do Q", LETTER.0, LETTER.1), vec![im])]);
        for width in [200.0, 100.0] {
            let (scaled, full) = (render(&bytes, width, true), render(&bytes, width, false));
            if matte.is_empty() {
                assert_close(&format!("{label} at {width}"), &diff(&scaled, &full));
            } else {
                assert_eq!(scaled.rgba, full.rgba, "{label}: undone at full size, as before");
            }
        }
    }
    // A colour key matches exact values: decoded at full size, as before.
    let bytes = page_drawing(&format!("q {} 0 0 {} 0 0 cm /Im0 Do Q", LETTER.0, LETTER.1), "/Mask [240 255 240 255 230 255]");
    assert_eq!(render(&bytes, 100.0, true).rgba, render(&bytes, 100.0, false).rgba);
}

#[test]
fn a_region_decodes_at_the_whole_page_scale_and_tiles_share_the_cache() {
    let bytes = page_with(Jpeg::Color420, false, "/DeviceRGB", "");
    let whole = Document::open(bytes.clone(), "").unwrap().render(0, 400.0, f32::INFINITY).unwrap();
    // The page as four tiles, in one document: the second tile keeps the image, the rest reuse it.
    let doc = Document::open(bytes.clone(), "").unwrap();
    for (i, (x, y)) in [(0.0, 0.0), (306.0, 0.0), (0.0, 396.0), (306.0, 396.0)].into_iter().enumerate() {
        let region = Region { x, y, width: 306.0, height: 396.0 };
        let part = doc.render_region(0, 400.0, f32::INFINITY, Some(region)).unwrap();
        for row in 0..part.height {
            let at = ((part.y + row) * whole.width + part.x) as usize * 4;
            let from = (row * part.width) as usize * 4;
            assert_eq!(
                &part.rgba[from..from + part.width as usize * 4],
                &whole.rgba[at..at + part.width as usize * 4],
                "tile {i}, row {row}: a region is the same pixels as the whole page"
            );
        }
        assert_eq!(doc.image_cache_bytes() > 0, i >= 1, "tile {i}");
    }
    // A thumbnail, at 1/8.
    assert_close("thumbnail at 60", &diff(&render(&bytes, 60.0, true), &render(&bytes, 60.0, false)));
}

#[test]
fn a_huge_declared_jpeg_is_still_cut_however_small_it_is_drawn() {
    // 16 bytes of scan after a header declaring 65,000 by 65,000: 12.7 GB at full size, and still
    // 198 MB at 1/8, under the limit. It's cut on its full size, as before.
    for progressive in [false, true] {
        let mut data = jpeg(&[128u8; 64 * 3], 8, 8, Jpeg::Color444, progressive, 85);
        let sof = data.windows(2).position(|m| m == [0xFF, if progressive { 0xC2 } else { 0xC0 }]).unwrap();
        data[sof + 5..sof + 9].copy_from_slice(&[0xFD, 0xE8, 0xFD, 0xE8]);
        let bytes = full_page(|pdf| pdf.image(65000, 65000, "/DeviceRGB", "/Filter /DCTDecode", "", &data));
        let doc = Document::open(bytes, "").unwrap();
        assert!(doc.render(0, 100.0, f32::INFINITY).unwrap().truncated, "progressive: {progressive}");
    }
}

#[test]
fn an_image_drawn_again_comes_from_the_cache_which_stays_within_its_limit() {
    // Five different images, 2 MB each as drawn, each on two pages, under a decode limit of 32 MiB:
    // the cache keeps at most an eighth of that, 4 MiB.
    set_max_decoded_bytes(32 << 20);
    let (w, h) = (816, 612);
    let mut pdf = PdfWriter::default();
    let mut pages = Vec::new();
    for seed in 0..5 {
        let data = jpeg(&scan_pixels(w, h, 3, seed), w, h, Jpeg::Color420, false, 85);
        let im = pdf.image(w, h, "/DeviceRGB", "/Filter /DCTDecode", "", &data);
        let page = ("q 612 0 0 459 0 0 cm /Im0 Do Q".to_string(), vec![im]);
        pages.push(page.clone());
        pages.push(page);
    }
    let bytes = pdf.pages(LETTER, &pages);
    let cached = Document::open(bytes.clone(), "").unwrap();
    let mut held = Vec::new();
    for page in 0..pages.len() {
        let drawn = cached.render(page, 1224.0, f32::INFINITY).unwrap();
        held.push(cached.image_cache_bytes());
        // The same pixels as a document drawing only this page.
        let fresh = Document::open(bytes.clone(), "").unwrap().render(page, 1224.0, f32::INFINITY).unwrap();
        assert_eq!(drawn.rgba, fresh.rgba, "page {page}");
        assert!(!drawn.truncated);
    }
    set_max_decoded_bytes(DEFAULT_MAX_DECODED_BYTES);
    println!("cache bytes after each page: {held:?}");
    assert_eq!(held[0], 0, "an image seen once isn't kept");
    assert_eq!(held[1], w * h * 4, "seen twice, it is, as RGBA at its own size");
    assert!(held.iter().all(|&b| b <= 4 << 20), "{held:?}");

    // Under a lower limit than it was decoded at, a cached image isn't handed out: the decode runs,
    // and is cut, as it would have been.
    let doc = Document::open(bytes.clone(), "").unwrap();
    doc.render(0, 1224.0, f32::INFINITY).unwrap();
    doc.render(1, 1224.0, f32::INFINITY).unwrap();
    assert!(doc.image_cache_bytes() > 0);
    set_max_decoded_bytes(1 << 20);
    let cut = doc.render(1, 1224.0, f32::INFINITY).unwrap();
    set_max_decoded_bytes(DEFAULT_MAX_DECODED_BYTES);
    assert!(cut.truncated);
}

#[test]
fn the_cache_keeps_at_most_256_images_however_small() {
    // 400 tiny images, each drawn twice at the same size: kept are the last 256, the same bytes each.
    let tiny = |n: usize| {
        let mut pdf = PdfWriter::default();
        let images: Vec<usize> = (0..n).map(|i| pdf.image(2, 2, "/DeviceGray", "", "", &[i as u8; 4])).collect();
        let content: String = (0..n).map(|i| format!("q 4 0 0 4 {} {} cm /Im{i} Do Q ", i % 100 * 6, i / 100 * 6)).collect();
        let doc = Document::open(pdf.pages(LETTER, &[(content.repeat(2), images)]), "").unwrap();
        doc.render(0, 816.0, f32::INFINITY).unwrap();
        doc.image_cache_bytes()
    };
    let one = tiny(1);
    assert!(one > 0);
    assert_eq!(tiny(400), 256 * one);
}

#[test]
fn renders_are_deterministic() {
    let bytes = page_with(Jpeg::Color420, true, "/DeviceRGB", "");
    let doc = Document::open(bytes.clone(), "").unwrap();
    let first = doc.render(0, 200.0, f32::INFINITY).unwrap();
    // Again in the same document (from the cache the third time on) and in another.
    for _ in 0..3 {
        assert_eq!(doc.render(0, 200.0, f32::INFINITY).unwrap().rgba, first.rgba);
    }
    assert_eq!(render(&bytes, 200.0, true).rgba, first.rgba);
}
