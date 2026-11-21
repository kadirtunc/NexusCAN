//! Test-only helpers shared by the workspace crates (not used on any production path).

use std::time::Duration;

/// Multiplier for wall-clock upper bounds in tests, from `NEXUS_TEST_TIME_SCALE` (default 1).
///
/// CI sets it on the 3-vCPU macOS VM only, where thread wake-up latency and oversleeping make
/// tight budgets (5-100 ms) fail at random. Linux, Windows and local runs keep the exact budgets.
/// Invalid or zero values fall back to 1; the value is capped at 20.
pub fn time_scale() -> u32 {
    std::env::var("NEXUS_TEST_TIME_SCALE")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|&n| n >= 1)
        .map_or(1, |n| n.min(20))
}

/// `budget` scaled by [`time_scale`]; use for "must finish within" assertions, never for
/// lower bounds or for the behaviour under test itself.
pub fn scaled(budget: Duration) -> Duration {
    budget * time_scale()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_scale_is_one() {
        if std::env::var_os("NEXUS_TEST_TIME_SCALE").is_none() {
            assert_eq!(time_scale(), 1);
            assert_eq!(scaled(Duration::from_millis(25)), Duration::from_millis(25));
        }
    }
}
