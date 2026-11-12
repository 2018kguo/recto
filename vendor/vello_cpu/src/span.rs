// Copyright 2026 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Spans for delimiting horizontal regions.

use vello_common::tile::Tile;

/// A horizontal span in pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(hidden)]
pub struct Span {
    /// The horizontal start position in pixels.
    x: u16,
    /// The horizontal span width in pixels.
    width: u16,
}

impl Span {
    /// Creates a span from pixel coordinates.
    pub fn new(x: u16, width: u16) -> Self {
        Self { x, width }
    }

    /// Expands this span to the tiles covering it. Empty spans remain empty.
    ///
    /// Panics if the aligned end cannot be represented in pixel coordinates.
    pub fn tile_aligned(self) -> TileAlignedSpan {
        let start = self.tile_x();
        let count = if self.width == 0 {
            0
        } else {
            self.tile_end() - start
        };

        TileAlignedSpan::from_tiles(start, count)
    }

    /// Returns the horizontal start position in tile coordinates.
    pub fn tile_x(self) -> u16 {
        self.x / Tile::WIDTH
    }

    /// Returns the exclusive horizontal end position in tile coordinates.
    pub fn tile_end(self) -> u16 {
        self.pixel_end().div_ceil(Tile::WIDTH)
    }

    /// Extends this span to include another span.
    pub fn extend(&mut self, other: Self) {
        let x = self.x.min(other.x);
        let end = self.pixel_end().max(other.pixel_end());
        *self = Self::new(x, end.saturating_sub(x));
    }

    /// Returns the intersection of this span with another span.
    pub fn intersect(self, other: Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let end = self.pixel_end().min(other.pixel_end());
        (x < end).then(|| Self::new(x, end - x))
    }

    /// Returns the horizontal start position in pixels.
    pub fn pixel_x(self) -> u16 {
        self.x
    }

    /// Returns the horizontal span width in pixels.
    pub fn pixel_width(self) -> u16 {
        self.width
    }

    /// Returns the exclusive horizontal end position in pixels.
    pub fn pixel_end(self) -> u16 {
        self.pixel_x().saturating_add(self.pixel_width())
    }
}

/// A horizontal pixel span aligned to tile coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(hidden)]
pub struct TileAlignedSpan(Span);

impl TileAlignedSpan {
    /// Creates a tile-aligned span from a tile start and tile count.
    pub fn from_tiles(start: u16, count: u16) -> Self {
        let x = start.checked_mul(Tile::WIDTH).unwrap();
        let width = count.checked_mul(Tile::WIDTH).unwrap();
        x.checked_add(width).unwrap();

        Self(Span::new(x, width))
    }

    /// Returns the underlying pixel span.
    pub fn as_span(self) -> Span {
        self.0
    }

    /// Returns the horizontal start position in pixels.
    pub fn pixel_x(self) -> u16 {
        self.0.pixel_x()
    }

    /// Returns the horizontal width in pixels.
    pub fn pixel_width(self) -> u16 {
        self.0.pixel_width()
    }

    /// Returns the exclusive horizontal end in pixels.
    pub fn pixel_end(self) -> u16 {
        self.0.pixel_end()
    }

    /// Returns the horizontal start in tile coordinates.
    pub fn tile_x(self) -> u16 {
        self.pixel_x() / Tile::WIDTH
    }

    /// Returns the exclusive horizontal end in tile coordinates.
    pub fn tile_end(self) -> u16 {
        self.pixel_end() / Tile::WIDTH
    }

    /// Extends this span to cover another tile-aligned span.
    pub fn extend(&mut self, other: Self) {
        self.0.extend(other.0);
    }

    /// Intersects two tile-aligned spans.
    pub fn intersect(self, other: Self) -> Option<Self> {
        self.0.intersect(other.0).map(Self)
    }
}

impl TryFrom<Span> for TileAlignedSpan {
    type Error = &'static str;

    fn try_from(span: Span) -> Result<Self, Self::Error> {
        if !span.x.is_multiple_of(Tile::WIDTH) || !span.width.is_multiple_of(Tile::WIDTH) {
            return Err("span is not tile-aligned");
        }

        if span.x.checked_add(span.width).is_none() {
            return Err("tile span end overflow");
        }

        Ok(Self::from_tiles(
            span.x / Tile::WIDTH,
            span.width / Tile::WIDTH,
        ))
    }
}
