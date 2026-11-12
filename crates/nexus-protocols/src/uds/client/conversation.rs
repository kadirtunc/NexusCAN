//! Conversation log: bounded ring buffer of [`ConversationEventDto`] with monotonic `seq`.
//!
//! The interpretation layer (`planning/contracts/uds-interpretation-v1.md`) and the HMI history
//! poll this with `since_seq`. Memory is bounded: the oldest events are overwritten and the
//! next page reports `truncated = true` when the caller missed some.

use std::collections::VecDeque;

use crate::uds::dto::{
    ConversationEventDto, ConversationEventKind, ConversationPageDto, DiagOrigin, UdsAddressing,
};

/// Ring capacity (contract: ≥ 10 000 events).
pub const CONVERSATION_CAPACITY: usize = 16_384;
const _: () = assert!(CONVERSATION_CAPACITY >= 10_000);
/// Byte budget for the payloads (`bytes`) retained in the ring (MED-03 / HIGH-07.1). The entry
/// count alone does not bound memory: 16 384 × 64 KiB responses would be 1 GiB. Oldest events are
/// evicted first; the newest event is always kept.
pub const CONVERSATION_BYTE_BUDGET: usize = 16 * 1024 * 1024;
/// Upper bound for one page, independent of the caller's `max`.
pub const MAX_PAGE: usize = 10_000;

/// Fields of a new event (everything except `seq`).
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub timestamp_us: u64,
    pub kind: ConversationEventKind,
    pub addressing: UdsAddressing,
    pub sid: Option<u8>,
    pub bytes: Vec<u8>,
    pub request_seq: Option<u64>,
    pub elapsed_us: Option<u64>,
    pub nrc: Option<u8>,
    pub detail: Option<String>,
    pub origin: DiagOrigin,
}

impl NewEvent {
    pub fn new(kind: ConversationEventKind, addressing: UdsAddressing, timestamp_us: u64) -> Self {
        Self {
            timestamp_us,
            kind,
            addressing,
            sid: None,
            bytes: Vec::new(),
            request_seq: None,
            elapsed_us: None,
            nrc: None,
            detail: None,
            origin: DiagOrigin::Other,
        }
    }
    pub fn origin(mut self, origin: DiagOrigin) -> Self {
        self.origin = origin;
        self
    }
    pub fn sid(mut self, sid: Option<u8>) -> Self {
        self.sid = sid;
        self
    }
    pub fn bytes(mut self, bytes: &[u8]) -> Self {
        self.bytes = bytes.to_vec();
        self
    }
    pub fn request(mut self, seq: Option<u64>, elapsed_us: Option<u64>) -> Self {
        self.request_seq = seq;
        self.elapsed_us = elapsed_us;
        self
    }
    pub fn nrc(mut self, nrc: Option<u8>) -> Self {
        self.nrc = nrc;
        self
    }
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[derive(Debug)]
pub struct Conversation {
    events: VecDeque<ConversationEventDto>,
    capacity: usize,
    byte_budget: usize,
    bytes: usize,
    next_seq: u64,
}

impl Default for Conversation {
    fn default() -> Self {
        Self::with_capacity(CONVERSATION_CAPACITY)
    }
}

impl Conversation {
    pub fn with_capacity(capacity: usize) -> Self {
        Self::with_limits(capacity, CONVERSATION_BYTE_BUDGET)
    }

    pub fn with_limits(capacity: usize, byte_budget: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            events: VecDeque::with_capacity(capacity.min(1024)),
            capacity,
            byte_budget,
            bytes: 0,
            next_seq: 1,
        }
    }

    fn event_bytes(e: &ConversationEventDto) -> usize {
        e.bytes.len() + e.detail.as_ref().map_or(0, String::len)
    }

    /// Payload bytes currently retained.
    #[cfg(test)]
    pub fn retained_bytes(&self) -> usize {
        self.bytes
    }

    /// Appends an event and returns its `seq` (starts at 1).
    pub fn push(&mut self, ev: NewEvent) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        let incoming = ev.bytes.len() + ev.detail.as_ref().map_or(0, String::len);
        while !self.events.is_empty()
            && (self.events.len() >= self.capacity || self.bytes + incoming > self.byte_budget)
        {
            if let Some(old) = self.events.pop_front() {
                self.bytes -= Self::event_bytes(&old);
            }
        }
        self.bytes += incoming;
        self.events.push_back(ConversationEventDto {
            seq,
            timestamp_us: ev.timestamp_us,
            kind: ev.kind,
            addressing: ev.addressing,
            sid: ev.sid,
            bytes: ev.bytes,
            request_seq: ev.request_seq,
            elapsed_us: ev.elapsed_us,
            nrc: ev.nrc,
            detail: ev.detail,
            origin: ev.origin,
        });
        seq
    }

    /// `seq` of the newest event, 0 when empty.
    pub fn last_seq(&self) -> u64 {
        self.next_seq - 1
    }

    /// Events with `seq > since_seq`, at most `max` (capped at [`MAX_PAGE`]).
    ///
    /// * `truncated` — events after `since_seq` were overwritten by the ring buffer, or
    ///   `since_seq` is newer than anything this session produced (stale cursor from a previous
    ///   session); in that case the page restarts at the oldest retained event.
    /// * `last_seq` — `seq` of the last returned event; when nothing is returned, the newest
    ///   `seq` not after the cursor, so polling continues seamlessly.
    pub fn since(&self, since_seq: u64, max: usize) -> ConversationPageDto {
        let newest = self.last_seq();
        let (since, stale_cursor) = if since_seq > newest {
            (0, true)
        } else {
            (since_seq, false)
        };
        let oldest = self.events.front().map_or(newest + 1, |e| e.seq);
        let truncated = stale_cursor || (oldest > since + 1 && since < newest);
        let max = max.min(MAX_PAGE);
        let start = self.events.partition_point(|e| e.seq <= since);
        let events: Vec<ConversationEventDto> =
            self.events.iter().skip(start).take(max).cloned().collect();
        let last_seq = events.last().map_or(since, |e| e.seq);
        ConversationPageDto {
            events,
            last_seq,
            truncated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(i: u64) -> NewEvent {
        NewEvent::new(ConversationEventKind::Request, UdsAddressing::Physical, i)
            .bytes(&[0x3E, 0x00])
    }

    #[test]
    fn seq_starts_at_one_and_pages() {
        let mut c = Conversation::with_capacity(100);
        assert_eq!(c.last_seq(), 0);
        let p = c.since(0, 10);
        assert!(p.events.is_empty() && p.last_seq == 0 && !p.truncated);
        for i in 0..25 {
            assert_eq!(c.push(ev(i)), i + 1);
        }
        let p = c.since(0, 10);
        assert_eq!(p.events.len(), 10);
        assert_eq!(p.events[0].seq, 1);
        assert_eq!(p.last_seq, 10);
        let p = c.since(p.last_seq, 10);
        assert_eq!(p.events[0].seq, 11);
        assert_eq!(p.last_seq, 20);
        let p = c.since(p.last_seq, 10);
        assert_eq!(p.events.len(), 5);
        assert_eq!(p.last_seq, 25);
        let p = c.since(25, 10);
        assert!(p.events.is_empty());
        assert_eq!(p.last_seq, 25);
        assert!(!p.truncated);
        let p = c.since(5, 0);
        assert!(p.events.is_empty() && p.last_seq == 5);
    }

    #[test]
    fn ring_overwrites_and_reports_truncation() {
        let mut c = Conversation::with_capacity(10);
        for i in 0..25 {
            c.push(ev(i));
        }
        let p = c.since(0, 100);
        assert!(p.truncated);
        assert_eq!(p.events.len(), 10);
        assert_eq!(p.events[0].seq, 16);
        assert_eq!(p.last_seq, 25);
        // Cursor inside the retained window: not truncated.
        let p = c.since(15, 100);
        assert!(!p.truncated);
        assert_eq!(p.events.len(), 10);
        let p = c.since(20, 100);
        assert!(!p.truncated);
        assert_eq!(p.events[0].seq, 21);
        // Cursor older than the window.
        let p = c.since(3, 2);
        assert!(p.truncated);
        assert_eq!(p.events[0].seq, 16);
        assert_eq!(p.last_seq, 17);
    }

    #[test]
    fn stale_cursor_from_previous_session() {
        let mut c = Conversation::with_capacity(10);
        for i in 0..3 {
            c.push(ev(i));
        }
        let p = c.since(500, 100);
        assert!(p.truncated);
        assert_eq!(p.events.len(), 3);
        assert_eq!(p.last_seq, 3);
    }

    #[test]
    fn byte_budget_evicts_oldest_and_bounds_memory() {
        let mut c = Conversation::with_limits(1000, 10_000);
        let big = vec![0u8; 4_000];
        for i in 0..10 {
            c.push(
                NewEvent::new(ConversationEventKind::Response, UdsAddressing::Physical, i)
                    .bytes(&big),
            );
        }
        assert!(c.retained_bytes() <= 10_000, "{}", c.retained_bytes());
        let p = c.since(0, 100);
        assert_eq!(p.events.len(), 2);
        assert!(p.truncated);
        assert_eq!(p.last_seq, 10);
        // A single event larger than the budget is still kept (alone).
        c.push(
            NewEvent::new(ConversationEventKind::Response, UdsAddressing::Physical, 11)
                .bytes(&vec![1u8; 20_000]),
        );
        assert_eq!(c.since(0, 100).events.len(), 1);
        c.push(ev(12));
        assert_eq!(c.since(0, 100).events.len(), 1);
        assert_eq!(c.retained_bytes(), 2);
    }

    #[test]
    fn default_capacity_meets_contract() {
        let mut c = Conversation::default();
        for i in 0..12_000 {
            c.push(ev(i));
        }
        let p = c.since(0, usize::MAX);
        assert!(!p.truncated);
        assert_eq!(p.events.len(), MAX_PAGE);
        assert_eq!(p.events[0].seq, 1);
    }
}
