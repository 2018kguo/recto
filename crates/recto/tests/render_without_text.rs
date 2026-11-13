//! A page drawn without its text (`RenderOptions { text: false }`) is, pixel for pixel, the same page
//! with its text taken out of the content: every other thing on it draws as usual. Each page here is
//! also drawn with its text, which must differ, so a test that passes draws something to leave out.

use recto::{Bitmap, Document, Region, RenderOptions};

const NO_TEXT: RenderOptions = RenderOptions { text: false };

/// A PDF from `objects` (object 1 is the catalog), with a correct xref.
fn pdf(objects: &[Vec<u8>]) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for o in offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
    );
    out
}

fn stream(dict: &str, data: &str) -> Vec<u8> {
    let mut s = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
    s.extend_from_slice(data.as_bytes());
    s.extend_from_slice(b"\nendstream");
    s
}

/// A 200 x 200 page of `content`, with Helvetica as /F1, a Type 3 font as /T3, a 2 x 2 image as
/// /Im, and `form` as the form /Fm; `annotation` is an appearance stream for an annotation over the
/// page, if given.
fn page(content: &str, form: &str, annotation: Option<&str>) -> Document {
    let annots = if annotation.is_some() { "/Annots [10 0 R]" } else { "" };
    let page = format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R {annots} \
         /Resources << /Font << /F1 5 0 R /T3 6 0 R >> /XObject << /Im 7 0 R /Fm 8 0 R >> >> >>"
    );
    let objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        page.into_bytes(),
        stream("", content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        // One glyph, a filled square that draws in the colour it's shown with.
        b"<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] \
           /CharProcs << /sq 9 0 R >> /Encoding << /Type /Encoding /Differences [65 /sq] >> \
           /FirstChar 65 /LastChar 65 /Widths [1000] >>"
            .to_vec(),
        stream(
            "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 \
             /Filter /ASCIIHexDecode",
            "FF0000 00FF00 0000FF FFFF00>",
        ),
        stream("/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >>", form),
        stream("", "1000 0 d0 0 0 1000 1000 re f"),
        format!(
            "<< /Type /Annot /Subtype /Stamp /Rect [0 0 200 200] /AP << /N 11 0 R >> >>"
        )
        .into_bytes(),
        stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >>",
            annotation.unwrap_or(""),
        ),
    ];
    Document::open(pdf(&objects), "").unwrap()
}

fn draw(doc: &Document, region: Option<Region>, options: RenderOptions) -> Bitmap {
    doc.render_with(0, 200.0, 200.0, region, options).unwrap()
}

/// `with_text`, drawn without its text, is `without`; drawn with it, it's not.
fn check(with_text: &Document, without: &Document, region: Option<Region>) {
    let reference = draw(without, region, RenderOptions::default());
    let no_text = draw(with_text, region, NO_TEXT);
    assert_eq!((no_text.width, no_text.height), (reference.width, reference.height));
    let differ = no_text.rgba.iter().zip(&reference.rgba).filter(|(a, b)| a != b).count();
    assert_eq!(differ, 0, "drawn without text, the page differs from the one with no text in {differ} channels");
    assert!(!no_text.truncated);
    assert_ne!(draw(with_text, region, RenderOptions::default()).rgba, reference.rgba, "the text draws nothing");
}

fn pixel(b: &Bitmap, x: usize, y: usize) -> [u8; 3] {
    let i = (y * b.width as usize + x) * 4;
    [b.rgba[i], b.rgba[i + 1], b.rgba[i + 2]]
}

/// A table cell's fill under its text, by every operator that shows text.
const CELL: &str = "0.8 0.9 1 rg 20 100 160 60 re f";
const CELL_TEXT: &str = "BT 0 0 0 rg /F1 24 Tf 30 135 Td (Cell) Tj 30 TL [(te) -200 (xt)] TJ (more) ' 1 2 (last) \" ET";

#[test]
fn a_cell_keeps_its_fill_and_loses_its_text() {
    let with_text = page(&format!("{CELL} {CELL_TEXT}"), "", None);
    check(&with_text, &page(CELL, "", None), None);
    // Where "Cell" is drawn, a glyph's stem is black with text and the fill without.
    let (full, bare) = (draw(&with_text, None, RenderOptions::default()), draw(&with_text, None, NO_TEXT));
    let inked: Vec<(usize, usize)> =
        (100..160).flat_map(|y| (20..180).map(move |x| (x, 200 - y))).filter(|&(x, y)| pixel(&full, x, y) == [0, 0, 0]).collect();
    assert!(inked.len() > 50, "only {} pixels of the glyphs are black", inked.len());
    assert!(inked.iter().all(|&(x, y)| pixel(&bare, x, y) == [204, 230, 255]));
}

#[test]
fn a_region_draws_without_text_too() {
    let region = Some(Region { x: 25.0, y: 40.0, width: 90.0, height: 40.0 });
    check(&page(&format!("{CELL} {CELL_TEXT}"), "", None), &page(CELL, "", None), region);
}

#[test]
fn a_form_over_an_image_keeps_its_paths() {
    let image = "q 200 0 0 200 0 0 cm /Im Do Q /Fm Do";
    let fill = "1 1 1 rg 40 40 120 40 re f";
    let with_text = page(image, &format!("{fill} BT 0 0 1 rg /F1 30 Tf 45 50 Td (Form) Tj ET"), None);
    check(&with_text, &page(image, fill, None), None);
}

#[test]
fn type3_glyphs_are_text() {
    let fill = "0.5 g 10 10 50 50 re f";
    check(&page(&format!("{fill} BT 1 0 0 rg /T3 40 Tf 80 80 Td (AAA) Tj ET"), "", None), &page(fill, "", None), None);
}

#[test]
fn stroked_text_is_left_out() {
    let fill = "0 1 0 rg 0 0 200 30 re f";
    let text = "BT /F1 40 Tf 2 w 1 0 0 RG 0 0 1 rg 1 Tr 10 120 Td (Stroke) Tj 2 Tr 0 -60 Td (Both) Tj ET";
    check(&page(&format!("{fill} {text}"), "", None), &page(fill, "", None), None);
}

#[test]
fn invisible_text_is_drawn_as_before() {
    let fill = "0 0 1 rg 30 30 100 100 re f";
    let doc = page(&format!("{fill} BT 3 Tr /F1 40 Tf 30 60 Td (Hidden) Tj ET"), "", None);
    let reference = draw(&page(fill, "", None), None, RenderOptions::default());
    assert_eq!(draw(&doc, None, NO_TEXT).rgba, reference.rgba);
    assert_eq!(draw(&doc, None, RenderOptions::default()).rgba, reference.rgba);
}

#[test]
fn clipping_text_adds_no_clip() {
    // With text, the blue fill shows through the glyphs alone; without, the whole page is blue.
    let fill = "0 0 1 rg 0 0 200 200 re f";
    let doc = page(&format!("q BT 7 Tr /F1 80 Tf 10 60 Td (Clip) Tj ET {fill} Q 1 0 0 rg 0 0 20 20 re f"), "", None);
    let without = page(&format!("q {fill} Q 1 0 0 rg 0 0 20 20 re f"), "", None);
    check(&doc, &without, None);
    // Fill and stroke with a clip (4 to 6) leave out the glyphs and their clip alike.
    for mode in 4..=6 {
        let doc = page(&format!("q BT {mode} Tr /F1 80 Tf 10 60 Td (Clip) Tj ET {fill} Q"), "", None);
        check(&doc, &page(&format!("q {fill} Q"), "", None), None);
    }
}

#[test]
fn an_annotation_keeps_its_appearance_but_its_text() {
    let fill = "1 0.5 0 rg 50 50 100 100 re f";
    let with_text = page("", "", Some(&format!("{fill} BT 0 g /F1 30 Tf 55 90 Td (Stamp) Tj ET")));
    check(&with_text, &page("", "", Some(fill)), None);
}

#[test]
fn a_task_draws_without_text() {
    let with_text = std::rc::Rc::new(page(&format!("{CELL} {CELL_TEXT}"), "", None));
    let mut task = recto::RenderTask::with_options(with_text, 0, 200.0, 200.0, None, NO_TEXT).unwrap();
    while !task.step(&|| true) {}
    let reference = draw(&page(CELL, "", None), None, RenderOptions::default());
    assert_eq!(task.finish().rgba, reference.rgba);
}
