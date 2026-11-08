//! Cross-platform monotonic microsecond clocks and hardware-priority timestamp resolution.

use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_EPOCH: OnceLock<Instant> = OnceLock::new();

/// Monotonic microsecond stopwatch anchored to an [`Instant`] epoch.
///
/// Portable across Linux, Windows, macOS, and WASI without OS-specific syscalls.
#[derive(Clone, Copy, Debug)]
pub struct MonotonicClock {
    epoch: Instant,
}

impl MonotonicClock {
    /// Captures the current monotonic [`Instant`] as the zero-microsecond origin.
    #[inline]
    pub fn new() -> Self {
        Self {
            epoch: Instant::now(),
        }
    }

    /// Returns elapsed microseconds since this clock was created (saturating at `u64::MAX`).
    #[inline]
    pub fn elapsed_us(&self) -> u64 {
        let micros = self.epoch.elapsed().as_micros();
        micros.min(u128::from(u64::MAX)) as u64
    }
}

impl Default for MonotonicClock {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

/// Returns monotonic microseconds elapsed since the process-wide global clock was first queried.
#[inline]
pub fn now_monotonic_us() -> u64 {
    let epoch = PROCESS_EPOCH.get_or_init(Instant::now);
    let micros = epoch.elapsed().as_micros();
    micros.min(u128::from(u64::MAX)) as u64
}

/// Resolves the canonical timestamp for an incoming CAN/CAN-FD frame, enforcing the
/// NexusCAN **Hardware Clock Priority** invariant:
///
/// - If `hw_timestamp_us` is `Some(ts)` with `ts > 0`, returns `(ts, true)`.
/// - Otherwise (`None` or `Some(0)`), falls back to `(now_monotonic_us(), false)`.
#[inline]
pub fn resolve_frame_timestamp_us(hw_timestamp_us: Option<u64>) -> (u64, bool) {
    match hw_timestamp_us {
        Some(ts) if ts > 0 => (ts, true),
        _ => (now_monotonic_us(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn monotonic_clock_and_global_epoch_never_regress() {
        let clock = MonotonicClock::new();
        let t0 = clock.elapsed_us();
        let g0 = now_monotonic_us();

        thread::sleep(Duration::from_millis(2));

        let t1 = clock.elapsed_us();
        let g1 = now_monotonic_us();

        assert!(t1 > t0, "expected t1 ({t1}) > t0 ({t0})");
        assert!(g1 > g0, "expected g1 ({g1}) > g0 ({g0})");
    }

    #[test]
    fn hardware_timestamp_takes_strict_priority_when_nonzero() {
        let (ts_hw, is_hw) = resolve_frame_timestamp_us(Some(987_654_321));
        assert_eq!(ts_hw, 987_654_321);
        assert!(is_hw);

        // Zero hardware timestamp is treated as unpopulated and falls back to monotonic clock
        let before = now_monotonic_us();
        let (ts_zero, is_hw_zero) = resolve_frame_timestamp_us(Some(0));
        let (ts_none, is_hw_none) = resolve_frame_timestamp_us(None);
        let after = now_monotonic_us();

        assert!(!is_hw_zero);
        assert!(!is_hw_none);
        assert!(ts_zero >= before && ts_zero <= ts_none);
        assert!(ts_none <= after);
    }
}
