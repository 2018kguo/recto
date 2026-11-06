// Dumps a page's chars and boxes: cargo run --example glyphs -- file.pdf [page]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let doc = recto::Document::open(std::fs::read(&a[1]).unwrap(), "").unwrap();
    let page = doc
        .text(a.get(2).map_or(0, |p| p.parse().unwrap()))
        .unwrap();
    for c in &page.chars {
        println!("{:?} {:?} {}", c.text, c.bbox, c.flags);
    }
}
