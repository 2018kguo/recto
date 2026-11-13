//! The fonts a page's text uses, as their dictionaries describe them, and the font programs they embed.
//!
//! Nothing here runs while reading text: `Document::fonts` interprets the page as `text` does, keeping a
//! glyph of each font, then reads each font's dictionary, which it finds by walking the page's resources.

use hayro::hayro_interpret::CacheKey;
use hayro::hayro_interpret::hayro_cmap::BfString;
use hayro::hayro_syntax::object::dict::keys::{
    BASE_ENCODING, BASE_FONT, DESCENDANT_FONTS, ENCODING, FLAGS, FONT, FONT_DESC, FONT_FILE, FONT_FILE2,
    FONT_FILE3, FONT_WEIGHT, ITALIC_ANGLE, NAME, PATTERN, RESOURCES, SUBTYPE, TO_UNICODE, XOBJECT,
};
use hayro::hayro_syntax::object::{Array, Dict, Name, ObjectIdentifier, Stream};

use crate::device::FontGlyph;

/// A font program's id: the object number and generation of its stream, the same on every page and in
/// every instance that opens the file. Written `"12 0"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ProgramId {
    pub object: u32,
    pub generation: i32,
}

impl std::fmt::Display for ProgramId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.object, self.generation)
    }
}

impl std::str::FromStr for ProgramId {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        let (object, generation) = s.trim().split_once(' ').ok_or(())?;
        Ok(Self {
            object: object.parse().map_err(|_| ())?,
            generation: generation.trim().parse().map_err(|_| ())?,
        })
    }
}

/// Which key of the font descriptor holds a program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgramFile {
    /// `/FontFile`: a Type 1 program.
    FontFile,
    /// `/FontFile2`: a TrueType program.
    FontFile2,
    /// `/FontFile3`: what its `/Subtype` says (`Type1C`, `CIDFontType0C`, `OpenType`).
    FontFile3,
}

impl ProgramFile {
    pub fn key(self) -> &'static str {
        match self {
            Self::FontFile => "FontFile",
            Self::FontFile2 => "FontFile2",
            Self::FontFile3 => "FontFile3",
        }
    }
}

/// An embedded font program, by reference: `Document::font_program` reads its bytes.
#[derive(Clone, Debug, PartialEq)]
pub struct FontProgram {
    pub id: ProgramId,
    pub file: ProgramFile,
    /// The stream's `/Subtype`, as `FontFile3` has: `Type1C`, `CIDFontType0C`, `OpenType`.
    pub subtype: Option<String>,
}

/// What one of a font's codes maps to.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeMapping {
    pub code: u32,
    /// The glyph id in the embedded program; `None` where the font embeds none (a Type 3 font, or a
    /// font drawn with a substitute), or the code maps to `.notdef`.
    pub glyph: Option<u32>,
    /// The Unicode text the code reads as (`ToUnicode`, else the encoding's glyph names); empty for none.
    pub unicode: String,
}

/// A font a page's text uses, entry `i` for `TextPage::fonts[i]` (what a char's `font` indexes).
#[derive(Clone, Debug, PartialEq)]
pub struct FontInfo {
    /// `BaseFont` without a subset prefix (a Type 3 font's `/Name`), as `TextPage::fonts` has it.
    pub name: String,
    /// `BaseFont` as written, prefix and all; empty if the dictionary has none.
    pub base_font: String,
    /// `BaseFont` starts with a subset tag: six capital letters and a `+`.
    pub subset: bool,
    /// The dictionary's `/Subtype`: `Type1`, `MMType1`, `TrueType`, `Type0` or `Type3`. Empty for the
    /// font the engine reads text in when the content names none it can find.
    pub subtype: String,
    /// A `Type0` font's descendant's `/Subtype`: `CIDFontType0` or `CIDFontType2`.
    pub cid_subtype: Option<String>,
    /// `/Encoding` by name (`WinAnsiEncoding`, `Identity-H`), or a differences dictionary's
    /// `/BaseEncoding`; `None` for none, or an embedded CMap.
    pub encoding: Option<String>,
    /// The font has a program of its own: a descriptor with a font file, or a Type 3 font's glyph procedures.
    pub embedded: bool,
    /// What the program is: `"type1"` (`FontFile`), `"truetype"` (`FontFile2`), `"cff"` (`FontFile3`
    /// `Type1C`), `"cid-cff"` (`CIDFontType0C`), `"opentype"` (`OpenType`), `"type3"`; `None` when not
    /// embedded, or a `FontFile3` of another subtype.
    pub kind: Option<&'static str>,
    /// The embedded program, `None` for a Type 3 font or one that embeds none.
    pub program: Option<FontProgram>,
    /// The descriptor's `/Flags`, `/ItalicAngle` and `/FontWeight`, where it states them.
    pub flags: Option<u32>,
    pub italic_angle: Option<f32>,
    pub weight: Option<u32>,
    /// From the descriptor (italic flag or a slanted `/ItalicAngle`; `ForceBold` or a weight of 600 or
    /// more), else from the name (`Italic`, `Oblique`; `Bold`, `Black`, `Heavy`).
    pub italic: bool,
    pub bold: bool,
    /// The dictionary has a `/ToUnicode` CMap.
    pub to_unicode: bool,
    /// Each code that maps to something, in code order. A simple font's 256 codes; a `Type0` font's
    /// two-byte codes that read as Unicode.
    pub codes: Vec<CodeMapping>,
}

/// The descriptor flags this reads.
const ITALIC: u32 = 1 << 6;
const FORCE_BOLD: u32 = 1 << 18;
/// How deep the resource walk goes into forms, patterns and Type 3 fonts.
const MAX_DEPTH: u32 = 32;
/// And how many forms and patterns it opens.
const MAX_FORMS: usize = 4096;

pub(crate) fn describe<'a>(
    page: &hayro::hayro_syntax::page::Page<'a>,
    fonts: &[crate::Font],
    order: &[u32],
    kept: &[(u128, FontGlyph<'a>)],
) -> Vec<FontInfo> {
    let wanted: Vec<u128> = order.iter().filter_map(|&d| kept.get(d as usize)).map(|(k, _)| *k).collect();
    let mut dicts = Vec::new();
    let resources = page.resources();
    let mut walk = Walk { wanted: &wanted, found: &mut dicts, seen: Vec::new() };
    walk.fonts(&resources.fonts, 0);
    walk.forms(&resources.x_objects, 0);
    walk.forms(&resources.patterns, 0);
    fonts
        .iter()
        .zip(order)
        .map(|(font, &d)| {
            let kept = kept.get(d as usize);
            let dict = kept.and_then(|(key, _)| dicts.iter().find(|(k, _)| k == key)).map(|(_, d)| d);
            describe_one(font, dict, kept.map(|(_, g)| g))
        })
        .collect()
}

/// Finds font dictionaries by key in a page's resources and the resources of what it draws.
struct Walk<'s, 'w> {
    wanted: &'s [u128],
    // Vecs, not maps: a page has a few fonts, and a map of these types would be code of its own.
    found: &'s mut Vec<(u128, Dict<'w>)>,
    seen: Vec<ObjectIdentifier>,
}

impl<'w> Walk<'_, 'w> {
    fn done(&self) -> bool {
        self.found.len() >= self.wanted.len()
    }

    fn fonts(&mut self, fonts: &Dict<'w>, depth: u32) {
        for name in fonts.keys() {
            if self.done() {
                return;
            }
            let Some(font) = fonts.get::<Dict<'_>>(name.as_ref()) else { continue };
            let key = font.cache_key();
            if self.wanted.contains(&key) && !self.found.iter().any(|(k, _)| *k == key) {
                self.found.push((key, font.clone()));
            }
            // A Type 3 font's procedures draw with resources of their own, which may name it again.
            if font.get::<Name<'_>>(SUBTYPE).is_some_and(|s| s.as_str() == "Type3") {
                if let Some(id) = font.obj_id() {
                    if self.seen.contains(&id) {
                        continue;
                    }
                    self.seen.push(id);
                }
                self.resources(&font, depth + 1);
            }
        }
    }

    /// The forms (or tiling patterns) a dictionary names, and theirs.
    fn forms(&mut self, named: &Dict<'w>, depth: u32) {
        for name in named.keys() {
            if self.done() {
                return;
            }
            let Some(stream) = named.get::<Stream<'_>>(name.as_ref()) else { continue };
            let id = stream.obj_id();
            if self.seen.contains(&id) {
                continue;
            }
            self.seen.push(id);
            let dict = stream.dict();
            if dict.get::<Name<'_>>(SUBTYPE).is_some_and(|s| s.as_str() == "Image") {
                continue;
            }
            self.resources(dict, depth + 1);
        }
    }

    fn resources(&mut self, owner: &Dict<'w>, depth: u32) {
        if depth > MAX_DEPTH || self.seen.len() > MAX_FORMS {
            return;
        }
        let Some(resources) = owner.get::<Dict<'_>>(RESOURCES) else { return };
        for (key, nested) in [(FONT, 0), (XOBJECT, 1), (PATTERN, 1)] {
            if let Some(d) = resources.get::<Dict<'_>>(key) {
                if nested == 0 { self.fonts(&d, depth) } else { self.forms(&d, depth) }
            }
        }
    }
}

fn name_of(dict: &Dict<'_>, key: &[u8]) -> Option<String> {
    dict.get::<Name<'_>>(key).map(|n| n.as_str().to_string())
}

/// `ABCDEF+`: six capitals and a plus.
fn has_subset_tag(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() > 7 && b[6] == b'+' && b[..6].iter().all(u8::is_ascii_uppercase)
}

fn describe_one(font: &crate::Font, dict: Option<&Dict<'_>>, glyph: Option<&FontGlyph<'_>>) -> FontInfo {
    let base_font = dict.and_then(|d| name_of(d, BASE_FONT).or_else(|| name_of(d, NAME))).unwrap_or_default();
    let subtype = dict.and_then(|d| name_of(d, SUBTYPE)).unwrap_or_default();
    let descendant = dict
        .and_then(|d| d.get::<Array<'_>>(DESCENDANT_FONTS))
        .and_then(|a| a.iter::<Dict<'_>>().next());
    let descriptor = dict
        .and_then(|d| d.get::<Dict<'_>>(FONT_DESC))
        .or_else(|| descendant.as_ref().and_then(|d| d.get::<Dict<'_>>(FONT_DESC)));
    let type3 = subtype == "Type3";
    let program = descriptor.as_ref().and_then(|d| {
        [(FONT_FILE, ProgramFile::FontFile), (FONT_FILE2, ProgramFile::FontFile2), (FONT_FILE3, ProgramFile::FontFile3)]
            .into_iter()
            .find_map(|(key, file)| {
                let stream = d.get::<Stream<'_>>(key)?;
                let id = stream.obj_id();
                Some(FontProgram {
                    id: ProgramId { object: id.obj_number, generation: id.gen_number },
                    file,
                    subtype: name_of(stream.dict(), SUBTYPE),
                })
            })
    });
    let kind = if type3 {
        Some("type3")
    } else {
        program.as_ref().and_then(|p| match (p.file, p.subtype.as_deref()) {
            (ProgramFile::FontFile, _) => Some("type1"),
            (ProgramFile::FontFile2, _) => Some("truetype"),
            (ProgramFile::FontFile3, Some("Type1C")) => Some("cff"),
            (ProgramFile::FontFile3, Some("CIDFontType0C")) => Some("cid-cff"),
            (ProgramFile::FontFile3, Some("OpenType")) => Some("opentype"),
            (ProgramFile::FontFile3, _) => None,
        })
    };
    let flags = descriptor.as_ref().and_then(|d| d.get::<u32>(FLAGS));
    let italic_angle = descriptor.as_ref().and_then(|d| d.get::<f32>(ITALIC_ANGLE));
    let weight = descriptor.as_ref().and_then(|d| d.get::<f32>(FONT_WEIGHT)).map(|w| w as u32);
    let lower = font.name.to_ascii_lowercase();
    let italic = flags.is_some_and(|f| f & ITALIC != 0)
        || italic_angle.is_some_and(|a| a != 0.0)
        || lower.contains("italic")
        || lower.contains("oblique");
    let bold = flags.is_some_and(|f| f & FORCE_BOLD != 0)
        || weight.is_some_and(|w| w >= 600)
        || ["bold", "black", "heavy"].iter().any(|w| lower.contains(w));
    let encoding = dict.and_then(|d| {
        name_of(d, ENCODING).or_else(|| d.get::<Dict<'_>>(ENCODING).and_then(|e| name_of(&e, BASE_ENCODING)))
    });
    let codes = glyph.map_or_else(Vec::new, |g| codes(g, subtype == "Type0", program.is_some()));
    FontInfo {
        name: font.name.clone(),
        subset: has_subset_tag(&base_font),
        base_font,
        cid_subtype: descendant.as_ref().and_then(|d| name_of(d, SUBTYPE)),
        embedded: font.embedded,
        kind,
        program,
        flags,
        italic_angle,
        weight,
        italic,
        bold,
        to_unicode: dict.is_some_and(|d| d.contains_key(TO_UNICODE)),
        encoding,
        subtype,
        codes,
    }
}

fn unicode_text(u: Option<BfString>) -> String {
    match u {
        Some(BfString::Char(c)) => c.to_string(),
        Some(BfString::String(s)) => s,
        None => String::new(),
    }
}

/// What a font's codes map to: a simple font's 256, a composite font's two-byte codes that have Unicode.
fn codes(glyph: &FontGlyph<'_>, composite: bool, embedded: bool) -> Vec<CodeMapping> {
    let mut out = Vec::new();
    match glyph {
        FontGlyph::Type3(g) => {
            for code in 0..=255 {
                let unicode = unicode_text(g.code_unicode(code));
                if !unicode.is_empty() {
                    out.push(CodeMapping { code, glyph: None, unicode });
                }
            }
        }
        FontGlyph::Outline(g) if composite => {
            for code in 0..=0xffff {
                let unicode = unicode_text(g.code_unicode(code));
                if !unicode.is_empty() {
                    let glyph = Some(g.code_mapping(code).0.to_u32()).filter(|&gid| embedded && gid != 0);
                    out.push(CodeMapping { code, glyph, unicode });
                }
            }
        }
        FontGlyph::Outline(g) => {
            for code in 0..=255 {
                let (gid, unicode) = g.code_mapping(code);
                let unicode = unicode_text(unicode);
                let glyph = (embedded && gid.to_u32() != 0).then(|| gid.to_u32());
                if !unicode.is_empty() || glyph.is_some() {
                    out.push(CodeMapping { code, glyph, unicode });
                }
            }
        }
    }
    out
}

/// The stream `id` names, decoded: what its filters give, nothing re-encoded.
pub(crate) fn program_bytes(xref: &hayro::hayro_syntax::xref::XRef, id: ProgramId) -> Option<Vec<u8>> {
    let stream = xref.get::<Stream<'_>>(ObjectIdentifier::new(id.object, id.generation))?;
    stream.decoded_data().ok().map(|data| data.into_owned())
}
