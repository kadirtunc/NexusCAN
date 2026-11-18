//! Simulated flash memory: a set of non-overlapping regions with NOR-flash
//! semantics. A byte can only be programmed once after an erase; programming
//! a non-erased byte is a `generalProgrammingFailure` (NRC 0x72).
//!
//! Power-on content is a deterministic "old firmware" pattern that is *not*
//! erased, so a RequestDownload without a prior eraseMemory is rejected.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemError {
    /// Range not fully contained in a single region.
    OutOfRange,
    /// Target byte not erased.
    NotErased { address: u64 },
}

#[derive(Debug, Clone)]
pub struct Region {
    pub address: u64,
    pub data: Vec<u8>,
    erased: Vec<bool>,
    written: Vec<bool>,
}

impl Region {
    pub fn len(&self) -> u64 {
        self.data.len() as u64
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    fn end(&self) -> u64 {
        self.address + self.len()
    }
}

#[derive(Debug, Clone)]
pub struct Memory {
    regions: Vec<Region>,
}

impl Memory {
    pub fn new(regions: &[(u32, u32)]) -> Self {
        let regions = regions
            .iter()
            .map(|&(a, l)| {
                let data = (0..l)
                    .map(|i| (i.wrapping_mul(31).wrapping_add(7) ^ (i >> 8)) as u8)
                    .collect();
                Region {
                    address: u64::from(a),
                    data,
                    erased: vec![false; l as usize],
                    written: vec![false; l as usize],
                }
            })
            .collect();
        Self { regions }
    }

    pub fn regions(&self) -> &[Region] {
        &self.regions
    }

    /// Index of the region fully containing `[addr, addr+len)` and the offset.
    pub fn locate(&self, addr: u64, len: u64) -> Option<(usize, usize)> {
        let end = addr.checked_add(len)?;
        self.regions
            .iter()
            .position(|r| addr >= r.address && end <= r.end())
            .map(|i| (i, (addr - self.regions[i].address) as usize))
    }

    pub fn erase(&mut self, addr: u64, len: u64) -> Result<(), MemError> {
        let (i, off) = self.locate(addr, len).ok_or(MemError::OutOfRange)?;
        let r = &mut self.regions[i];
        let n = len as usize;
        r.data[off..off + n].fill(0xFF);
        r.erased[off..off + n].fill(true);
        r.written[off..off + n].fill(false);
        Ok(())
    }

    pub fn erase_all(&mut self) {
        for r in &mut self.regions {
            r.data.fill(0xFF);
            r.erased.fill(true);
            r.written.fill(false);
        }
    }

    pub fn is_erased(&self, addr: u64, len: u64) -> Result<bool, MemError> {
        let (i, off) = self.locate(addr, len).ok_or(MemError::OutOfRange)?;
        Ok(self.regions[i].erased[off..off + len as usize]
            .iter()
            .all(|&e| e))
    }

    /// Programs `data` at `addr`. All-or-nothing: nothing is written if any
    /// target byte is not erased.
    pub fn program(&mut self, addr: u64, data: &[u8]) -> Result<(), MemError> {
        let (i, off) = self
            .locate(addr, data.len() as u64)
            .ok_or(MemError::OutOfRange)?;
        let r = &mut self.regions[i];
        if let Some(p) = r.erased[off..off + data.len()].iter().position(|&e| !e) {
            return Err(MemError::NotErased {
                address: addr + p as u64,
            });
        }
        r.data[off..off + data.len()].copy_from_slice(data);
        r.erased[off..off + data.len()].fill(false);
        r.written[off..off + data.len()].fill(true);
        Ok(())
    }

    pub fn read(&self, addr: u64, len: u64) -> Option<&[u8]> {
        let (i, off) = self.locate(addr, len)?;
        Some(&self.regions[i].data[off..off + len as usize])
    }

    /// Contiguous runs of bytes programmed since their last erase.
    pub fn written_runs(&self) -> Vec<(u64, &[u8])> {
        let mut out = Vec::new();
        for r in &self.regions {
            let mut i = 0;
            while i < r.written.len() {
                if r.written[i] {
                    let start = i;
                    while i < r.written.len() && r.written[i] {
                        i += 1;
                    }
                    out.push((r.address + start as u64, &r.data[start..i]));
                } else {
                    i += 1;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flash_semantics() {
        let mut m = Memory::new(&[(0x1000, 0x100), (0x2000, 0x10)]);
        assert_eq!(m.is_erased(0x1000, 0x10), Ok(false));
        assert_eq!(
            m.program(0x1000, &[1, 2]),
            Err(MemError::NotErased { address: 0x1000 })
        );
        m.erase(0x1000, 0x80).unwrap();
        assert_eq!(m.is_erased(0x1000, 0x80), Ok(true));
        assert_eq!(m.is_erased(0x1000, 0x81), Ok(false));
        m.program(0x1010, &[0xAA, 0xBB]).unwrap();
        assert_eq!(
            m.program(0x1011, &[0]),
            Err(MemError::NotErased { address: 0x1011 })
        );
        assert_eq!(m.read(0x100F, 4).unwrap(), &[0xFF, 0xAA, 0xBB, 0xFF]);
        let runs = m.written_runs();
        assert_eq!(runs, vec![(0x1010, &[0xAA, 0xBB][..])]);
        // crossing regions / outside
        assert_eq!(m.erase(0x10F0, 0x20), Err(MemError::OutOfRange));
        assert_eq!(m.locate(0x2000, 0x10), Some((1, 0)));
        assert_eq!(m.locate(0x2000, 0x11), None);
        assert_eq!(m.locate(u64::MAX, 2), None);
    }
}
