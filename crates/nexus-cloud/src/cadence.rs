//! Adaptive `60Hz -> 30Hz / 20Hz / 15Hz / 10Hz / 2Hz` snapshot decimator and
//! bounded exponential reconnection backoff controller.

use core::time::Duration;

use crate::protocol::BridgeTargetHz;

const JITTER_TOLERANCE_US: u64 = 1_500;

/// Deterministic cadence decimator converting local `60Hz` `StateTable` snapshots
/// to the cloud room's requested target rate (`2Hz` idle heartbeat, `20Hz` WAN, `60Hz` LAN).
#[derive(Clone, Debug)]
pub struct CadenceDecimator {
    target_hz: BridgeTargetHz,
    last_emitted_us: Option<u64>,
}

impl CadenceDecimator {
    pub const fn new(initial_hz: BridgeTargetHz) -> Self {
        Self {
            target_hz: initial_hz,
            last_emitted_us: None,
        }
    }

    pub const fn target_hz(&self) -> BridgeTargetHz {
        self.target_hz
    }

    pub fn set_target_hz(&mut self, next_hz: BridgeTargetHz) {
        self.target_hz = next_hz;
    }

    pub fn reset(&mut self) {
        self.last_emitted_us = None;
    }

    /// Returns `true` if the snapshot at `timestamp_us` should be forwarded over the bridge.
    #[inline]
    pub fn should_emit(&mut self, timestamp_us: u64) -> bool {
        if self.target_hz == BridgeTargetHz::Hz60 {
            self.last_emitted_us = Some(timestamp_us);
            return true;
        }

        let Some(prev_us) = self.last_emitted_us else {
            self.last_emitted_us = Some(timestamp_us);
            return true;
        };

        // Handle monotonic clock reset gracefully
        if timestamp_us < prev_us {
            self.last_emitted_us = Some(timestamp_us);
            return true;
        }

        let elapsed_us = timestamp_us - prev_us;
        let required_us = self.target_hz.period_us();
        if elapsed_us.saturating_add(JITTER_TOLERANCE_US) >= required_us {
            self.last_emitted_us = Some(timestamp_us);
            true
        } else {
            false
        }
    }
}

/// Bounded exponential backoff (`base_ms * 2^attempt` capped at `max_ms`) for
/// resilient WAN reconnection without thundering herds or hot spin loops.
#[derive(Clone, Debug)]
pub struct ExponentialBackoff {
    base_delay_ms: u64,
    max_delay_ms: u64,
    attempt: u32,
}

impl ExponentialBackoff {
    pub const fn new(base_delay_ms: u64, max_delay_ms: u64) -> Self {
        let safe_base = if base_delay_ms == 0 { 100 } else { base_delay_ms };
        let safe_max = if max_delay_ms < safe_base {
            safe_base
        } else {
            max_delay_ms
        };
        Self {
            base_delay_ms: safe_base,
            max_delay_ms: safe_max,
            attempt: 0,
        }
    }

    pub const fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn next_delay(&mut self) -> Duration {
        let shift = self.attempt.min(20);
        let factor = 1u64 << shift;
        let delay_ms = self.base_delay_ms.saturating_mul(factor).min(self.max_delay_ms);
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(delay_ms)
    }
}

impl Default for ExponentialBackoff {
    fn default() -> Self {
        Self::new(500, 30_000)
    }
}
