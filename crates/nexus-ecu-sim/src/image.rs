//! Sparse memory-image JSON written by the simulator:
//!
//! ```json
//! { "format": "nexus-ecu-sim-image/1",
//!   "regions": [ { "address": 134217728, "length": 524288, "addressHex": "0x08000000" } ],
//!   "written": [ { "address": 134217728, "length": 4, "addressHex": "0x08000000", "dataHex": "DEADBEEF" } ] }
//! ```
//!
//! `written` lists only bytes programmed via TransferData since their last
//! erase. Files are replaced atomically (write to `*.tmp`, fsync, rename).

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::firmware::SparseImage;
use crate::memory::Memory;

pub const FORMAT: &str = "nexus-ecu-sim-image/1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionDesc {
    pub address: u64,
    pub length: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_hex: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenDesc {
    pub address: u64,
    #[serde(default)]
    pub length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_hex: Option<String>,
    pub data_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageFile {
    #[serde(default)]
    pub format: Option<String>,
    pub regions: Vec<RegionDesc>,
    pub written: Vec<WrittenDesc>,
}

pub fn hex_encode(data: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(data.len() * 2);
    for &b in data {
        s.push(D[usize::from(b >> 4)] as char);
        s.push(D[usize::from(b & 0xF)] as char);
    }
    s
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) {
        return Err("odd-length hex string".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

impl ImageFile {
    pub fn from_memory(mem: &Memory) -> Self {
        Self {
            format: Some(FORMAT.to_string()),
            regions: mem
                .regions()
                .iter()
                .map(|r| RegionDesc {
                    address: r.address,
                    length: r.len(),
                    address_hex: Some(format!("0x{:08X}", r.address)),
                })
                .collect(),
            written: mem
                .written_runs()
                .into_iter()
                .map(|(a, d)| WrittenDesc {
                    address: a,
                    length: Some(d.len() as u64),
                    address_hex: Some(format!("0x{a:08X}")),
                    data_hex: hex_encode(d),
                })
                .collect(),
        }
    }

    pub fn to_sparse(&self) -> Result<SparseImage, String> {
        let mut chunks = Vec::with_capacity(self.written.len());
        for w in &self.written {
            let d =
                hex_decode(&w.data_hex).map_err(|e| format!("written@0x{:08X}: {e}", w.address))?;
            if let Some(l) = w.length {
                if l != d.len() as u64 {
                    return Err(format!(
                        "written@0x{:08X}: length {l} != {} data bytes",
                        w.address,
                        d.len()
                    ));
                }
            }
            chunks.push((w.address, d));
        }
        SparseImage::from_chunks(chunks)
    }
}

/// Atomically writes the memory image JSON to `path`.
pub fn write_atomic(path: &Path, mem: &Memory) -> std::io::Result<()> {
    let img = ImageFile::from_memory(mem);
    let json = serde_json::to_vec_pretty(&img).map_err(std::io::Error::other)?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

pub fn load(path: &Path) -> Result<SparseImage, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let img: ImageFile =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    img.to_sparse()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_through_file() {
        let mut m = Memory::new(&[(0x0800_0000, 0x1000)]);
        m.erase(0x0800_0000, 0x1000).unwrap();
        m.program(0x0800_0010, &[1, 2, 3]).unwrap();
        m.program(0x0800_0100, &[0xFF, 0x00]).unwrap();
        let dir = std::env::temp_dir().join(format!("nexus-ecu-sim-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("img.json");
        write_atomic(&p, &m).unwrap();
        let sparse = load(&p).unwrap();
        let want = SparseImage::from_chunks(vec![
            (0x0800_0010, vec![1, 2, 3]),
            (0x0800_0100, vec![0xFF, 0x00]),
        ])
        .unwrap();
        assert!(SparseImage::compare(&want, &sparse).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hex_codec() {
        assert_eq!(hex_encode(&[0x00, 0xAB, 0xFF]), "00ABFF");
        assert_eq!(hex_decode("00abFF").unwrap(), vec![0, 0xAB, 0xFF]);
        assert!(hex_decode("abc").is_err());
    }
}
