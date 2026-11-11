//! ISO-TP frame capture for the Diagnostics ISO-TP Monitor.
//!
//! The pump thread (`bridge::pump_loop`) records every `Rx` and `TxConfirmed` tap event of a
//! session (NOT `TxRejected`: those never reached the bus) into a fixed-capacity ring that is
//! allocated ONCE at session open. Recording is O(1), copies a `Copy` record and takes a short
//! `parking_lot` lock — zero heap allocation on the pump thread. Readers (IPC, cold path) build
//! DTO pages from it.
//!
//! Sequence numbers are per session and start at 1. `truncated` = the reader's `since_seq` is
//! older than the oldest retained frame (frames in between were overwritten) or the cursor is
//! from the future (session was reopened). `dropped` counts overwritten frames that no reader had
//! fetched yet — it only starts counting after the first read (no monitor attached → no loss).
//!
//! ## Transaction tagging (`requestSeq`)
//! Every record carries the conversation `seq` of the exchange in flight when it was recorded.
//! The engine owns the request lock, so at most one exchange is in flight per session:
//! * [`IsoTpCapture::begin_txn`] — right BEFORE the first request frame is handed to the ISO-TP
//!   stack: frames recorded from now on are tagged `PENDING` (the request event's `seq` is only
//!   known after the TX confirmation of the request's last frame).
//! * [`TxnTag::bind`] — right after the transaction's head event (`request` / `keepaliveSent`,
//!   or the failure event of a request that never fully reached the bus) is logged: the
//!   `PENDING` suffix of the ring is rewritten to that `seq` and later frames get it directly.
//! * drop of [`TxnTag`] — right AFTER the final event (response / timeout / error) is logged:
//!   later frames are untagged. Never bound → the `PENDING` suffix becomes untagged.
//!
//! The current tag lives inside the ring mutex the pump already takes per frame, so begin/bind/end
//! and `record` are totally ordered (a frame handed to the port after `begin_txn` returned can
//! only be recorded after it). Readers never see `PENDING`: a page stops before the first
//! `PENDING` record and the caller fetches it once bound (bounded by one request's send phase).

use nexus_core::RawCanFrame;
use parking_lot::Mutex;

use crate::uds::discovery::{classify_pci, PciClass};
use crate::uds::dto::{IsoTpDirection, IsoTpFrameDto, IsoTpFrameKind, IsoTpFramePageDto};

/// Ring capacity per session (~400 KiB: 4096 × 96-byte records).
pub const ISOTP_CAPTURE_CAPACITY: usize = 4_096;

/// Record tag: no transaction in flight.
const TAG_NONE: u64 = 0;
/// Record tag: transaction in flight, head event not logged yet (conversation seqs start at 1
/// and never reach `u64::MAX`).
const TAG_PENDING: u64 = u64::MAX;

#[derive(Clone, Copy)]
struct Record {
    seq: u64,
    /// Conversation seq of the transaction ([`TAG_NONE`] / [`TAG_PENDING`]).
    tag: u64,
    tx: bool,
    frame: RawCanFrame,
}

struct Ring {
    buf: Box<[Record]>,
    /// Index of the oldest record.
    head: usize,
    len: usize,
    /// Seq of the newest record (0 = none yet).
    last_seq: u64,
    /// Highest seq handed out to a reader (0 = never read).
    read_seq: u64,
    reader_seen: bool,
    dropped: u64,
    /// Tag given to frames recorded now.
    cur_tag: u64,
}

impl Ring {
    /// Rewrites the trailing run of `PENDING` records (all recorded since `begin_txn`).
    fn retag_pending_suffix(&mut self, tag: u64) {
        let cap = self.buf.len();
        for k in 0..self.len {
            let idx = (self.head + self.len - 1 - k) % cap;
            if self.buf[idx].tag != TAG_PENDING {
                break;
            }
            self.buf[idx].tag = tag;
        }
    }
}

/// Transaction tag of one exchange (see module docs). Untags on drop.
#[must_use = "dropping the tag ends the transaction"]
pub struct TxnTag<'a> {
    capture: &'a IsoTpCapture,
}

impl TxnTag<'_> {
    /// Binds the in-flight transaction to conversation `seq` (first call wins).
    pub fn bind(&self, seq: u64) {
        if seq == TAG_NONE || seq == TAG_PENDING {
            return;
        }
        let mut r = self.capture.ring.lock();
        if r.cur_tag == TAG_PENDING {
            r.cur_tag = seq;
            r.retag_pending_suffix(seq);
        }
    }
}

impl Drop for TxnTag<'_> {
    fn drop(&mut self) {
        let mut r = self.capture.ring.lock();
        if r.cur_tag == TAG_PENDING {
            r.retag_pending_suffix(TAG_NONE);
        }
        r.cur_tag = TAG_NONE;
    }
}

/// Fixed-capacity ISO-TP frame ring of one session.
pub struct IsoTpCapture {
    ring: Mutex<Ring>,
}

impl Default for IsoTpCapture {
    fn default() -> Self {
        Self::with_capacity(ISOTP_CAPTURE_CAPACITY)
    }
}

/// ISO-TP frame kind from the PCI (CAN-FD SF escape `00 len` and FF escape `10 00 <u32>`
/// included). Malformed SF / FF → `Unknown`.
pub fn classify_kind(data: &[u8]) -> IsoTpFrameKind {
    match classify_pci(data) {
        PciClass::Single(_) => IsoTpFrameKind::Single,
        PciClass::FirstFrame { .. } => IsoTpFrameKind::First,
        PciClass::Ignore => match data.first().map(|b| b >> 4) {
            Some(0x2) => IsoTpFrameKind::Consecutive,
            Some(0x3) if data.len() >= 3 && data[0] & 0x0F <= 2 => IsoTpFrameKind::FlowControl,
            _ => IsoTpFrameKind::Unknown,
        },
    }
}

impl IsoTpCapture {
    pub fn with_capacity(capacity: usize) -> Self {
        let cap = capacity.max(1);
        let empty = Record { seq: 0, tag: TAG_NONE, tx: false, frame: RawCanFrame::zeroed() };
        Self {
            ring: Mutex::new(Ring {
                buf: vec![empty; cap].into_boxed_slice(),
                head: 0,
                len: 0,
                last_seq: 0,
                read_seq: 0,
                reader_seen: false,
                dropped: 0,
                cur_tag: TAG_NONE,
            }),
        }
    }

    /// Engine: a transaction starts (call before the first request frame is queued). Frames
    /// recorded until [`TxnTag::bind`] are held back from readers. Ends when the tag drops.
    pub fn begin_txn(&self) -> TxnTag<'_> {
        self.ring.lock().cur_tag = TAG_PENDING;
        TxnTag { capture: self }
    }

    /// Pump thread: records one bus frame. Zero allocation. Returns its seq.
    #[inline]
    pub fn record(&self, frame: &RawCanFrame, tx: bool) -> u64 {
        let mut r = self.ring.lock();
        let cap = r.buf.len();
        r.last_seq += 1;
        let seq = r.last_seq;
        let rec = Record { seq, tag: r.cur_tag, tx, frame: *frame };
        if r.len < cap {
            let idx = (r.head + r.len) % cap;
            r.buf[idx] = rec;
            r.len += 1;
        } else {
            let head = r.head;
            let lost = r.buf[head].seq;
            if r.reader_seen && lost > r.read_seq {
                r.dropped += 1;
            }
            r.buf[head] = rec;
            r.head = (head + 1) % cap;
        }
        seq
    }

    /// Seq of the newest recorded frame (0 = none).
    pub fn last_seq(&self) -> u64 {
        self.ring.lock().last_seq
    }

    /// Frames with `seq > since_seq` (oldest first), at most `max` (>= 1).
    pub fn since(&self, since_seq: u64, max: usize) -> IsoTpFramePageDto {
        let max = max.max(1);
        // Copy the selected records out under the lock; build DTOs (heap) after releasing it.
        let (picked, newest, truncated, dropped) = {
            let mut r = self.ring.lock();
            let newest = r.last_seq;
            let (since, stale_cursor) = if since_seq > newest { (0, true) } else { (since_seq, false) };
            let cap = r.buf.len();
            let oldest = if r.len == 0 { newest + 1 } else { r.buf[r.head].seq };
            let truncated = stale_cursor || (oldest > since + 1 && since < newest);
            // Records are contiguous in seq: offset of the first one with seq > since.
            let skip = usize::try_from((since + 1).saturating_sub(oldest)).unwrap_or(usize::MAX).min(r.len);
            let n = (r.len - skip).min(max);
            let mut picked: Vec<Record> = Vec::with_capacity(n);
            for i in 0..n {
                let rec = r.buf[(r.head + skip + i) % cap];
                if rec.tag == TAG_PENDING {
                    // Held back until the transaction's head event is logged (next poll).
                    break;
                }
                picked.push(rec);
            }
            if let Some(last) = picked.last() {
                r.read_seq = r.read_seq.max(last.seq);
            } else {
                r.read_seq = r.read_seq.max(since);
            }
            r.reader_seen = true;
            (picked, newest, truncated, r.dropped)
        };
        let last_seq = picked.last().map_or(since_seq.min(newest), |p| p.seq);
        let frames = picked
            .iter()
            .map(|p| {
                let data = p.frame.payload().to_vec();
                IsoTpFrameDto {
                    seq: p.seq,
                    timestamp_us: p.frame.timestamp_us,
                    can_id: p.frame.arb_id,
                    is_extended: p.frame.is_extended(),
                    direction: if p.tx { IsoTpDirection::Tx } else { IsoTpDirection::Rx },
                    fd: p.frame.is_fd(),
                    kind: classify_kind(&data),
                    data,
                    request_seq: (p.tag != TAG_NONE).then_some(p.tag),
                }
            })
            .collect();
        IsoTpFramePageDto { frames, last_seq, truncated, dropped }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::CanIdKey;

    fn frame(i: u8) -> RawCanFrame {
        let key = CanIdKey::new_standard(0x7EA).expect("id");
        RawCanFrame::new_classical(0, key, &[0x21, i, 0, 0, 0, 0, 0, 0], u64::from(i) + 1).expect("frame")
    }

    #[test]
    fn kinds_including_fd_escapes() {
        assert_eq!(classify_kind(&[0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]), IsoTpFrameKind::Single);
        assert_eq!(classify_kind(&[0x00, 0x0A, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), IsoTpFrameKind::Single);
        assert_eq!(classify_kind(&[0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2, 3]), IsoTpFrameKind::First);
        assert_eq!(classify_kind(&[0x10, 0x00, 0x00, 0x01, 0x00, 0x00, 0x62, 0x01]), IsoTpFrameKind::First);
        assert_eq!(classify_kind(&[0x21, 1, 2, 3, 4, 5, 6, 7]), IsoTpFrameKind::Consecutive);
        assert_eq!(classify_kind(&[0x2F]), IsoTpFrameKind::Consecutive);
        assert_eq!(classify_kind(&[0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]), IsoTpFrameKind::FlowControl);
        assert_eq!(classify_kind(&[0x31, 0x00, 0x00]), IsoTpFrameKind::FlowControl);
        assert_eq!(classify_kind(&[0x32, 0x00, 0x00]), IsoTpFrameKind::FlowControl);
        assert_eq!(classify_kind(&[0x33, 0x00, 0x00]), IsoTpFrameKind::Unknown);
        assert_eq!(classify_kind(&[0x30, 0x00]), IsoTpFrameKind::Unknown);
        assert_eq!(classify_kind(&[0x05, 0x01]), IsoTpFrameKind::Unknown); // SF longer than frame
        assert_eq!(classify_kind(&[0x10]), IsoTpFrameKind::Unknown);
        assert_eq!(classify_kind(&[0x45, 0x00]), IsoTpFrameKind::Unknown);
        assert_eq!(classify_kind(&[]), IsoTpFrameKind::Unknown);
    }

    #[test]
    fn empty_and_paging() {
        let c = IsoTpCapture::with_capacity(16);
        let p = c.since(0, 10);
        assert!(p.frames.is_empty() && p.last_seq == 0 && !p.truncated && p.dropped == 0);
        for i in 0..10 {
            assert_eq!(c.record(&frame(i), i % 2 == 0), u64::from(i) + 1);
        }
        let p = c.since(0, 4);
        assert_eq!(p.frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert_eq!(p.last_seq, 4);
        assert_eq!(p.frames[0].direction, IsoTpDirection::Tx);
        assert_eq!(p.frames[1].direction, IsoTpDirection::Rx);
        assert_eq!(p.frames[0].kind, IsoTpFrameKind::Consecutive);
        assert_eq!(p.frames[0].can_id, 0x7EA);
        assert_eq!(p.frames[0].data.len(), 8);
        assert_eq!(p.frames[3].timestamp_us, 4);
        let p = c.since(p.last_seq, 100);
        assert_eq!(p.frames.len(), 6);
        assert_eq!(p.last_seq, 10);
        let p = c.since(10, 100);
        assert!(p.frames.is_empty() && p.last_seq == 10 && !p.truncated);
    }

    #[test]
    fn wrap_truncated_and_dropped() {
        let c = IsoTpCapture::with_capacity(8);
        // No reader yet: overwriting is not "dropped".
        for i in 0..12 {
            c.record(&frame(i), false);
        }
        let p = c.since(0, 100);
        assert!(p.truncated, "seq 1..=4 were overwritten");
        assert_eq!(p.dropped, 0);
        assert_eq!(p.frames.first().map(|f| f.seq), Some(5));
        assert_eq!(p.last_seq, 12);
        assert_eq!(p.frames.len(), 8);

        // Reader at 12; 4 new frames fit without losing unread ones.
        for i in 0..4 {
            c.record(&frame(i), true);
        }
        assert_eq!(c.since(12, 2).last_seq, 14); // reader now at 14
        // 8 more: overwrites 9..=16; 15 and 16 were unread → dropped 2.
        for i in 0..8 {
            c.record(&frame(i), true);
        }
        let p = c.since(14, 100);
        assert!(p.truncated, "15 and 16 were lost");
        assert_eq!(p.dropped, 2);
        assert_eq!(p.frames.first().map(|f| f.seq), Some(17));
        assert_eq!(p.last_seq, 24);
        let p = c.since(24, 100);
        assert!(!p.truncated && p.frames.is_empty());
    }

    fn tags(p: &IsoTpFramePageDto) -> Vec<(u64, Option<u64>)> {
        p.frames.iter().map(|f| (f.seq, f.request_seq)).collect()
    }

    #[test]
    fn txn_tagging_pending_hold_back_bind_and_end() {
        let c = IsoTpCapture::with_capacity(16);
        c.record(&frame(0), false); // before any exchange
        {
            let t = c.begin_txn();
            c.record(&frame(1), true); // request SF (TX confirmed before the event is logged)
            c.record(&frame(2), false); // fast response
            // Not bound yet: held back, the untagged frame is returned.
            let p = c.since(0, 100);
            assert_eq!(tags(&p), vec![(1, None)]);
            assert_eq!(p.last_seq, 1);
            t.bind(42);
            t.bind(43); // first bind wins
            c.record(&frame(3), true);
        }
        c.record(&frame(4), false); // late frame after the final event
        let p = c.since(1, 100);
        assert_eq!(tags(&p), vec![(2, Some(42)), (3, Some(42)), (4, Some(42)), (5, None)]);
        // Never bound (e.g. request rejected without an event): untagged, not held back.
        {
            let _t = c.begin_txn();
            c.record(&frame(5), true);
            assert!(c.since(5, 100).frames.is_empty());
        }
        assert_eq!(tags(&c.since(5, 100)), vec![(6, None)]);
    }

    #[test]
    fn txn_tags_survive_ring_wrap() {
        let c = IsoTpCapture::with_capacity(4);
        for k in 0..5u64 {
            let t = c.begin_txn();
            c.record(&frame(0), true);
            t.bind(10 + k);
            c.record(&frame(1), false);
            drop(t);
            c.record(&frame(2), false);
        }
        // 15 records, ring keeps the last 4: seq 12..=15.
        let p = c.since(0, 100);
        assert!(p.truncated);
        assert_eq!(tags(&p), vec![(12, None), (13, Some(14)), (14, Some(14)), (15, None)]);
        // A PENDING run longer than the ring is still retagged entirely.
        let t = c.begin_txn();
        for i in 0..6 {
            c.record(&frame(i), true);
        }
        t.bind(99);
        drop(t);
        let p = c.since(15, 100);
        assert_eq!(tags(&p), vec![(18, Some(99)), (19, Some(99)), (20, Some(99)), (21, Some(99))]);
    }

    #[test]
    fn stale_cursor_from_future_restarts() {
        let c = IsoTpCapture::with_capacity(8);
        for i in 0..3 {
            c.record(&frame(i), false);
        }
        let p = c.since(99, 10);
        assert!(p.truncated);
        assert_eq!(p.frames.len(), 3);
        assert_eq!(p.last_seq, 3);
    }
}
