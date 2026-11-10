// Note that these polyfills can be very imprecise, but hopefully good enough
// for the vast majority of cases.

#[inline(always)]
pub(crate) fn powi_f64(x: f64, n: u32) -> f64 {
    {
        x.powi(n as i32)
    }
}
