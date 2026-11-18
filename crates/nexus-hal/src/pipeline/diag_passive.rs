//! Passive ECU discovery: finds diagnostic tester ↔ ECU id pairs by WATCHING existing traffic.
//! Sends nothing, ever: it runs on a [`PassiveTap`] (RX-only, no TX sender, no gate), so it
//! works on Listen-Only buses and survives Panic Stop / disarm.
//!
//! # Heuristic
//!
//! Every frame is classified by its ISO-TP PCI (normal / normalFixed addressing: PCI in byte 0).
//! Strict plausibility checks keep ordinary signal traffic out:
//!
//! * SF: classic `0x0N` (N = 1..=7, DLC = N + 1 or 8) or CAN-FD escape `00 len` (DLC > 8);
//!   when there are >= 2 padding bytes they must all be equal (ISO 15765-2 padding).
//! * FF: announced length larger than one frame can carry; classic FF is always 8 bytes.
//! * FC: `0x30..=0x32`, valid STmin, DLC 3 or 8 (classic), uniform padding.
//!
//! Then:
//!
//! 1. **Request**: an SF / FF on id X whose first payload byte is a known UDS request SID
//!    (0x10..=0x3E, 0x83..=0x87) with a plausible length / sub-function, or an OBD service
//!    0x01..=0x0A on a legislated OBD request id (11-bit 0x7DF / 0x7E0..=0x7E7, 29-bit
//!    0x18DB33F1 / 0x18DA_xx_F1). It is kept as *pending* for P2* (5 s, restarted by `7F sid 78`).
//! 2. **Response**: an SF / FF on id Y != X (same id width) within P2* whose first payload byte
//!    is `sid + 0x40` with the request's echo bytes (sub-function, DID, RID, PID), or exactly
//!    `7F sid nrc` (3-byte SF, nrc != 0). The pair is (X, Y). If several pending requests fit,
//!    one already paired with Y wins, else the most recent one.
//! 3. **Flow Control**: an FC on id B within N_Bs (1 s) after an FF on id A pairs them: FF with
//!    a request SID → (A, B); FF with a response SID → (B, A) (B must be the tester the response
//!    was matched to, when known).
//!
//! **Strong vs weak evidence.** At 50k frames/s random payloads hit unpadded SF shapes
//! (`03 37 xx` with DLC 4) and 3-byte FCs often enough, so a NEW pair is created only by
//! *strong* evidence: a negative response `7F sid nrc` with a defined NRC; a positive response
//! echoing >= 2 request bytes (DID, RID, address); a 1-byte echo (sub-function, PID) when the
//! request or the response is ISO-TP padded (>= 2 equal padding bytes); a request AND response
//! that are both padded; or a padded (8-byte) FC. Weak matches only add evidence to an
//! EXISTING pair. (Measured: 1M random frames at 50k frames/s, 0 pairs.)
//!
//! Evidence: one per (pending request, responder) for responses (a `7F sid 78` followed by the
//! final answer counts once; several ECUs answering one functional request count once each),
//! plus one per Flow Control match. Confidence: 1..=2 low, 3..=9 medium, >= 10 or any FC match
//! high.
//!
//! TODO(extended addressing): with extended / mixed addressing the PCI is in byte 1 after an
//! N_TA / N_AE byte; such traffic is not recognized yet (it fails the PCI plausibility).
//!
//! # Cost
//!
//! The bus-io thread only copies frames into the tap queue (no allocation). The analyzer thread
//! is O(1) per frame and allocation-free: fixed pending tables ([`MAX_PENDING_REQUESTS`],
//! [`MAX_PENDING_FIRST_FRAMES`] entries, linear scans) and a pair table + index pre-allocated
//! for [`MAX_PASSIVE_PAIRS`] entries (never grown; overflow is counted, `truncated`).

use super::diag_tap::{PassiveTap, TapRegisterError};
use super::*;
use crate::dto::{PassiveConfidenceDto, PassiveDiscoverySnapshotDto, PassiveEcuPairDto};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

/// Max distinct (request id, response id, id width) pairs tracked per bus.
pub const MAX_PASSIVE_PAIRS: usize = 512;
/// Outstanding requests tracked at once (oldest evicted first when full).
pub const MAX_PENDING_REQUESTS: usize = 64;
/// First Frames awaiting a Flow Control at once.
pub const MAX_PENDING_FIRST_FRAMES: usize = 32;
/// Response window after a request (ISO 14229-2 P2*server default 5000 ms).
pub const P2_STAR_US: u64 = 5_000_000;
/// Flow Control window after a First Frame (ISO 15765-2 N_Bs timeout 1000 ms).
pub const N_BS_US: u64 = 1_000_000;
/// Tolerated negative skew between a request and its answer (TX echo timestamps are taken
/// after the driver write, RX timestamps by the kernel / adapter).
const TS_SKEW_US: u64 = 10_000;
/// Distinct responders remembered per pending request (dedupe of 0x78 + final answer).
const RESPONDERS_PER_REQUEST: usize = 8;
/// Tap queue depth of a passive scan (~1.3 s at 50k frames/s).
const PASSIVE_TAP_DEPTH: usize = 65_536;
/// Max frames processed per analyzer lock (keeps snapshots responsive at bus rate).
const ANALYZE_BATCH: usize = 1_024;
/// Worker wake-up period: bounds stop latency.
const WORKER_POLL: Duration = Duration::from_millis(20);

// ─── frame classification ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pci<'a> {
    /// Single Frame payload; `padded` = >= 2 (equal) padding bytes.
    Sf {
        pdu: &'a [u8],
        padded: bool,
    },
    /// First Frame: announced length + data bytes in this frame.
    Ff {
        total: u32,
        first: &'a [u8],
    },
    /// Flow Control (any flow status); `padded` = >= 2 (equal) padding bytes.
    Fc {
        padded: bool,
    },
    None,
}

/// Shape of the frame that carried a PDU.
#[derive(Clone, Copy)]
enum PduShape {
    Single { padded: bool },
    First { total: u32 },
}

/// `true` when `pad` is empty, one byte, or all bytes equal.
#[inline]
fn uniform(pad: &[u8]) -> bool {
    match pad.split_first() {
        Some((first, rest)) => rest.iter().all(|b| b == first),
        None => true,
    }
}

/// ISO-TP PCI of one CAN payload with plausibility checks (see module docs).
fn classify(data: &[u8], fd: bool) -> Pci<'_> {
    let len = data.len();
    let Some(&b0) = data.first() else {
        return Pci::None;
    };
    match b0 >> 4 {
        0x0 => {
            let n = usize::from(b0 & 0x0F);
            if n != 0 {
                // Classic SF PCI: only in frames of up to 8 bytes.
                if len > 8 || len < n + 1 || n > 7 {
                    return Pci::None;
                }
                if len != n + 1 && len != 8 {
                    return Pci::None;
                }
                let pad = &data[n + 1..];
                if !uniform(pad) {
                    return Pci::None;
                }
                Pci::Sf {
                    pdu: &data[1..=n],
                    padded: pad.len() >= 2,
                }
            } else {
                // CAN-FD escape SF: only in frames longer than 8 bytes.
                if !fd || len <= 8 {
                    return Pci::None;
                }
                let n = usize::from(data[1]);
                if n < 7 || n + 2 > len || !uniform(&data[n + 2..]) {
                    return Pci::None;
                }
                Pci::Sf {
                    pdu: &data[2..n + 2],
                    padded: len - (n + 2) >= 2,
                }
            }
        }
        0x1 => {
            if len < 8 || (!fd && len != 8) {
                return Pci::None;
            }
            let short = (u32::from(b0 & 0x0F) << 8) | u32::from(data[1]);
            if short != 0 {
                // Must not fit into a single frame of this size.
                let sf_room = if len > 8 { len - 2 } else { 7 };
                if short as usize <= sf_room {
                    return Pci::None;
                }
                Pci::Ff {
                    total: short,
                    first: &data[2..],
                }
            } else {
                let total = u32::from_be_bytes([data[2], data[3], data[4], data[5]]);
                if total <= 4_095 {
                    return Pci::None;
                }
                Pci::Ff {
                    total,
                    first: &data[6..],
                }
            }
        }
        0x3 => {
            let fs = b0 & 0x0F;
            if fs > 2 || len < 3 || (!fd && len != 3 && len != 8) {
                return Pci::None;
            }
            let st_min = data[2];
            if !(st_min <= 0x7F || (0xF1..=0xF9).contains(&st_min)) {
                return Pci::None;
            }
            if !uniform(&data[3..]) {
                return Pci::None;
            }
            Pci::Fc {
                padded: len - 3 >= 2,
            }
        }
        _ => Pci::None,
    }
}

/// UDS services with a sub-function byte (bit 7 = suppressPosRspMsgIndicationBit).
#[inline]
fn has_sub_function(sid: u8) -> bool {
    matches!(
        sid,
        0x10 | 0x11 | 0x19 | 0x27 | 0x28 | 0x29 | 0x2C | 0x31 | 0x3E | 0x83 | 0x85 | 0x86 | 0x87
    )
}

/// Legislated OBD request id (11-bit 0x7DF / 0x7E0..=0x7E7, 29-bit 0x18DB33F1 / 0x18DA_xx_F1).
#[inline]
fn is_obd_request_id(id: u32, ext: bool) -> bool {
    if ext {
        id == 0x18DB_33F1 || (id & 0x1FFF_00FF) == 0x18DA_00F1
    } else {
        id == 0x7DF || (0x7E0..=0x7E7).contains(&id)
    }
}

/// Legislated OBD response id (11-bit 0x7E8..=0x7EF, 29-bit 0x18DA_F1_xx).
#[inline]
fn is_obd_response_id(id: u32, ext: bool) -> bool {
    if ext {
        (id & 0x1FFF_FF00) == 0x18DA_F100
    } else {
        (0x7E8..=0x7EF).contains(&id)
    }
}

/// Functional request id (11-bit 0x7DF, 29-bit PF 0xDB).
#[inline]
fn is_functional_id(id: u32, ext: bool) -> bool {
    if ext {
        (id & 0x03FF_0000) == 0x00DB_0000
    } else {
        id == 0x7DF
    }
}

/// Plausible UDS / OBD request: `pdu` = SF payload or FF first bytes, `total` = PDU length.
fn request_plausible(pdu: &[u8], total: u32, id: u32, ext: bool) -> bool {
    let Some(&sid) = pdu.first() else {
        return false;
    };
    let sub = pdu.get(1).map(|b| b & 0x7F);
    let t = total;
    match sid {
        0x01..=0x0A => {
            is_obd_request_id(id, ext)
                && match sid {
                    0x03 | 0x04 | 0x07 | 0x0A => t == 1,
                    _ => (2..=7).contains(&t),
                }
        }
        0x10 | 0x11 => t == 2 && sub.is_some_and(|s| s != 0),
        0x3E => t == 2 && sub == Some(0),
        0x14 => t == 4 || t == 5,
        0x19 | 0x27 | 0x2C | 0x83 | 0x85 | 0x87 => t >= 2 && sub.is_some_and(|s| s != 0),
        0x22 => t >= 3 && t & 1 == 1, // SID + n * 2-byte DIDs
        0x23 | 0x2E | 0x2F | 0x3D => t >= 4,
        0x24 => t == 3,
        0x28 => t >= 3,
        0x29 | 0x2A | 0x36 | 0x84 | 0x86 => t >= 2,
        0x31 => t >= 4 && sub.is_some_and(|s| (1..=3).contains(&s)),
        0x34 | 0x35 | 0x38 => t >= 5,
        0x37 => t >= 1,
        _ => false,
    }
}

/// Request bytes the positive response must echo, by service (`n` bytes after the SID).
#[inline]
fn echo_len(sid: u8) -> usize {
    match sid {
        0x22 | 0x24 | 0x2E | 0x2F => 2,
        0x31 | 0x3D => 3,
        0x01 | 0x02 | 0x06 | 0x08 | 0x09 | 0x36 | 0x38 => 1,
        s if has_sub_function(s) => 1,
        _ => 0,
    }
}

/// NRC values defined by ISO 14229-1 (incl. 0x78 responsePending and the 0x81..=0x93
/// conditions-not-correct family).
#[inline]
fn is_defined_nrc(nrc: u8) -> bool {
    matches!(
        nrc,
        0x10..=0x14
            | 0x21..=0x26
            | 0x31
            | 0x33
            | 0x35..=0x37
            | 0x70..=0x73
            | 0x78
            | 0x7E
            | 0x7F
            | 0x81..=0x93
    )
}

/// Length rule of a positive response (`total` = PDU length) where the service fixes it.
#[inline]
fn positive_len_ok(sid: u8, total: u32) -> bool {
    match sid {
        0x10 => total == 2 || total == 6,
        0x11 => total == 2 || total == 3,
        0x3E | 0x85 => total == 2,
        0x14 => total == 1,
        0x2E => total == 3,
        0x22 | 0x24 | 0x2F | 0x31 => total >= 4,
        0x19 | 0x27 | 0x28 | 0x29 | 0x2C | 0x83 | 0x86 | 0x87 => total >= 2,
        _ => total >= 1,
    }
}

/// Response of `pdu` (SF payload or FF first bytes), as `(request sid, negative, nrc)`.
fn response_sid(pdu: &[u8], is_sf: bool, total: u32) -> Option<(u8, bool, u8)> {
    match pdu {
        [0x7F, sid, nrc, ..] if is_sf && total == 3 && is_defined_nrc(*nrc) => {
            Some((*sid, true, *nrc))
        }
        [r, ..]
            if (0x41..=0x4A).contains(r)
                || (0x50..=0x7E).contains(r)
                || (0xC3..=0xC7).contains(r) =>
        {
            let sid = r - 0x40;
            positive_len_ok(sid, total).then_some((sid, false, 0))
        }
        _ => None,
    }
}

// ─── analyzer state ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Default)]
struct PendingReq {
    used: bool,
    id: u32,
    ext: bool,
    ts: u64,
    sid: u8,
    /// Request bytes after the SID (for echo checks).
    head: [u8; 3],
    head_len: u8,
    /// The request frame was ISO-TP padded (strong shape).
    padded: bool,
    responders: [u32; RESPONDERS_PER_REQUEST],
    n_resp: u8,
}

impl PendingReq {
    fn seen(&self, id: u32) -> bool {
        self.responders[..usize::from(self.n_resp)].contains(&id)
    }

    fn note(&mut self, id: u32) {
        if usize::from(self.n_resp) < RESPONDERS_PER_REQUEST {
            self.responders[usize::from(self.n_resp)] = id;
            self.n_resp += 1;
        }
    }

    /// Request bytes a positive response echoes (0 = none).
    fn echo_bytes(&self) -> usize {
        echo_len(self.sid).min(usize::from(self.head_len))
    }

    /// The positive response `pdu` echoes this request's identifying bytes.
    fn echoes(&self, pdu: &[u8]) -> bool {
        let n = echo_len(self.sid).min(usize::from(self.head_len));
        if n == 0 {
            return true;
        }
        let Some(echo) = pdu.get(1..=n) else {
            return false;
        };
        if has_sub_function(self.sid) {
            // Sub-function echo without the suppress bit, then the rest verbatim (0x31 RID).
            echo[0] == self.head[0] & 0x7F && echo[1..] == self.head[1..n]
        } else {
            echo == &self.head[..n]
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FfRole {
    Request,
    Response,
}

#[derive(Clone, Copy)]
struct PendingFf {
    used: bool,
    id: u32,
    ext: bool,
    ts: u64,
    role: FfRole,
    sid: u8,
    /// Tester id the response FF was matched to (FC must come from it).
    peer: Option<u32>,
}

impl Default for PendingFf {
    fn default() -> Self {
        Self {
            used: false,
            id: 0,
            ext: false,
            ts: 0,
            role: FfRole::Request,
            sid: 0,
            peer: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct PairKey {
    request_id: u32,
    response_id: u32,
    ext: bool,
}

#[derive(Clone, Copy)]
struct PairState {
    key: PairKey,
    evidence: u32,
    first_seen_us: u64,
    last_seen_us: u64,
    sids: [u64; 4],
    fc: bool,
}

/// Pure passive-discovery analyzer (one per bus). See the module docs for the heuristic.
pub struct PassiveAnalyzer {
    bus_id: u8,
    pending: [PendingReq; MAX_PENDING_REQUESTS],
    ffs: [PendingFf; MAX_PENDING_FIRST_FRAMES],
    pairs: Vec<PairState>,
    index: FxHashMap<PairKey, u16>,
    frames: u64,
    dropped_pairs: u32,
    evicted_requests: u64,
}

impl PassiveAnalyzer {
    pub fn new(bus_id: u8) -> Self {
        Self {
            bus_id,
            pending: [PendingReq::default(); MAX_PENDING_REQUESTS],
            ffs: [PendingFf::default(); MAX_PENDING_FIRST_FRAMES],
            pairs: Vec::with_capacity(MAX_PASSIVE_PAIRS),
            index: FxHashMap::with_capacity_and_hasher(MAX_PASSIVE_PAIRS, Default::default()),
            frames: 0,
            dropped_pairs: 0,
            evicted_requests: 0,
        }
    }

    /// Frames analyzed so far.
    pub fn frames_analyzed(&self) -> u64 {
        self.frames
    }

    /// Feeds one bus frame (RX or TX echo). O(1), allocation-free.
    pub fn on_frame(&mut self, f: &RawCanFrame) {
        self.frames = self.frames.wrapping_add(1);
        if f.is_error() || f.flags & nexus_core::FLAG_RTR != 0 {
            return;
        }
        let ext = f.is_extended();
        let (id, ts) = (f.arb_id, f.timestamp_us);
        match classify(f.payload(), f.is_fd()) {
            Pci::Sf { pdu, padded } => self.on_pdu(id, ext, ts, pdu, PduShape::Single { padded }),
            Pci::Ff { total, first } => self.on_pdu(id, ext, ts, first, PduShape::First { total }),
            Pci::Fc { padded } => self.on_flow_control(id, ext, ts, padded),
            Pci::None => {}
        }
    }

    fn on_pdu(&mut self, id: u32, ext: bool, ts: u64, pdu: &[u8], shape: PduShape) {
        let (total, is_sf, padded) = match shape {
            PduShape::Single { padded } => (pdu.len() as u32, true, padded),
            PduShape::First { total } => (total, false, false),
        };
        if request_plausible(pdu, total, id, ext) {
            self.add_request(id, ext, ts, pdu, padded);
            if !is_sf {
                self.add_ff(id, ext, ts, FfRole::Request, pdu[0], None);
            }
            return;
        }
        let Some((sid, negative, nrc)) = response_sid(pdu, is_sf, total) else {
            return;
        };
        if (0x01..=0x0A).contains(&sid) && !is_obd_response_id(id, ext) {
            return;
        }
        let Some(idx) = self.match_request(id, ext, ts, sid, negative, pdu) else {
            return;
        };
        let req = &mut self.pending[idx];
        let request_id = req.id;
        // Strong: a defined NRC, >= 2 echoed bytes, 1 echoed byte with at least one padded
        // frame, or request AND response ISO-TP padded (module docs).
        let echo = req.echo_bytes();
        let strong = negative
            || echo >= 2
            || (echo == 1 && (req.padded || padded))
            || (req.padded && padded);
        if negative && nrc == 0x78 {
            // responsePending: the final answer may come up to P2* later.
            req.ts = ts;
        }
        let first_answer = !req.seen(id);
        req.note(id);
        if first_answer {
            self.add_evidence(request_id, id, ext, ts, sid, false, strong);
        }
        if !is_sf {
            self.add_ff(id, ext, ts, FfRole::Response, sid, Some(request_id));
        }
    }

    fn add_request(&mut self, id: u32, ext: bool, ts: u64, pdu: &[u8], padded: bool) {
        let mut slot = None;
        let mut oldest = (u64::MAX, 0usize);
        for (i, p) in self.pending.iter().enumerate() {
            if !p.used || ts.saturating_sub(p.ts) > P2_STAR_US {
                slot = Some(i);
                break;
            }
            if p.ts < oldest.0 {
                oldest = (p.ts, i);
            }
        }
        let i = slot.unwrap_or_else(|| {
            self.evicted_requests = self.evicted_requests.saturating_add(1);
            oldest.1
        });
        let mut head = [0u8; 3];
        let n = (pdu.len() - 1).min(3);
        head[..n].copy_from_slice(&pdu[1..=n]);
        self.pending[i] = PendingReq {
            used: true,
            id,
            ext,
            ts,
            sid: pdu[0],
            head,
            head_len: n as u8,
            padded,
            responders: [0; RESPONDERS_PER_REQUEST],
            n_resp: 0,
        };
    }

    /// Pending request answered by `pdu` on `resp_id` (see module docs, step 2).
    fn match_request(
        &self,
        resp_id: u32,
        ext: bool,
        ts: u64,
        sid: u8,
        negative: bool,
        pdu: &[u8],
    ) -> Option<usize> {
        let mut best: Option<(bool, u64, usize)> = None;
        for (i, p) in self.pending.iter().enumerate() {
            if !p.used
                || p.ext != ext
                || p.id == resp_id
                || p.sid != sid
                || ts.saturating_add(TS_SKEW_US) < p.ts
                || ts.saturating_sub(p.ts) > P2_STAR_US
                || (!negative && !p.echoes(pdu))
            {
                continue;
            }
            let paired = self.index.contains_key(&PairKey {
                request_id: p.id,
                response_id: resp_id,
                ext,
            });
            let cand = (paired, p.ts, i);
            if best.is_none_or(|b| (cand.0, cand.1) > (b.0, b.1)) {
                best = Some(cand);
            }
        }
        best.map(|b| b.2)
    }

    fn add_ff(&mut self, id: u32, ext: bool, ts: u64, role: FfRole, sid: u8, peer: Option<u32>) {
        let mut slot = None;
        let mut oldest = (u64::MAX, 0usize);
        for (i, p) in self.ffs.iter().enumerate() {
            if !p.used || ts.saturating_sub(p.ts) > N_BS_US {
                slot = Some(i);
                break;
            }
            if p.ts < oldest.0 {
                oldest = (p.ts, i);
            }
        }
        let i = slot.unwrap_or(oldest.1);
        self.ffs[i] = PendingFf {
            used: true,
            id,
            ext,
            ts,
            role,
            sid,
            peer,
        };
    }

    fn on_flow_control(&mut self, fc_id: u32, ext: bool, ts: u64, padded: bool) {
        let mut best: Option<(bool, u64, usize)> = None;
        for (i, p) in self.ffs.iter().enumerate() {
            if !p.used
                || p.ext != ext
                || p.id == fc_id
                || ts.saturating_add(TS_SKEW_US) < p.ts
                || ts.saturating_sub(p.ts) > N_BS_US
            {
                continue;
            }
            if p.peer.is_some_and(|peer| peer != fc_id) {
                continue;
            }
            let key = match p.role {
                FfRole::Request => (p.id, fc_id),
                FfRole::Response => (fc_id, p.id),
            };
            let paired = self.index.contains_key(&PairKey {
                request_id: key.0,
                response_id: key.1,
                ext,
            });
            if best.is_none_or(|b| (paired, p.ts) > (b.0, b.1)) {
                best = Some((paired, p.ts, i));
            }
        }
        let Some((_, _, i)) = best else {
            return;
        };
        let ff = self.ffs[i];
        // One FC per FF counts (WAIT frames repeat).
        self.ffs[i].used = false;
        let (request_id, response_id) = match ff.role {
            FfRole::Request => (ff.id, fc_id),
            FfRole::Response => (fc_id, ff.id),
        };
        // An unpadded 3-byte FC is too easy to hit by chance: it only reinforces.
        self.add_evidence(request_id, response_id, ext, ts, ff.sid, true, padded);
    }

    /// Adds one evidence to `(request_id, response_id)`. Only `strong` evidence may create a
    /// new pair (see the module docs).
    #[allow(clippy::too_many_arguments)]
    fn add_evidence(
        &mut self,
        request_id: u32,
        response_id: u32,
        ext: bool,
        ts: u64,
        sid: u8,
        fc: bool,
        strong: bool,
    ) {
        let key = PairKey {
            request_id,
            response_id,
            ext,
        };
        let idx = match self.index.get(&key) {
            Some(&i) => usize::from(i),
            None => {
                if !strong {
                    return;
                }
                if self.pairs.len() >= MAX_PASSIVE_PAIRS {
                    self.dropped_pairs = self.dropped_pairs.saturating_add(1);
                    return;
                }
                let i = self.pairs.len();
                // Both within the pre-allocated capacity: no reallocation.
                self.pairs.push(PairState {
                    key,
                    evidence: 0,
                    first_seen_us: ts,
                    last_seen_us: ts,
                    sids: [0; 4],
                    fc: false,
                });
                self.index.insert(key, i as u16);
                i
            }
        };
        let p = &mut self.pairs[idx];
        p.evidence = p.evidence.saturating_add(1);
        p.last_seen_us = p.last_seen_us.max(ts);
        p.first_seen_us = p.first_seen_us.min(ts);
        p.sids[usize::from(sid >> 6)] |= 1u64 << (sid & 0x3F);
        p.fc |= fc;
    }

    /// Confidence rule (module docs).
    pub fn confidence(evidence: u32, fc: bool) -> PassiveConfidenceDto {
        if fc || evidence >= 10 {
            PassiveConfidenceDto::High
        } else if evidence >= 3 {
            PassiveConfidenceDto::Medium
        } else {
            PassiveConfidenceDto::Low
        }
    }

    /// Pairs sorted by `(requestId, responseId)` (control plane: allocates).
    pub fn pairs(&self) -> Vec<PassiveEcuPairDto> {
        let mut out: Vec<PassiveEcuPairDto> = self
            .pairs
            .iter()
            .map(|p| PassiveEcuPairDto {
                bus_id: self.bus_id,
                request_id: p.key.request_id,
                response_id: p.key.response_id,
                is_extended_id: p.key.ext,
                evidence_count: p.evidence,
                first_seen_us: p.first_seen_us,
                last_seen_us: p.last_seen_us,
                sids_seen: (0u16..256)
                    .filter(|s| p.sids[usize::from(s >> 6)] & (1u64 << (s & 0x3F)) != 0)
                    .map(|s| s as u8)
                    .collect(),
                confidence: Self::confidence(p.evidence, p.fc),
                flow_control_seen: p.fc,
                functional_request: is_functional_id(p.key.request_id, p.key.ext),
            })
            .collect();
        out.sort_by_key(|p| (p.is_extended_id, p.request_id, p.response_id));
        out
    }

    pub fn truncated(&self) -> bool {
        self.dropped_pairs > 0
    }

    pub fn dropped_pairs(&self) -> u32 {
        self.dropped_pairs
    }

    pub fn evicted_requests(&self) -> u64 {
        self.evicted_requests
    }
}

// ─── per-bus scan runtime ───────────────────────────────────────────────────

struct ScanShared {
    analyzer: Mutex<PassiveAnalyzer>,
    running: AtomicBool,
    stop: AtomicBool,
    stop_reason: Mutex<Option<String>>,
    started_at_us: u64,
}

struct PassiveScan {
    shared: Arc<ScanShared>,
    tap: diag_tap::DiagTapStatus,
    join: Option<JoinHandle<()>>,
}

impl PassiveScan {
    fn stop(&mut self, reason: &str) {
        if !self.shared.stop.swap(true, Ordering::AcqRel) {
            let mut r = self.shared.stop_reason.lock();
            if r.is_none() && self.shared.running.load(Ordering::Acquire) {
                *r = Some(reason.to_string());
            }
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }

    fn snapshot(&self, bus_id: u8) -> PassiveDiscoverySnapshotDto {
        let (pairs, frames, truncated, dropped_pairs, evicted) = {
            let a = self.shared.analyzer.lock();
            (
                a.pairs(),
                a.frames_analyzed(),
                a.truncated(),
                a.dropped_pairs(),
                a.evicted_requests(),
            )
        };
        PassiveDiscoverySnapshotDto {
            bus_id,
            running: self.shared.running.load(Ordering::Acquire),
            stop_reason: self.shared.stop_reason.lock().clone(),
            started_at_us: self.shared.started_at_us,
            frames_analyzed: frames,
            frames_dropped: self.tap.rx_dropped(),
            pairs,
            truncated,
            dropped_pairs,
            max_pairs: MAX_PASSIVE_PAIRS as u32,
            evicted_requests: evicted,
        }
    }
}

fn run_passive_worker(tap: PassiveTap, shared: Arc<ScanShared>) {
    let reason = loop {
        if shared.stop.load(Ordering::Acquire) {
            break None;
        }
        match tap.recv_timeout(WORKER_POLL) {
            Ok(Some(first)) => {
                let mut a = shared.analyzer.lock();
                a.on_frame(&first);
                for _ in 1..ANALYZE_BATCH {
                    match tap.try_recv() {
                        Some(f) => a.on_frame(&f),
                        None => break,
                    }
                }
            }
            Ok(None) => {}
            Err(_) => break Some("bus disconnected or channel reopened (passive tap closed)"),
        }
    };
    if let Some(r) = reason {
        shared
            .stop_reason
            .lock()
            .get_or_insert_with(|| r.to_string());
    }
    shared.running.store(false, Ordering::Release);
    drop(tap);
}

/// Passive scans by bus, owned by [`PipelineEngine`].
#[derive(Default)]
pub(crate) struct PassiveScanMap(Mutex<HashMap<u8, PassiveScan>>);

impl PassiveScanMap {
    /// Stops every scan (engine shutdown).
    pub(crate) fn stop_all(&self) {
        let mut scans: Vec<PassiveScan> = self.0.lock().drain().map(|(_, s)| s).collect();
        for s in &mut scans {
            s.stop("engine shutdown");
        }
    }
}

impl Drop for PassiveScanMap {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn idle_snapshot(bus_id: u8) -> PassiveDiscoverySnapshotDto {
    PassiveDiscoverySnapshotDto {
        bus_id,
        running: false,
        stop_reason: None,
        started_at_us: 0,
        frames_analyzed: 0,
        frames_dropped: 0,
        pairs: Vec::new(),
        truncated: false,
        dropped_pairs: 0,
        max_pairs: MAX_PASSIVE_PAIRS as u32,
        evicted_requests: 0,
    }
}

impl PipelineEngine {
    /// Opens an RX-only tap on `bus_id` (connected bus required; NO TX gate because it cannot
    /// transmit). Match-all acceptance filter.
    fn open_passive_tap(&self, bus_id: u8) -> Result<PassiveTap, DiagError> {
        let guard = self.buses.lock();
        let bus = guard
            .get(&bus_id)
            .filter(|b| b.is_connected())
            .ok_or_else(|| {
                DiagError::new(
                    DiagErrorCode::BusNotConnected,
                    format!("bus {bus_id} is not connected"),
                )
            })?;
        let all = [DiagTapFilter {
            id: 0,
            mask: 0,
            extended: None,
        }];
        let reg = bus
            .diag
            .register_passive(&all, PASSIVE_TAP_DEPTH)
            .map_err(|e| match e {
                TapRegisterError::NoFreeSlot => DiagError::new(
                    DiagErrorCode::Busy,
                    format!(
                        "bus {bus_id} already has {} diag taps open; close a session first",
                        diag_tap::MAX_DIAG_TAPS
                    ),
                ),
                TapRegisterError::BadFilters => {
                    DiagError::new(DiagErrorCode::Internal, "invalid passive tap filter")
                }
                TapRegisterError::BusGone => DiagError::new(
                    DiagErrorCode::BusNotConnected,
                    format!("bus {bus_id} I/O thread is gone"),
                ),
            })?;
        Ok(PassiveTap::new(reg, Arc::clone(&bus.diag)))
    }

    /// `cmd_diag_passive_discovery_start` → starts watching `bus_id` (Listen-Only OK; sends
    /// nothing). Idempotent: an already running scan keeps its state. A finished scan
    /// (stopped / bus gone) is replaced by a fresh one.
    pub fn cmd_diag_passive_discovery_start(
        &self,
        bus_id: u8,
    ) -> Result<PassiveDiscoverySnapshotDto, DiagError> {
        let mut map = self.diag_passive.0.lock();
        if let Some(s) = map.get(&bus_id) {
            if s.shared.running.load(Ordering::Acquire) {
                return Ok(s.snapshot(bus_id));
            }
        }
        if let Some(mut old) = map.remove(&bus_id) {
            old.stop("restarted");
        }
        let tap = self.open_passive_tap(bus_id)?;
        let shared = Arc::new(ScanShared {
            analyzer: Mutex::new(PassiveAnalyzer::new(bus_id)),
            running: AtomicBool::new(true),
            stop: AtomicBool::new(false),
            stop_reason: Mutex::new(None),
            started_at_us: now_monotonic_us(),
        });
        let status = tap.status();
        let worker_shared = Arc::clone(&shared);
        let join = thread::Builder::new()
            .name(format!("nexus-diag-passive-{bus_id}"))
            .spawn(move || run_passive_worker(tap, worker_shared))
            .map_err(|e| {
                DiagError::new(
                    DiagErrorCode::Internal,
                    format!("cannot start the passive discovery thread: {e}"),
                )
            })?;
        let scan = PassiveScan {
            shared,
            tap: status,
            join: Some(join),
        };
        let snap = scan.snapshot(bus_id);
        map.insert(bus_id, scan);
        self.debug_hub.record(
            "info",
            "DIAG",
            "protocol",
            Some(bus_id),
            "diag.passive_started",
            format!(
                "Started passive ECU discovery on Bus {}",
                u16::from(bus_id) + 1
            ),
            None,
        );
        Ok(snap)
    }

    /// `cmd_diag_passive_discovery_snapshot` → current pairs (also after stop; an idle,
    /// empty snapshot when never started).
    pub fn cmd_diag_passive_discovery_snapshot(
        &self,
        bus_id: u8,
    ) -> Result<PassiveDiscoverySnapshotDto, DiagError> {
        Ok(self
            .diag_passive
            .0
            .lock()
            .get(&bus_id)
            .map_or_else(|| idle_snapshot(bus_id), |s| s.snapshot(bus_id)))
    }

    /// `cmd_diag_passive_discovery_stop` → stops the scan (< ~25 ms), returns the final
    /// snapshot (kept for later `snapshot` calls). Idempotent.
    pub fn cmd_diag_passive_discovery_stop(
        &self,
        bus_id: u8,
    ) -> Result<PassiveDiscoverySnapshotDto, DiagError> {
        let mut map = self.diag_passive.0.lock();
        Ok(match map.get_mut(&bus_id) {
            Some(s) => {
                let was_running = s.shared.running.load(Ordering::Acquire);
                s.stop("stopped by user");
                let snap = s.snapshot(bus_id);
                if was_running {
                    self.debug_hub.record(
                        "info",
                        "DIAG",
                        "protocol",
                        Some(bus_id),
                        "diag.passive_stopped",
                        format!(
                            "Stopped passive ECU discovery on Bus {} ({} pair(s) identified)",
                            u16::from(bus_id) + 1,
                            snap.pairs.len()
                        ),
                        Some(format!("framesAnalyzed={}", snap.frames_analyzed)),
                    );
                }
                snap
            }
            None => idle_snapshot(bus_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChannelConfigDto, MOCK0_DEVICE_ID};
    use nexus_core::{FLAG_FD, FLAG_TX};

    fn sf(id: u32, ts: u64, pdu: &[u8]) -> RawCanFrame {
        let mut d = [0xAAu8; 8];
        d[0] = pdu.len() as u8;
        d[1..=pdu.len()].copy_from_slice(pdu);
        raw(id, ts, &d)
    }

    fn raw(id: u32, ts: u64, d: &[u8]) -> RawCanFrame {
        let key = if id > 0x7FF {
            CanIdKey::new_extended(id)
        } else {
            CanIdKey::new_standard(id as u16)
        }
        .expect("id");
        RawCanFrame::new_classical(0, key, d, ts).expect("frame")
    }

    fn ff(id: u32, ts: u64, total: u16, first: &[u8; 6]) -> RawCanFrame {
        let mut d = [0u8; 8];
        d[0] = 0x10 | (total >> 8) as u8;
        d[1] = total as u8;
        d[2..].copy_from_slice(first);
        raw(id, ts, &d)
    }

    fn fc(id: u32, ts: u64) -> RawCanFrame {
        raw(id, ts, &[0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA])
    }

    fn pair(a: &PassiveAnalyzer, req: u32, resp: u32) -> Option<PassiveEcuPairDto> {
        a.pairs()
            .into_iter()
            .find(|p| p.request_id == req && p.response_id == resp)
    }

    #[test]
    fn classification_is_strict() {
        assert_eq!(
            classify(&[0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], false),
            Pci::Sf {
                pdu: &[0x3E, 0x00],
                padded: true
            }
        );
        assert_eq!(
            classify(&[0x02, 0x3E, 0x00], false),
            Pci::Sf {
                pdu: &[0x3E, 0x00],
                padded: false
            }
        );
        // Non-uniform padding, odd DLC, oversize classic SF.
        assert_eq!(
            classify(&[0x02, 0x3E, 0x00, 0xAA, 0x12, 0xAA, 0xAA, 0xAA], false),
            Pci::None
        );
        assert_eq!(classify(&[0x02, 0x3E, 0x00, 0xAA, 0xAA], false), Pci::None);
        assert_eq!(classify(&[0x08, 1, 2, 3, 4, 5, 6, 7], false), Pci::None);
        // FF must not fit an SF; classic FF is 8 bytes.
        assert_eq!(classify(&[0x10, 0x07, 1, 2, 3, 4, 5, 6], false), Pci::None);
        assert!(matches!(
            classify(&[0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2, 3], false),
            Pci::Ff { total: 0x14, .. }
        ));
        assert_eq!(classify(&[0x10, 0x14, 0x62, 0xF1], false), Pci::None);
        // FC: status, STmin, DLC, padding.
        assert_eq!(classify(&[0x30, 0, 0], false), Pci::Fc { padded: false });
        assert_eq!(
            classify(&[0x30, 0, 0, 0x55, 0x55, 0x55, 0x55, 0x55], false),
            Pci::Fc { padded: true }
        );
        assert_eq!(classify(&[0x33, 0, 0], false), Pci::None);
        assert_eq!(classify(&[0x30, 0, 0x80], false), Pci::None);
        assert_eq!(classify(&[0x30, 0, 0, 1, 2, 3, 4, 5], false), Pci::None);
        // CAN-FD escape SF only in > 8 byte frames.
        let mut fd = [0xCCu8; 12];
        fd[0] = 0;
        fd[1] = 8;
        assert!(matches!(classify(&fd, true), Pci::Sf { pdu, padded: true } if pdu.len() == 8));
        fd[1] = 9;
        assert!(matches!(classify(&fd, true), Pci::Sf { pdu, padded: false } if pdu.len() == 9));
        assert_eq!(classify(&fd, false), Pci::None);
    }

    #[test]
    fn scripted_sequence_gives_pairs_and_confidence() {
        let mut a = PassiveAnalyzer::new(0);
        let mut t = 1_000_000u64;
        // OEM tester 0x6F1 ↔ ECU 0x6F9: one TesterPresent → low.
        a.on_frame(&sf(0x6F1, t, &[0x3E, 0x00]));
        a.on_frame(&sf(0x6F9, t + 3_000, &[0x7E, 0x00]));
        let p = pair(&a, 0x6F1, 0x6F9).expect("pair");
        assert_eq!(
            (p.evidence_count, p.confidence, p.sids_seen.clone()),
            (1, PassiveConfidenceDto::Low, vec![0x3E])
        );
        assert!(!p.functional_request && !p.flow_control_seen);

        // Two more transactions (one negative with 0x78 first) → medium, 3 SIDs.
        t += 100_000;
        a.on_frame(&sf(0x6F1, t, &[0x10, 0x03]));
        a.on_frame(&sf(0x6F9, t + 2_000, &[0x7F, 0x10, 0x78]));
        a.on_frame(&sf(
            0x6F9,
            t + 900_000,
            &[0x50, 0x03, 0x00, 0x32, 0x01, 0xF4],
        ));
        t += 1_000_000;
        a.on_frame(&sf(0x6F1, t, &[0x22, 0xF1, 0x8C]));
        a.on_frame(&sf(0x6F9, t + 5_000, &[0x7F, 0x22, 0x31]));
        let p = pair(&a, 0x6F1, 0x6F9).expect("pair");
        assert_eq!(p.evidence_count, 3, "0x78 + final count once");
        assert_eq!(p.confidence, PassiveConfidenceDto::Medium);
        assert_eq!(p.sids_seen, vec![0x10, 0x22, 0x3E]);

        // Multi-frame answer with FC from the tester → high.
        t += 100_000;
        a.on_frame(&sf(0x6F1, t, &[0x22, 0xF1, 0x90]));
        a.on_frame(&ff(
            0x6F9,
            t + 4_000,
            20,
            &[0x62, 0xF1, 0x90, b'W', b'N', b'X'],
        ));
        a.on_frame(&fc(0x6F1, t + 5_000));
        let p = pair(&a, 0x6F1, 0x6F9).expect("pair");
        assert!(p.flow_control_seen);
        assert_eq!(p.confidence, PassiveConfidenceDto::High);
        assert_eq!(p.evidence_count, 5, "response + FC");
        assert_eq!(p.first_seen_us, 1_003_000);

        // Wrong echo (other DID) is not an answer; a response after P2* is not either.
        t += 100_000;
        a.on_frame(&sf(0x5F1, t, &[0x22, 0x12, 0x34]));
        a.on_frame(&sf(0x5F9, t + 1_000, &[0x62, 0x43, 0x21, 0x00]));
        a.on_frame(&sf(0x5F9, t + P2_STAR_US + 1, &[0x62, 0x12, 0x34, 0x00]));
        assert!(pair(&a, 0x5F1, 0x5F9).is_none());

        // Functional OBD request answered by two ECUs: two pairs, one evidence each.
        t += 10_000_000;
        a.on_frame(&sf(0x7DF, t, &[0x01, 0x0C]));
        a.on_frame(&sf(0x7E8, t + 2_000, &[0x41, 0x0C, 0x1A, 0xF8]));
        a.on_frame(&sf(0x7E9, t + 2_500, &[0x41, 0x0C, 0x1B, 0x00]));
        let p8 = pair(&a, 0x7DF, 0x7E8).expect("7E8");
        let p9 = pair(&a, 0x7DF, 0x7E9).expect("7E9");
        assert!(p8.functional_request && p9.functional_request);
        assert_eq!((p8.evidence_count, p9.evidence_count), (1, 1));
        assert_eq!(p8.sids_seen, vec![0x01]);
        // OBD service on a non-legislated id is not a request.
        a.on_frame(&sf(0x6A0, t, &[0x01, 0x0C]));
        a.on_frame(&sf(0x6A8, t + 1_000, &[0x41, 0x0C, 0x00, 0x00]));
        assert!(pair(&a, 0x6A0, 0x6A8).is_none());

        // 29-bit normal fixed: 0x18DB33F1 functional → 0x18DAF110, then physical with FC.
        t += 100_000;
        a.on_frame(&sf(0x18DB_33F1, t, &[0x3E, 0x00]));
        a.on_frame(&sf(0x18DA_F110, t + 1_000, &[0x7E, 0x00]));
        // Long request (0x2E, 12 bytes): FF from the tester, FC from the ECU.
        a.on_frame(&ff(
            0x18DA_10F1,
            t + 10_000,
            12,
            &[0x2E, 0xF1, 0x99, 1, 2, 3],
        ));
        a.on_frame(&fc(0x18DA_F110, t + 11_000));
        let f = pair(&a, 0x18DB_33F1, 0x18DA_F110).expect("functional 29-bit");
        assert!(f.is_extended_id && f.functional_request);
        let phys = pair(&a, 0x18DA_10F1, 0x18DA_F110).expect("physical 29-bit by FC");
        assert!(phys.flow_control_seen && !phys.functional_request);
        assert_eq!(phys.confidence, PassiveConfidenceDto::High);
        assert_eq!(phys.sids_seen, vec![0x2E]);
    }

    #[test]
    fn ten_matches_are_high_and_most_recent_request_wins() {
        let mut a = PassiveAnalyzer::new(3);
        for i in 0..10u64 {
            let t = 1_000 + i * 200_000;
            a.on_frame(&sf(0x700, t, &[0x3E, 0x00]));
            a.on_frame(&sf(0x708, t + 500, &[0x7E, 0x00]));
        }
        let p = pair(&a, 0x700, 0x708).expect("pair");
        assert_eq!(
            (p.evidence_count, p.confidence),
            (10, PassiveConfidenceDto::High)
        );
        assert_eq!(p.bus_id, 3);
        assert_eq!(a.pairs().len(), 1, "no cross pairs between transactions");
    }

    #[test]
    fn weak_matches_only_reinforce_existing_pairs() {
        let mut a = PassiveAnalyzer::new(0);
        // Unpadded 0x37 RequestTransferExit + unpadded 0x77: no echo bytes, weak → no pair.
        a.on_frame(&raw(0x6E1, 1_000, &[0x01, 0x37]));
        a.on_frame(&raw(0x6E9, 2_000, &[0x01, 0x77]));
        assert!(a.pairs().is_empty(), "weak evidence never creates a pair");
        // Unpadded FC after a request FF: weak as well.
        a.on_frame(&ff(0x6E1, 3_000, 12, &[0x2E, 0xF1, 0x99, 1, 2, 3]));
        a.on_frame(&raw(0x6E9, 4_000, &[0x30, 0x00, 0x00]));
        assert!(a.pairs().is_empty());
        // Unpadded 1-byte echo (3E 00 / 7E 00) is weak too.
        a.on_frame(&raw(0x6E1, 5_000, &[0x02, 0x3E, 0x00]));
        a.on_frame(&raw(0x6E9, 6_000, &[0x02, 0x7E, 0x00]));
        assert!(a.pairs().is_empty());
        // Strong (unpadded, but 2 echoed DID bytes) creates it; then weak matches add evidence.
        a.on_frame(&raw(0x6E1, 10_000, &[0x03, 0x22, 0xF1, 0x90]));
        a.on_frame(&raw(0x6E9, 11_000, &[0x04, 0x62, 0xF1, 0x90, 0x01]));
        a.on_frame(&raw(0x6E1, 20_000, &[0x01, 0x37]));
        a.on_frame(&raw(0x6E9, 21_000, &[0x01, 0x77]));
        a.on_frame(&ff(0x6E1, 30_000, 12, &[0x2E, 0xF1, 0x99, 1, 2, 3]));
        a.on_frame(&raw(0x6E9, 31_000, &[0x30, 0x00, 0x00]));
        let p = pair(&a, 0x6E1, 0x6E9).expect("pair");
        assert_eq!(p.evidence_count, 3, "0x22 + weak 0x37 + weak FC");
        assert_eq!(p.sids_seen, vec![0x22, 0x2E, 0x37]);
        assert!(p.flow_control_seen);
        // Negative response with an undefined NRC is not a response at all.
        a.on_frame(&sf(0x5E1, 40_000, &[0x10, 0x03]));
        a.on_frame(&sf(0x5E9, 41_000, &[0x7F, 0x10, 0x05]));
        assert!(pair(&a, 0x5E1, 0x5E9).is_none());
        a.on_frame(&sf(0x5E9, 42_000, &[0x7F, 0x10, 0x22]));
        assert!(pair(&a, 0x5E1, 0x5E9).is_some());
    }

    /// xorshift64* (deterministic).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
    }

    #[test]
    fn random_traffic_produces_no_pairs() {
        // 1M frames = 20 s of 50k frames/s random traffic, plus two shorter seeds.
        random_run(0x9E37_79B9_7F4A_7C15, 1_000_000);
        random_run(0x0123_4567_89AB_CDEF, 300_000);
        random_run(0xDEAD_BEEF_CAFE_F00D, 300_000);
    }

    fn random_run(seed: u64, frames: u64) {
        let mut a = PassiveAnalyzer::new(0);
        let mut rng = Rng(seed);
        let mut t = 0u64;
        for _ in 0..frames {
            let r = rng.next();
            t += 20; // 50k frames/s
            let ext = r & 1 == 1;
            let id = if ext {
                (r >> 1) as u32 & 0x1FFF_FFFF
            } else {
                (r >> 1) as u32 & 0x7FF
            };
            let dlc = 1 + (r >> 40) as usize % 8;
            let d = rng.next().to_le_bytes();
            let f = if ext {
                RawCanFrame::new_classical(0, CanIdKey::new_extended(id).expect("x"), &d[..dlc], t)
            } else {
                RawCanFrame::new_classical(
                    0,
                    CanIdKey::new_standard(id as u16).expect("s"),
                    &d[..dlc],
                    t,
                )
            }
            .expect("frame");
            a.on_frame(&f);
        }
        assert_eq!(a.frames_analyzed(), frames);
        assert!(
            a.pairs().is_empty(),
            "seed {seed:#X}: false pairs: {:?}",
            a.pairs()
        );
    }

    #[test]
    fn caps_are_bounded_and_reported_without_reallocation() {
        let mut a = PassiveAnalyzer::new(0);
        let (cap_pairs, cap_index) = (a.pairs.capacity(), a.index.capacity());
        let mut t = 1u64;
        // 600 distinct testers each answered by its own ECU (extended ids, never collide).
        for i in 0..600u32 {
            let req = 0x1000_0000 | (i << 8);
            a.on_frame(&sf(req, t, &[0x3E, 0x00]));
            a.on_frame(&sf(req | 0x80, t + 10, &[0x7E, 0x00]));
            t += 1_000;
        }
        assert_eq!(a.pairs().len(), MAX_PASSIVE_PAIRS);
        assert!(a.truncated());
        assert_eq!(a.dropped_pairs(), 600 - MAX_PASSIVE_PAIRS as u32);
        assert_eq!(a.pairs.capacity(), cap_pairs, "pair table never grows");
        assert_eq!(a.index.capacity(), cap_index, "index never rehashes");

        // Pending table: 100 unanswered requests within P2* evict the oldest 36.
        let mut b = PassiveAnalyzer::new(0);
        for i in 0..100u32 {
            b.on_frame(&sf(0x100 + i, 10 + u64::from(i), &[0x3E, 0x00]));
        }
        assert_eq!(b.evicted_requests(), 100 - MAX_PENDING_REQUESTS as u64);
        // The newest request still matches; the evicted oldest does not.
        b.on_frame(&sf(0x700, 1_000, &[0x7E, 0x00]));
        let ps = b.pairs();
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].request_id, 0x100 + 99);
    }

    #[test]
    fn rtr_error_and_echo_frames_are_handled() {
        let mut a = PassiveAnalyzer::new(0);
        let mut req = sf(0x6F1, 10, &[0x3E, 0x00]);
        req.flags |= FLAG_TX; // our own tester's echo counts as bus traffic
        a.on_frame(&req);
        let mut rtr = sf(0x6F9, 20, &[0x7E, 0x00]);
        rtr.flags |= nexus_core::FLAG_RTR;
        a.on_frame(&rtr);
        assert!(a.pairs().is_empty(), "RTR is never a response");
        a.on_frame(&sf(0x6F9, 30, &[0x7E, 0x00]));
        assert_eq!(a.pairs().len(), 1);
        let mut fd = sf(0x6F1, 40, &[0x3E, 0x00]);
        fd.flags |= FLAG_FD;
        a.on_frame(&fd);
    }

    // ─── engine integration: Listen-Only, zero TX ───────────────────────────

    /// mock0 wrapper: injects scripted RX frames, counts (and refuses) every driver write.
    struct ScriptedChannel {
        inner: Box<dyn CanChannel>,
        script: Arc<Mutex<std::collections::VecDeque<RawCanFrame>>>,
        sent: Arc<AtomicU64>,
        mock_traffic: bool,
    }

    impl CanChannel for ScriptedChannel {
        fn descriptor(&self) -> &DeviceDescriptor {
            self.inner.descriptor()
        }
        fn capabilities(&self) -> &crate::traits::AdapterCapabilities {
            self.inner.capabilities()
        }
        fn close(&mut self) -> Result<(), AdapterError> {
            self.inner.close()
        }
        fn recv_batch(
            &mut self,
            out: &mut [RawCanFrame],
            timeout_ms: u32,
        ) -> Result<usize, AdapterError> {
            let mut n = 0;
            {
                let mut q = self.script.lock();
                while n < out.len() {
                    let Some(mut f) = q.pop_front() else { break };
                    f.timestamp_us = now_monotonic_us();
                    out[n] = f;
                    n += 1;
                }
            }
            if n > 0 {
                return Ok(n);
            }
            if self.mock_traffic {
                self.inner.recv_batch(out, timeout_ms)
            } else {
                thread::sleep(Duration::from_millis(1));
                Ok(0)
            }
        }
        fn send_frame(&mut self, _frame: &RawCanFrame) -> Result<(), AdapterError> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            Err(AdapterError::ListenOnlyMode)
        }
        fn set_filters(
            &mut self,
            filters: &[crate::traits::CanFilter],
        ) -> Result<(), AdapterError> {
            self.inner.set_filters(filters)
        }
        fn health(&self) -> crate::traits::BusHealthSnapshot {
            self.inner.health()
        }
    }

    struct Rig {
        engine: PipelineEngine,
        script: Arc<Mutex<std::collections::VecDeque<RawCanFrame>>>,
        sent: Arc<AtomicU64>,
    }

    /// Engine with bus 0 = Listen-Only mock0 behind a [`ScriptedChannel`].
    fn rig(mock_traffic: bool, fps: u32) -> Rig {
        let engine = PipelineEngine::new();
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: true,
            mock_fps_preset: Some(fps),
            ..ChannelConfigDto::default()
        };
        let (descriptor, inner) = engine
            .registry
            .open_by_device_id(MOCK0_DEVICE_ID, &cfg)
            .expect("open mock0");
        let script = Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let sent = Arc::new(AtomicU64::new(0));
        let chan = ScriptedChannel {
            inner,
            script: Arc::clone(&script),
            sent: Arc::clone(&sent),
            mock_traffic,
        };
        let handle = engine
            .spawn_connected_bus_handle(0, descriptor, cfg, Box::new(chan), false)
            .expect("spawn bus");
        engine.buses.lock().insert(0, handle);
        Rig {
            engine,
            script,
            sent,
        }
    }

    fn wait_for(cond: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn listen_only_bus_passive_scan_sends_nothing_and_survives_panic() {
        let r = rig(false, 1_000);
        let e = &r.engine;
        // Not connected bus → error, nothing started.
        assert_eq!(
            e.cmd_diag_passive_discovery_start(7).unwrap_err().code,
            DiagErrorCode::BusNotConnected
        );
        let idle = e.cmd_diag_passive_discovery_snapshot(0).expect("idle");
        assert!(!idle.running && idle.pairs.is_empty() && idle.started_at_us == 0);

        let s = e
            .cmd_diag_passive_discovery_start(0)
            .expect("start on Listen-Only");
        assert!(s.running);
        assert_eq!(e.diag_tap_count(0), 1);
        // Idempotent start.
        assert!(
            e.cmd_diag_passive_discovery_start(0)
                .expect("again")
                .running
        );
        assert_eq!(e.diag_tap_count(0), 1);

        {
            let mut q = r.script.lock();
            q.push_back(sf(0x6F1, 0, &[0x3E, 0x00]));
            q.push_back(sf(0x6F9, 0, &[0x7E, 0x00]));
            q.push_back(sf(0x6F1, 0, &[0x22, 0xF1, 0x90]));
            q.push_back(ff(0x6F9, 0, 20, &[0x62, 0xF1, 0x90, 1, 2, 3]));
            q.push_back(fc(0x6F1, 0));
        }
        assert!(wait_for(|| e
            .cmd_diag_passive_discovery_snapshot(0)
            .is_ok_and(|s| s
                .pairs
                .first()
                .is_some_and(|p| p.flow_control_seen))));

        // Panic Stop closes TX-capable taps only: the passive scan keeps running.
        let _ = e.cmd_panic_stop_tx();
        let s = e.cmd_diag_passive_discovery_snapshot(0).expect("snap");
        assert!(s.running, "{s:?}");
        r.script.lock().push_back(sf(0x6F1, 0, &[0x10, 0x03]));
        r.script
            .lock()
            .push_back(sf(0x6F9, 0, &[0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]));
        assert!(wait_for(|| e
            .cmd_diag_passive_discovery_snapshot(0)
            .is_ok_and(|s| s
                .pairs
                .first()
                .is_some_and(|p| p.evidence_count == 4))));

        let t0 = Instant::now();
        let fin = e.cmd_diag_passive_discovery_stop(0).expect("stop");
        assert!(
            t0.elapsed() < Duration::from_millis(100),
            "{:?}",
            t0.elapsed()
        );
        assert!(!fin.running);
        assert_eq!(fin.stop_reason.as_deref(), Some("stopped by user"));
        let p = &fin.pairs[0];
        assert_eq!((p.request_id, p.response_id), (0x6F1, 0x6F9));
        assert_eq!(p.confidence, PassiveConfidenceDto::High);
        assert_eq!(p.sids_seen, vec![0x10, 0x22, 0x3E]);
        assert!(fin.frames_analyzed >= 7);
        // The final state stays readable, the tap is released.
        assert_eq!(
            e.cmd_diag_passive_discovery_snapshot(0)
                .expect("after")
                .pairs
                .len(),
            1
        );
        assert!(wait_for(|| e.diag_tap_count(0) == 0));

        // Restart = fresh state; disconnect ends it with a reason.
        let s = e.cmd_diag_passive_discovery_start(0).expect("restart");
        assert!(s.running && s.pairs.is_empty());
        e.cmd_disconnect_bus(0).expect("disconnect");
        assert!(wait_for(|| e
            .cmd_diag_passive_discovery_snapshot(0)
            .is_ok_and(|s| !s.running && s.stop_reason.is_some())));

        assert_eq!(r.sent.load(Ordering::SeqCst), 0, "ZERO driver writes");
    }

    #[test]
    fn mock0_signal_stream_produces_no_false_pairs() {
        let r = rig(true, 25_000);
        let e = &r.engine;
        e.cmd_diag_passive_discovery_start(0).expect("start");
        thread::sleep(Duration::from_millis(1_500));
        let s = e.cmd_diag_passive_discovery_stop(0).expect("stop");
        assert!(
            s.frames_analyzed > 5_000,
            "mock0 traffic analyzed: {}",
            s.frames_analyzed
        );
        assert!(s.pairs.is_empty(), "false pairs from mock0: {:?}", s.pairs);
        assert_eq!(r.sent.load(Ordering::SeqCst), 0);
    }
}
