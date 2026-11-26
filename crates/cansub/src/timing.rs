//! Bitrate → `BitTiming` for the 80 MHz CANsub CAN clock (contract §2.5). `no_std`. C1.
//!
//! `bitrate = 80_000_000 / (brp × (1 + seg1 + seg2))`, sample point = `(1 + seg1) / (1 + seg1 + seg2)`.
//!
//! # Selection rule
//! Derived from the official CANsub.4 bit-timing table (all 290 rows reproduced by the golden test
//! `tests/timing_golden.rs`, and no extra combination on the table's bitrate × sample-point grid):
//!
//! * BRP is **shared** by the nominal and data phase; the smallest BRP that satisfies every
//!   constraint wins (classical [`nominal_timing`]: BRP `1..=512`, FD [`fd_timing`]: `1..=32`).
//! * The sample point must be hit exactly: `|SP_exact − sample_point_permille| ≤ 0.5 ‰`
//!   (so the doc's rounded 812 / 688 / 562 ‰ select 81.25 / 68.75 / 56.25 %).
//! * Nominal: `seg1 1..=256`, `seg2 2..=128`. Data: `seg1 2..=32`, `seg2 2..=16`, total
//!   time quanta `≤ 25`.
//! * `sjw = min(4, seg2)` in both phases.
//! * Bitrate exactness: `round(80 MHz / (brp × tq)) == bitrate` — exact division, or the
//!   integer-rounded value of an exact division, which is the official table's own convention
//!   (666 667, 95 238, 83 333 bit/s). Any other bitrate returns `None`; no approximation.

/// CAN core clock of the CANsub (Hz).
pub const CAN_CLOCK_HZ: u32 = 80_000_000;

/// Default sample point (‰), same as qt-cansub.
pub const DEFAULT_SAMPLE_POINT_PERMILLE: u16 = 800;

/// One phase's bit timing (`timing` / `timing_data` REST objects).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitTiming {
    /// Baud-rate prescaler (shared by nominal and data phase).
    pub brp: u16,
    /// Time segment 1 (propagation + phase segment 1), in time quanta.
    pub seg1: u16,
    /// Time segment 2 (phase segment 2), in time quanta.
    pub seg2: u16,
    /// Synchronisation jump width, in time quanta.
    pub sjw: u16,
}

#[derive(Clone, Copy)]
struct Limits {
    seg1_min: u64,
    seg1_max: u64,
    seg2_max: u64,
    tq_max: u64,
}

const NOMINAL: Limits = Limits {
    seg1_min: 1,
    seg1_max: 256,
    seg2_max: 128,
    tq_max: 1 + 256 + 128,
};
const DATA: Limits = Limits {
    seg1_min: 2,
    seg1_max: 32,
    seg2_max: 16,
    tq_max: 25,
};
const SEG2_MIN: u64 = 2;
const CLASSIC_BRP_MAX: u16 = 512;
const FD_BRP_MAX: u16 = 32;

/// `round(n / d)`, half up; `d > 0`.
const fn div_round(n: u64, d: u64) -> u64 {
    (2 * n + d) / (2 * d)
}

/// Time quanta per bit for `bitrate` at `brp`, if the bitrate is exact (see module docs).
fn tq_per_bit(bitrate: u32, brp: u16) -> Option<u64> {
    let clk = u64::from(CAN_CLOCK_HZ);
    let unit = u64::from(bitrate).checked_mul(u64::from(brp))?;
    if unit == 0 {
        return None;
    }
    let tq = div_round(clk, unit);
    let total = tq.checked_mul(u64::from(brp))?;
    (tq > 0 && div_round(clk, total) == u64::from(bitrate)).then_some(tq)
}

/// Segments for `tq` time quanta at `sp` ‰, or `None` if not exactly reachable within `lim`.
fn segments(tq: u64, sp: u16, brp: u16, lim: Limits) -> Option<BitTiming> {
    if tq > lim.tq_max || sp == 0 || sp >= 1000 {
        return None;
    }
    let target = u64::from(sp) * tq; // 1000 × (1 + seg1) ideally
    let base = target / 1000;
    let sync_seg1 = [base, base + 1]
        .into_iter()
        .find(|&c| (2000 * c).abs_diff(2 * target) <= tq)?;
    let seg1 = sync_seg1.checked_sub(1)?;
    let seg2 = tq.checked_sub(sync_seg1)?;
    if !(lim.seg1_min..=lim.seg1_max).contains(&seg1) || !(SEG2_MIN..=lim.seg2_max).contains(&seg2)
    {
        return None;
    }
    Some(BitTiming {
        brp,
        seg1: u16::try_from(seg1).ok()?,
        seg2: u16::try_from(seg2).ok()?,
        sjw: u16::try_from(seg2.min(4)).ok()?,
    })
}

/// Classical CAN (nominal-only) timing for `bitrate` at `sample_point_permille`.
///
/// Smallest BRP in `1..=512` meeting the module rules; `None` if the bitrate is not exactly
/// reachable from 80 MHz or the sample point cannot be hit exactly.
pub fn nominal_timing(bitrate: u32, sample_point_permille: u16) -> Option<BitTiming> {
    (1..=CLASSIC_BRP_MAX).find_map(|brp| {
        let tq = tq_per_bit(bitrate, brp)?;
        segments(tq, sample_point_permille, brp, NOMINAL)
    })
}

/// CAN-FD timing pair `(nominal, data)` with a shared BRP, exactly as in the official table.
///
/// The same sample point applies to both phases (as in the table). `None` if no BRP in
/// `1..=32` satisfies both phases.
pub fn fd_timing(
    nominal: u32,
    data_bitrate: u32,
    sample_point_permille: u16,
) -> Option<(BitTiming, BitTiming)> {
    (1..=FD_BRP_MAX).find_map(|brp| {
        let ntq = tq_per_bit(nominal, brp)?;
        let dtq = tq_per_bit(data_bitrate, brp)?;
        let d = segments(dtq, sample_point_permille, brp, DATA)?;
        let n = segments(ntq, sample_point_permille, brp, NOMINAL)?;
        Some((n, d))
    })
}

/// CAN-FD data-phase timing (`timing_data`) for `nominal` / `data_bitrate`.
///
/// Equals `fd_timing(..).map(|(_, d)| d)`. Because BRP is shared, the matching nominal timing
/// is the first element of [`fd_timing`], **not** [`nominal_timing`] (which may pick a smaller
/// BRP for classical CAN).
pub fn data_timing(
    nominal: u32,
    data_bitrate: u32,
    sample_point_permille: u16,
) -> Option<BitTiming> {
    fd_timing(nominal, data_bitrate, sample_point_permille).map(|(_, d)| d)
}
