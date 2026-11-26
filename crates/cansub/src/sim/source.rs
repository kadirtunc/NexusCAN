//! Frame sources for the emulator: deterministic mock generator, candump `.log` replay, xorshift RNG.

use std::path::Path;

use super::wire::SimFrame;

/// Small deterministic xorshift64* RNG (no extra dependency).
#[derive(Clone, Debug)]
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        // splitmix64 scramble so seeds 0/1/2 are not degenerate.
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Self((z ^ (z >> 31)) | 1)
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in `[0, 1)`.
    pub(crate) fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// `true` with probability `p`.
    pub(crate) fn chance(&mut self, p: f64) -> bool {
        p > 0.0 && self.unit() < p
    }

    /// Uniform in `lo..=hi`.
    pub(crate) fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + (self.next_u64() % (hi - lo + 1) as u64) as usize
    }
}

/// Deterministic mixed CAN / CAN-FD, standard / extended traffic for one channel.
///
/// The frame for sequence number `n` is a pure function of `(channel, n)`; filling is done in place so
/// generation never allocates.
pub(crate) fn mock_frame(channel: u8, n: u64, out: &mut SimFrame) {
    let ch = u32::from(channel);
    let seed = n as u8;
    *out = SimFrame::default();
    let (id, ext, fd, brs, len, rtr) = match n % 10 {
        0 => (0x100 + ch, false, false, false, 8, false),
        1 => (0x18FE_F100 | ch, true, false, false, 8, false),
        2 => (0x200 + ch, false, true, true, 12, false),
        3 => (0x1CEB_FF00 | ch, true, true, true, 64, false),
        4 => (0x7DF, false, false, false, 2, false),
        5 => (0x300 + ch, false, true, false, 64, false),
        6 => (0x123, false, false, false, 8, true),
        7 => (0x0CF0_0400 | ch, true, false, false, 8, false),
        8 => (0x400 + ch, false, true, true, 32, false),
        _ => (0x500 + ch, false, false, false, 0, false),
    };
    out.id = id;
    out.extended = ext;
    out.fd = fd;
    out.brs = brs;
    out.rtr = rtr;
    out.dlc = super::wire::len_to_dlc(len);
    if !rtr {
        // Counter + ramp; naturally contains 0x7E / 0x7D so stuffing is exercised.
        out.data[..8].copy_from_slice(&n.to_le_bytes());
        for (i, b) in out.data.iter_mut().enumerate().take(len).skip(8) {
            *b = seed.wrapping_add((i as u8).wrapping_mul(7));
        }
    }
}

/// One replay record: offset from the first log line (µs) and the frame.
pub(crate) type ReplayRecord = (u64, SimFrame);

/// Parses a candump `-L` log (`(ts) iface ID#DATA`, `ID##F DATA` for FD, `ID#R[len]` for RTR).
///
/// Interfaces are mapped to channels `1..` in order of first appearance; lines for channels beyond
/// `channels` are dropped. Error frames (`CAN_ERR_FLAG` in an 8-digit id) are skipped.
pub(crate) fn load_candump(path: &Path, channels: u8) -> std::io::Result<Vec<Vec<ReplayRecord>>> {
    let text = std::fs::read_to_string(path)?;
    let mut ifaces: Vec<String> = Vec::new();
    let mut out: Vec<Vec<ReplayRecord>> = vec![Vec::new(); usize::from(channels)];
    let mut first_ts: Option<u64> = None;
    for (lineno, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let bad = |what: &str| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{}:{}: {what}: {line}", path.display(), lineno + 1),
            )
        };
        let mut parts = line.split_whitespace();
        let ts = parts
            .next()
            .and_then(|t| t.strip_prefix('(')?.strip_suffix(')'))
            .and_then(parse_ts_us)
            .ok_or_else(|| bad("bad timestamp"))?;
        let iface = parts.next().ok_or_else(|| bad("missing interface"))?;
        let body = parts.next().ok_or_else(|| bad("missing frame"))?;
        let Some(frame) = parse_frame(body).ok_or_else(|| bad("bad frame"))? else {
            continue; // error frame
        };
        let idx = match ifaces.iter().position(|i| i == iface) {
            Some(i) => i,
            None => {
                ifaces.push(iface.to_string());
                ifaces.len() - 1
            }
        };
        let base = *first_ts.get_or_insert(ts);
        if idx < out.len() {
            out[idx].push((ts.saturating_sub(base), frame));
        }
    }
    Ok(out)
}

fn parse_ts_us(t: &str) -> Option<u64> {
    let (s, frac) = t.split_once('.').unwrap_or((t, ""));
    let secs: u64 = s.parse().ok()?;
    let mut us = 0u64;
    let mut digits = 0;
    for ch in frac.chars() {
        let d = ch.to_digit(10)?;
        if digits < 6 {
            us = us * 10 + u64::from(d);
            digits += 1;
        }
    }
    while digits < 6 {
        us *= 10;
        digits += 1;
    }
    secs.checked_mul(1_000_000)?.checked_add(us)
}

fn hex_bytes(s: &str, out: &mut [u8; 64]) -> Option<usize> {
    if s.len() % 2 != 0 || s.len() > 128 {
        return None;
    }
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16)?;
        let lo = (chunk[1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(s.len() / 2)
}

/// `Some(None)` = valid error frame (skipped), `None` = syntax error.
fn parse_frame(body: &str) -> Option<Option<SimFrame>> {
    let (id_s, rest) = body.split_once('#')?;
    let raw = u32::from_str_radix(id_s, 16).ok()?;
    let extended = match id_s.len() {
        3 => false,
        8 => true,
        _ => return None,
    };
    if extended && raw & 0x2000_0000 != 0 {
        return Some(None);
    }
    let id = if extended {
        raw & 0x1FFF_FFFF
    } else {
        raw & 0x7FF
    };
    let mut data = [0u8; 64];
    if let Some(fd_rest) = rest.strip_prefix('#') {
        let mut chars = fd_rest.chars();
        let flags = chars.next()?.to_digit(16)?;
        let n = hex_bytes(chars.as_str(), &mut data)?;
        let mut f = SimFrame::fd(id, extended, flags & 1 != 0, &data[..n]);
        f.esi = flags & 2 != 0;
        return Some(Some(f));
    }
    if let Some(r) = rest.strip_prefix('R').or_else(|| rest.strip_prefix('r')) {
        let dlc = if r.is_empty() {
            0
        } else {
            r.parse::<u8>().ok()?.min(8)
        };
        return Some(Some(SimFrame::remote(id, extended, dlc)));
    }
    let n = hex_bytes(rest, &mut data)?;
    if n > 8 {
        return None;
    }
    Some(Some(SimFrame::classic(id, extended, &data[..n])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candump_lines() {
        let f = parse_frame("123#DEAD").unwrap().unwrap();
        assert_eq!(
            (f.id, f.extended, f.payload()),
            (0x123, false, &[0xDE, 0xAD][..])
        );
        let f = parse_frame("1ABCDEF0##1").unwrap().unwrap();
        assert!(f.fd && f.brs && f.extended && f.payload().is_empty());
        let f = parse_frame("7FF#R8").unwrap().unwrap();
        assert!(f.rtr && f.dlc == 8);
        assert!(parse_frame("20000080#0000").unwrap().is_none());
        assert!(parse_frame("12#00").is_none());
        assert_eq!(
            parse_ts_us("1436509052.249713"),
            Some(1_436_509_052_249_713)
        );
    }

    #[test]
    fn mock_is_deterministic() {
        let mut a = SimFrame::default();
        let mut b = SimFrame::default();
        for n in 0..100 {
            mock_frame(2, n, &mut a);
            mock_frame(2, n, &mut b);
            assert_eq!(a, b);
        }
    }
}
