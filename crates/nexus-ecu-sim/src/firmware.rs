//! Independent parsers for Intel HEX, Motorola S-record and raw binary
//! firmware files, a sparse byte image and a byte-for-byte comparator.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub address: u64,
    pub data: Vec<u8>,
}

/// Sorted, non-overlapping, coalesced byte segments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SparseImage {
    segments: Vec<Segment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mismatch {
    pub address: u64,
    /// Byte in the reference (source) image, `None` if absent there.
    pub expected: Option<u8>,
    /// Byte in the device image, `None` if absent there.
    pub actual: Option<u8>,
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let b = |v: Option<u8>| v.map_or_else(|| "--".to_string(), |x| format!("{x:02X}"));
        write!(
            f,
            "first mismatch at 0x{:08X}: expected {} actual {}",
            self.address,
            b(self.expected),
            b(self.actual)
        )
    }
}

impl SparseImage {
    /// Builds an image from possibly unordered chunks. Overlapping chunks are
    /// accepted only when they carry identical bytes.
    pub fn from_chunks(chunks: Vec<(u64, Vec<u8>)>) -> Result<Self, String> {
        let mut map: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
        for (addr, data) in chunks {
            if data.is_empty() {
                continue;
            }
            if let Some(prev) = map.get(&addr) {
                // Duplicate start: keep the longer one after checking overlap below.
                let (short, long) = if prev.len() <= data.len() {
                    (prev.clone(), data)
                } else {
                    (data, prev.clone())
                };
                if long[..short.len()] != short[..] {
                    return Err(format!("conflicting data at 0x{addr:08X}"));
                }
                map.insert(addr, long);
            } else {
                map.insert(addr, data);
            }
        }
        let mut segments: Vec<Segment> = Vec::new();
        for (addr, data) in map {
            if let Some(last) = segments.last_mut() {
                let last_end = last.address + last.data.len() as u64;
                if addr < last_end {
                    let ov = (last_end - addr) as usize;
                    let ov_len = ov.min(data.len());
                    let off = (addr - last.address) as usize;
                    if last.data[off..off + ov_len] != data[..ov_len] {
                        let p = (0..ov_len)
                            .find(|&i| last.data[off + i] != data[i])
                            .unwrap_or(0);
                        return Err(format!(
                            "conflicting overlapping data at 0x{:08X}",
                            addr + p as u64
                        ));
                    }
                    if data.len() > ov {
                        last.data.extend_from_slice(&data[ov..]);
                    }
                    continue;
                }
                if addr == last_end {
                    last.data.extend_from_slice(&data);
                    continue;
                }
            }
            segments.push(Segment {
                address: addr,
                data,
            });
        }
        Ok(Self { segments })
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    pub fn len(&self) -> usize {
        self.segments.iter().map(|s| s.data.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    pub fn bytes(&self) -> impl Iterator<Item = (u64, u8)> + '_ {
        self.segments.iter().flat_map(|s| {
            s.data
                .iter()
                .enumerate()
                .map(move |(i, &b)| (s.address + i as u64, b))
        })
    }

    /// First difference between `expected` (source) and `actual` (device),
    /// or `None` when they are byte-for-byte identical (same addresses, same
    /// bytes, nothing extra on either side).
    pub fn compare(expected: &SparseImage, actual: &SparseImage) -> Option<Mismatch> {
        let mut a = expected.bytes().peekable();
        let mut b = actual.bytes().peekable();
        loop {
            match (a.peek().copied(), b.peek().copied()) {
                (None, None) => return None,
                (Some((aa, av)), None) => {
                    return Some(Mismatch {
                        address: aa,
                        expected: Some(av),
                        actual: None,
                    })
                }
                (None, Some((ba, bv))) => {
                    return Some(Mismatch {
                        address: ba,
                        expected: None,
                        actual: Some(bv),
                    })
                }
                (Some((aa, av)), Some((ba, bv))) => {
                    if aa == ba {
                        if av != bv {
                            return Some(Mismatch {
                                address: aa,
                                expected: Some(av),
                                actual: Some(bv),
                            });
                        }
                        a.next();
                        b.next();
                    } else if aa < ba {
                        return Some(Mismatch {
                            address: aa,
                            expected: Some(av),
                            actual: None,
                        });
                    } else {
                        return Some(Mismatch {
                            address: ba,
                            expected: None,
                            actual: Some(bv),
                        });
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    IntelHex,
    SRecord,
    Binary,
}

impl std::str::FromStr for Format {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "hex" | "ihex" | "intel" => Ok(Format::IntelHex),
            "srec" | "s19" | "s28" | "s37" | "mot" => Ok(Format::SRecord),
            "bin" | "binary" => Ok(Format::Binary),
            _ => Err(format!("unknown format '{s}' (hex|srec|bin)")),
        }
    }
}

/// Guesses the format from the extension, then from the first byte.
pub fn detect_format(path: &Path, content: &[u8]) -> Format {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "hex" | "ihex" | "ihx" => return Format::IntelHex,
        "s19" | "s28" | "s37" | "srec" | "mot" | "sx" => return Format::SRecord,
        "bin" => return Format::Binary,
        _ => {}
    }
    match content.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b':') => Format::IntelHex,
        Some(b'S') => Format::SRecord,
        _ => Format::Binary,
    }
}

pub fn parse(format: Format, content: &[u8], base: u64) -> Result<SparseImage, String> {
    match format {
        Format::IntelHex => parse_intel_hex(
            std::str::from_utf8(content).map_err(|_| "Intel HEX file is not UTF-8/ASCII")?,
        ),
        Format::SRecord => parse_srecord(
            std::str::from_utf8(content).map_err(|_| "S-record file is not UTF-8/ASCII")?,
        ),
        Format::Binary => SparseImage::from_chunks(vec![(base, content.to_vec())]),
    }
}

fn decode_hex_line(s: &str, lineno: usize) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("line {lineno}: odd number of hex digits"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|_| format!("line {lineno}: invalid hex '{}'", &s[i..i + 2]))
        })
        .collect()
}

/// Intel HEX (I8HEX / I16HEX / I32HEX): record types 00..05.
pub fn parse_intel_hex(text: &str) -> Result<SparseImage, String> {
    let mut chunks = Vec::new();
    let mut base: u64 = 0;
    let mut eof = false;
    for (idx, raw) in text.lines().enumerate() {
        let lineno = idx + 1;
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if eof {
            return Err(format!("line {lineno}: data after EOF record"));
        }
        let body = line
            .strip_prefix(':')
            .ok_or_else(|| format!("line {lineno}: missing ':' start code"))?;
        let b = decode_hex_line(body, lineno)?;
        if b.len() < 5 || b.len() != usize::from(b[0]) + 5 {
            return Err(format!("line {lineno}: record length mismatch"));
        }
        let sum = b.iter().fold(0u8, |a, &x| a.wrapping_add(x));
        if sum != 0 {
            return Err(format!("line {lineno}: checksum error"));
        }
        let offset = u64::from(u16::from_be_bytes([b[1], b[2]]));
        let data = &b[4..b.len() - 1];
        match b[3] {
            0x00 => chunks.push((base + offset, data.to_vec())),
            0x01 => eof = true,
            0x02 => {
                if data.len() != 2 {
                    return Err(format!("line {lineno}: bad extended segment record"));
                }
                base = u64::from(u16::from_be_bytes([data[0], data[1]])) << 4;
            }
            0x04 => {
                if data.len() != 2 {
                    return Err(format!("line {lineno}: bad extended linear record"));
                }
                base = u64::from(u16::from_be_bytes([data[0], data[1]])) << 16;
            }
            0x03 | 0x05 => {} // start address: irrelevant for memory content
            t => return Err(format!("line {lineno}: unknown record type 0x{t:02X}")),
        }
    }
    if !eof {
        return Err("Intel HEX: missing EOF (type 01) record".into());
    }
    SparseImage::from_chunks(chunks)
}

/// Motorola S-record: S0 header, S1/S2/S3 data, S5/S6 count, S7/S8/S9 end.
pub fn parse_srecord(text: &str) -> Result<SparseImage, String> {
    let mut chunks = Vec::new();
    let mut data_records: u64 = 0;
    for (idx, raw) in text.lines().enumerate() {
        let lineno = idx + 1;
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let mut ch = line.chars();
        if ch.next() != Some('S') {
            return Err(format!("line {lineno}: missing 'S' start"));
        }
        let t = ch
            .next()
            .and_then(|c| c.to_digit(10))
            .ok_or_else(|| format!("line {lineno}: bad record type"))?;
        let b = decode_hex_line(&line[2..], lineno)?;
        if b.is_empty() || b.len() != usize::from(b[0]) + 1 {
            return Err(format!("line {lineno}: byte count mismatch"));
        }
        let sum = b.iter().fold(0u8, |a, &x| a.wrapping_add(x));
        if sum != 0xFF {
            return Err(format!("line {lineno}: checksum error"));
        }
        let alen = match t {
            0 | 1 | 5 | 9 => 2,
            2 | 6 | 8 => 3,
            3 | 7 => 4,
            _ => return Err(format!("line {lineno}: unsupported record S{t}")),
        };
        if b.len() < 1 + alen + 1 {
            return Err(format!("line {lineno}: record too short"));
        }
        let addr = b[1..1 + alen]
            .iter()
            .fold(0u64, |a, &x| (a << 8) | u64::from(x));
        let data = &b[1 + alen..b.len() - 1];
        match t {
            1..=3 => {
                data_records += 1;
                chunks.push((addr, data.to_vec()));
            }
            5 | 6 if addr != data_records => {
                return Err(format!(
                    "line {lineno}: record count {addr} != {data_records} data records"
                ));
            }
            _ => {} // S0 header, S7/S8/S9 start address
        }
    }
    SparseImage::from_chunks(chunks)
}

/// Reads and parses a firmware file.
pub fn load(path: &Path, format: Option<Format>, base: u64) -> Result<SparseImage, String> {
    let content = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let fmt = format.unwrap_or_else(|| detect_format(path, &content));
    parse(fmt, &content, base).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intel_hex_with_extended_linear() {
        // Classic Wikipedia sample lines + an extended linear address record.
        let txt = ":020000040800F2\n\
                   :10000000214601360121470136007EFE09D2190141\n\
                   :0400100001020304E2\n\
                   :00000001FF\n";
        let img = parse_intel_hex(txt).unwrap();
        assert_eq!(img.segments().len(), 1);
        assert_eq!(img.segments()[0].address, 0x0800_0000);
        assert_eq!(img.len(), 20);
        assert_eq!(&img.segments()[0].data[16..], &[1, 2, 3, 4]);
    }

    #[test]
    fn intel_hex_errors() {
        assert!(
            parse_intel_hex(":10000000214601360121470136007EFE09D2190140\n:00000001FF\n").is_err()
        );
        assert!(parse_intel_hex(":0400100001020304E2\n").is_err()); // no EOF
        assert!(parse_intel_hex("0400100001020304E2\n:00000001FF").is_err());
    }

    #[test]
    fn srecord_s3_with_count() {
        // S3 record at 0x08000000 with 4 data bytes, S5 count 1, S7 end.
        let mk = |t: u8, body: &[u8]| {
            let mut v = vec![(body.len() + 1) as u8];
            v.extend_from_slice(body);
            let ck = !v.iter().fold(0u8, |a, &x| a.wrapping_add(x));
            v.push(ck);
            format!(
                "S{t}{}",
                v.iter().map(|b| format!("{b:02X}")).collect::<String>()
            )
        };
        let txt = [
            mk(0, &[0, 0, b'h', b'i']),
            mk(3, &[0x08, 0, 0, 0, 0xDE, 0xAD, 0xBE, 0xEF]),
            mk(5, &[0, 1]),
            mk(7, &[0x08, 0, 0, 0]),
        ]
        .join("\n");
        let img = parse_srecord(&txt).unwrap();
        assert_eq!(
            img.segments(),
            &[Segment {
                address: 0x0800_0000,
                data: vec![0xDE, 0xAD, 0xBE, 0xEF]
            }]
        );
        // Wikipedia S1 sample line checksum validates.
        assert!(parse_srecord("S1137AF00A0A0D0000000000000000000000000061").is_ok());
        assert!(parse_srecord("S1137AF00A0A0D0000000000000000000000000062").is_err());
    }

    #[test]
    fn sparse_merge_and_compare() {
        let a = SparseImage::from_chunks(vec![
            (0x10, vec![3, 4]),
            (0x0E, vec![1, 2]),
            (0x20, vec![9]),
        ])
        .unwrap();
        assert_eq!(a.segments().len(), 2);
        assert!(SparseImage::compare(&a, &a.clone()).is_none());
        let b = SparseImage::from_chunks(vec![(0x0E, vec![1, 2, 3, 5]), (0x20, vec![9])]).unwrap();
        assert_eq!(
            SparseImage::compare(&a, &b),
            Some(Mismatch {
                address: 0x11,
                expected: Some(4),
                actual: Some(5)
            })
        );
        let c = SparseImage::from_chunks(vec![(0x0E, vec![1, 2, 3, 4])]).unwrap();
        assert_eq!(
            SparseImage::compare(&a, &c),
            Some(Mismatch {
                address: 0x20,
                expected: Some(9),
                actual: None
            })
        );
        assert!(SparseImage::from_chunks(vec![(0, vec![1, 2]), (1, vec![3])]).is_err());
        assert!(SparseImage::from_chunks(vec![(0, vec![1, 2]), (1, vec![2, 7])]).is_ok());
    }
}
