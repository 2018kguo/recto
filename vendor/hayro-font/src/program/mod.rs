use crate::FontData;
use crate::GlyphId;
use crate::{HintingCache, UNITS_PER_EM};
use kurbo::{Affine, BezPath};
use siphasher::sip128::{Hasher128, SipHasher13};
use skrifa::font::Kind;
use skrifa::raw::model::attribute::Style;
use skrifa::raw::model::charmap::Encoding;
use skrifa::raw::ps::cff::CffFontRef;
use skrifa::raw::{FontRef, TableProvider};
use skrifa::{
    DrawMemory, Font, GlyphSource, GlyphSourceOrder, HintOptions, OutlineSource, RasterTarget,
    ScalerFont, Tag,
};
use std::fmt::{Debug, Formatter};
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::Arc;

mod pen;

use pen::OutlinePath;

#[derive(Clone)]
pub(crate) struct FontProgram(Arc<Inner>);

impl FontProgram {
    pub(crate) fn new(data: FontData, index: u32) -> Option<Self> {
        // recto: see `repair_loca`.
        #[cfg(feature = "outlines")]
        let data = repair_loca(data.as_ref().as_ref())
            .map(|repaired| -> FontData { Arc::new(repaired) })
            .unwrap_or(data);
        let mut font = Font::new(data.clone(), index)?;

        // OpenType fonts embedded in PDFs sometimes only contain the tables needed for their
        // CFF outlines and lack `maxp`, which skrifa needs to know the number of glyphs.
        if matches!(font.kind(), Kind::Sfnt(..))
            && font.num_glyphs() == 0
            && let Some(cff) = cff_table_font(&data, index)
        {
            font = cff;
        }

        // Reject fonts with invalid post table version, fixes pdf.js issue 9462. Not sure
        // if there is a better fix, for some reason skrifa accepts the font which is
        // completely invalid.
        if matches!(font.kind(), Kind::Sfnt(..))
            && font.tables().post().is_ok_and(|p| {
                !matches!(
                    p.version().to_major_minor(),
                    (1, 0) | (2, 0) | (2, 5) | (3, 0)
                )
            })
        {
            return None;
        }

        #[cfg(feature = "outlines")]
        let scaler = ScalerFont::unhinted(font.clone(), Some(UNITS_PER_EM));

        Some(Self(Arc::new(Inner {
            hash: content_hash(data.as_ref().as_ref(), index),
            data,
            font,
            #[cfg(feature = "outlines")]
            scaler,
        })))
    }

    pub(crate) fn kind(&self) -> ProgramKind {
        match self.font().kind() {
            Kind::Sfnt(..) => ProgramKind::Sfnt,
            Kind::Cff(..) => ProgramKind::Cff,
            Kind::Type1(_) => ProgramKind::Type1,
        }
    }

    pub(crate) fn content_hash(&self) -> u128 {
        self.0.hash
    }

    pub(crate) fn data(&self) -> &FontData {
        &self.0.data
    }

    pub(crate) fn has_cff_outlines(&self) -> bool {
        self.cff().is_some()
    }

    pub(crate) fn is_cid_keyed(&self) -> bool {
        self.font().is_cid_keyed()
    }

    pub(crate) fn glyph_by_name(&self, name: &str) -> Option<GlyphId> {
        self.font().glyph_by_name(name).map(GlyphId::from_skrifa)
    }

    pub(crate) fn glyph_by_cid(&self, cid: u32) -> Option<GlyphId> {
        self.font().glyph_by_cid(cid).map(GlyphId::from_skrifa)
    }

    pub(crate) fn builtin_encoding_glyph(&self, code: u8) -> Option<GlyphId> {
        let font = self.font();
        let glyph = match font.kind() {
            Kind::Type1(t) => t.encoding()?.map(code),
            Kind::Cff(cff, _) => cff.encoding()?.map(code),
            Kind::Sfnt(..) => self.cff()?.encoding()?.map(code),
        };

        glyph.map(GlyphId::from_skrifa)
    }

    pub(crate) fn builtin_encoding_glyph_name(&self, code: u8) -> Option<&str> {
        let font = self.font();
        match font.kind() {
            Kind::Type1(t) => t.encoding()?.glyph_name(code),
            Kind::Cff(cff, _) => cff_glyph_name(&cff, cff.encoding()?.map(code)?),
            Kind::Sfnt(..) => {
                let cff = self.cff()?;
                cff_glyph_name(cff, cff.encoding()?.map(code)?)
            }
        }
    }

    pub(crate) fn cmap_glyph(&self, c: char) -> Option<GlyphId> {
        self.font()
            .charmap()
            .map_unicode(c)
            .map(GlyphId::from_skrifa)
    }

    pub(crate) fn cmap_subtables(&self) -> Vec<CmapSubtable<'_>> {
        let charmap = self.font().charmap();
        charmap
            .encodings()
            .filter_map(|encoding| {
                let (platform, encoding_id) = encoding.sfnt_ids()?;
                Some(CmapSubtable {
                    font: self.font(),
                    platform: match platform {
                        0 => CmapPlatform::Unicode,
                        1 => CmapPlatform::Macintosh,
                        3 => CmapPlatform::Windows,
                        _ => CmapPlatform::Other,
                    },
                    encoding_id,
                    encoding,
                })
            })
            .collect()
    }

    pub(crate) fn advance_width(&self, glyph: GlyphId) -> Option<f32> {
        let font = self.sfnt()?;
        let advance = font.glyph_metrics().h_advance(glyph.to_skrifa());

        Some(advance * UNITS_PER_EM / f32::from(font.units_per_em()))
    }

    pub(crate) fn weight(&self) -> Option<u32> {
        let weight = self.sfnt()?.default_attributes().weight.value().round() as u32;
        (weight > 0).then_some(weight)
    }

    pub(crate) fn is_italic(&self) -> bool {
        self.sfnt()
            .is_some_and(|font| font.default_attributes().style != Style::Normal)
    }

    pub(crate) fn is_monospace(&self) -> bool {
        self.sfnt()
            .and_then(|font| font.style_metrics().is_fixed_pitch)
            .unwrap_or(false)
    }

    pub(crate) fn hinted_outline(
        &self,
        glyph: GlyphId,
        ppem: f32,
        cache: &HintingCache,
    ) -> Option<BezPath> {
        // Fonts that need their instructions are drawn by `outline`, which runs them.
        if self.font().is_hint_reliant() {
            return None;
        }

        let scaler = cache.get_or_insert_with(self.content_hash(), ppem, || {
            // Like FreeType's light hinting, TrueType outlines use the auto-hinter.
            let options = match self.font().outline_glyphs().source() {
                Some(OutlineSource::Glyf) => HintOptions::auto(),
                _ => HintOptions::interpreter(),
            };
            let scaler = ScalerFont::hinted(
                self.font().clone(),
                ppem,
                options.with_target(RasterTarget::Light),
            );

            scaler.is_hinted().then_some(scaler)
        })?;

        let mut path = OutlinePath::new();
        scaler
            .outline(glyph.to_skrifa())?
            .draw(DrawMemory::Scratch, &mut path)
            .ok()?;

        Some(Affine::scale(f64::from(UNITS_PER_EM / ppem)) * path.take())
    }

    #[cfg(feature = "outlines")]
    pub(crate) fn outline(&self, glyph: GlyphId) -> BezPath {
        let mut path = OutlinePath::new();
        if let Some(outline) = self.0.scaler.outline(glyph.to_skrifa()) {
            let _ = outline.draw(DrawMemory::Scratch, &mut path);
        }

        path.take()
    }

    // recto: the text-only wasm draws nothing, and this keeps skrifa's scalers out of it.
    #[cfg(not(feature = "outlines"))]
    pub(crate) fn outline(&self, _glyph: GlyphId) -> BezPath {
        BezPath::new()
    }

    fn font(&self) -> &Font {
        &self.0.font
    }

    fn cff(&self) -> Option<&CffFontRef<'_>> {
        self.font()
            .outline_glyphs_with(GlyphSourceOrder::new(&[GlyphSource::Cff]))
            .cff_font()
    }

    fn sfnt(&self) -> Option<&Font> {
        matches!(self.font().kind(), Kind::Sfnt(..)).then(|| self.font())
    }
}

impl Debug for FontProgram {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "FontProgram {{ .. }}")
    }
}

impl PartialEq for FontProgram {
    fn eq(&self, other: &Self) -> bool {
        self.content_hash() == other.content_hash()
    }
}

impl Eq for FontProgram {}

impl Hash for FontProgram {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u128(self.content_hash());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProgramKind {
    Sfnt,
    Cff,
    Type1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CmapPlatform {
    Unicode,
    Macintosh,
    Windows,
    Other,
}

pub(crate) struct CmapSubtable<'a> {
    font: &'a Font,
    platform: CmapPlatform,
    encoding_id: u16,
    encoding: Encoding,
}

impl CmapSubtable<'_> {
    pub(crate) fn platform(&self) -> CmapPlatform {
        self.platform
    }

    pub(crate) fn encoding_id(&self) -> u16 {
        self.encoding_id
    }

    pub(crate) fn map(&self, code: u32) -> Option<GlyphId> {
        self.font
            .charmap()
            .map_code(self.encoding, code)
            .map(GlyphId::from_skrifa)
    }
}

struct Inner {
    hash: u128,
    data: FontData,
    font: Font,
    #[cfg(feature = "outlines")]
    scaler: ScalerFont,
}

/// recto: a copy of a TrueType font whose `loca` runs backwards, in order. skrifa reads a glyph from
/// `loca[i]` to `loca[i + 1]` and finds nothing when the second is the lower, so those glyphs would
/// go missing, where FreeType and the others read on to the end of the table. None for a font that's
/// in order, which is nearly all, so what this costs is one pass over `loca`.
#[cfg(feature = "outlines")]
fn repair_loca(font: &[u8]) -> Option<Vec<u8>> {
    let be16 = |at: usize| Some(u16::from_be_bytes(font.get(at..at + 2)?.try_into().ok()?));
    let be32 = |at: usize| Some(u32::from_be_bytes(font.get(at..at + 4)?.try_into().ok()?));
    let mut records = [None; 3];
    for i in 0..be16(4)? as usize {
        let record = 12 + 16 * i;
        let slot = match font.get(record..record + 4)? {
            b"head" => 0,
            b"loca" => 1,
            b"glyf" => 2,
            _ => continue,
        };
        records[slot] = Some((record, be32(record + 8)? as usize, be32(record + 12)? as usize));
    }
    let (head_record, loca_record, glyf_record) = (records[0]?, records[1]?, records[2]?);
    let (_, head, _) = head_record;
    let (_, glyf, glyf_length) = glyf_record;
    // A table's place comes from the file too: all of it has to be there before anything's sized by it.
    font.get(glyf..glyf.checked_add(glyf_length)?)?;
    font.get(loca_record.1..loca_record.1.checked_add(loca_record.2)?)?;
    let head_flag = head.checked_add(50)?;
    let long = be16(head_flag)? != 0;
    let entry_size = if long { 4 } else { 2 };
    let entries = loca_record.2 / entry_size;
    let offset_of = |i: usize| -> Option<usize> {
        let at = loca_record.1 + i * entry_size;
        if long { be32(at).map(|v| v as usize) } else { be16(at).map(|v| v as usize * 2) }
    };
    let mut offsets = Vec::with_capacity(entries);
    let mut in_order = true;
    for i in 0..entries {
        let offset = offset_of(i)?;
        in_order &= offsets.last().is_none_or(|&last| last <= offset);
        offsets.push(offset);
    }
    if in_order || entries < 2 {
        return None;
    }
    let mut sorted = offsets.clone();
    sorted.sort_unstable();
    sorted.dedup();
    let mut glyphs = Vec::new();
    let mut new_loca = Vec::with_capacity(entries * 4);
    for pair in offsets.windows(2) {
        new_loca.extend_from_slice(&u32::try_from(glyphs.len()).ok()?.to_be_bytes());
        let (start, end) = (pair[0], pair[1]);
        if start == end || start >= glyf_length {
            continue;
        }
        let end = if end > start {
            end.min(glyf_length)
        } else {
            // Up to the glyph that follows in the table, not all the way to its end.
            let next = sorted.partition_point(|&offset| offset <= start);
            sorted.get(next).copied().unwrap_or(glyf_length).min(glyf_length)
        };
        // A hostile `loca` could name one long stretch many times over.
        if glyphs.len() + (end - start) > font.len().saturating_mul(16) {
            return None;
        }
        glyphs.extend_from_slice(&font[glyf + start..glyf + end]);
    }
    new_loca.extend_from_slice(&u32::try_from(glyphs.len()).ok()?.to_be_bytes());

    let mut repaired = Vec::with_capacity(font.len() + glyphs.len() + new_loca.len() + 8);
    repaired.extend_from_slice(font);
    repaired.resize(repaired.len().next_multiple_of(4), 0);
    let new_glyf = repaired.len();
    repaired.extend_from_slice(&glyphs);
    repaired.resize(repaired.len().next_multiple_of(4), 0);
    let new_loca_at = repaired.len();
    repaired.extend_from_slice(&new_loca);
    let mut point = |record: usize, offset: usize, length: usize| -> Option<()> {
        repaired.get_mut(record + 8..record + 12)?.copy_from_slice(&u32::try_from(offset).ok()?.to_be_bytes());
        repaired.get_mut(record + 12..record + 16)?.copy_from_slice(&u32::try_from(length).ok()?.to_be_bytes());
        Some(())
    };
    point(glyf_record.0, new_glyf, glyphs.len())?;
    point(loca_record.0, new_loca_at, new_loca.len())?;
    repaired.get_mut(head_flag..head_flag + 2)?.copy_from_slice(&1u16.to_be_bytes());
    Some(repaired)
}

fn cff_table_font(data: &FontData, index: u32) -> Option<Font> {
    let bytes = data.as_ref().as_ref();
    let record = *FontRef::from_index(bytes, index)
        .ok()?
        .table_directory()
        .table_records()
        .iter()
        .find(|record| record.tag() == Tag::new(b"CFF "))?;
    let start = record.offset() as usize;
    let range = start..start.checked_add(record.length() as usize)?;
    bytes.get(range.clone())?;

    let table: FontData = Arc::new(TableData {
        font: data.clone(),
        range,
    });
    Font::new(table, 0)
}

struct TableData {
    font: FontData,
    range: Range<usize>,
}

impl AsRef<[u8]> for TableData {
    fn as_ref(&self) -> &[u8] {
        &self.font.as_ref().as_ref()[self.range.clone()]
    }
}

fn cff_glyph_name<'a>(cff: &CffFontRef<'a>, glyph: skrifa::GlyphId) -> Option<&'a str> {
    if cff.is_cid() {
        return None;
    }

    let sid = cff.charset()?.string_id(glyph)?;
    std::str::from_utf8(cff.string(sid)?).ok()
}

pub(crate) fn content_hash(data: &[u8], index: u32) -> u128 {
    let mut state = SipHasher13::new();
    (data, index).hash(&mut state);
    state.finish128().as_u128()
}
