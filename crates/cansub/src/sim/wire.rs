//! Independent CANsub wire codec used by the emulator (contract cansub-v1 §2.2–2.3).
//!
//! Independence rule (§4): this module must NOT use the crate's `proto` module. It is written from the
//! CSS Electronics WebSocket API document on its own and validated against the official TV-01..TV-20
//! vectors (see the test module), so a bug shared with `proto` cannot hide in simulation.
//!
//! Layout recap:
//! * HDLC: `0x7E | stuff(payload ‖ CRC32_BE(payload)) | 0x7E`, stuffing `7E → 7D 5E`, `7D → 7D 5D`.
//! * CAN frame: `u48 BE timestamp | flags | id (2 B std / 4 B ext, bit15 of the first u16 = IDE) | data`.
//! * Error frame: `u48 BE timestamp | 0b001x_xxxx` (7 bytes in total).

/// HDLC boundary byte.
pub const FLAG: u8 = 0x7E;
/// HDLC escape byte.
pub const ESCAPE: u8 = 0x7D;
/// Maximum size of one *stuffed* HDLC frame on the wire, boundary bytes included (API doc footnote 1).
pub const MAX_HDLC_WIRE: usize = 1400;
/// Largest serialized CAN frame: 6 B timestamp + 1 B flags + 4 B extended id + 64 B data.
pub const MAX_CAN_BYTES: usize = 75;
/// Offset between the device epoch (2025-01-01T00:00:00Z) and the Unix epoch, in microseconds.
pub const DEVICE_EPOCH_UNIX_US: u64 = 1_735_689_600_000_000;
/// Largest value of the 48-bit device timestamp.
pub const TIMESTAMP_MASK: u64 = 0xFFFF_FFFF_FFFF;

/// Unstuffed HDLC body limit in the decoder; anything longer is dropped as `oversize`.
const MAX_BODY: usize = 8192;

const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = build_crc_table();

/// IEEE 802.3 CRC32 (reflected polynomial `0xEDB88320`, init and xor-out `0xFFFFFFFF`).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/// Payload length in bytes for a DLC code. Classical CAN: `9..=15 → 8`; CAN-FD: `12, 16, 20, 24, 32, 48, 64`.
pub fn dlc_to_len(fd: bool, dlc: u8) -> usize {
    const FD: [usize; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
    let dlc = usize::from(dlc & 0x0F);
    if fd {
        FD[dlc]
    } else {
        dlc.min(8)
    }
}

/// Smallest DLC whose payload holds `len` bytes (CAN-FD table; `len > 64` saturates at DLC 15).
pub fn len_to_dlc(len: usize) -> u8 {
    match len {
        0..=8 => len as u8,
        9..=12 => 9,
        13..=16 => 10,
        17..=20 => 11,
        21..=24 => 12,
        25..=32 => 13,
        33..=48 => 14,
        _ => 15,
    }
}

/// One CAN / CAN-FD frame or error frame as seen by the emulator (independent of `proto::CanFrame`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SimFrame {
    /// Device timestamp in µs since 2025-01-01T00:00:00Z (48 bits on the wire).
    pub timestamp: u64,
    /// Clean 11-bit or 29-bit identifier (0 for error frames).
    pub id: u32,
    /// 29-bit identifier (IDE).
    pub extended: bool,
    /// CAN-FD frame (FDF).
    pub fd: bool,
    /// Remote frame (classical CAN only).
    pub rtr: bool,
    /// Bit-rate switch (CAN-FD only).
    pub brs: bool,
    /// Error state indicator (CAN-FD only).
    pub esi: bool,
    /// Transmission acknowledgement marker (device → client only; must be 0 in client TX).
    pub tx_ack: bool,
    /// Data length code `0..=15`; kept for RTR frames even though they carry no data.
    pub dlc: u8,
    /// Payload; the first [`SimFrame::len`] bytes are valid.
    pub data: [u8; 64],
    /// `Some(code)` for an error frame (`0` Bit, `1` Ack, `2` Form, `3` Stuff, `4` CRC).
    pub error: Option<u8>,
}

impl Default for SimFrame {
    fn default() -> Self {
        Self {
            timestamp: 0,
            id: 0,
            extended: false,
            fd: false,
            rtr: false,
            brs: false,
            esi: false,
            tx_ack: false,
            dlc: 0,
            data: [0; 64],
            error: None,
        }
    }
}

impl SimFrame {
    /// Classical CAN data frame; `data` longer than 8 bytes is truncated.
    pub fn classic(id: u32, extended: bool, data: &[u8]) -> Self {
        let n = data.len().min(8);
        let mut f = Self {
            id,
            extended,
            dlc: n as u8,
            ..Self::default()
        };
        f.data[..n].copy_from_slice(&data[..n]);
        f
    }

    /// CAN-FD data frame; the DLC is rounded up to the next valid FD length and padded with zeros.
    pub fn fd(id: u32, extended: bool, brs: bool, data: &[u8]) -> Self {
        let n = data.len().min(64);
        let mut f = Self {
            id,
            extended,
            fd: true,
            brs,
            dlc: len_to_dlc(n),
            ..Self::default()
        };
        f.data[..n].copy_from_slice(&data[..n]);
        f
    }

    /// Classical remote frame with the given DLC (no data on the wire).
    pub fn remote(id: u32, extended: bool, dlc: u8) -> Self {
        Self {
            id,
            extended,
            rtr: true,
            dlc: dlc & 0x0F,
            ..Self::default()
        }
    }

    /// Error frame with the given 5-bit error code.
    pub fn error_frame(code: u8) -> Self {
        Self {
            error: Some(code & 0x1F),
            ..Self::default()
        }
    }

    /// Number of payload bytes carried on the wire (0 for RTR and error frames).
    pub fn len(&self) -> usize {
        if self.error.is_some() || (self.rtr && !self.fd) {
            0
        } else {
            dlc_to_len(self.fd, self.dlc)
        }
    }

    /// `true` when no payload bytes are carried.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Payload bytes carried on the wire.
    pub fn payload(&self) -> &[u8] {
        &self.data[..self.len()]
    }

    /// Unix timestamp in µs derived from the device timestamp.
    pub fn unix_us(&self) -> u64 {
        self.timestamp + DEVICE_EPOCH_UNIX_US
    }
}

/// Serializes one frame (§2.3) into `out`; returns the number of bytes written (7..=75).
pub fn serialize_frame(f: &SimFrame, out: &mut [u8; MAX_CAN_BYTES]) -> usize {
    let ts = (f.timestamp & TIMESTAMP_MASK).to_be_bytes();
    out[..6].copy_from_slice(&ts[2..8]);
    if let Some(code) = f.error {
        out[6] = 0x20 | (code & 0x1F);
        return 7;
    }
    let mut flags = f.dlc & 0x0F;
    if f.fd {
        flags |= 0x80;
        if f.brs {
            flags |= 0x40;
        }
        if f.esi {
            flags |= 0x20;
        }
    } else if f.rtr {
        flags |= 0x40;
    }
    if f.tx_ack {
        flags |= 0x10;
    }
    out[6] = flags;
    let mut pos = 7;
    if f.extended {
        let v = (f.id & 0x1FFF_FFFF) | 0x8000_0000;
        out[7..11].copy_from_slice(&v.to_be_bytes());
        pos = 11;
    } else {
        let v = (f.id & 0x7FF) as u16;
        out[7..9].copy_from_slice(&v.to_be_bytes());
        pos += 2;
    }
    let n = f.len();
    out[pos..pos + n].copy_from_slice(&f.data[..n]);
    pos + n
}

/// Number of bytes `bytes` occupies after HDLC stuffing.
pub fn stuffed_len(bytes: &[u8]) -> usize {
    bytes.len() + bytes.iter().filter(|&&b| b == FLAG || b == ESCAPE).count()
}

#[inline]
fn push_stuffed(out: &mut Vec<u8>, b: u8) {
    if b == FLAG || b == ESCAPE {
        out.push(ESCAPE);
        out.push(b ^ 0x20);
    } else {
        out.push(b);
    }
}

/// Appends one HDLC frame carrying `payload` with an explicit CRC value (used for CRC corruption chaos).
pub fn push_hdlc_with_crc(payload: &[u8], crc: u32, out: &mut Vec<u8>) {
    out.push(FLAG);
    for &b in payload {
        push_stuffed(out, b);
    }
    for b in crc.to_be_bytes() {
        push_stuffed(out, b);
    }
    out.push(FLAG);
}

/// Appends one HDLC frame carrying `payload` (CRC32 big-endian, stuffing applied to payload and CRC).
pub fn push_hdlc(payload: &[u8], out: &mut Vec<u8>) {
    push_hdlc_with_crc(payload, crc32(payload), out);
}

/// Encodes `frames` into as many HDLC frames as needed so none exceeds [`MAX_HDLC_WIRE`] bytes.
pub fn encode_frames(frames: &[SimFrame], out: &mut Vec<u8>) {
    let mut payload: Vec<u8> = Vec::with_capacity(MAX_HDLC_WIRE);
    let mut stuffed = 0usize;
    let mut tmp = [0u8; MAX_CAN_BYTES];
    for f in frames {
        let n = serialize_frame(f, &mut tmp);
        let s = stuffed_len(&tmp[..n]);
        // 2 boundary bytes + worst-case 8 stuffed CRC bytes.
        if !payload.is_empty() && stuffed + s + 10 > MAX_HDLC_WIRE {
            push_hdlc(&payload, out);
            payload.clear();
            stuffed = 0;
        }
        payload.extend_from_slice(&tmp[..n]);
        stuffed += s;
    }
    if !payload.is_empty() {
        push_hdlc(&payload, out);
    }
}

/// Decoder counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WireStats {
    /// Data / remote frames delivered.
    pub frames: u64,
    /// Error frames with a known code (0..=4) delivered.
    pub error_frames: u64,
    /// Error frames with an unknown code (skipped but counted).
    pub unknown_errors: u64,
    /// HDLC frames that passed the CRC check.
    pub hdlc_ok: u64,
    /// HDLC frames dropped because of a CRC mismatch.
    pub crc_errors: u64,
    /// Bytes outside any HDLC frame (before the first boundary byte).
    pub garbage_bytes: u64,
    /// Closed HDLC bodies shorter than the 4-byte CRC (e.g. garbage between frames).
    pub runts: u64,
    /// HDLC bodies ending in a dangling escape byte.
    pub aborted: u64,
    /// HDLC bodies longer than the decoder limit.
    pub oversize: u64,
    /// Incomplete CAN frames at the end of a valid HDLC payload.
    pub truncated: u64,
}

/// Streaming HDLC + CAN frame decoder; does not rely on WebSocket message boundaries.
///
/// A closing boundary byte also acts as the opening byte of the next frame, so both `7E..7E 7E..7E`
/// and shared-flag `7E..7E..7E` streams decode. No input panics.
#[derive(Debug)]
pub struct Decoder {
    body: Vec<u8>,
    in_frame: bool,
    escape: bool,
    overflow: bool,
    /// Running counters.
    pub stats: WireStats,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    /// Creates a decoder with a pre-allocated body buffer (no allocation on the hot path afterwards).
    pub fn new() -> Self {
        Self {
            body: Vec::with_capacity(MAX_BODY),
            in_frame: false,
            escape: false,
            overflow: false,
            stats: WireStats::default(),
        }
    }

    /// Feeds raw bytes (any chunking); `on_frame` is called for every decoded frame in order.
    pub fn push(&mut self, bytes: &[u8], mut on_frame: impl FnMut(&SimFrame)) {
        for &b in bytes {
            if !self.in_frame {
                if b == FLAG {
                    self.open();
                } else {
                    self.stats.garbage_bytes += 1;
                }
                continue;
            }
            if b == FLAG {
                if self.body.is_empty() && !self.escape && !self.overflow {
                    continue; // back-to-back boundary bytes
                }
                self.finish(&mut on_frame);
                self.open();
                continue;
            }
            if self.overflow {
                continue;
            }
            let v = if self.escape {
                self.escape = false;
                b ^ 0x20
            } else if b == ESCAPE {
                self.escape = true;
                continue;
            } else {
                b
            };
            if self.body.len() >= MAX_BODY {
                self.overflow = true;
            } else {
                self.body.push(v);
            }
        }
    }

    fn open(&mut self) {
        self.in_frame = true;
        self.escape = false;
        self.overflow = false;
        self.body.clear();
    }

    fn finish(&mut self, on_frame: &mut impl FnMut(&SimFrame)) {
        if self.overflow {
            self.stats.oversize += 1;
            return;
        }
        if self.escape {
            self.stats.aborted += 1;
            return;
        }
        let n = self.body.len();
        if n < 4 {
            self.stats.runts += 1;
            return;
        }
        let (payload, crc) = self.body.split_at(n - 4);
        let want = u32::from_be_bytes([crc[0], crc[1], crc[2], crc[3]]);
        if crc32(payload) != want {
            self.stats.crc_errors += 1;
            return;
        }
        self.stats.hdlc_ok += 1;
        parse_payload(payload, &mut self.stats, on_frame);
    }
}

fn parse_payload(p: &[u8], stats: &mut WireStats, on_frame: &mut impl FnMut(&SimFrame)) {
    let mut pos = 0usize;
    while pos < p.len() {
        let rest = &p[pos..];
        if rest.len() < 7 {
            stats.truncated += 1;
            return;
        }
        let mut ts_bytes = [0u8; 8];
        ts_bytes[2..].copy_from_slice(&rest[..6]);
        let timestamp = u64::from_be_bytes(ts_bytes);
        let flags = rest[6];
        if flags & 0xE0 == 0x20 {
            let code = flags & 0x1F;
            pos += 7;
            if code <= 4 {
                stats.error_frames += 1;
                let mut f = SimFrame::error_frame(code);
                f.timestamp = timestamp;
                on_frame(&f);
            } else {
                stats.unknown_errors += 1;
            }
            continue;
        }
        if rest.len() < 9 {
            stats.truncated += 1;
            return;
        }
        let fd = flags & 0x80 != 0;
        let mut f = SimFrame {
            timestamp,
            fd,
            rtr: !fd && flags & 0x40 != 0,
            brs: fd && flags & 0x40 != 0,
            esi: fd && flags & 0x20 != 0,
            tx_ack: flags & 0x10 != 0,
            dlc: flags & 0x0F,
            ..SimFrame::default()
        };
        let hi = u16::from_be_bytes([rest[7], rest[8]]);
        let mut hdr = 9;
        if hi & 0x8000 != 0 {
            if rest.len() < 11 {
                stats.truncated += 1;
                return;
            }
            let lo = u16::from_be_bytes([rest[9], rest[10]]);
            f.extended = true;
            f.id = ((u32::from(hi) << 16) | u32::from(lo)) & 0x1FFF_FFFF;
            hdr = 11;
        } else {
            f.id = u32::from(hi) & 0x7FF;
        }
        let n = f.len();
        if rest.len() < hdr + n {
            stats.truncated += 1;
            return;
        }
        f.data[..n].copy_from_slice(&rest[hdr..hdr + n]);
        stats.frames += 1;
        on_frame(&f);
        pos += hdr + n;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        s.split_whitespace()
            .map(|h| u8::from_str_radix(h, 16).unwrap())
            .collect()
    }

    const Y2026: u64 = 365 * 86_400 * 1_000_000;
    const Y2027: u64 = 730 * 86_400 * 1_000_000;

    fn c(ts: u64, id: u32, data: &[u8]) -> SimFrame {
        let mut f = SimFrame::classic(id, false, data);
        f.timestamp = ts;
        f
    }

    fn err(code: u8) -> SimFrame {
        SimFrame::error_frame(code)
    }

    struct Tv {
        name: &'static str,
        net: &'static [&'static str],
        frames: Vec<SimFrame>,
        single_hdlc: bool,
    }

    fn vectors() -> Vec<Tv> {
        let mut tv02 = SimFrame::classic(0x1FFF_FFFF, true, &[0]);
        tv02.timestamp = Y2027;
        let tv03 = SimFrame::remote(0x001, false, 8);
        let tv04 = SimFrame::fd(0x001, false, false, &[0]);
        let tv05 = SimFrame::fd(0x001, false, true, &[0]);
        let mut tv06 = SimFrame::fd(0x001, false, false, &[0]);
        tv06.esi = true;
        let d64: Vec<u8> = (0u8..64).collect();
        let tv07 = SimFrame::fd(0x001, false, false, &d64);
        let mut tv08 = c(0, 1, &[0]);
        tv08.tx_ack = true;
        let one = c(0, 1, &[0]);
        let four = vec![c(0, 1, &[1]), c(0, 2, &[2]), c(0, 3, &[3]), c(0, 4, &[4])];
        vec![
            Tv { name: "TV-01", net: &["7E 1C AE 8C 13 E0 00 01 07 FF 00 98 4F D1 B8 7E"], frames: vec![c(Y2026, 0x7FF, &[0])], single_hdlc: true },
            Tv { name: "TV-02", net: &["7E 39 5D 18 27 C0 00 01 9F FF FF FF 00 82 83 9F 92 7E"], frames: vec![tv02], single_hdlc: true },
            Tv { name: "TV-03", net: &["7E 00 00 00 00 00 00 48 00 01 EF 87 F8 40 7E"], frames: vec![tv03], single_hdlc: true },
            Tv { name: "TV-04", net: &["7E 00 00 00 00 00 00 81 00 01 00 AF 74 88 69 7E"], frames: vec![tv04], single_hdlc: true },
            Tv { name: "TV-05", net: &["7E 00 00 00 00 00 00 C1 00 01 00 34 60 D0 54 7E"], frames: vec![tv05], single_hdlc: true },
            Tv { name: "TV-06", net: &["7E 00 00 00 00 00 00 A1 00 01 00 0F 46 27 57 7E"], frames: vec![tv06], single_hdlc: true },
            Tv {
                name: "TV-07",
                net: &["7E 00 00 00 00 00 00 8F 00 01 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A 2B 2C 2D 2E 2F 30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F DE 43 31 51 7E"],
                frames: vec![tv07],
                single_hdlc: true,
            },
            Tv { name: "TV-08", net: &["7E 00 00 00 00 00 00 11 00 01 00 12 34 69 CD 7E"], frames: vec![tv08], single_hdlc: true },
            Tv { name: "TV-09", net: &["7E 00 00 00 00 00 00 01 00 01 00 42 2D 3E 52 7E"], frames: vec![one], single_hdlc: true },
            Tv { name: "TV-10", net: &["7E", "00 00 00 00 00 00", "01", "00 01", "00", "42 2D 3E 52", "7E"], frames: vec![one], single_hdlc: true },
            Tv {
                name: "TV-11",
                net: &["7E 00 00 00 00 00 00 01 00 01 01 00 00 00 00 00 00 01 00 02 02 00 00 00 00 00 00 01 00 03 03 00 00 00 00 00 00 01 00 04 04 D1 2C 1F D9 7E"],
                frames: four.clone(),
                single_hdlc: true,
            },
            Tv {
                name: "TV-12",
                net: &["7E 00 00 00 00 00 00 01 00 01 01 35 2A 0E C4 7E 7E 00 00 00 00 00 00 01 00 02 02 87 0E 0C BD 7E 7E 00 00 00 00 00 00 01 00 03 03 E9 12 0D 6A 7E 7E 00 00 00 00 00 00 01 00 04 04 38 37 0E 0E 7E"],
                frames: four,
                single_hdlc: false,
            },
            Tv { name: "TV-13", net: &["01 02 03 04 05 7E 00 00 00 00 00 00 01 00 01 00 42 2D 3E 52 7E"], frames: vec![one], single_hdlc: false },
            Tv {
                name: "TV-14",
                net: &["7E 00 00 00 00 00 00 01 00 01 01 35 2A 0E C4 7E 01 02 03 04 05 7E 00 00 00 00 00 00 01 00 02 02 87 0E 0C BD 7E"],
                frames: vec![c(0, 1, &[1]), c(0, 2, &[2])],
                single_hdlc: false,
            },
            Tv {
                name: "TV-15",
                net: &["7E 00 00 00 00 00 00 01 00 01 01 35 2A 0E C4 7E 7E 00 00 00 00 00 00 01 00 02 02 00 00 00 00 7E 7E 00 00 00 00 00 00 01 00 03 03 E9 12 0D 6A 7E"],
                frames: vec![c(0, 1, &[1]), c(0, 3, &[3])],
                single_hdlc: false,
            },
            Tv {
                name: "TV-16",
                net: &["7E 00 00 00 00 00 00 08 00 01 7D 5E 7D 5E 7D 5E 7D 5E 7D 5D 7D 5D 7D 5D 7D 5D 67 49 97 08 7E"],
                frames: vec![c(0, 1, &[0x7E, 0x7E, 0x7E, 0x7E, 0x7D, 0x7D, 0x7D, 0x7D])],
                single_hdlc: true,
            },
            Tv { name: "TV-17", net: &["7E 00 00 00 00 2A D1 01 00 01 01 27 88 7D 5E 7D 5D 7E"], frames: vec![c(0x2AD1, 1, &[1])], single_hdlc: true },
            Tv {
                name: "TV-18",
                net: &["7E 00 00 00 00 00 00 01 00 01 01 00 00 00 00 00 00 02 00 02 02 BE C0 22 71 7E 7E 00 00 00 00 00 00 01 00 03 03 E9 12 0D 6A 7E"],
                frames: vec![c(0, 1, &[1]), c(0, 3, &[3])],
                single_hdlc: false,
            },
            Tv {
                name: "TV-19",
                net: &["7E 00 00 00 00 00 00 20 A6 02 FF B6 7E", "7E 00 00 00 00 00 00 01 00 01 00 42 2D 3E 52 7E"],
                frames: vec![err(0), one],
                single_hdlc: false,
            },
            Tv {
                name: "TV-20",
                net: &["7E 00 00 00 00 00 00 20 00 00 00 00 00 00 01 00 01 00 EE D4 28 4E 7E"],
                frames: vec![err(0), one],
                single_hdlc: true,
            },
        ]
    }

    #[test]
    fn official_vectors_decode_and_encode() {
        let tvs = vectors();
        assert_eq!(tvs.len(), 20);
        for tv in &tvs {
            let mut dec = Decoder::new();
            let mut got = Vec::new();
            for msg in tv.net {
                dec.push(&hex(msg), |f| got.push(*f));
            }
            assert_eq!(got, tv.frames, "{} decode", tv.name);
            if tv.single_hdlc {
                let want: Vec<u8> = tv.net.iter().flat_map(|m| hex(m)).collect();
                let mut enc = Vec::new();
                encode_frames(&tv.frames, &mut enc);
                assert_eq!(enc, want, "{} encode", tv.name);
            }
        }
    }

    #[test]
    fn vector_stats() {
        let tvs = vectors();
        let stats = |name: &str| {
            let tv = tvs.iter().find(|t| t.name == name).unwrap();
            let mut dec = Decoder::new();
            for m in tv.net {
                dec.push(&hex(m), |_| {});
            }
            dec.stats
        };
        assert_eq!(stats("TV-13").garbage_bytes, 5);
        assert_eq!(stats("TV-15").crc_errors, 1);
        assert_eq!(stats("TV-15").hdlc_ok, 2);
        assert_eq!(stats("TV-18").truncated, 1);
        assert_eq!(stats("TV-19").error_frames, 1);
    }

    #[test]
    fn byte_by_byte_and_garbage_never_panic() {
        let mut frames = Vec::new();
        for i in 0..200u32 {
            let d: Vec<u8> = (0..(i % 65) as u8).map(|b| b ^ 0x7E).collect();
            let mut f = if i % 3 == 0 {
                SimFrame::fd(i, i % 2 == 0, true, &d)
            } else {
                SimFrame::classic(i & 0x7FF, false, &d)
            };
            f.timestamp = u64::from(i) * 1000;
            frames.push(f);
        }
        let mut wire = Vec::new();
        encode_frames(&frames, &mut wire);
        let mut dec = Decoder::new();
        let mut got = Vec::new();
        for b in &wire {
            dec.push(std::slice::from_ref(b), |f| got.push(*f));
        }
        assert_eq!(got, frames);
        // Every HDLC respects the wire limit.
        let mut start = None;
        let mut i = 0;
        while i < wire.len() {
            if wire[i] == FLAG {
                match start {
                    None => start = Some(i),
                    Some(s) => {
                        assert!(i - s < MAX_HDLC_WIRE);
                        start = None;
                    }
                }
            }
            i += 1;
        }
        let mut x = 0x1234_5678u32;
        let mut junk = Vec::new();
        for _ in 0..100_000 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            junk.push(x as u8);
        }
        dec.push(&junk, |_| {});
    }
}
