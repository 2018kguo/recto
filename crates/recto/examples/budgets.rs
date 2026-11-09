//! How close real files come to each budget: the most any page or tree in the given directories used
//! of each limit, as a ratio, and anything cut short. Decoded bytes are the most one stream or image of a
//! page asked for, its text, objects and a render at 800 px. `cargo run --release -p recto --example budgets -- dir...`
use std::path::PathBuf;
use std::{env, fs};

use hayro::hayro_interpret::PageBudget;

const MAX_PAGES: usize = 300;

#[derive(Default)]
struct Peak(f64, String);
impl Peak {
    fn see(&mut self, used: f64, limit: f64, what: &str) {
        if used / limit > self.0 {
            self.0 = used / limit;
            self.1 = format!("{what}: {used} of {limit}");
        }
    }
}

fn main() {
    let (mut nested, mut points, mut expression, mut kids, mut labels, mut names, mut decoded) = (
        Peak::default(),
        Peak::default(),
        Peak::default(),
        Peak::default(),
        Peak::default(),
        Peak::default(),
        Peak::default(),
    );
    let (mut files, mut pages) = (0, 0);
    let (mut truncated, mut empty, mut lost) = (Vec::new(), 0, Vec::new());
    for dir in env::args().skip(1) {
        let mut paths: Vec<PathBuf> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        paths.sort();
        for path in paths.iter().filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))) {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let bytes = fs::read(path).unwrap();
            let Ok(doc) = recto::Document::open(bytes, "") else { continue };
            files += 1;
            let ((read, limit), label_nodes, name_nodes, lost_all) = doc.tree_use();
            kids.see(read as f64, limit as f64, &name);
            labels.see(label_nodes as f64, 65_536.0, &name);
            names.see(name_nodes as f64, recto::outline::MAX_NAME_NODES as f64, &name);
            if doc.page_count() == 0 {
                empty += 1;
                if lost_all {
                    lost.push(name.clone());
                }
            }
            let cut = doc.structure_truncated();
            if cut.pages || cut.page_labels || cut.outline {
                truncated.push(format!("{name} {cut:?}"));
            }
            for index in 0..doc.page_count().min(MAX_PAGES) {
                pages += 1;
                let mut see = |used: (u32, usize, u32), kind: &str, cut: bool| {
                    let what = format!("{name} p{index} {kind}");
                    nested.see(f64::from(used.0), f64::from(PageBudget::NESTED), &what);
                    points.see(used.1 as f64, PageBudget::ANNOTATION_POINTS as f64, &what);
                    expression.see(f64::from(used.2), f64::from(PageBudget::EXPRESSION_NODES), &what);
                    if cut {
                        truncated.push(what);
                    }
                };
                if let Ok(scan) = doc.scan(index, true, false) {
                    see(scan.budget_used, "objects", scan.text.truncated || scan.objects.truncated);
                }
                if let Ok(scan) = doc.scan(index, false, false) {
                    see(scan.budget_used, "text", scan.text.truncated);
                }
                if let Ok((used, cut)) = doc.render_budget(index, 800.0) {
                    see(used, "render", cut);
                }
                let what = format!("{name} p{index}");
                decoded.see(hayro::hayro_syntax::take_largest_decode() as f64, hayro::hayro_syntax::DEFAULT_MAX_DECODED_BYTES as f64, &what);
            }
        }
    }
    println!("{files} files, {pages} pages, {empty} with no pages, {} of them lost their kids", lost.len());
    for (label, peak) in [("nested", &nested), ("annotation points", &points), ("/VE nodes", &expression), ("page tree kids", &kids), ("label nodes", &labels), ("name nodes", &names), ("decoded bytes", &decoded)] {
        println!("{label:20} {:.6}  {}", peak.0, peak.1);
    }
    println!("truncated: {truncated:#?}");
    println!("lost: {lost:?}");
}
