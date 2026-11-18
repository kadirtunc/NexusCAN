//! SecurityAccess seed/key algorithms.
//!
//! These replicate — independently, from the documented definition, not by
//! code reuse — the NexusCAN `builtin` providers so the flasher can unlock:
//!
//! * `xor_ff`            : `key[i] = seed[i] ^ 0xFF`
//! * `xor_const[:HEX]`   : `key[i] = seed[i] ^ C.to_be_bytes()[i % 4]`,
//!   `C` defaults to `0x5A3C1E8F`.
//!
//! Constant parsing: an optional `0x` prefix, then 1..=8 hex digits. (The
//! NexusCAN builtin additionally emulates JavaScript `parseInt` quirks for
//! malformed or >8 digit input; the simulator rejects such input instead so a
//! misconfigured HIL run fails loudly rather than silently diverging.)

use std::fmt;
use std::str::FromStr;

/// Default `xor_const` constant (matches NexusCAN `builtin::DEFAULT_CONSTANT`).
pub const DEFAULT_XOR_CONST: u32 = 0x5A3C_1E8F;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedAlgo {
    XorFf,
    XorConst(u32),
}

impl SeedAlgo {
    /// Expected key for `seed`.
    pub fn key(&self, seed: &[u8]) -> Vec<u8> {
        match *self {
            SeedAlgo::XorFf => seed.iter().map(|b| b ^ 0xFF).collect(),
            SeedAlgo::XorConst(c) => {
                let cb = c.to_be_bytes();
                seed.iter()
                    .zip(cb.iter().cycle())
                    .map(|(s, k)| s ^ k)
                    .collect()
            }
        }
    }
}

impl fmt::Display for SeedAlgo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SeedAlgo::XorFf => write!(f, "xor_ff"),
            SeedAlgo::XorConst(c) => write!(f, "xor_const:{c:08X}"),
        }
    }
}

impl FromStr for SeedAlgo {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        let (name, arg) = match s.split_once(':') {
            Some((n, a)) => (n, Some(a)),
            None => (s, None),
        };
        match (name.to_ascii_lowercase().as_str(), arg) {
            ("xor_ff", None) => Ok(SeedAlgo::XorFf),
            ("xor_const", None) => Ok(SeedAlgo::XorConst(DEFAULT_XOR_CONST)),
            ("xor_const", Some(hex)) => {
                let h = hex
                    .strip_prefix("0x")
                    .or_else(|| hex.strip_prefix("0X"))
                    .unwrap_or(hex);
                if h.is_empty() || h.len() > 8 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(format!(
                        "xor_const constant must be 1..=8 hex digits, got '{hex}'"
                    ));
                }
                u32::from_str_radix(h, 16)
                    .map(SeedAlgo::XorConst)
                    .map_err(|e| e.to_string())
            }
            _ => Err(format!(
                "unknown seed algorithm '{s}' (expected xor_ff | xor_const[:HEX])"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xor_ff_vector() {
        assert_eq!(
            SeedAlgo::XorFf.key(&[0x12, 0x34, 0x00, 0xFF]),
            vec![0xED, 0xCB, 0xFF, 0x00]
        );
    }

    #[test]
    fn xor_const_vectors() {
        let a = SeedAlgo::XorConst(DEFAULT_XOR_CONST);
        // 0x11^0x5A, 0x22^0x3C, 0x33^0x1E, 0x44^0x8F, 0x55^0x5A (cycles BE bytes)
        assert_eq!(
            a.key(&[0x11, 0x22, 0x33, 0x44, 0x55]),
            vec![0x4B, 0x1E, 0x2D, 0xCB, 0x0F]
        );
    }

    #[test]
    fn parsing() {
        assert_eq!("xor_ff".parse::<SeedAlgo>().unwrap(), SeedAlgo::XorFf);
        assert_eq!(
            "xor_const".parse::<SeedAlgo>().unwrap(),
            SeedAlgo::XorConst(0x5A3C_1E8F)
        );
        assert_eq!(
            "xor_const:0xDEADBEEF".parse::<SeedAlgo>().unwrap(),
            SeedAlgo::XorConst(0xDEAD_BEEF)
        );
        assert_eq!(
            "xor_const:1".parse::<SeedAlgo>().unwrap(),
            SeedAlgo::XorConst(1)
        );
        assert!("xor_const:123456789".parse::<SeedAlgo>().is_err());
        assert!("xor_const:zz".parse::<SeedAlgo>().is_err());
        assert!("crc32".parse::<SeedAlgo>().is_err());
    }
}
