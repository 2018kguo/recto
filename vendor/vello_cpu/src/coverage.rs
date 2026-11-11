// recto: a coverage mask, one byte a pixel, filled as the strips' own alphas, so a cached glyph is
// a solid fill like any other path rather than an image paint encoded again at every draw. See
// `RenderContext::fill_coverage`.

use alloc::vec::Vec;
use vello_common::strip::Strip;
use vello_common::tile::Tile;

/// A mask placed in the target: `height` bytes a column, column by column, its top-left pixel at
/// (`x`, `y`), drawn only within `[x0, x1) × [y0, y1)`, which lies inside both the mask and the
/// target.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PlacedCoverage<'a> {
    pub(crate) coverage: &'a [u8],
    pub(crate) height: usize,
    pub(crate) x: i64,
    pub(crate) y: i64,
    pub(crate) x0: u16,
    pub(crate) y0: u16,
    pub(crate) x1: u16,
    pub(crate) y1: u16,
}

const _: () = assert!(Tile::HEIGHT == 4, "a strip's columns are 4 rows");

/// One strip a row of tiles, as wide as the drawn part rounded out to whole tiles, its alphas the
/// mask's bytes (0 outside the drawn part), column by column as strips keep them, so each column of
/// the mask is copied 4 bytes at a time; then the sentinel. The same layout `vello_common::rect`
/// gives a rectangle's edge rows.
pub(crate) fn render(placed: PlacedCoverage<'_>, strips: &mut Vec<Strip>, alphas: &mut Vec<u8>) {
    let PlacedCoverage { coverage, height, x, y, x0, y0, x1, y1 } = placed;
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let tile_x0 = x0 / Tile::WIDTH * Tile::WIDTH;
    let columns = usize::from(x1).div_ceil(4) * 4 - usize::from(tile_x0);
    let lead = usize::from(x0 - tile_x0);
    // The drawn part's columns in the mask.
    let first = (i64::from(x0) - x) as usize * height;
    let drawn = &coverage[first..first + usize::from(x1 - x0) * height];
    let mut strip_y = u32::from(y0 / Tile::HEIGHT * Tile::HEIGHT);
    while strip_y < u32::from(y1) {
        let start = alphas.len();
        alphas.resize(start + columns * 4, 0);
        let out = &mut alphas[start + lead * 4..];
        // The strip's rows that are drawn, and where they are in the strip and in the mask.
        let top = strip_y.max(u32::from(y0));
        let bottom = (strip_y + 4).min(u32::from(y1));
        let (at, from) = ((top - strip_y) as usize, (i64::from(top) - y) as usize);
        let rows = (bottom - top) as usize;
        let columns = out.chunks_exact_mut(4).zip(drawn.chunks_exact(height));
        if rows == 4 {
            for (column, mask) in columns {
                column.copy_from_slice(&mask[from..from + 4]);
            }
        } else {
            for (column, mask) in columns {
                column[at..at + rows].copy_from_slice(&mask[from..from + rows]);
            }
        }
        strips.push(Strip::new(tile_x0, strip_y as u16, start as u32, false));
        strip_y += u32::from(Tile::HEIGHT);
    }
    let last_strip_y = (strip_y - u32::from(Tile::HEIGHT)) as u16;
    strips.push(Strip::sentinel(last_strip_y, alphas.len() as u32));
}
