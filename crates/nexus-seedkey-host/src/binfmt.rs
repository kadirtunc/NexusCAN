//! Executable header sniffing: container format + CPU architecture of a shared library.
//!
//! Pure byte parsing — the file is never mapped, loaded or executed. Used for the bitness
//! pre-flight (which helper binary must run the library) and for `probe`.
//!
//! * PE: `MZ`, `e_lfanew @ 0x3C`, `PE\0\0`, `IMAGE_FILE_HEADER.Machine`
//!   (`0x014C` i386, `0x8664` AMD64, `0xAA64` ARM64, `0x01C4` ARMNT), `Characteristics & 0x2000` = DLL.
//! * ELF: `\x7FELF`, `EI_CLASS` (1 = 32-bit, 2 = 64-bit), `EI_DATA`, `e_machine @ 18`
//!   (3 = x86, 62 = x86_64, 40 = ARM, 183 = AArch64).
//! * Mach-O: thin `0xFEEDFACE` / `0xFEEDFACF` (either byte order) and universal `0xCAFEBABE`
//!   (`cputype` 7 = x86, `0x01000007` = x86_64, 12 = ARM, `0x0100000C` = arm64).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes read from the start of the file (PE headers normally live in the first 1 KiB).
const HEAD_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BinFormat {
    Pe,
    Elf,
    MachO,
    Unknown,
}

impl BinFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pe => "pe",
            Self::Elf => "elf",
            Self::MachO => "macho",
            Self::Unknown => "unknown",
        }
    }

    /// Native shared-library format of an OS (`std::env::consts::OS` value).
    pub fn native_for_os(os: &str) -> Self {
        match os {
            "windows" => Self::Pe,
            "macos" | "ios" => Self::MachO,
            _ => Self::Elf,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BinArch {
    X86,
    X86_64,
    Aarch64,
    Arm,
    Unknown,
}

impl BinArch {
    /// Same strings as `std::env::consts::ARCH` / `SeedKeyLibraryInfoDto.arch`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::X86 => "x86",
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
            Self::Arm => "arm",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_consts(arch: &str) -> Self {
        match arch {
            "x86" => Self::X86,
            "x86_64" => Self::X86_64,
            "aarch64" => Self::Aarch64,
            "arm" => Self::Arm,
            _ => Self::Unknown,
        }
    }

    /// Architecture this code was compiled for.
    pub fn current() -> Self {
        Self::from_consts(std::env::consts::ARCH)
    }

    /// Pointer width in bits.
    pub fn bits(self) -> Option<u8> {
        match self {
            Self::X86 | Self::Arm => Some(32),
            Self::X86_64 | Self::Aarch64 => Some(64),
            Self::Unknown => None,
        }
    }

    /// 32-bit architecture a 64-bit host of this architecture can usually run natively
    /// (WoW64 on Windows, multiarch / compat on Linux).
    pub fn companion_32(self) -> Option<Self> {
        match self {
            Self::X86_64 => Some(Self::X86),
            Self::Aarch64 => Some(Self::Arm),
            _ => None,
        }
    }
}

/// What the header says about a binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryInfo {
    pub format: BinFormat,
    /// One entry for thin binaries; several for Mach-O universal binaries.
    pub archs: Vec<BinArch>,
    /// PE `IMAGE_FILE_DLL` / ELF `ET_DYN` / Mach-O `MH_DYLIB` when known.
    pub is_shared_library: Option<bool>,
}

impl BinaryInfo {
    fn unknown() -> Self {
        Self {
            format: BinFormat::Unknown,
            archs: vec![BinArch::Unknown],
            is_shared_library: None,
        }
    }

    /// First architecture (the only one for thin binaries).
    pub fn primary_arch(&self) -> BinArch {
        self.archs.first().copied().unwrap_or(BinArch::Unknown)
    }

    /// `"x86"`, or `"x86_64+aarch64"` for universal binaries.
    pub fn arch_label(&self) -> String {
        self.archs
            .iter()
            .map(|a| a.as_str())
            .collect::<Vec<_>>()
            .join("+")
    }
}

fn u16_at(b: &[u8], off: usize, le: bool) -> Option<u16> {
    let s: [u8; 2] = b.get(off..off.checked_add(2)?)?.try_into().ok()?;
    Some(if le {
        u16::from_le_bytes(s)
    } else {
        u16::from_be_bytes(s)
    })
}

fn u32_at(b: &[u8], off: usize, le: bool) -> Option<u32> {
    let s: [u8; 4] = b.get(off..off.checked_add(4)?)?.try_into().ok()?;
    Some(if le {
        u32::from_le_bytes(s)
    } else {
        u32::from_be_bytes(s)
    })
}

fn pe_machine(machine: u16) -> BinArch {
    match machine {
        0x014C => BinArch::X86,
        0x8664 => BinArch::X86_64,
        0xAA64 => BinArch::Aarch64,
        0x01C0 | 0x01C2 | 0x01C4 => BinArch::Arm,
        _ => BinArch::Unknown,
    }
}

fn elf_machine(machine: u16) -> BinArch {
    match machine {
        3 => BinArch::X86,
        62 => BinArch::X86_64,
        40 => BinArch::Arm,
        183 => BinArch::Aarch64,
        _ => BinArch::Unknown,
    }
}

fn macho_cpu(cputype: u32) -> BinArch {
    match cputype {
        7 => BinArch::X86,
        0x0100_0007 => BinArch::X86_64,
        12 => BinArch::Arm,
        0x0100_000C => BinArch::Aarch64,
        _ => BinArch::Unknown,
    }
}

/// Parses the NT headers; `nt` starts at the `PE\0\0` signature (file offset `e_lfanew`).
fn parse_pe_nt(nt: &[u8]) -> Option<BinaryInfo> {
    if nt.get(0..4)? != b"PE\0\0" {
        return None;
    }
    let machine = u16_at(nt, 4, true)?;
    let characteristics = u16_at(nt, 22, true)?;
    Some(BinaryInfo {
        format: BinFormat::Pe,
        archs: vec![pe_machine(machine)],
        is_shared_library: Some(characteristics & 0x2000 != 0),
    })
}

/// Inspects in-memory header bytes. For PE files whose `PE\0\0` signature lies beyond
/// `head`, returns `format = Pe` with `arch = Unknown`; use [`inspect_file`] for files.
pub fn inspect_bytes(head: &[u8]) -> BinaryInfo {
    if head.starts_with(b"MZ") {
        let Some(pe_off) = u32_at(head, 0x3C, true) else {
            return BinaryInfo {
                format: BinFormat::Pe,
                ..BinaryInfo::unknown()
            };
        };
        return head
            .get(pe_off as usize..)
            .and_then(parse_pe_nt)
            .unwrap_or(BinaryInfo {
                format: BinFormat::Pe,
                ..BinaryInfo::unknown()
            });
    }
    if head.starts_with(b"\x7FELF") {
        let le = head.get(5) != Some(&2);
        let arch = u16_at(head, 18, le).map_or(BinArch::Unknown, elf_machine);
        let e_type = u16_at(head, 16, le);
        return BinaryInfo {
            format: BinFormat::Elf,
            archs: vec![arch],
            is_shared_library: e_type.map(|t| t == 3),
        };
    }
    if let Some(magic) = u32_at(head, 0, false) {
        match magic {
            // Thin Mach-O, big-endian or little-endian magic.
            0xFEED_FACE | 0xFEED_FACF | 0xCEFA_EDFE | 0xCFFA_EDFE => {
                let le = matches!(magic, 0xCEFA_EDFE | 0xCFFA_EDFE);
                let arch = u32_at(head, 4, le).map_or(BinArch::Unknown, macho_cpu);
                let filetype = u32_at(head, 12, le);
                return BinaryInfo {
                    format: BinFormat::MachO,
                    archs: vec![arch],
                    is_shared_library: filetype.map(|t| t == 6),
                };
            }
            // Universal (fat) binary, always big-endian. Java class files share the magic but
            // have a large "count" (major version); cap the arch count.
            0xCAFE_BABE => {
                let n = u32_at(head, 4, false).unwrap_or(0);
                if (1..=16).contains(&n) {
                    let archs: Vec<BinArch> = (0..n as usize)
                        .filter_map(|i| u32_at(head, 8 + i * 20, false))
                        .map(macho_cpu)
                        .collect();
                    if !archs.is_empty() {
                        return BinaryInfo {
                            format: BinFormat::MachO,
                            archs,
                            is_shared_library: None,
                        };
                    }
                }
            }
            _ => {}
        }
    }
    BinaryInfo::unknown()
}

/// Reads the header of `path` (never maps / loads / executes it).
pub fn inspect_file(path: &Path) -> io::Result<BinaryInfo> {
    let mut file = File::open(path)?;
    let mut head = Vec::with_capacity(4096);
    (&mut file).take(HEAD_LEN as u64).read_to_end(&mut head)?;
    let info = inspect_bytes(&head);
    if info.format == BinFormat::Pe && info.primary_arch() == BinArch::Unknown {
        // `e_lfanew` beyond the first chunk: read the NT header directly.
        if let Some(pe_off) = u32_at(&head, 0x3C, true) {
            if pe_off as usize >= head.len() {
                let mut nt = [0u8; 24];
                file.seek(SeekFrom::Start(u64::from(pe_off)))?;
                if file.read_exact(&mut nt).is_ok() {
                    if let Some(parsed) = parse_pe_nt(&nt) {
                        return Ok(parsed);
                    }
                }
            }
        }
    }
    Ok(info)
}

/// Builds a minimal PE header (MZ stub + NT signature + file header) for tests and fixtures.
pub fn fake_pe_header(machine: u16, dll: bool) -> Vec<u8> {
    let mut b = vec![0u8; 0x100];
    b[0..2].copy_from_slice(b"MZ");
    b[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    b[0x80..0x84].copy_from_slice(b"PE\0\0");
    b[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
    let characteristics: u16 = if dll { 0x2102 } else { 0x0102 };
    b[0x96..0x98].copy_from_slice(&characteristics.to_le_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pe_machines() {
        for (machine, arch) in [
            (0x014C, BinArch::X86),
            (0x8664, BinArch::X86_64),
            (0xAA64, BinArch::Aarch64),
            (0x01C4, BinArch::Arm),
        ] {
            let info = inspect_bytes(&fake_pe_header(machine, true));
            assert_eq!(info.format, BinFormat::Pe);
            assert_eq!(info.archs, vec![arch]);
            assert_eq!(info.is_shared_library, Some(true));
        }
        assert_eq!(
            inspect_bytes(&fake_pe_header(0x014C, false)).is_shared_library,
            Some(false)
        );
        // Truncated PE: format known, arch unknown.
        let info = inspect_bytes(b"MZ");
        assert_eq!(info.format, BinFormat::Pe);
        assert_eq!(info.primary_arch(), BinArch::Unknown);
    }

    #[test]
    fn elf_classes_and_machines() {
        let mut elf32 = vec![0u8; 64];
        elf32[0..4].copy_from_slice(b"\x7FELF");
        elf32[4] = 1; // ELFCLASS32
        elf32[5] = 1; // little-endian
        elf32[16..18].copy_from_slice(&3u16.to_le_bytes()); // ET_DYN
        elf32[18..20].copy_from_slice(&3u16.to_le_bytes()); // EM_386
        let info = inspect_bytes(&elf32);
        assert_eq!(info.format, BinFormat::Elf);
        assert_eq!(info.archs, vec![BinArch::X86]);
        assert_eq!(info.is_shared_library, Some(true));

        let mut elf64 = elf32.clone();
        elf64[4] = 2;
        elf64[18..20].copy_from_slice(&183u16.to_le_bytes());
        assert_eq!(inspect_bytes(&elf64).archs, vec![BinArch::Aarch64]);
    }

    #[test]
    fn macho_thin_and_universal() {
        let mut thin = vec![0u8; 32];
        thin[0..4].copy_from_slice(&0xFEED_FACFu32.to_le_bytes()); // on-disk LE magic
        thin[4..8].copy_from_slice(&0x0100_000Cu32.to_le_bytes());
        thin[12..16].copy_from_slice(&6u32.to_le_bytes());
        let info = inspect_bytes(&thin);
        assert_eq!(info.format, BinFormat::MachO);
        assert_eq!(info.archs, vec![BinArch::Aarch64]);
        assert_eq!(info.is_shared_library, Some(true));

        let mut fat = vec![0u8; 8 + 2 * 20];
        fat[0..4].copy_from_slice(&0xCAFE_BABEu32.to_be_bytes());
        fat[4..8].copy_from_slice(&2u32.to_be_bytes());
        fat[8..12].copy_from_slice(&0x0100_0007u32.to_be_bytes());
        fat[28..32].copy_from_slice(&0x0100_000Cu32.to_be_bytes());
        let info = inspect_bytes(&fat);
        assert_eq!(info.archs, vec![BinArch::X86_64, BinArch::Aarch64]);
        assert_eq!(info.arch_label(), "x86_64+aarch64");
    }

    #[test]
    fn unknown_and_current() {
        assert_eq!(inspect_bytes(b"hello").format, BinFormat::Unknown);
        assert_ne!(BinArch::current(), BinArch::Unknown);
        assert_eq!(BinArch::X86_64.companion_32(), Some(BinArch::X86));
    }

    #[test]
    fn inspects_own_test_binary() {
        let exe = std::env::current_exe().unwrap();
        let info = inspect_file(&exe).unwrap();
        assert_eq!(info.format, BinFormat::native_for_os(std::env::consts::OS));
        assert!(info.archs.contains(&BinArch::current()), "{info:?}");
    }
}
