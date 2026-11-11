//! `builtin` demo algorithms, bit-exact with the legacy TypeScript
//! `calculateKey` in `src/components/diagnostics/uds-flow/FlowEngine.ts`.
//!
//! All quirks of the legacy implementation are reproduced on purpose so that
//! flows migrated from the JS engine keep producing identical keys:
//!
//! * The constant is parsed like `parseInt(hex.replace(/[^0-9a-fA-F]/g,'') || '5A3C1E8F', 16) >>> 0`
//!   — non-hex characters are dropped (so `0x` loses its `x`), an empty result
//!   falls back to the default, and inputs longer than 8 digits go through an
//!   IEEE-754 double (53-bit mantissa, round-half-even) before `ToUint32`.
//! * Seeds shorter than 4 bytes take per-byte fallbacks in `add_const` /
//!   `right_rotate` (`ror32(b, 2) & 0xFF`, i.e. `b >> 2`).
//! * `crc16_kermit` is the TS `crc16ibm` (reflected poly 0x8408, init 0, no
//!   final XOR — CRC-16/KERMIT), emitted big-endian.
//! * Empty seeds give empty keys for the per-byte algorithms (legacy parity).

use super::super::{BuiltinAlgorithm, KeyProvider, SeedKeyError, SeedKeyRequest};
use super::check_seed_len;

/// Default constant used when `constantHex` is missing or contains no hex digit.
pub const DEFAULT_CONSTANT: u32 = 0x5A3C_1E8F;

pub(super) struct BuiltinProvider {
    algorithm: BuiltinAlgorithm,
    constant: u32,
}

impl BuiltinProvider {
    pub(super) fn new(algorithm: BuiltinAlgorithm, constant_hex: Option<&str>) -> Self {
        Self {
            algorithm,
            constant: legacy_constant(constant_hex.unwrap_or("")),
        }
    }
}

impl KeyProvider for BuiltinProvider {
    fn kind(&self) -> &'static str {
        "builtin"
    }

    fn compute_key(&self, req: &SeedKeyRequest<'_>) -> Result<Vec<u8>, SeedKeyError> {
        check_seed_len(req.seed)?;
        Ok(compute(self.algorithm, req.seed, self.constant))
    }
}

/// Pure algorithm dispatch (exposed for parity tests).
pub(super) fn compute(algorithm: BuiltinAlgorithm, seed: &[u8], c: u32) -> Vec<u8> {
    match algorithm {
        BuiltinAlgorithm::XorFf => seed.iter().map(|b| b ^ 0xFF).collect(),
        BuiltinAlgorithm::XorConst => {
            let cb = c.to_be_bytes();
            seed.iter()
                .enumerate()
                .map(|(i, b)| b ^ cb[i % 4])
                .collect()
        }
        BuiltinAlgorithm::SumNegate => {
            // JS: sum is a Number, `~sum` is ToInt32 → NOT; wrapping u32 is equivalent.
            let sum = seed.iter().fold(0u32, |a, &b| a.wrapping_add(u32::from(b)));
            let neg = (!sum & 0xFFFF) as u16;
            neg.to_be_bytes().to_vec()
        }
        BuiltinAlgorithm::AddConst => match be_u32(seed) {
            Some(v) => v.wrapping_add(c).to_be_bytes().to_vec(),
            None => {
                let add = c.to_le_bytes()[0];
                seed.iter().map(|b| b.wrapping_add(add)).collect()
            }
        },
        BuiltinAlgorithm::RightRotate => match be_u32(seed) {
            Some(v) => (v.rotate_right(2) ^ c).to_be_bytes().to_vec(),
            // Legacy quirk: 32-bit rotate of a single byte, low byte kept.
            None => seed
                .iter()
                .map(|&b| u32::from(b).rotate_right(2).to_le_bytes()[0])
                .collect(),
        },
        BuiltinAlgorithm::Crc16Kermit => crc16_legacy(seed).to_be_bytes().to_vec(),
        BuiltinAlgorithm::Crc32 => crc32(seed).to_be_bytes().to_vec(),
    }
}

/// Big-endian u32 of the first 4 bytes, `None` for seeds shorter than 4 bytes.
fn be_u32(seed: &[u8]) -> Option<u32> {
    match seed {
        [a, b, c, d, ..] => Some(u32::from_be_bytes([*a, *b, *c, *d])),
        _ => None,
    }
}

/// Port of TS `crc16ibm` (byte-wise reflected 0x8408, init 0).
fn crc16_legacy(data: &[u8]) -> u16 {
    let mut crc: u32 = 0;
    for &byte in data {
        let mut b = u32::from(byte) ^ (crc & 0xFF);
        b ^= (b << 4) & 0xFF;
        crc = ((crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4)) & 0xFFFF;
    }
    (crc & 0xFFFF) as u16
}

/// CRC-32/ISO-HDLC (zlib), bitwise like the TS implementation.
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xFFFF_FFFF
}

/// Emulates `parseInt(s.replace(/[^0-9a-fA-F]/g, '') || '5A3C1E8F', 16) >>> 0`.
///
/// `parseInt` with radix 16 yields the exact integer rounded to the nearest
/// IEEE-754 double (ties to even); `>>> 0` then takes it modulo 2^32. Values
/// that need ≥ 86 bits keep no set bit below 2^32 after rounding (and an
/// overflow to `Infinity` maps to 0), so they always produce 0.
pub(super) fn legacy_constant(input: &str) -> u32 {
    let digits: Vec<u8> = input
        .bytes()
        .filter_map(|c| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        })
        .collect();
    if digits.is_empty() {
        return DEFAULT_CONSTANT;
    }
    let first_nz = digits.iter().position(|&d| d != 0);
    let Some(first_nz) = first_nz else {
        return 0;
    };
    let sig = &digits[first_nz..];
    // Number of significant bits of the exact value.
    let lead_bits = 8 - sig[0].leading_zeros() as usize;
    let bit_len = lead_bits + 4 * (sig.len() - 1);
    if bit_len <= 53 {
        let v = sig.iter().fold(0u64, |a, &d| (a << 4) | u64::from(d));
        return (v & 0xFFFF_FFFF) as u32;
    }
    // shift = number of bits dropped by rounding to a 53-bit mantissa.
    let shift = bit_len - 53;
    if shift >= 33 {
        // Even after a rounding carry, the value is a multiple of 2^33.
        return 0;
    }
    // bit_len ≤ 85 here: exact value fits into u128.
    let v = sig.iter().fold(0u128, |a, &d| (a << 4) | u128::from(d));
    let mut mantissa = v >> shift;
    let rem = v & ((1u128 << shift) - 1);
    let half = 1u128 << (shift - 1);
    if rem > half || (rem == half && mantissa & 1 == 1) {
        mantissa += 1;
    }
    ((mantissa << shift) & 0xFFFF_FFFF) as u32
}
