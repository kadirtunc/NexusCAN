//! HDLC stream `Decoder` and `encode_hdlc` (0x7E flags, 0x7D stuffing, CRC32 big-endian). C1.
//!
//! ```text
//! 0x7E | stuff( payload ‖ CRC32_BE(payload) ) | 0x7E
//! stuff: 0x7E → 7D 5E , 0x7D → 7D 5D   (decode: byte after 7D is XOR 0x20)
//! ```

use super::crc::{crc32, Crc32};
use super::frame::{is_valid_tx, parse_payload, serialize, CanFrame, Event, MAX_SERIALIZED};
use super::{MAX_RX_HDLC, MAX_WIRE_HDLC};

const FLAG: u8 = 0x7E;
const ESC: u8 = 0x7D;
const XOR: u8 = 0x20;

/// Running decoder counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecoderStats {
    /// HDLC frames whose CRC matched (their payload was parsed).
    pub hdlc_ok: u64,
    /// HDLC frames rejected by the integrity check: CRC mismatch, body shorter than the 4-byte
    /// CRC, or a dangling `0x7D` escape right before the closing flag.
    pub crc_errors: u64,
    /// HDLC frames longer than [`MAX_RX_HDLC`] destuffed bytes (dropped, decoder resyncs on the
    /// next `0x7E`).
    pub overflows: u64,
    /// CRC-valid payloads that ended inside a CAN frame (the partial frame is dropped; the
    /// complete frames before it are delivered).
    pub truncated_frames: u64,
    /// Bytes skipped while hunting for an opening `0x7E` (before / between HDLC frames).
    pub garbage_bytes: u64,
    /// Error frames with a wire code outside `0..=4` (still delivered as `ErrorKind::Other`).
    pub unknown_errors: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Waiting for an opening flag; other bytes are garbage.
    Hunt,
    /// Inside an HDLC body.
    Body,
    /// Inside an HDLC body, previous byte was `0x7D`.
    Escape,
}

/// Streaming, allocation-free HDLC + CAN frame decoder.
///
/// Input may be split at arbitrary byte boundaries (WebSocket message boundaries carry no
/// meaning, TV-10..12). Framing follows the CSS Electronics C reference: the closing `0x7E` of
/// an HDLC frame is consumed by it, so bytes after it up to the next `0x7E` are garbage (TV-14).
/// One deliberate robustness extension: an empty body (`7E 7E`) is not an error, the second
/// flag simply (re)opens a frame — this lets the decoder realign when it starts mid-stream or
/// after an overflow. No input can make [`Decoder::push`] panic.
pub struct Decoder {
    buf: [u8; MAX_RX_HDLC],
    len: usize,
    state: State,
    stats: DecoderStats,
}

impl Decoder {
    /// New decoder in the "hunting for `0x7E`" state with zeroed stats.
    pub const fn new() -> Self {
        Self {
            buf: [0u8; MAX_RX_HDLC],
            len: 0,
            state: State::Hunt,
            stats: zero_stats(),
        }
    }

    /// Feeds raw bytes; every decoded [`Event`] is passed to `sink` in stream order.
    pub fn push(&mut self, bytes: &[u8], sink: &mut impl FnMut(Event)) {
        for &b in bytes {
            match self.state {
                State::Hunt => {
                    if b == FLAG {
                        self.len = 0;
                        self.state = State::Body;
                    } else {
                        self.stats.garbage_bytes += 1;
                    }
                }
                State::Body => match b {
                    FLAG if self.len == 0 => {} // `7E 7E`: second flag (re)opens.
                    FLAG => {
                        self.finish(sink);
                        self.state = State::Hunt;
                    }
                    ESC => self.state = State::Escape,
                    _ => self.store(b),
                },
                State::Escape => {
                    if b == FLAG {
                        // Dangling escape: unrecoverable body, the flag closes it.
                        self.stats.crc_errors += 1;
                        self.len = 0;
                        self.state = State::Hunt;
                    } else {
                        self.state = State::Body;
                        self.store(b ^ XOR);
                    }
                }
            }
        }
    }

    /// Snapshot of the counters.
    pub fn stats(&self) -> DecoderStats {
        self.stats
    }

    /// Drops any partial HDLC frame, returns to the hunting state and zeroes the counters.
    pub fn reset(&mut self) {
        self.len = 0;
        self.state = State::Hunt;
        self.stats = DecoderStats::default();
    }

    fn store(&mut self, b: u8) {
        match self.buf.get_mut(self.len) {
            Some(slot) => {
                *slot = b;
                self.len += 1;
            }
            None => {
                self.stats.overflows += 1;
                self.len = 0;
                self.state = State::Hunt;
            }
        }
    }

    fn finish(&mut self, sink: &mut impl FnMut(Event)) {
        let Self {
            buf, len, stats, ..
        } = self;
        let body = buf.get(..*len).unwrap_or(&[]);
        *len = 0;
        let Some(split) = body.len().checked_sub(4) else {
            stats.crc_errors += 1;
            return;
        };
        let (payload, crc) = body.split_at(split);
        let expected = crc.iter().fold(0u32, |acc, &b| (acc << 8) | u32::from(b));
        if crc32(payload) != expected {
            stats.crc_errors += 1;
            return;
        }
        stats.hdlc_ok += 1;
        parse_payload(payload, stats, sink);
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl core::fmt::Debug for Decoder {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Decoder")
            .field("buffered", &self.len)
            .field("state", &self.state)
            .field("stats", &self.stats)
            .finish()
    }
}

const fn zero_stats() -> DecoderStats {
    DecoderStats {
        hdlc_ok: 0,
        crc_errors: 0,
        overflows: 0,
        truncated_frames: 0,
        garbage_bytes: 0,
        unknown_errors: 0,
    }
}

/// [`encode_hdlc`] failure.
#[derive(Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// Not even the first frame fits into `min(out.len(), MAX_WIRE_HDLC)` bytes.
    BufferTooSmall,
    /// The first frame cannot be represented on the wire: DLC > 15, classical frame with
    /// DLC > 8, RTR on an FD frame, BRS/ESI on a classical frame, id outside 11/29 bits, or
    /// timestamp ≥ 2^48.
    InvalidFrame,
}

/// Writes `b` (stuffed) at `*pos` if it fits below `limit`.
fn put_stuffed(out: &mut [u8], limit: usize, pos: &mut usize, b: u8) -> bool {
    let (first, second) = if b == FLAG || b == ESC {
        (ESC, Some(b ^ XOR))
    } else {
        (b, None)
    };
    let need = if second.is_some() { 2 } else { 1 };
    if *pos + need > limit {
        return false;
    }
    let mut write = |v: u8| match out.get_mut(*pos) {
        Some(slot) => {
            *slot = v;
            *pos += 1;
            true
        }
        None => false,
    };
    write(first) && second.is_none_or(write)
}

const fn stuffed_len(bytes: &[u8; 4]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while i < 4 {
        n += if bytes[i] == FLAG || bytes[i] == ESC {
            2
        } else {
            1
        };
        i += 1;
    }
    n
}

/// Encodes as many frames from the start of `frames` as fit into ONE HDLC frame of at most
/// `min(out.len(), MAX_WIRE_HDLC)` bytes.
///
/// Returns `(bytes written, frames consumed)`. An empty `frames` slice returns `Ok((0, 0))`
/// and writes nothing. If a later frame is invalid, encoding stops before it (the valid prefix
/// is returned) so the next call reports [`EncodeError::InvalidFrame`] for exactly that frame.
/// [`FrameFlags::TX_ACK`](super::FrameFlags::TX_ACK) is always encoded as 0.
///
/// # Errors
/// [`EncodeError::InvalidFrame`] if `frames[0]` is not representable,
/// [`EncodeError::BufferTooSmall`] if `frames[0]` does not fit.
pub fn encode_hdlc(frames: &[CanFrame], out: &mut [u8]) -> Result<(usize, usize), EncodeError> {
    let Some(first) = frames.first() else {
        return Ok((0, 0));
    };
    if !is_valid_tx(first) {
        return Err(EncodeError::InvalidFrame);
    }
    let limit = out.len().min(MAX_WIRE_HDLC);
    let mut pos = 1usize; // out[0] = opening flag, written on success.
    let mut crc = Crc32::new();
    let mut consumed = 0usize;
    let mut tmp = [0u8; MAX_SERIALIZED];

    for f in frames {
        if !is_valid_tx(f) {
            break;
        }
        let n = serialize(f, &mut tmp);
        let bytes = tmp.get(..n).unwrap_or(&[]);
        let (save_pos, save_crc) = (pos, crc);
        let mut ok = bytes.iter().all(|&b| put_stuffed(out, limit, &mut pos, b));
        if ok {
            crc.update(bytes);
            // Room for the stuffed CRC and the closing flag?
            ok = pos + stuffed_len(&crc.finish().to_be_bytes()) < limit;
        }
        if !ok {
            pos = save_pos;
            crc = save_crc;
            break;
        }
        consumed += 1;
    }
    if consumed == 0 {
        return Err(EncodeError::BufferTooSmall);
    }
    // Fits by construction (checked above); the `get_mut`s keep this panic-free regardless.
    if let Some(slot) = out.get_mut(0) {
        *slot = FLAG;
    }
    for b in crc.finish().to_be_bytes() {
        if !put_stuffed(out, limit, &mut pos, b) {
            return Err(EncodeError::BufferTooSmall);
        }
    }
    match out.get_mut(pos) {
        Some(slot) if pos < limit => *slot = FLAG,
        _ => return Err(EncodeError::BufferTooSmall),
    }
    Ok((pos + 1, consumed))
}
