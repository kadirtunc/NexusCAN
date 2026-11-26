//! Identity-matched suppression of the pipeline's own TX echoes (CANsub QA C7).
//!
//! Drivers with self-loopback (`mock0`, CANsub `tx_ack_frames`) deliver every successful TX back
//! as an RX frame with `FLAG_TX`. Restbus/replay TX (`suppress_echo = true`) must not show up in
//! the trace, so the bus-io thread remembers each suppressed frame here and drops the matching
//! echo when it arrives. Matching is by identity (`id`, ext/FD/RTR, length, payload hash) and
//! entries expire after [`SUPPRESSED_ECHO_TIMEOUT_US`]: a suppressed frame that the bus never
//! ACKed can therefore not swallow a later, different TX-ack (the old anonymous counter could).
//!
//! Fixed-capacity ring on the stack of the bus-io thread; no heap, `O(capacity)` per lookup.

use nexus_core::{RawCanFrame, EXT_CAN_ID_MASK, FLAG_EXTENDED, FLAG_FD, FLAG_RTR, STD_CAN_ID_MASK};

/// Pending suppressed echoes remembered per bus.
pub(crate) const PENDING_ECHO_CAPACITY: usize = 64;

/// A suppressed echo that has not arrived within this window is forgotten; a later (late)
/// echo is then shown in the trace like any other TX-ack.
pub(crate) const SUPPRESSED_ECHO_TIMEOUT_US: u64 = 500_000;

/// Identity of one frame as the adapter echoes it back.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
struct EchoKey {
    arb_id: u32,
    /// `EXTENDED | FD | RTR` (RTR only for classical frames, as on the wire).
    kind: u8,
    len: u8,
    payload_hash: u64,
}

impl EchoKey {
    #[inline]
    fn of(frame: &RawCanFrame) -> Self {
        let ext = frame.is_extended();
        let fd = frame.is_fd();
        let rtr = frame.is_rtr() && !fd;
        let mut kind = 0u8;
        if ext {
            kind |= FLAG_EXTENDED;
        }
        if fd {
            kind |= FLAG_FD;
        }
        if rtr {
            kind |= FLAG_RTR;
        }
        let len = frame.dlc.min(64);
        // FNV-1a over the payload; RTR frames carry no data (adapters zero it).
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        if !rtr {
            for &b in &frame.data[..usize::from(len)] {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        Self {
            arb_id: frame.arb_id
                & if ext {
                    EXT_CAN_ID_MASK
                } else {
                    STD_CAN_ID_MASK
                },
            kind,
            len,
            payload_hash: h,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct PendingEcho {
    key: EchoKey,
    sent_us: u64,
}

/// Bounded FIFO of suppressed echoes still expected from the adapter.
pub(crate) struct PendingEchoes {
    slots: [PendingEcho; PENDING_ECHO_CAPACITY],
    /// Index of the oldest live entry.
    head: usize,
    len: usize,
    /// Entries dropped because the ring was full (oldest first). Monotonic.
    evicted_full: u64,
    /// Entries dropped because their echo never arrived in time. Monotonic.
    expired: u64,
}

impl PendingEchoes {
    pub(crate) fn new() -> Self {
        Self {
            slots: [PendingEcho::default(); PENDING_ECHO_CAPACITY],
            head: 0,
            len: 0,
            evicted_full: 0,
            expired: 0,
        }
    }

    #[inline]
    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub(crate) fn evicted_full(&self) -> u64 {
        self.evicted_full
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[inline]
    fn slot(&self, i: usize) -> usize {
        (self.head + i) % PENDING_ECHO_CAPACITY
    }

    /// Drops expired entries from the front (entries are in send order).
    #[inline]
    fn expire(&mut self, now_us: u64) {
        while self.len > 0 {
            let e = &self.slots[self.head];
            if now_us.saturating_sub(e.sent_us) <= SUPPRESSED_ECHO_TIMEOUT_US {
                break;
            }
            self.head = (self.head + 1) % PENDING_ECHO_CAPACITY;
            self.len -= 1;
            self.expired += 1;
        }
    }

    /// Remembers that the echo of `frame` (sent at `now_us`) must be suppressed.
    pub(crate) fn push(&mut self, frame: &RawCanFrame, now_us: u64) {
        self.expire(now_us);
        if self.len == PENDING_ECHO_CAPACITY {
            self.head = (self.head + 1) % PENDING_ECHO_CAPACITY;
            self.len -= 1;
            self.evicted_full += 1;
        }
        let idx = self.slot(self.len);
        self.slots[idx] = PendingEcho {
            key: EchoKey::of(frame),
            sent_us: now_us,
        };
        self.len += 1;
    }

    /// `true` if `echo` (an RX frame with `FLAG_TX`) matches a pending entry, which is consumed
    /// (oldest match first). Non-matching echoes leave the ring untouched.
    pub(crate) fn take_match(&mut self, echo: &RawCanFrame, now_us: u64) -> bool {
        self.expire(now_us);
        if self.len == 0 {
            return false;
        }
        let key = EchoKey::of(echo);
        let Some(pos) = (0..self.len).find(|&i| self.slots[self.slot(i)].key == key) else {
            return false;
        };
        // Close the gap, keeping send order.
        for i in pos..self.len - 1 {
            let (dst, src) = (self.slot(i), self.slot(i + 1));
            self.slots[dst] = self.slots[src];
        }
        self.len -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::FLAG_TX;

    fn frame(id: u32, data: &[u8]) -> RawCanFrame {
        let mut f = RawCanFrame::zeroed();
        f.arb_id = id;
        f.dlc = data.len() as u8;
        f.data[..data.len()].copy_from_slice(data);
        f
    }

    #[test]
    fn matches_by_identity_only() {
        let mut p = PendingEchoes::new();
        p.push(&frame(0x100, &[1, 2, 3]), 0);
        // Different id / data / length / ext never match.
        assert!(!p.take_match(&frame(0x101, &[1, 2, 3]).with_flags(FLAG_TX), 10));
        assert!(!p.take_match(&frame(0x100, &[1, 2, 4]).with_flags(FLAG_TX), 10));
        assert!(!p.take_match(&frame(0x100, &[1, 2]).with_flags(FLAG_TX), 10));
        assert!(!p.take_match(&frame(0x100, &[1, 2, 3]).with_flags(FLAG_EXTENDED), 10));
        assert_eq!(p.len(), 1);
        // Echo flags (TX / HW timestamp) are ignored.
        let echo = frame(0x100, &[1, 2, 3]).with_flags(FLAG_TX | nexus_core::FLAG_HW_TIMESTAMP);
        assert!(p.take_match(&echo, 10));
        assert!(p.is_empty());
        assert!(!p.take_match(&echo, 11));
    }

    #[test]
    fn rtr_ignores_payload_bytes() {
        let mut p = PendingEchoes::new();
        let mut tx = frame(0x7FF, &[0xAA; 4]).with_flags(FLAG_RTR);
        tx.dlc = 4;
        p.push(&tx, 0);
        let mut echo = frame(0x7FF, &[0; 4]).with_flags(FLAG_RTR | FLAG_TX);
        echo.dlc = 4;
        assert!(p.take_match(&echo, 1));
    }

    #[test]
    fn middle_match_keeps_order_and_expiry() {
        let mut p = PendingEchoes::new();
        p.push(&frame(1, &[1]), 0);
        p.push(&frame(2, &[2]), 100_000);
        p.push(&frame(3, &[3]), 200_000);
        assert!(p.take_match(&frame(2, &[2]), 300_000));
        // Entry 1 expires first, entry 3 is still live.
        assert!(!p.take_match(&frame(1, &[1]), 600_000));
        assert!(p.take_match(&frame(3, &[3]), 600_000));
        assert!(p.is_empty());
        assert_eq!(p.expired, 1);
    }

    #[test]
    fn full_ring_drops_oldest_and_counts() {
        let mut p = PendingEchoes::new();
        for i in 0..(PENDING_ECHO_CAPACITY as u32 + 3) {
            p.push(&frame(i, &[]), u64::from(i));
        }
        assert_eq!(p.len(), PENDING_ECHO_CAPACITY);
        assert_eq!(p.evicted_full(), 3);
        for i in 0..3 {
            assert!(!p.take_match(&frame(i, &[]), 100));
        }
        assert!(p.take_match(&frame(3, &[]), 100));
        assert!(p.take_match(&frame(PENDING_ECHO_CAPACITY as u32 + 2, &[]), 100));
    }
}
