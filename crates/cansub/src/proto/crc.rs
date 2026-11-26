//! CRC-32 (IEEE 802.3, reflected poly `0xEDB88320`, init/xorout `0xFFFFFFFF`), const table. C1.
//!
//! This is the same CRC as Zephyr `crc32_ieee()` used by the CSS Electronics reference
//! implementation; the check value of `b"123456789"` is `0xCBF43926`.

/// Reflected IEEE 802.3 polynomial.
const POLY: u32 = 0xEDB8_8320;

/// Byte-wise lookup table, built at compile time.
const TABLE: [u32; 256] = build_table();

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ POLY } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

/// Incremental CRC-32 state (useful when the payload is produced in pieces).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crc32 {
    state: u32,
}

impl Crc32 {
    /// Fresh state (`init = 0xFFFFFFFF`).
    pub const fn new() -> Self {
        Self { state: 0xFFFF_FFFF }
    }

    /// Feeds `data` into the running CRC.
    pub fn update(&mut self, data: &[u8]) {
        let mut c = self.state;
        for &b in data {
            // Index is `u8`-derived, always < 256: never panics.
            c = TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
        }
        self.state = c;
    }

    /// Final CRC value (`xorout = 0xFFFFFFFF`). Does not consume the state.
    pub const fn finish(&self) -> u32 {
        self.state ^ 0xFFFF_FFFF
    }
}

impl Default for Crc32 {
    fn default() -> Self {
        Self::new()
    }
}

/// One-shot CRC-32 of `data`.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = Crc32::new();
    c.update(data);
    c.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn incremental_matches_one_shot() {
        let mut c = Crc32::new();
        c.update(b"1234");
        c.update(b"56789");
        assert_eq!(c.finish(), crc32(b"123456789"));
    }
}
