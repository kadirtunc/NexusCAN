//! SAE J1939-21 Transport Protocol reassembly (TP.CM PGN 60416 / TP.DT PGN 60160) — pure logic,
//! no I/O, no clocks, no threads.
//!
//! [`Reassembler`] is a passive (bus-monitor) receiver for both transport modes:
//!
//! * **BAM** (broadcast, `TP.CM_BAM` control byte 32 to DA 0xFF): no handshake.
//! * **CMDT** (connection mode, RTS 16 / CTS 17 / EndOfMsgAck 19 / Abort 255): the reassembler
//!   follows the handshake it observes on the bus. It never sends anything. When NexusCAN acts
//!   as the responder, the HAL sends CTS / EndOfMsgAck / Abort built with [`build_tp_cts`],
//!   [`build_tp_end_of_msg_ack`] and [`build_tp_abort`] through the gated TX path, and must feed
//!   its own transmitted frames back (TX echo) so this state machine sees the CTS.
//!
//! Timing is driven only by caller timestamps (`timestamp_us` in [`Reassembler::feed`] and
//! [`Reassembler::poll`]). Every frame fed first expires overdue sessions at its timestamp.
//!
//! Memory is bounded: at most one BAM session per SA, one CMDT session per (SA, DA) pair and
//! [`ReassemblerConfig::max_sessions`] sessions in total (default 64, each ≤ 1785 bytes).
//! Announcements over the cap are dropped and counted.
//!
//! Passive-monitor policies (documented choices, not mandated by J1939-21 for a sniffer):
//! * A message is reported complete when its LAST TP.DT arrives; the later EndOfMsgAck is not
//!   required (a monitor cannot rely on seeing it).
//! * A new BAM / RTS for a key that already has an open session replaces the old session; the
//!   old one is reported as aborted ([`TpAbortDetail::ReplacedByNewAnnouncement`]).
//! * A TP.DT that matches no session is counted as stray (we may have joined mid-transfer).

use serde::{Deserialize, Serialize};

use super::id::{
    pgn_from_le3, pgn_to_le3, J1939Frame, J1939Id, J1939IdError, ADDRESS_GLOBAL, MAX_PGN,
};

/// TP.CM PGN (0xEC00).
pub const PGN_TP_CM: u32 = 60416;
/// TP.DT PGN (0xEB00).
pub const PGN_TP_DT: u32 = 60160;

/// TP.CM control byte: Request To Send.
pub const CM_RTS: u8 = 16;
/// TP.CM control byte: Clear To Send.
pub const CM_CTS: u8 = 17;
/// TP.CM control byte: End of Message Acknowledge.
pub const CM_END_OF_MSG_ACK: u8 = 19;
/// TP.CM control byte: Broadcast Announce Message.
pub const CM_BAM: u8 = 32;
/// TP.CM control byte: Connection Abort.
pub const CM_ABORT: u8 = 255;

/// Smallest TP message (shorter messages fit one frame).
pub const TP_MIN_SIZE: usize = 9;
/// Largest TP message: 255 packets × 7 bytes.
pub const TP_MAX_SIZE: usize = 1785;
/// Payload bytes per TP.DT packet.
pub const TP_BYTES_PER_PACKET: usize = 7;
/// Default priority of TP.CM / TP.DT frames.
pub const TP_DEFAULT_PRIORITY: u8 = 7;
/// Default global session cap.
pub const DEFAULT_MAX_SESSIONS: usize = 64;

/// J1939-21 timeouts in microseconds.
pub const T1_US: u64 = 750_000;
pub const T2_US: u64 = 1_250_000;
pub const T3_US: u64 = 1_250_000;
pub const T4_US: u64 = 1_050_000;
pub const TR_US: u64 = 200_000;
pub const TH_US: u64 = 500_000;

/// Abort reason codes (J1939-21 TP.Conn_Abort byte 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TpAbortReason {
    /// 1 — already in one or more connection-managed sessions and cannot support another.
    AlreadyInSession,
    /// 2 — system resources were needed for another task.
    ResourcesNeeded,
    /// 3 — a timeout occurred.
    Timeout,
    /// 4 — CTS received while a data transfer is in progress.
    CtsWhileTransferring,
    /// 5 — maximum retransmit request limit reached.
    MaxRetransmitReached,
    /// 6 — unexpected data transfer packet.
    UnexpectedDataTransfer,
    /// 7 — bad sequence number.
    BadSequenceNumber,
    /// 8 — duplicate sequence number.
    DuplicateSequenceNumber,
    /// 9 — total message size is greater than 1785 bytes.
    MessageTooLarge,
    /// 250 — a reason not listed in the J1939-21 table (used for locally detected conditions
    /// without a dedicated code, e.g. wrong DLC or size/packet-count mismatch).
    NotListed,
    /// Any other code seen on the wire.
    Other(u8),
}

impl TpAbortReason {
    pub fn code(self) -> u8 {
        match self {
            Self::AlreadyInSession => 1,
            Self::ResourcesNeeded => 2,
            Self::Timeout => 3,
            Self::CtsWhileTransferring => 4,
            Self::MaxRetransmitReached => 5,
            Self::UnexpectedDataTransfer => 6,
            Self::BadSequenceNumber => 7,
            Self::DuplicateSequenceNumber => 8,
            Self::MessageTooLarge => 9,
            Self::NotListed => 250,
            Self::Other(c) => c,
        }
    }

    pub fn from_code(code: u8) -> Self {
        match code {
            1 => Self::AlreadyInSession,
            2 => Self::ResourcesNeeded,
            3 => Self::Timeout,
            4 => Self::CtsWhileTransferring,
            5 => Self::MaxRetransmitReached,
            6 => Self::UnexpectedDataTransfer,
            7 => Self::BadSequenceNumber,
            8 => Self::DuplicateSequenceNumber,
            9 => Self::MessageTooLarge,
            250 => Self::NotListed,
            c => Self::Other(c),
        }
    }
}

/// Transport mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TpMode {
    Bam,
    Cmdt,
}

/// J1939-21 timer names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TpTimer {
    T1,
    T2,
    T3,
    T4,
}

/// Who ended the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AbortOrigin {
    /// Detected by this reassembler (what a conforming receiver would abort with).
    Local,
    /// A TP.Conn_Abort observed on the bus.
    Remote,
}

/// Precise local explanation of an abort (the wire code is in [`TpAbortReason`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TpAbortDetail {
    /// TP.Conn_Abort observed on the bus.
    RemoteAbort,
    /// The named timer expired.
    #[serde(rename_all = "camelCase")]
    TimedOut { timer: TpTimer },
    /// Announced size outside 9..=1785.
    #[serde(rename_all = "camelCase")]
    SizeOutOfRange { size: u16 },
    /// Announced packet count != ceil(size / 7).
    #[serde(rename_all = "camelCase")]
    PacketCountMismatch { size: u16, packets: u8 },
    /// The announced PGN does not fit 18 bits.
    #[serde(rename_all = "camelCase")]
    InvalidPgn { pgn: u32 },
    /// RTS sent to the global address (CMDT is destination-specific).
    RtsToGlobal,
    /// Global session cap reached.
    SessionCapReached,
    /// A new BAM / RTS for the same key replaced this session.
    ReplacedByNewAnnouncement,
    /// TP.DT sequence number skipped ahead (or 0, or beyond the total).
    #[serde(rename_all = "camelCase")]
    SequenceGap { expected: u8, got: u8 },
    /// TP.DT sequence number already received in this window.
    #[serde(rename_all = "camelCase")]
    DuplicatePacket { seq: u8 },
    /// TP.DT too short for the bytes it must carry, or longer than 8.
    #[serde(rename_all = "camelCase")]
    WrongDlc { len: u8 },
    /// TP.DT received while no CTS window was open (CMDT).
    DataWithoutCts,
    /// CTS received while packets of the previous CTS window were still outstanding.
    CtsDuringTransfer,
    /// CTS window start outside 1..=total packets.
    #[serde(rename_all = "camelCase")]
    InvalidCts { next_seq: u8 },
    /// EndOfMsgAck seen before all packets arrived.
    PrematureEndOfMsgAck,
}

/// A completed TP message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpMessage {
    pub mode: TpMode,
    /// Transported PGN (from TP.CM bytes 6..8).
    pub pgn: u32,
    /// Originator.
    pub sa: u8,
    /// Destination (0xFF for BAM).
    pub da: u8,
    /// Exactly `size` bytes (the 0xFF fill of the last packet is stripped).
    pub payload: Vec<u8>,
    pub started_us: u64,
    pub completed_us: u64,
}

/// An aborted / rejected / timed-out session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpAbort {
    pub mode: TpMode,
    pub pgn: u32,
    /// Originator.
    pub sa: u8,
    /// Destination (0xFF for BAM).
    pub da: u8,
    pub reason: TpAbortReason,
    pub detail: TpAbortDetail,
    pub origin: AbortOrigin,
    pub timestamp_us: u64,
}

/// Reassembler output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TpEvent {
    Completed(TpMessage),
    Aborted(TpAbort),
}

/// Counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpStatsDto {
    pub active_sessions: u32,
    pub completed: u64,
    pub aborted: u64,
    /// Announcements refused because the global session cap was reached.
    pub dropped: u64,
    /// TP frames matching no session, malformed TP.CM frames, unknown control bytes.
    pub stray_frames: u64,
}

/// Configuration. Timer values are the J1939-21 defaults; override only for tests or for
/// deliberately lenient monitoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassemblerConfig {
    pub max_sessions: usize,
    pub t1_us: u64,
    pub t2_us: u64,
    pub t3_us: u64,
    pub t4_us: u64,
}

impl Default for ReassemblerConfig {
    fn default() -> Self {
        Self {
            max_sessions: DEFAULT_MAX_SESSIONS,
            t1_us: T1_US,
            t2_us: T2_US,
            t3_us: T3_US,
            t4_us: T4_US,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CmdtState {
    /// After RTS or after a completed CTS window: waiting for the responder's CTS (T3).
    AwaitingCts,
    /// CTS with 0 packets seen: waiting for the next CTS (T4).
    Hold,
    /// Inside a CTS window: waiting for TP.DT (T2 for the first packet, T1 after).
    Receiving,
}

#[derive(Debug, Clone)]
struct Session {
    mode: TpMode,
    sa: u8,
    da: u8,
    pgn: u32,
    size: u16,
    total_packets: u8,
    /// Next expected sequence number (1..=256).
    next_seq: u16,
    /// Last sequence number of the current window (CMDT) / `total_packets` (BAM).
    window_end: u16,
    state: CmdtState,
    buf: Vec<u8>,
    started_us: u64,
    deadline_us: u64,
    timer: TpTimer,
}

impl Session {
    fn abort(
        &self,
        reason: TpAbortReason,
        detail: TpAbortDetail,
        origin: AbortOrigin,
        ts: u64,
    ) -> TpAbort {
        TpAbort {
            mode: self.mode,
            pgn: self.pgn,
            sa: self.sa,
            da: self.da,
            reason,
            detail,
            origin,
            timestamp_us: ts,
        }
    }

    fn arm(&mut self, now: u64, timer: TpTimer, cfg: &ReassemblerConfig) {
        let dur = match timer {
            TpTimer::T1 => cfg.t1_us,
            TpTimer::T2 => cfg.t2_us,
            TpTimer::T3 => cfg.t3_us,
            TpTimer::T4 => cfg.t4_us,
        };
        self.timer = timer;
        self.deadline_us = now.saturating_add(dur);
    }
}

/// Parsed RTS / BAM / EndOfMsgAck announcement fields.
struct Announce {
    size: u16,
    packets: u8,
    pgn: u32,
}

/// Validates size / packet count / PGN of an announcement.
fn validate_announce(a: &Announce) -> Result<(), (TpAbortReason, TpAbortDetail)> {
    let size = usize::from(a.size);
    if size > TP_MAX_SIZE {
        return Err((
            TpAbortReason::MessageTooLarge,
            TpAbortDetail::SizeOutOfRange { size: a.size },
        ));
    }
    if size < TP_MIN_SIZE {
        return Err((
            TpAbortReason::NotListed,
            TpAbortDetail::SizeOutOfRange { size: a.size },
        ));
    }
    if usize::from(a.packets) != size.div_ceil(TP_BYTES_PER_PACKET) {
        return Err((
            TpAbortReason::NotListed,
            TpAbortDetail::PacketCountMismatch {
                size: a.size,
                packets: a.packets,
            },
        ));
    }
    if a.pgn > MAX_PGN {
        return Err((
            TpAbortReason::NotListed,
            TpAbortDetail::InvalidPgn { pgn: a.pgn },
        ));
    }
    Ok(())
}

/// Passive J1939 TP reassembler. See the module docs.
#[derive(Debug, Clone)]
pub struct Reassembler {
    cfg: ReassemblerConfig,
    sessions: Vec<Session>,
    stats: TpStatsDto,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new(ReassemblerConfig::default())
    }
}

impl Reassembler {
    pub fn new(cfg: ReassemblerConfig) -> Self {
        Self {
            cfg,
            sessions: Vec::with_capacity(cfg.max_sessions.min(DEFAULT_MAX_SESSIONS)),
            stats: TpStatsDto::default(),
        }
    }

    pub fn config(&self) -> &ReassemblerConfig {
        &self.cfg
    }

    pub fn stats(&self) -> TpStatsDto {
        TpStatsDto {
            active_sessions: self.sessions.len() as u32,
            ..self.stats
        }
    }

    pub fn active_sessions(&self) -> usize {
        self.sessions.len()
    }

    /// Drops all sessions silently (counters are kept).
    pub fn reset(&mut self) {
        self.sessions.clear();
    }

    /// Expires every session whose deadline is before `now_us`; emits timeout aborts.
    pub fn poll(&mut self, now_us: u64, out: &mut Vec<TpEvent>) {
        let mut i = 0;
        while i < self.sessions.len() {
            let s = &self.sessions[i];
            if now_us > s.deadline_us {
                let timer = s.timer;
                let ab = s.abort(
                    TpAbortReason::Timeout,
                    TpAbortDetail::TimedOut { timer },
                    AbortOrigin::Local,
                    now_us,
                );
                self.sessions.swap_remove(i);
                self.emit_abort(ab, out);
            } else {
                i += 1;
            }
        }
    }

    /// Feeds a raw frame. Non-extended and non-TP frames are ignored (no event, not stray).
    pub fn feed_raw(
        &mut self,
        raw_id: u32,
        extended: bool,
        data: &[u8],
        timestamp_us: u64,
        out: &mut Vec<TpEvent>,
    ) {
        if let Ok(id) = J1939Id::decode(raw_id, extended) {
            self.feed(&id, data, timestamp_us, out);
        }
    }

    /// Feeds one decoded J1939 frame (`data` = the CAN payload, DLC bytes).
    pub fn feed(&mut self, id: &J1939Id, data: &[u8], timestamp_us: u64, out: &mut Vec<TpEvent>) {
        let pgn = id.pgn();
        if pgn != PGN_TP_CM && pgn != PGN_TP_DT {
            return;
        }
        self.poll(timestamp_us, out);
        if pgn == PGN_TP_CM {
            self.on_cm(id.sa, id.destination(), data, timestamp_us, out);
        } else {
            self.on_dt(id.sa, id.destination(), data, timestamp_us, out);
        }
    }

    fn emit_abort(&mut self, ab: TpAbort, out: &mut Vec<TpEvent>) {
        self.stats.aborted = self.stats.aborted.saturating_add(1);
        out.push(TpEvent::Aborted(ab));
    }

    fn find(&self, mode: TpMode, sa: u8, da: u8) -> Option<usize> {
        self.sessions
            .iter()
            .position(|s| s.mode == mode && s.sa == sa && s.da == da)
    }

    fn remove_and_abort(
        &mut self,
        idx: usize,
        reason: TpAbortReason,
        detail: TpAbortDetail,
        origin: AbortOrigin,
        ts: u64,
        out: &mut Vec<TpEvent>,
    ) {
        let s = self.sessions.swap_remove(idx);
        let ab = s.abort(reason, detail, origin, ts);
        self.emit_abort(ab, out);
    }

    fn stray(&mut self) {
        self.stats.stray_frames = self.stats.stray_frames.saturating_add(1);
    }

    fn on_cm(&mut self, sa: u8, da: u8, data: &[u8], ts: u64, out: &mut Vec<TpEvent>) {
        let Some(cm) = data.get(..8) else {
            self.stray();
            return;
        };
        let pgn = pgn_from_le3([cm[5], cm[6], cm[7]]);
        match cm[0] {
            CM_BAM | CM_RTS => {
                let announce = Announce {
                    size: u16::from_le_bytes([cm[1], cm[2]]),
                    packets: cm[3],
                    pgn,
                };
                let mode = if cm[0] == CM_BAM {
                    TpMode::Bam
                } else {
                    TpMode::Cmdt
                };
                self.on_announce(mode, sa, da, announce, ts, out);
            }
            CM_CTS => {
                // CTS travels responder → originator: the session key is (originator = da, sa).
                self.on_cts(da, sa, cm[1], cm[2], pgn, ts, out);
            }
            CM_END_OF_MSG_ACK => {
                // Completion is reported on the last TP.DT; an ack for a still-open session is
                // premature (the responder closed the connection early).
                match self.find(TpMode::Cmdt, da, sa) {
                    Some(i) if self.sessions[i].pgn == pgn => self.remove_and_abort(
                        i,
                        TpAbortReason::NotListed,
                        TpAbortDetail::PrematureEndOfMsgAck,
                        AbortOrigin::Remote,
                        ts,
                        out,
                    ),
                    _ => self.stray(),
                }
            }
            CM_ABORT => {
                // Either side may abort: try (sa → da) then (da → sa). BAM is never aborted.
                let idx = self
                    .find(TpMode::Cmdt, sa, da)
                    .or_else(|| self.find(TpMode::Cmdt, da, sa))
                    .filter(|&i| self.sessions[i].pgn == pgn);
                match idx {
                    Some(i) => self.remove_and_abort(
                        i,
                        TpAbortReason::from_code(cm[1]),
                        TpAbortDetail::RemoteAbort,
                        AbortOrigin::Remote,
                        ts,
                        out,
                    ),
                    None => self.stray(),
                }
            }
            _ => self.stray(),
        }
    }

    fn on_announce(
        &mut self,
        mode: TpMode,
        sa: u8,
        da: u8,
        a: Announce,
        ts: u64,
        out: &mut Vec<TpEvent>,
    ) {
        let reject = |reason, detail| TpAbort {
            mode,
            pgn: a.pgn,
            sa,
            da,
            reason,
            detail,
            origin: AbortOrigin::Local,
            timestamp_us: ts,
        };
        match mode {
            TpMode::Bam if da != ADDRESS_GLOBAL => {
                // BAM must go to the global address; not a valid announcement.
                self.stray();
                return;
            }
            TpMode::Cmdt if da == ADDRESS_GLOBAL => {
                let ab = reject(TpAbortReason::NotListed, TpAbortDetail::RtsToGlobal);
                self.emit_abort(ab, out);
                return;
            }
            _ => {}
        }
        // Any new announcement for the same key closes the old session first.
        if let Some(i) = self.find(mode, sa, da) {
            self.remove_and_abort(
                i,
                TpAbortReason::NotListed,
                TpAbortDetail::ReplacedByNewAnnouncement,
                AbortOrigin::Local,
                ts,
                out,
            );
        }
        if let Err((reason, detail)) = validate_announce(&a) {
            let ab = reject(reason, detail);
            self.emit_abort(ab, out);
            return;
        }
        if self.sessions.len() >= self.cfg.max_sessions {
            self.stats.dropped = self.stats.dropped.saturating_add(1);
            let ab = reject(
                TpAbortReason::AlreadyInSession,
                TpAbortDetail::SessionCapReached,
            );
            self.emit_abort(ab, out);
            return;
        }
        let total = a.packets;
        let mut s = Session {
            mode,
            sa,
            da,
            pgn: a.pgn,
            size: a.size,
            total_packets: total,
            next_seq: 1,
            window_end: if mode == TpMode::Bam {
                u16::from(total)
            } else {
                0
            },
            state: if mode == TpMode::Bam {
                CmdtState::Receiving
            } else {
                CmdtState::AwaitingCts
            },
            buf: vec![0xFF; usize::from(total) * TP_BYTES_PER_PACKET],
            started_us: ts,
            deadline_us: ts,
            timer: TpTimer::T1,
        };
        // BAM: next TP.DT within T1. CMDT: the originator waits T3 for the first CTS.
        let timer = if mode == TpMode::Bam {
            TpTimer::T1
        } else {
            TpTimer::T3
        };
        s.arm(ts, timer, &self.cfg);
        self.sessions.push(s);
    }

    #[allow(clippy::too_many_arguments)]
    fn on_cts(
        &mut self,
        originator: u8,
        responder: u8,
        num_packets: u8,
        next_seq: u8,
        pgn: u32,
        ts: u64,
        out: &mut Vec<TpEvent>,
    ) {
        let Some(i) = self
            .find(TpMode::Cmdt, originator, responder)
            .filter(|&i| self.sessions[i].pgn == pgn)
        else {
            self.stray();
            return;
        };
        let cfg = self.cfg;
        let s = &mut self.sessions[i];
        if s.state == CmdtState::Receiving && s.next_seq <= s.window_end {
            self.remove_and_abort(
                i,
                TpAbortReason::CtsWhileTransferring,
                TpAbortDetail::CtsDuringTransfer,
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        }
        if num_packets == 0 {
            s.state = CmdtState::Hold;
            s.arm(ts, TpTimer::T4, &cfg);
            return;
        }
        if next_seq == 0 || next_seq > s.total_packets {
            self.remove_and_abort(
                i,
                TpAbortReason::NotListed,
                TpAbortDetail::InvalidCts { next_seq },
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        }
        // A CTS may rewind (retransmission request); the window is clamped to the total.
        s.next_seq = u16::from(next_seq);
        s.window_end =
            (u16::from(next_seq) + u16::from(num_packets) - 1).min(u16::from(s.total_packets));
        s.state = CmdtState::Receiving;
        s.arm(ts, TpTimer::T2, &cfg);
    }

    fn on_dt(&mut self, sa: u8, da: u8, data: &[u8], ts: u64, out: &mut Vec<TpEvent>) {
        let mode = if da == ADDRESS_GLOBAL {
            TpMode::Bam
        } else {
            TpMode::Cmdt
        };
        let Some(i) = self.find(mode, sa, da) else {
            self.stray();
            return;
        };
        let cfg = self.cfg;
        let s = &mut self.sessions[i];
        if s.state != CmdtState::Receiving {
            self.remove_and_abort(
                i,
                TpAbortReason::UnexpectedDataTransfer,
                TpAbortDetail::DataWithoutCts,
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        }
        let Some(&seq) = data.first() else {
            self.remove_and_abort(
                i,
                TpAbortReason::NotListed,
                TpAbortDetail::WrongDlc { len: 0 },
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        };
        let seq16 = u16::from(seq);
        if seq16 < s.next_seq && seq != 0 {
            self.remove_and_abort(
                i,
                TpAbortReason::DuplicateSequenceNumber,
                TpAbortDetail::DuplicatePacket { seq },
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        }
        if seq16 != s.next_seq || seq16 > s.window_end {
            let expected = u8::try_from(s.next_seq).unwrap_or(u8::MAX);
            self.remove_and_abort(
                i,
                TpAbortReason::BadSequenceNumber,
                TpAbortDetail::SequenceGap { expected, got: seq },
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        }
        // Bytes this packet must carry; the last packet may be short of 7 (fill is optional
        // here, but a frame longer than classic CAN or shorter than needed is wrong-size).
        let offset = (usize::from(seq) - 1) * TP_BYTES_PER_PACKET;
        let needed = usize::from(s.size)
            .saturating_sub(offset)
            .min(TP_BYTES_PER_PACKET);
        if data.len() > 8 || data.len() < 1 + needed {
            let len = u8::try_from(data.len()).unwrap_or(u8::MAX);
            self.remove_and_abort(
                i,
                TpAbortReason::NotListed,
                TpAbortDetail::WrongDlc { len },
                AbortOrigin::Local,
                ts,
                out,
            );
            return;
        }
        let avail = (data.len() - 1).min(TP_BYTES_PER_PACKET);
        if let Some(dst) = s.buf.get_mut(offset..offset + avail) {
            dst.copy_from_slice(&data[1..1 + avail]);
        }
        s.next_seq += 1;
        if seq == s.total_packets {
            let s = self.sessions.swap_remove(i);
            let mut payload = s.buf;
            payload.truncate(usize::from(s.size));
            self.stats.completed = self.stats.completed.saturating_add(1);
            out.push(TpEvent::Completed(TpMessage {
                mode: s.mode,
                pgn: s.pgn,
                sa: s.sa,
                da: s.da,
                payload,
                started_us: s.started_us,
                completed_us: ts,
            }));
        } else if s.mode == TpMode::Cmdt && s.next_seq > s.window_end {
            // Window done: the originator waits T3 for the next CTS.
            s.state = CmdtState::AwaitingCts;
            s.arm(ts, TpTimer::T3, &cfg);
        } else {
            s.arm(ts, TpTimer::T1, &cfg);
        }
    }
}

/// Error building a TP control frame.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TpBuildError {
    #[error(transparent)]
    Id(#[from] J1939IdError),
    #[error("CTS next sequence number must be 1..=255, got 0")]
    InvalidNextSequence,
    #[error("message size {0} outside 9..=1785")]
    InvalidSize(u16),
    #[error("packet count {packets} does not match size {size} (expected ceil(size / 7))")]
    PacketCountMismatch { size: u16, packets: u8 },
    #[error("transported PGN 0x{0:X} exceeds 18 bits")]
    InvalidPgn(u32),
}

fn cm_frame(
    sa: u8,
    da: u8,
    body: [u8; 5],
    transported_pgn: u32,
) -> Result<J1939Frame, TpBuildError> {
    if transported_pgn > MAX_PGN {
        return Err(TpBuildError::InvalidPgn(transported_pgn));
    }
    let id = J1939Id::from_pgn(TP_DEFAULT_PRIORITY, PGN_TP_CM, da, sa)?;
    let p = pgn_to_le3(transported_pgn);
    Ok(J1939Frame {
        id: id.encode(),
        data: [
            body[0], body[1], body[2], body[3], body[4], p[0], p[1], p[2],
        ],
        len: 8,
    })
}

/// TP.CM_CTS (responder `sa` → originator `da`). `num_packets = 0` means "hold" (Th / T4).
/// Byte 3 is the next sequence number expected (1..=255).
///
/// TX action: the HAL must send it only through the gated TX path (Listen-Only lock, Arm
/// Active Bus, Panic Stop) and should respect Tr (200 ms) / Th (500 ms) when responding.
pub fn build_tp_cts(
    sa: u8,
    da: u8,
    transported_pgn: u32,
    num_packets: u8,
    next_seq: u8,
) -> Result<J1939Frame, TpBuildError> {
    if next_seq == 0 {
        return Err(TpBuildError::InvalidNextSequence);
    }
    cm_frame(
        sa,
        da,
        [CM_CTS, num_packets, next_seq, 0xFF, 0xFF],
        transported_pgn,
    )
}

/// TP.CM_EndOfMsgAck (responder `sa` → originator `da`).
/// TX action: gate through the HAL TX path.
pub fn build_tp_end_of_msg_ack(
    sa: u8,
    da: u8,
    transported_pgn: u32,
    size: u16,
    total_packets: u8,
) -> Result<J1939Frame, TpBuildError> {
    if !(TP_MIN_SIZE..=TP_MAX_SIZE).contains(&usize::from(size)) {
        return Err(TpBuildError::InvalidSize(size));
    }
    if usize::from(total_packets) != usize::from(size).div_ceil(TP_BYTES_PER_PACKET) {
        return Err(TpBuildError::PacketCountMismatch {
            size,
            packets: total_packets,
        });
    }
    let [lo, hi] = size.to_le_bytes();
    cm_frame(
        sa,
        da,
        [CM_END_OF_MSG_ACK, lo, hi, total_packets, 0xFF],
        transported_pgn,
    )
}

/// TP.Conn_Abort (`sa` → `da`) with a J1939-21 reason code. Bytes 3..5 are 0xFF.
/// TX action: gate through the HAL TX path.
pub fn build_tp_abort(
    sa: u8,
    da: u8,
    transported_pgn: u32,
    reason: TpAbortReason,
) -> Result<J1939Frame, TpBuildError> {
    cm_frame(
        sa,
        da,
        [CM_ABORT, reason.code(), 0xFF, 0xFF, 0xFF],
        transported_pgn,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test helper: builds TP frames from the bit layout (constructed vectors, not captured).
    fn cm_id(sa: u8, da: u8) -> u32 {
        J1939Id::from_pgn(7, PGN_TP_CM, da, sa).unwrap().encode()
    }
    fn dt_id(sa: u8, da: u8) -> u32 {
        J1939Id::from_pgn(7, PGN_TP_DT, da, sa).unwrap().encode()
    }
    fn announce(ctrl: u8, size: u16, packets: u8, extra: u8, pgn: u32) -> [u8; 8] {
        let [lo, hi] = size.to_le_bytes();
        let p = pgn_to_le3(pgn);
        [ctrl, lo, hi, packets, extra, p[0], p[1], p[2]]
    }
    fn cts(n: u8, next: u8, pgn: u32) -> [u8; 8] {
        let p = pgn_to_le3(pgn);
        [CM_CTS, n, next, 0xFF, 0xFF, p[0], p[1], p[2]]
    }
    fn dt_frames(payload: &[u8]) -> Vec<[u8; 8]> {
        payload
            .chunks(7)
            .enumerate()
            .map(|(i, c)| {
                let mut f = [0xFF; 8];
                f[0] = (i + 1) as u8;
                f[1..1 + c.len()].copy_from_slice(c);
                f
            })
            .collect()
    }
    fn payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 + 3) as u8).collect()
    }
    fn completed(ev: &[TpEvent]) -> Vec<&TpMessage> {
        ev.iter()
            .filter_map(|e| match e {
                TpEvent::Completed(m) => Some(m),
                TpEvent::Aborted(_) => None,
            })
            .collect()
    }
    fn aborts(ev: &[TpEvent]) -> Vec<&TpAbort> {
        ev.iter()
            .filter_map(|e| match e {
                TpEvent::Aborted(a) => Some(a),
                TpEvent::Completed(_) => None,
            })
            .collect()
    }

    const DM1: u32 = 65226;

    #[test]
    fn tp_bam_three_packets_complete() {
        // DM1 with 4 DTCs = 2 + 16 = 18 bytes → 3 packets (constructed).
        let data = payload(18);
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            0,
            &mut ev,
        );
        assert!(ev.is_empty());
        for (k, f) in dt_frames(&data).iter().enumerate() {
            r.feed_raw(dt_id(0x00, 0xFF), true, f, 50_000 * (k as u64 + 1), &mut ev);
        }
        let done = completed(&ev);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].mode, TpMode::Bam);
        assert_eq!(done[0].pgn, DM1);
        assert_eq!(done[0].sa, 0x00);
        assert_eq!(done[0].da, 0xFF);
        assert_eq!(done[0].payload, data);
        assert_eq!(done[0].completed_us, 150_000);
        assert_eq!(r.active_sessions(), 0);
        assert_eq!(r.stats().completed, 1);
    }

    #[test]
    fn tp_bam_timeout_t1() {
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x03, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            1_000,
            &mut ev,
        );
        let f = dt_frames(&payload(18));
        r.feed_raw(dt_id(0x03, 0xFF), true, &f[0], 100_000, &mut ev);
        // Exactly T1 after the last packet: still alive.
        r.poll(100_000 + T1_US, &mut ev);
        assert!(ev.is_empty());
        r.poll(100_000 + T1_US + 1, &mut ev);
        let ab = aborts(&ev);
        assert_eq!(ab.len(), 1);
        assert_eq!(ab[0].reason, TpAbortReason::Timeout);
        assert_eq!(ab[0].reason.code(), 3);
        assert_eq!(ab[0].detail, TpAbortDetail::TimedOut { timer: TpTimer::T1 });
        assert_eq!(r.active_sessions(), 0);
        // A late packet is now stray.
        ev.clear();
        r.feed_raw(dt_id(0x03, 0xFF), true, &f[1], 2_000_000, &mut ev);
        assert!(ev.is_empty());
        assert_eq!(r.stats().stray_frames, 1);
    }

    #[test]
    fn tp_cmdt_rts_cts_dt_complete() {
        // 20 bytes, 3 packets, originator 0x00 → responder 0xF9, CTS windows of 2 then 1.
        let pgn = 0xFEE5;
        let data = payload(20);
        let frames = dt_frames(&data);
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        let t = |ms: u64| ms * 1000;
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 2, pgn),
            t(0),
            &mut ev,
        );
        // DT before CTS would be unexpected; we follow the handshake instead.
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(2, 1, pgn), t(10), &mut ev);
        r.feed_raw(dt_id(0x00, 0xF9), true, &frames[0], t(20), &mut ev);
        r.feed_raw(dt_id(0x00, 0xF9), true, &frames[1], t(30), &mut ev);
        // Hold, then continue.
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(0, 0xFF, pgn), t(40), &mut ev);
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(1, 3, pgn), t(500), &mut ev);
        r.feed_raw(dt_id(0x00, 0xF9), true, &frames[2], t(510), &mut ev);
        assert!(aborts(&ev).is_empty(), "{ev:?}");
        let done = completed(&ev);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].mode, TpMode::Cmdt);
        assert_eq!((done[0].sa, done[0].da, done[0].pgn), (0x00, 0xF9, pgn));
        assert_eq!(done[0].payload, data);
        // The EndOfMsgAck after completion matches no session: stray, no event.
        let eoma = announce(CM_END_OF_MSG_ACK, 20, 3, 0xFF, pgn);
        ev.clear();
        r.feed_raw(cm_id(0xF9, 0x00), true, &eoma, t(520), &mut ev);
        assert!(ev.is_empty());
    }

    #[test]
    fn tp_cmdt_retransmit_rewind() {
        // Responder requests packet 1 again after window [1,2]: allowed rewind.
        let pgn = 0xFEE5;
        let data = payload(14);
        let frames = dt_frames(&data);
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x10, 0x20),
            true,
            &announce(CM_RTS, 14, 2, 0xFF, pgn),
            0,
            &mut ev,
        );
        r.feed_raw(cm_id(0x20, 0x10), true, &cts(1, 1, pgn), 1, &mut ev);
        r.feed_raw(dt_id(0x10, 0x20), true, &frames[0], 2, &mut ev);
        r.feed_raw(cm_id(0x20, 0x10), true, &cts(2, 1, pgn), 3, &mut ev);
        r.feed_raw(dt_id(0x10, 0x20), true, &frames[0], 4, &mut ev);
        r.feed_raw(dt_id(0x10, 0x20), true, &frames[1], 5, &mut ev);
        assert_eq!(completed(&ev).len(), 1);
        assert_eq!(completed(&ev)[0].payload, data);
    }

    #[test]
    fn tp_wrong_sequence_aborts() {
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        let frames = dt_frames(&payload(18));
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            0,
            &mut ev,
        );
        r.feed_raw(dt_id(0x00, 0xFF), true, &frames[0], 10, &mut ev);
        // Skip packet 2.
        r.feed_raw(dt_id(0x00, 0xFF), true, &frames[2], 20, &mut ev);
        let ab = aborts(&ev);
        assert_eq!(ab.len(), 1);
        assert_eq!(ab[0].reason, TpAbortReason::BadSequenceNumber);
        assert_eq!(ab[0].reason.code(), 7);
        assert_eq!(
            ab[0].detail,
            TpAbortDetail::SequenceGap {
                expected: 2,
                got: 3
            }
        );

        // Duplicate packet 1.
        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            30,
            &mut ev,
        );
        r.feed_raw(dt_id(0x00, 0xFF), true, &frames[0], 40, &mut ev);
        r.feed_raw(dt_id(0x00, 0xFF), true, &frames[0], 50, &mut ev);
        let ab = aborts(&ev);
        assert_eq!(ab[0].reason, TpAbortReason::DuplicateSequenceNumber);
        assert_eq!(ab[0].reason.code(), 8);

        // Sequence 0 is never valid.
        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            60,
            &mut ev,
        );
        let mut z = frames[0];
        z[0] = 0;
        r.feed_raw(dt_id(0x00, 0xFF), true, &z, 70, &mut ev);
        assert_eq!(aborts(&ev)[0].reason, TpAbortReason::BadSequenceNumber);
    }

    #[test]
    fn tp_wrong_size_dt_aborts() {
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            0,
            &mut ev,
        );
        // Packet 1 must carry 7 bytes; DLC 5 is too short.
        r.feed_raw(dt_id(0x00, 0xFF), true, &[1, 1, 2, 3, 4], 10, &mut ev);
        let ab = aborts(&ev);
        assert_eq!(ab[0].detail, TpAbortDetail::WrongDlc { len: 5 });
        assert_eq!(ab[0].reason.code(), 250);
        // A short LAST packet carrying all remaining bytes is accepted (lenient fill).
        ev.clear();
        let data = payload(16);
        let f = dt_frames(&data);
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 16, 3, 0xFF, DM1),
            20,
            &mut ev,
        );
        r.feed_raw(dt_id(0x00, 0xFF), true, &f[0], 30, &mut ev);
        r.feed_raw(dt_id(0x00, 0xFF), true, &f[1], 40, &mut ev);
        r.feed_raw(dt_id(0x00, 0xFF), true, &f[2][..3], 50, &mut ev);
        assert_eq!(completed(&ev)[0].payload, data);
    }

    #[test]
    fn tp_cmdt_dt_without_cts_and_cts_during_transfer() {
        let pgn = 0xFEE5;
        let frames = dt_frames(&payload(20));
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 0xFF, pgn),
            0,
            &mut ev,
        );
        r.feed_raw(dt_id(0x00, 0xF9), true, &frames[0], 1, &mut ev);
        assert_eq!(aborts(&ev)[0].reason, TpAbortReason::UnexpectedDataTransfer);
        assert_eq!(aborts(&ev)[0].detail, TpAbortDetail::DataWithoutCts);

        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 0xFF, pgn),
            2,
            &mut ev,
        );
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(3, 1, pgn), 3, &mut ev);
        r.feed_raw(dt_id(0x00, 0xF9), true, &frames[0], 4, &mut ev);
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(3, 1, pgn), 5, &mut ev);
        assert_eq!(aborts(&ev)[0].reason, TpAbortReason::CtsWhileTransferring);
    }

    #[test]
    fn tp_cmdt_timeouts_t2_t3_t4() {
        let pgn = 0xFEE5;
        let mut ev = Vec::new();
        // T3: no CTS after RTS.
        let mut r = Reassembler::default();
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 0xFF, pgn),
            0,
            &mut ev,
        );
        r.poll(T3_US + 1, &mut ev);
        assert_eq!(
            aborts(&ev)[0].detail,
            TpAbortDetail::TimedOut { timer: TpTimer::T3 }
        );
        // T2: CTS, then no DT.
        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 0xFF, pgn),
            0,
            &mut ev,
        );
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(3, 1, pgn), 0, &mut ev);
        r.poll(T2_US + 1, &mut ev);
        assert_eq!(
            aborts(&ev)[0].detail,
            TpAbortDetail::TimedOut { timer: TpTimer::T2 }
        );
        // T4: hold CTS, then no further CTS.
        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 0xFF, pgn),
            0,
            &mut ev,
        );
        r.feed_raw(cm_id(0xF9, 0x00), true, &cts(0, 0xFF, pgn), 0, &mut ev);
        r.poll(T4_US, &mut ev);
        assert!(ev.is_empty());
        r.poll(T4_US + 1, &mut ev);
        assert_eq!(
            aborts(&ev)[0].detail,
            TpAbortDetail::TimedOut { timer: TpTimer::T4 }
        );
    }

    #[test]
    fn tp_remote_abort() {
        let pgn = 0xFEE5;
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x00, 0xF9),
            true,
            &announce(CM_RTS, 20, 3, 0xFF, pgn),
            0,
            &mut ev,
        );
        let p = pgn_to_le3(pgn);
        let abort = [CM_ABORT, 2, 0xFF, 0xFF, 0xFF, p[0], p[1], p[2]];
        r.feed_raw(cm_id(0xF9, 0x00), true, &abort, 5, &mut ev);
        let ab = aborts(&ev);
        assert_eq!(ab[0].origin, AbortOrigin::Remote);
        assert_eq!(ab[0].reason, TpAbortReason::ResourcesNeeded);
        assert_eq!(r.active_sessions(), 0);
    }

    #[test]
    fn tp_session_cap_dropped_counter() {
        let mut r = Reassembler::new(ReassemblerConfig {
            max_sessions: 4,
            ..ReassemblerConfig::default()
        });
        let mut ev = Vec::new();
        for sa in 0..6u8 {
            r.feed_raw(
                cm_id(sa, 0xFF),
                true,
                &announce(CM_BAM, 18, 3, 0xFF, DM1),
                0,
                &mut ev,
            );
        }
        assert_eq!(r.active_sessions(), 4);
        assert_eq!(r.stats().dropped, 2);
        let ab = aborts(&ev);
        assert_eq!(ab.len(), 2);
        assert!(ab
            .iter()
            .all(|a| a.detail == TpAbortDetail::SessionCapReached
                && a.reason == TpAbortReason::AlreadyInSession));

        // Default cap 64.
        let mut r = Reassembler::default();
        ev.clear();
        for sa in 0..=99u8 {
            r.feed_raw(
                cm_id(sa, 0xFF),
                true,
                &announce(CM_BAM, 18, 3, 0xFF, DM1),
                0,
                &mut ev,
            );
        }
        assert_eq!(r.active_sessions(), DEFAULT_MAX_SESSIONS);
        assert_eq!(r.stats().dropped, 36);
    }

    #[test]
    fn tp_one_bam_per_sa_replaces() {
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            0,
            &mut ev,
        );
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 3, 0xFF, DM1),
            10,
            &mut ev,
        );
        assert_eq!(r.active_sessions(), 1);
        assert_eq!(
            aborts(&ev)[0].detail,
            TpAbortDetail::ReplacedByNewAnnouncement
        );
    }

    #[test]
    fn tp_max_size_1785_and_1786_rejected() {
        let data = payload(TP_MAX_SIZE);
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 1785, 255, 0xFF, DM1),
            0,
            &mut ev,
        );
        for (k, f) in dt_frames(&data).iter().enumerate() {
            r.feed_raw(dt_id(0x00, 0xFF), true, f, (k as u64 + 1) * 50_000, &mut ev);
        }
        let done = completed(&ev);
        assert_eq!(done.len(), 1, "{:?}", aborts(&ev));
        assert_eq!(done[0].payload.len(), 1785);
        assert_eq!(done[0].payload, data);

        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 1786, 255, 0xFF, DM1),
            0,
            &mut ev,
        );
        let ab = aborts(&ev);
        assert_eq!(ab[0].reason, TpAbortReason::MessageTooLarge);
        assert_eq!(ab[0].reason.code(), 9);
        assert_eq!(r.active_sessions(), 0);
        // Too small and packet-count mismatch are rejected too.
        ev.clear();
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 8, 2, 0xFF, DM1),
            0,
            &mut ev,
        );
        r.feed_raw(
            cm_id(0x00, 0xFF),
            true,
            &announce(CM_BAM, 18, 4, 0xFF, DM1),
            0,
            &mut ev,
        );
        let ab = aborts(&ev);
        assert_eq!(ab[0].detail, TpAbortDetail::SizeOutOfRange { size: 8 });
        assert_eq!(
            ab[1].detail,
            TpAbortDetail::PacketCountMismatch {
                size: 18,
                packets: 4
            }
        );
        assert!(build_tp_end_of_msg_ack(0xF9, 0x00, DM1, 1786, 255).is_err());
    }

    #[test]
    fn tp_builders() {
        let f = build_tp_cts(0xF9, 0x00, 0xFEE5, 2, 1).unwrap();
        assert_eq!(f.id, 0x1CEC_00F9);
        assert_eq!(f.data, [17, 2, 1, 0xFF, 0xFF, 0xE5, 0xFE, 0x00]);
        assert_eq!(f.len, 8);
        assert_eq!(
            build_tp_cts(0xF9, 0x00, 0xFEE5, 2, 0),
            Err(TpBuildError::InvalidNextSequence)
        );
        let f = build_tp_end_of_msg_ack(0xF9, 0x00, 0xFEE5, 20, 3).unwrap();
        assert_eq!(f.data, [19, 20, 0, 3, 0xFF, 0xE5, 0xFE, 0x00]);
        assert!(matches!(
            build_tp_end_of_msg_ack(0xF9, 0x00, 0xFEE5, 20, 4),
            Err(TpBuildError::PacketCountMismatch { .. })
        ));
        let f = build_tp_abort(0xF9, 0x00, 0xFEE5, TpAbortReason::Timeout).unwrap();
        assert_eq!(f.data, [255, 3, 0xFF, 0xFF, 0xFF, 0xE5, 0xFE, 0x00]);
        assert!(build_tp_abort(0xF9, 0x00, 0x4_0000, TpAbortReason::Timeout).is_err());
        for c in 0..=255u8 {
            assert_eq!(TpAbortReason::from_code(c).code(), c);
        }
    }

    #[test]
    fn tp_ignores_non_tp_and_11bit() {
        let mut r = Reassembler::default();
        let mut ev = Vec::new();
        r.feed_raw(0x18FE_CA00, true, &[0; 8], 0, &mut ev);
        r.feed_raw(0x7DF, false, &[0; 8], 0, &mut ev);
        // Short TP.CM is stray.
        r.feed_raw(cm_id(0, 0xFF), true, &[CM_BAM, 1, 2], 0, &mut ev);
        assert!(ev.is_empty());
        assert_eq!(r.stats().stray_frames, 1);
    }

    #[test]
    fn tp_fuzz_never_panics_and_stays_bounded() {
        let mut x: u64 = 0x0123_4567_89AB_CDEF;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let mut r = Reassembler::new(ReassemblerConfig {
            max_sessions: 8,
            ..ReassemblerConfig::default()
        });
        let mut ev = Vec::new();
        let mut buf = [0u8; 64];
        let mut ts = 0u64;
        for _ in 0..20_000 {
            let v = next();
            let sa = (v & 0x07) as u8;
            let da = if v & 0x100 != 0 {
                0xFF
            } else {
                ((v >> 3) & 0x07) as u8
            };
            let id = if v & 0x200 != 0 {
                cm_id(sa, da)
            } else {
                dt_id(sa, da)
            };
            let len = ((v >> 16) % 12) as usize;
            for b in buf.iter_mut().take(len) {
                *b = next() as u8;
            }
            if v & 0x400 != 0 && len >= 1 {
                // Bias toward valid control bytes / small sequence numbers.
                buf[0] = [CM_BAM, CM_RTS, CM_CTS, CM_ABORT, 1, 2, 3][(v >> 40) as usize % 7];
            }
            ts = ts.wrapping_add((v >> 48) % 400_000);
            r.feed_raw(id, true, &buf[..len], ts, &mut ev);
            assert!(r.active_sessions() <= 8);
            for e in ev.drain(..) {
                if let TpEvent::Completed(m) = e {
                    assert!((TP_MIN_SIZE..=TP_MAX_SIZE).contains(&m.payload.len()));
                }
            }
        }
        r.poll(u64::MAX, &mut ev);
        assert_eq!(r.active_sessions(), 0);
    }
}
