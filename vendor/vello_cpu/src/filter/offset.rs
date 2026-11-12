// Copyright 2026 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! `feOffset` filter primitive implementation.

use vello_common::filter::offset::Offset;
use vello_common::pixmap::Pixmap;

use super::FilterEffect;
use super::shift::offset_pixels;
use crate::filter::context::ScratchBuffer;

impl FilterEffect for Offset {
    fn execute_lowp(&self, pixmap: &mut Pixmap, _: &mut ScratchBuffer) {
        offset_pixels(pixmap, self.dx, self.dy);
    }
}
