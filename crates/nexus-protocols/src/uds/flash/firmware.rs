//! Firmware image loading: Intel HEX, Motorola S-record and raw binary → normalised,
//! address-sorted, non-overlapping [`FirmwareSegment`]s.
//!
//! Not a hot path (one parse per user action): `Vec` / `String` allocation is fine here.
//!
//! References:
//! * Intel HEX: Intel "Hexadecimal Object File Format Specification" rev. A (1988) — record
//!   types 00..05, two's-complement checksum, I8086 segment wrap `SBA + ((DRLO + DRI) mod 64K)`.
//! * S-record: Motorola `srec(5)` format — S0..S9, ones' complement checksum over
//!   count + address + data, S5/S6 record count of preceding S1/S2/S3 records.
//!
//! Safety policy (flashing): everything that would silently change what lands in the ECU is
//! an error — bad checksums, overlapping writes (even with identical bytes), records after
//! the end-of-file record, a missing terminator (truncated file), addresses beyond 4 GiB.

use serde::{Deserialize, Serialize};

use super::checksum::{crc32_ieee, Crc32};

/// One contiguous memory region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirmwareSegment {
    pub address: u32,
    pub data: Vec<u8>,
}

impl FirmwareSegment {
    /// Exclusive end address (u64: a segment may end exactly at 4 GiB).
    pub fn end(&self) -> u64 {
        u64::from(self.address) + self.data.len() as u64
    }
}

/// Normalised image: segments sorted by address, non-empty, non-overlapping, and
/// non-adjacent (adjacent records are merged).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FirmwareImage {
    pub segments: Vec<FirmwareSegment>,
}

/// Source format of a firmware file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirmwareFormat {
    IntelHex,
    Srec,
    Binary,
}

/// Per-segment summary for the HMI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareSegmentSummaryDto {
    pub address: u32,
    pub length: u32,
    pub crc32: u32,
}

/// Image summary for the HMI (sent once after loading a file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareImageSummaryDto {
    pub segments: Vec<FirmwareSegmentSummaryDto>,
    pub total_bytes: u64,
    /// CRC-32 over the data of all segments concatenated in address order (gaps excluded).
    pub crc32: u32,
}

/// Firmware parse / normalisation error. Line numbers are 1-based.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FirmwareError {
    #[error("line {line}: {message}")]
    Syntax { line: usize, message: String },
    #[error(
        "line {line}: checksum mismatch (record says 0x{stored:02X}, computed 0x{computed:02X})"
    )]
    Checksum {
        line: usize,
        stored: u8,
        computed: u8,
    },
    #[error(
        "line {line}: data at 0x{address:X} (+{length} bytes) runs past the 4 GiB address space"
    )]
    AddressOverflow {
        line: usize,
        address: u64,
        length: usize,
    },
    #[error(
        "overlapping data: record at 0x{first_address:08X}{} and record at 0x{second_address:08X}{} both write 0x{overlap_start:08X}",
        fmt_line(*first_line),
        fmt_line(*second_line)
    )]
    Overlap {
        first_address: u32,
        first_line: Option<usize>,
        second_address: u32,
        second_line: Option<usize>,
        overlap_start: u32,
    },
    #[error("line {line}: S-record count record says {stored} data records, file has {actual}")]
    RecordCount {
        line: usize,
        stored: u32,
        actual: u32,
    },
    #[error("missing end-of-file / termination record (truncated file?)")]
    MissingTerminator,
    #[error("line {line}: record after the end-of-file / termination record")]
    DataAfterTerminator { line: usize },
    #[error("file contains no data")]
    NoData,
    #[error("unrecognised firmware format (expected Intel HEX ':' or S-record 'S' lines)")]
    UnknownFormat,
    #[error("{0}")]
    InvalidArgument(String),
}

fn fmt_line(line: Option<usize>) -> String {
    line.map(|l| format!(" (line {l})")).unwrap_or_default()
}

impl FirmwareError {
    /// IPC wire format, same convention as `DiagError::to_ipc_string`.
    pub fn to_ipc_string(&self) -> String {
        format!("[firmware] {self}")
    }
}

/// One data record before normalisation.
struct Piece {
    address: u32,
    data: Vec<u8>,
    line: Option<usize>,
}

fn syntax(line: usize, message: impl Into<String>) -> FirmwareError {
    FirmwareError::Syntax {
        line,
        message: message.into(),
    }
}

/// Decodes an even-length ASCII hex string.
fn decode_hex(line: usize, s: &str) -> Result<Vec<u8>, FirmwareError> {
    let b = s.as_bytes();
    if b.len() & 1 != 0 {
        return Err(syntax(line, "odd number of hex digits"));
    }
    fn nib(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    (0..b.len() / 2)
        .map(|i| match (nib(b[2 * i]), nib(b[2 * i + 1])) {
            (Some(h), Some(l)) => Ok((h << 4) | l),
            _ => Err(syntax(
                line,
                format!("invalid hex digit near column {}", 2 + i * 2),
            )),
        })
        .collect()
}

fn push_piece(
    pieces: &mut Vec<Piece>,
    line: usize,
    address: u64,
    data: &[u8],
) -> Result<(), FirmwareError> {
    if data.is_empty() {
        return Ok(());
    }
    if address + data.len() as u64 > 1u64 << 32 {
        return Err(FirmwareError::AddressOverflow {
            line,
            address,
            length: data.len(),
        });
    }
    pieces.push(Piece {
        address: address as u32,
        data: data.to_vec(),
        line: Some(line),
    });
    Ok(())
}

/// Parses Intel HEX (record types 00..05). Types 03/05 (start address) are checked and ignored.
pub fn parse_intel_hex(text: &str) -> Result<FirmwareImage, FirmwareError> {
    enum Base {
        Segment(u32),
        Linear(u32),
    }
    let mut base = Base::Linear(0);
    let mut pieces = Vec::new();
    let mut eof = false;
    for (idx, raw) in text.lines().enumerate() {
        let line = idx + 1;
        let rec = raw.trim();
        if rec.is_empty() {
            continue;
        }
        if eof {
            return Err(FirmwareError::DataAfterTerminator { line });
        }
        let body = rec
            .strip_prefix(':')
            .ok_or_else(|| syntax(line, "record does not start with ':'"))?;
        let bytes = decode_hex(line, body)?;
        if bytes.len() < 5 {
            return Err(syntax(line, "record shorter than 5 bytes"));
        }
        let len = usize::from(bytes[0]);
        if bytes.len() != len + 5 {
            return Err(syntax(
                line,
                format!(
                    "byte count field says {len} data bytes, record carries {}",
                    bytes.len() - 5
                ),
            ));
        }
        let stored = bytes[bytes.len() - 1];
        let computed = bytes[..bytes.len() - 1]
            .iter()
            .fold(0u8, |a, &b| a.wrapping_add(b))
            .wrapping_neg();
        if stored != computed {
            return Err(FirmwareError::Checksum {
                line,
                stored,
                computed,
            });
        }
        let offset = u16::from_be_bytes([bytes[1], bytes[2]]);
        let rtype = bytes[3];
        let data = &bytes[4..4 + len];
        let need = |n: usize, what: &str| -> Result<(), FirmwareError> {
            if len == n {
                Ok(())
            } else {
                Err(syntax(
                    line,
                    format!("{what} record must carry {n} data bytes, has {len}"),
                ))
            }
        };
        match rtype {
            0x00 => match base {
                Base::Linear(ulba) => {
                    push_piece(&mut pieces, line, u64::from(ulba) + u64::from(offset), data)?;
                }
                Base::Segment(sba) => {
                    // I8086 semantics: the offset wraps inside the 64 KiB segment.
                    let first = (0x1_0000 - usize::from(offset)).min(len);
                    let (a, b) = data.split_at(first);
                    push_piece(&mut pieces, line, u64::from(sba) + u64::from(offset), a)?;
                    push_piece(&mut pieces, line, u64::from(sba), b)?;
                }
            },
            0x01 => {
                need(0, "end-of-file")?;
                eof = true;
            }
            0x02 => {
                need(2, "extended segment address")?;
                base = Base::Segment(u32::from(u16::from_be_bytes([data[0], data[1]])) << 4);
            }
            0x03 => need(4, "start segment address")?,
            0x04 => {
                need(2, "extended linear address")?;
                base = Base::Linear(u32::from(u16::from_be_bytes([data[0], data[1]])) << 16);
            }
            0x05 => need(4, "start linear address")?,
            t => return Err(syntax(line, format!("unknown record type 0x{t:02X}"))),
        }
    }
    if !eof {
        return Err(FirmwareError::MissingTerminator);
    }
    normalise(pieces)
}

/// Parses Motorola S-records (S0..S3, S5..S9; S4 is reserved and rejected).
pub fn parse_srec(text: &str) -> Result<FirmwareImage, FirmwareError> {
    let mut pieces = Vec::new();
    let mut data_records: u32 = 0;
    let mut terminated = false;
    for (idx, raw) in text.lines().enumerate() {
        let line = idx + 1;
        let rec = raw.trim();
        if rec.is_empty() {
            continue;
        }
        if terminated {
            return Err(FirmwareError::DataAfterTerminator { line });
        }
        let mut chars = rec.chars();
        if chars.next() != Some('S') {
            return Err(syntax(line, "record does not start with 'S'"));
        }
        let rtype = chars
            .next()
            .and_then(|c| c.to_digit(10))
            .ok_or_else(|| syntax(line, "missing record type digit"))?;
        let bytes = decode_hex(line, &rec[2..])?;
        if bytes.is_empty() {
            return Err(syntax(line, "missing byte count"));
        }
        let count = usize::from(bytes[0]);
        if bytes.len() != count + 1 {
            return Err(syntax(
                line,
                format!(
                    "byte count field says {count}, record carries {}",
                    bytes.len() - 1
                ),
            ));
        }
        let addr_len = match rtype {
            0 | 1 | 5 | 9 => 2,
            2 | 6 | 8 => 3,
            3 | 7 => 4,
            t => return Err(syntax(line, format!("unsupported record type S{t}"))),
        };
        if count < addr_len + 1 {
            return Err(syntax(
                line,
                format!("byte count {count} too small for S{rtype}"),
            ));
        }
        let stored = bytes[bytes.len() - 1];
        let computed = !bytes[..bytes.len() - 1]
            .iter()
            .fold(0u8, |a, &b| a.wrapping_add(b));
        if stored != computed {
            return Err(FirmwareError::Checksum {
                line,
                stored,
                computed,
            });
        }
        let address = bytes[1..1 + addr_len]
            .iter()
            .fold(0u32, |a, &b| (a << 8) | u32::from(b));
        let data = &bytes[1 + addr_len..bytes.len() - 1];
        match rtype {
            0 => {}
            1..=3 => {
                data_records = data_records.saturating_add(1);
                push_piece(&mut pieces, line, u64::from(address), data)?;
            }
            5 | 6 => {
                if !data.is_empty() {
                    return Err(syntax(line, format!("S{rtype} must not carry data")));
                }
                if address != data_records {
                    return Err(FirmwareError::RecordCount {
                        line,
                        stored: address,
                        actual: data_records,
                    });
                }
            }
            _ => {
                // S7 / S8 / S9: start address (ignored), end of block.
                if !data.is_empty() {
                    return Err(syntax(line, format!("S{rtype} must not carry data")));
                }
                terminated = true;
            }
        }
    }
    if !terminated {
        return Err(FirmwareError::MissingTerminator);
    }
    normalise(pieces)
}

/// Wraps a raw binary blob located at `base_address`.
pub fn from_binary(bytes: &[u8], base_address: u32) -> Result<FirmwareImage, FirmwareError> {
    if bytes.is_empty() {
        return Err(FirmwareError::NoData);
    }
    if u64::from(base_address) + bytes.len() as u64 > 1u64 << 32 {
        return Err(FirmwareError::AddressOverflow {
            line: 0,
            address: u64::from(base_address),
            length: bytes.len(),
        });
    }
    Ok(FirmwareImage {
        segments: vec![FirmwareSegment {
            address: base_address,
            data: bytes.to_vec(),
        }],
    })
}

/// Guesses the format from the first non-blank line (`:` → Intel HEX, `S<digit>` → S-record).
/// Anything else (or non-UTF-8 content) → [`FirmwareFormat::Binary`].
pub fn detect_format(bytes: &[u8]) -> FirmwareFormat {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return FirmwareFormat::Binary;
    };
    let first = text.lines().map(str::trim).find(|l| !l.is_empty());
    match first.map(str::as_bytes) {
        Some([b':', ..]) => FirmwareFormat::IntelHex,
        Some([b'S', d, ..]) if d.is_ascii_digit() => FirmwareFormat::Srec,
        _ => FirmwareFormat::Binary,
    }
}

/// Merges sorted pieces into segments; overlapping writes are an error.
fn normalise(mut pieces: Vec<Piece>) -> Result<FirmwareImage, FirmwareError> {
    pieces.retain(|p| !p.data.is_empty());
    if pieces.is_empty() {
        return Err(FirmwareError::NoData);
    }
    // Stable: equal addresses keep file order, so `first_*` is the earlier line.
    pieces.sort_by_key(|p| p.address);
    let mut segments: Vec<FirmwareSegment> = Vec::new();
    // Start address / line of the piece that currently ends the last segment.
    let mut last: Option<(u32, Option<usize>)> = None;
    for p in pieces {
        match segments.last_mut() {
            Some(seg) if u64::from(p.address) < seg.end() => {
                let (first_address, first_line) = last.unwrap_or((seg.address, None));
                return Err(FirmwareError::Overlap {
                    first_address,
                    first_line,
                    second_address: p.address,
                    second_line: p.line,
                    overlap_start: p.address,
                });
            }
            Some(seg) if u64::from(p.address) == seg.end() => {
                seg.data.extend_from_slice(&p.data);
            }
            _ => segments.push(FirmwareSegment {
                address: p.address,
                data: p.data,
            }),
        }
        last = Some((p.address, p.line));
    }
    Ok(FirmwareImage { segments })
}

impl FirmwareImage {
    /// Parses `bytes` in `format`; `base_address` is used for [`FirmwareFormat::Binary`] only.
    /// Text formats accept a UTF-8 BOM.
    pub fn load(
        bytes: &[u8],
        format: FirmwareFormat,
        base_address: u32,
    ) -> Result<Self, FirmwareError> {
        let text = || -> Result<&str, FirmwareError> {
            let b = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
            std::str::from_utf8(b).map_err(|e| {
                FirmwareError::InvalidArgument(format!(
                    "text firmware file is not ASCII/UTF-8 (byte offset {})",
                    e.valid_up_to()
                ))
            })
        };
        match format {
            FirmwareFormat::IntelHex => parse_intel_hex(text()?),
            FirmwareFormat::Srec => parse_srec(text()?),
            FirmwareFormat::Binary => from_binary(bytes, base_address),
        }
    }

    /// Builds an image from arbitrary segments (sorted / merged / overlap-checked).
    pub fn from_segments(segments: Vec<FirmwareSegment>) -> Result<Self, FirmwareError> {
        let mut pieces = Vec::with_capacity(segments.len());
        for s in segments {
            if s.end() > 1u64 << 32 {
                return Err(FirmwareError::AddressOverflow {
                    line: 0,
                    address: u64::from(s.address),
                    length: s.data.len(),
                });
            }
            pieces.push(Piece {
                address: s.address,
                data: s.data,
                line: None,
            });
        }
        normalise(pieces)
    }

    /// Total data bytes (gaps excluded).
    pub fn total_bytes(&self) -> u64 {
        self.segments.iter().map(|s| s.data.len() as u64).sum()
    }

    /// Merges neighbouring segments whose gap is `<= max_gap` bytes, filling the gap with
    /// `fill_byte` (typically the erased-flash value 0xFF).
    pub fn fill_gaps(&mut self, max_gap: u32, fill_byte: u8) {
        let mut out: Vec<FirmwareSegment> = Vec::with_capacity(self.segments.len());
        for seg in std::mem::take(&mut self.segments) {
            match out.last_mut() {
                Some(prev)
                    if u64::from(seg.address) >= prev.end()
                        && u64::from(seg.address) - prev.end() <= u64::from(max_gap) =>
                {
                    let gap = (u64::from(seg.address) - prev.end()) as usize;
                    prev.data.resize(prev.data.len() + gap, fill_byte);
                    prev.data.extend_from_slice(&seg.data);
                }
                _ => out.push(seg),
            }
        }
        self.segments = out;
    }

    /// Splits every segment into consecutive segments of at most `max_len` bytes (e.g. one
    /// RequestDownload per flash sector). Afterwards segments may be adjacent.
    pub fn split_max(&mut self, max_len: usize) -> Result<(), FirmwareError> {
        if max_len == 0 {
            return Err(FirmwareError::InvalidArgument(
                "split length must be > 0".into(),
            ));
        }
        let mut out = Vec::with_capacity(self.segments.len());
        for seg in std::mem::take(&mut self.segments) {
            if seg.data.len() <= max_len {
                out.push(seg);
                continue;
            }
            for (i, chunk) in seg.data.chunks(max_len).enumerate() {
                out.push(FirmwareSegment {
                    // Fits: the whole segment lies below 4 GiB.
                    address: seg.address + (i * max_len) as u32,
                    data: chunk.to_vec(),
                });
            }
        }
        self.segments = out;
        Ok(())
    }

    /// HMI summary (per-segment and whole-image CRC-32).
    pub fn summary(&self) -> FirmwareImageSummaryDto {
        let mut all = Crc32::new();
        let segments = self
            .segments
            .iter()
            .map(|s| {
                all.update(&s.data);
                FirmwareSegmentSummaryDto {
                    address: s.address,
                    length: u32::try_from(s.data.len()).unwrap_or(u32::MAX),
                    crc32: crc32_ieee(&s.data),
                }
            })
            .collect();
        FirmwareImageSummaryDto {
            segments,
            total_bytes: self.total_bytes(),
            crc32: all.finish(),
        }
    }
}

#[cfg(test)]
#[path = "firmware_tests.rs"]
pub(crate) mod tests;
