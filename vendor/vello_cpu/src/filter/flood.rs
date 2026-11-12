// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Flood filter implementation.

use super::FilterEffect;
use crate::filter::context::ScratchBuffer;
use vello_common::filter::flood::Flood;
use vello_common::pixmap::Pixmap;

impl FilterEffect for Flood {
    fn execute_lowp(&self, pixmap: &mut Pixmap, _filter_scratch: &mut ScratchBuffer) {
        pixmap.data_mut().fill(self.color.premultiply().to_rgba8());
    }
}
