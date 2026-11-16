//! The hash the JavaScript side checks a file it read synchronously against, in a browser: SHA-256 of
//! the SHA-256 digests of the file's eight lanes, each lane `lane_len` bytes (the last ones shorter, or
//! empty). Plain SHA-256 is one block after another, and on 900 KB that took 3.3 ms before a first page
//! could draw; eight lanes are hashed side by side in SIMD, about twice as fast. It is as hard to forge
//! as SHA-256 itself: a different file has a different lane, and that a different digest.
//!
//! Its name keeps it in the text part (`MUST_STAY` in scripts/split-wasm.mjs): a part's check can't be in a part.

use hayro::hayro_syntax::sha256_parts::{H0, sha256_finish};

/// Lanes hashed side by side: two groups of four, one per 32-bit SIMD lane.
pub const LANES: usize = 8;

/// The length of each lane but the last ones: whole blocks, as few as cover the file in eight.
pub fn lane_len(len: usize) -> usize {
    len.div_ceil(LANES).div_ceil(64) * 64
}

/// SHA-256 over the digests of the eight lanes, in order.
pub fn sha256_lanes(data: &[u8]) -> [u8; 32] {
    let len = lane_len(data.len());
    let lanes: [&[u8]; LANES] =
        std::array::from_fn(|i| &data[(i * len).min(data.len())..((i + 1) * len).min(data.len())]);
    // The blocks every lane has, hashed side by side; each lane's own rest after them.
    let (states, done) = simd::sha256_states(&lanes);
    let mut digests = [0_u8; 32 * LANES];
    for (i, lane) in lanes.iter().enumerate() {
        digests[32 * i..32 * (i + 1)].copy_from_slice(&sha256_finish(states[i], &lane[64 * done..], lane.len()));
    }
    sha256_finish(H0, &digests, digests.len())
}

#[cfg(target_arch = "wasm32")]
mod simd {
    use super::{H0, LANES};
    use hayro::hayro_syntax::sha256_parts::K;
    use core::arch::wasm32::*;

    #[inline(always)]
    fn rotr(x: v128, n: u32) -> v128 {
        v128_or(u32x4_shr(x, n), i32x4_shl(x, 32 - n))
    }

    /// Four lanes' block `k` as sixteen big-endian words, word `i` of each lane side by side, then the
    /// rest of the schedule.
    #[inline(always)]
    fn sha256_schedule(lanes: &[&[u8]], k: usize) -> [v128; 64] {
        let swap = i8x16(3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12);
        let mut w = [u32x4_splat(0); 64];
        for q in 0..4 {
            let row = |lane: usize| {
                let at = 64 * k + 16 * q;
                // SAFETY: every lane holds at least `k + 1` whole blocks.
                let bytes = unsafe { v128_load(lanes[lane][at..at + 16].as_ptr().cast::<v128>()) };
                i8x16_swizzle(bytes, swap)
            };
            let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
            let t0 = i32x4_shuffle::<0, 4, 1, 5>(r0, r1);
            let t1 = i32x4_shuffle::<2, 6, 3, 7>(r0, r1);
            let t2 = i32x4_shuffle::<0, 4, 1, 5>(r2, r3);
            let t3 = i32x4_shuffle::<2, 6, 3, 7>(r2, r3);
            w[4 * q] = i64x2_shuffle::<0, 2>(t0, t2);
            w[4 * q + 1] = i64x2_shuffle::<1, 3>(t0, t2);
            w[4 * q + 2] = i64x2_shuffle::<0, 2>(t1, t3);
            w[4 * q + 3] = i64x2_shuffle::<1, 3>(t1, t3);
        }
        for i in 16..64 {
            let s0 = v128_xor(v128_xor(rotr(w[i - 15], 7), rotr(w[i - 15], 18)), u32x4_shr(w[i - 15], 3));
            let s1 = v128_xor(v128_xor(rotr(w[i - 2], 17), rotr(w[i - 2], 19)), u32x4_shr(w[i - 2], 10));
            w[i] = i32x4_add(i32x4_add(w[i - 16], s0), i32x4_add(w[i - 7], s1));
        }
        w
    }

    /// Block `k` of all eight lanes. The two groups' rounds interleave, each independent of the other.
    /// Not inlined: one call per block lets the engine's optimizing tier take over midway.
    #[inline(never)]
    fn sha256_compress8(h: &mut [[v128; 8]; 2], lanes: &[&[u8]; LANES], k: usize) {
        let w0 = sha256_schedule(&lanes[..4], k);
        let w1 = sha256_schedule(&lanes[4..], k);
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h[0];
        let [mut a2, mut b2, mut c2, mut d2, mut e2, mut f2, mut g2, mut hh2] = h[1];
        for i in 0..64 {
            let k = u32x4_splat(K[i]);
            let t1 = i32x4_add(
                i32x4_add(hh, v128_xor(v128_xor(rotr(e, 6), rotr(e, 11)), rotr(e, 25))),
                i32x4_add(v128_bitselect(f, g, e), i32x4_add(k, w0[i])),
            );
            let t2 = i32x4_add(
                v128_xor(v128_xor(rotr(a, 2), rotr(a, 13)), rotr(a, 22)),
                v128_or(v128_and(a, b), v128_and(c, v128_or(a, b))),
            );
            let u1 = i32x4_add(
                i32x4_add(hh2, v128_xor(v128_xor(rotr(e2, 6), rotr(e2, 11)), rotr(e2, 25))),
                i32x4_add(v128_bitselect(f2, g2, e2), i32x4_add(k, w1[i])),
            );
            let u2 = i32x4_add(
                v128_xor(v128_xor(rotr(a2, 2), rotr(a2, 13)), rotr(a2, 22)),
                v128_or(v128_and(a2, b2), v128_and(c2, v128_or(a2, b2))),
            );
            hh = g;
            g = f;
            f = e;
            e = i32x4_add(d, t1);
            d = c;
            c = b;
            b = a;
            a = i32x4_add(t1, t2);
            hh2 = g2;
            g2 = f2;
            f2 = e2;
            e2 = i32x4_add(d2, u1);
            d2 = c2;
            c2 = b2;
            b2 = a2;
            a2 = i32x4_add(u1, u2);
        }
        for (x, y) in h[0].iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = i32x4_add(*x, y);
        }
        for (x, y) in h[1].iter_mut().zip([a2, b2, c2, d2, e2, f2, g2, hh2]) {
            *x = i32x4_add(*x, y);
        }
    }

    /// Each lane's state after the blocks every lane has, and how many that is.
    pub fn sha256_states(lanes: &[&[u8]; LANES]) -> ([[u32; 8]; LANES], usize) {
        let common = lanes.iter().map(|lane| lane.len() / 64).min().unwrap_or(0);
        let mut h = [H0.map(u32x4_splat_word); 2];
        for k in 0..common {
            sha256_compress8(&mut h, lanes, k);
        }
        let states = std::array::from_fn(|lane| {
            let group = &h[lane / 4];
            std::array::from_fn(|word| {
                let v = group[word];
                match lane % 4 {
                    0 => u32x4_extract_lane::<0>(v),
                    1 => u32x4_extract_lane::<1>(v),
                    2 => u32x4_extract_lane::<2>(v),
                    _ => u32x4_extract_lane::<3>(v),
                }
            })
        });
        (states, common)
    }

    fn u32x4_splat_word(word: u32) -> v128 {
        u32x4_splat(word)
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod simd {
    use super::{H0, LANES};

    /// Without SIMD, no blocks side by side: each lane is hashed whole on its own.
    pub fn sha256_states(_lanes: &[&[u8]; LANES]) -> ([[u32; 8]; LANES], usize) {
        ([H0; LANES], 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The definition, from plain SHA-256 and nothing of this file's.
    fn reference(data: &[u8]) -> [u8; 32] {
        let len = lane_len(data.len());
        let mut digests = Vec::new();
        for i in 0..LANES {
            let lane = &data[(i * len).min(data.len())..((i + 1) * len).min(data.len())];
            digests.extend_from_slice(&hayro::hayro_syntax::sha256(lane));
        }
        hayro::hayro_syntax::sha256(&digests)
    }

    #[test]
    fn eight_lanes_of_sha256_at_every_boundary() {
        let data: Vec<u8> = (0..70_000_u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
        for len in [0, 1, 55, 56, 63, 64, 65, 511, 512, 513, 1000, 4096, 4097, 64 * 8 * 3 + 7, 70_000] {
            assert_eq!(sha256_lanes(&data[..len]), reference(&data[..len]), "{len} bytes");
        }
    }

    #[test]
    fn a_known_answer() {
        // Eight empty lanes: SHA-256 of eight copies of SHA-256("").
        let empty: Vec<u8> = (0..LANES).flat_map(|_| hayro::hayro_syntax::sha256(b"")).collect();
        assert_eq!(sha256_lanes(b""), hayro::hayro_syntax::sha256(&empty));
    }
}
