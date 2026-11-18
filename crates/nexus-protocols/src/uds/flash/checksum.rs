//! Firmware checksum helpers (table-driven, no external crate).
//!
//! | Function | Algorithm | Check value (`"123456789"`) |
//! | :--- | :--- | :--- |
//! | [`crc32_ieee`] / [`Crc32`] | CRC-32/ISO-HDLC (poly `0x04C11DB7` reflected, init/xorout `0xFFFFFFFF`) | `0xCBF43926` |
//! | [`crc16_ccitt`] / [`Crc16Ccitt`] | CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`, no reflection, xorout 0) | `0x29B1` |
//! | [`sum8`] | wrapping byte sum mod 2^8 | `0xDD` |
//! | [`sum16`] | wrapping byte sum mod 2^16 | `0x01DD` |

/// Reflected CRC-32 table (poly 0xEDB88320).
const CRC32_TABLE: [u32; 256] = {
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
};

/// MSB-first CRC-16 table (poly 0x1021).
const CRC16_CCITT_TABLE: [u16; 256] = {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = (i as u16) << 8;
        let mut k = 0;
        while k < 8 {
            c = if c & 0x8000 != 0 {
                (c << 1) ^ 0x1021
            } else {
                c << 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

/// Incremental CRC-32 (IEEE 802.3 / zlib / PNG).
#[derive(Debug, Clone, Copy)]
pub struct Crc32 {
    state: u32,
}

impl Default for Crc32 {
    fn default() -> Self {
        Self::new()
    }
}

impl Crc32 {
    pub const fn new() -> Self {
        Self { state: 0xFFFF_FFFF }
    }

    pub fn update(&mut self, data: &[u8]) {
        let mut c = self.state;
        for &b in data {
            c = CRC32_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
        }
        self.state = c;
    }

    pub const fn finish(&self) -> u32 {
        self.state ^ 0xFFFF_FFFF
    }
}

/// One-shot CRC-32 (IEEE).
pub fn crc32_ieee(data: &[u8]) -> u32 {
    let mut c = Crc32::new();
    c.update(data);
    c.finish()
}

/// Incremental CRC-16/CCITT-FALSE.
#[derive(Debug, Clone, Copy)]
pub struct Crc16Ccitt {
    state: u16,
}

impl Default for Crc16Ccitt {
    fn default() -> Self {
        Self::new()
    }
}

impl Crc16Ccitt {
    pub const fn new() -> Self {
        Self { state: 0xFFFF }
    }

    pub fn update(&mut self, data: &[u8]) {
        let mut c = self.state;
        for &b in data {
            c = (c << 8) ^ CRC16_CCITT_TABLE[(((c >> 8) as u8) ^ b) as usize];
        }
        self.state = c;
    }

    pub const fn finish(&self) -> u16 {
        self.state
    }
}

/// One-shot CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF).
pub fn crc16_ccitt(data: &[u8]) -> u16 {
    let mut c = Crc16Ccitt::new();
    c.update(data);
    c.finish()
}

/// Wrapping 8-bit byte sum.
pub fn sum8(data: &[u8]) -> u8 {
    data.iter().fold(0u8, |a, &b| a.wrapping_add(b))
}

/// Wrapping 16-bit byte sum.
pub fn sum16(data: &[u8]) -> u16 {
    data.iter().fold(0u16, |a, &b| a.wrapping_add(u16::from(b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHECK: &[u8] = b"123456789";

    #[test]
    fn crc32_known_answers() {
        assert_eq!(crc32_ieee(CHECK), 0xCBF4_3926);
        assert_eq!(crc32_ieee(b""), 0);
        assert_eq!(
            crc32_ieee(b"The quick brown fox jumps over the lazy dog"),
            0x414F_A339
        );
    }

    #[test]
    fn crc32_incremental_matches_one_shot() {
        let mut c = Crc32::new();
        c.update(b"1234");
        c.update(b"");
        c.update(b"56789");
        assert_eq!(c.finish(), 0xCBF4_3926);
    }

    #[test]
    fn crc16_ccitt_known_answers() {
        assert_eq!(crc16_ccitt(CHECK), 0x29B1);
        assert_eq!(crc16_ccitt(b""), 0xFFFF);
        let mut c = Crc16Ccitt::new();
        c.update(b"12345");
        c.update(b"6789");
        assert_eq!(c.finish(), 0x29B1);
    }

    #[test]
    fn sums_known_answers() {
        assert_eq!(sum8(CHECK), 0xDD);
        assert_eq!(sum16(CHECK), 0x01DD);
        assert_eq!(sum8(&[0xFF, 0x02]), 0x01);
        assert_eq!(sum16(&[0xFF; 300]), (300u32 * 0xFF) as u16);
    }
}
