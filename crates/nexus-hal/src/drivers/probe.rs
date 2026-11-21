//! Cross-OS CAN hardware discovery, USB bus scanner, PE DLL architecture inspector,
//! and OS-specific diagnostics engine (`cmd_probe_drivers`) for all 7 CAN driver families:
//! `socketcan`, `gs_usb`, `slcan`, `pcan`, `kvaser`, `vector_xl`, and `mock`.
//!
//! Contains no `unsafe` code (the crate denies it); vendor FFI lives in `pcan_drv`.

pub use crate::drivers::gs_usb_drv::GsUsbDriver;
use crate::drivers::gs_usb_drv::{
    is_gs_usb_device_active_in_process, match_candlelight_usb_id, usb_device_location_info,
    STM32_DFU_USB_ID,
};
use crate::drivers::mock_drv::{MOCK0_DEVICE_ID, MOCK1_DEVICE_ID};
use crate::drivers::pcan_drv::{open_pcan_channel, pcan_enumerate_attached};
use crate::drivers::slcan_drv::discover_serial_ports;
#[cfg(target_os = "linux")]
use crate::drivers::slcan_drv::linux_has_rw_permission;
#[cfg(target_os = "linux")]
use crate::drivers::socketcan_drv::SocketCanDriver;
use crate::dto::{
    AdapterCapabilitiesDto, DetectedChannelDetailDto, DeviceDescriptorDto, DriverFamilyStatusDto,
    DriverProbeReportDto, HostEnvironmentDto, OsSetupStepDto, SerialPortInfoDto, UsbCanDeviceDto,
};
use crate::error::AdapterError;
use crate::traits::{AdapterDriver, CanChannel, ChannelConfig, DeviceDescriptor};
use std::env;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// =============================================================================
// Safe Pure-Rust Windows PE Header Architecture Inspector (`#![forbid(unsafe_code)]`)
// =============================================================================

/// Portable Executable (`PE\0\0`) target CPU architecture parsed from a `.dll` header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeArchitecture {
    /// `IMAGE_FILE_MACHINE_AMD64` (`0x8664`) — 64-bit x86_64.
    X86_64,
    /// `IMAGE_FILE_MACHINE_ARM64` (`0xAA64`) — 64-bit ARM64.
    Arm64,
    /// `IMAGE_FILE_MACHINE_I386` (`0x014C`) — 32-bit x86 (`SysWOW64` / legacy 32-bit SDK).
    I386,
    /// Other COFF machine identifier.
    Other(u16),
}

impl PeArchitecture {
    /// Human-readable label for diagnostics UI.
    #[inline]
    pub const fn label(self) -> &'static str {
        match self {
            Self::X86_64 => "64-bit (x64, PE 0x8664)",
            Self::Arm64 => "64-bit (ARM64, PE 0xAA64)",
            Self::I386 => "32-bit (x86, PE 0x014C)",
            Self::Other(_) => "Unknown PE Machine",
        }
    }

    /// Returns `true` if this DLL architecture can be loaded into the running host process.
    #[inline]
    pub fn matches_host_arch(self) -> bool {
        match env::consts::ARCH {
            "x86_64" => self == Self::X86_64,
            "aarch64" => self == Self::Arm64 || self == Self::X86_64, // ARM64EC / emulation awareness
            "x86" => self == Self::I386,
            _ => matches!(self, Self::X86_64 | Self::Arm64),
        }
    }
}

/// Parses the COFF `Machine` (`u16`) field from the first `<= 1024` bytes of a Windows `.dll` file.
///
/// Layout:
/// - `0x00..0x02`: `"MZ"` DOS header magic
/// - `0x3C..0x40`: `e_lfanew` (`u32` LE offset to `PE\0\0` signature)
/// - `e_lfanew..e_lfanew + 4`: `"PE\0\0"` NT header signature
/// - `e_lfanew + 4..e_lfanew + 6`: `Machine` (`u16` LE: `0x8664` x64, `0xAA64` ARM64, `0x014C` i386)
pub fn parse_pe_machine_type(bytes: &[u8]) -> Result<PeArchitecture, &'static str> {
    if bytes.len() < 0x40 {
        return Err("file shorter than 64-byte DOS MZ header");
    }
    if &bytes[0..2] != b"MZ" {
        return Err("missing DOS 'MZ' signature");
    }
    let pe_offset =
        u32::from_le_bytes([bytes[0x3C], bytes[0x3D], bytes[0x3E], bytes[0x3F]]) as usize;
    let Some(end) = pe_offset.checked_add(6) else {
        return Err("invalid PE header offset overflow");
    };
    if end > bytes.len() {
        return Err("PE header offset exceeds inspected buffer");
    }
    if &bytes[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err("missing 'PE\\0\\0' NT signature");
    }
    let machine = u16::from_le_bytes([bytes[pe_offset + 4], bytes[pe_offset + 5]]);
    Ok(match machine {
        0x8664 => PeArchitecture::X86_64,
        0xAA64 => PeArchitecture::Arm64,
        0x014C => PeArchitecture::I386,
        other => PeArchitecture::Other(other),
    })
}

/// Reads up to the first 1024 bytes of a `.dll` file on disk and inspects its PE architecture.
pub fn inspect_pe_dll_file(path: &Path) -> Result<PeArchitecture, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut header = [0u8; 1024];
    let mut total = 0usize;
    while total < header.len() {
        match file.read(&mut header[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("read failed: {e}")),
        }
    }
    parse_pe_machine_type(&header[..total]).map_err(str::to_string)
}

// =============================================================================
// Top-Level Probe Orchestrator (`probe_all_drivers`)
// =============================================================================

/// Runs a live diagnostic probe of host OS capabilities, attached USB CAN devices, serial ports,
/// and all **7** CAN driver families (`socketcan`, `gs_usb`, `slcan`, `pcan`, `kvaser`, `vector_xl`, `mock`).
pub fn probe_all_drivers() -> DriverProbeReportDto {
    let checked_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let host_env = probe_host_environment();
    let serial_ports = discover_serial_ports();
    let usb_devices = scan_usb_can_devices(&serial_ports);

    let families = vec![
        probe_socketcan_family_with_env(&host_env),
        probe_gs_usb_family_with_context(&host_env, &usb_devices),
        probe_slcan_family(&serial_ports),
        probe_pcan_family_with_usb(&usb_devices),
        probe_kvaser_family_with_usb(&usb_devices),
        probe_vector_xl_family_with_usb(&usb_devices),
        probe_mock_family(),
    ];

    DriverProbeReportDto {
        host_os: env::consts::OS.to_string(),
        checked_at_ms,
        host_env,
        usb_devices,
        families,
        serial_ports,
    }
}

// =============================================================================
// 1. Host OS Environment Prober (`probe_host_environment`)
// =============================================================================

/// Inspects kernel/OS version, WSL2 status, udev/serial permissions, and native CAN stacks.
pub fn probe_host_environment() -> HostEnvironmentDto {
    let os = env::consts::OS.to_string();
    let arch = env::consts::ARCH.to_string();

    if cfg!(target_os = "linux") {
        let kernel_rel = fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Linux".to_string());

        let distro = read_linux_pretty_name();
        let os_release = match distro {
            Some(d) => format!("{d} (kernel {kernel_rel})"),
            None => kernel_rel.clone(),
        };

        let rel_lower = kernel_rel.to_ascii_lowercase();
        let is_wsl = rel_lower.contains("microsoft")
            || rel_lower.contains("wsl")
            || Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists();

        let udev_rules_present = detect_linux_can_udev_rules();
        let serial_permission_hint = detect_linux_serial_permission_hint();

        let native_stacks = vec![
            "Linux Kernel SocketCAN (AF_CAN / PF_CAN, ARPHRD_CAN=280)".to_string(),
            "Linux usbfs Direct USB (nusb -> /dev/bus/usb/*)".to_string(),
            "POSIX termios Serial (/dev/ttyACM*, /dev/ttyUSB*)".to_string(),
            "Linux Vendor Shared Libraries (libpcanbasic.so / libcanlib.so)".to_string(),
        ];

        let mut os_notes = vec![
            "SocketCAN kernel drivers (gs_usb, peak_usb, kvaser_usb) expose native network interfaces (can0, can1); when unbound, NexusCAN falls back to pure-Rust nusb over usbfs.".to_string(),
            if udev_rules_present {
                "Detected CAN/USB udev permission rules under /etc/udev/rules.d or /lib/udev/rules.d.".to_string()
            } else {
                "No custom CAN udev rules found in /etc/udev/rules.d — direct rootless USB access requires a udev rule (MODE=\"0666\" or TAG+=\"uaccess\") unless using SocketCAN.".to_string()
            },
        ];

        if is_wsl {
            os_notes.push(
                "WSL2 detected: pass Windows USB-CAN adapters into WSL2 from an elevated PowerShell with 'usbipd list' -> 'usbipd bind --busid <BUSID>' -> 'usbipd attach --wsl --busid <BUSID>'."
                    .to_string(),
            );
            os_notes.push(
                "WSL2 note: stock Microsoft WSL2 kernels may omit vcan.ko / gs_usb.ko; once attached via usbipd, NexusCAN's built-in nusb gs_usb driver can still open candleLight hardware directly via /dev/bus/usb!"
                    .to_string(),
            );
        }

        HostEnvironmentDto {
            os,
            arch,
            os_release,
            is_wsl,
            udev_rules_present,
            serial_permission_hint,
            native_stacks,
            os_notes,
        }
    } else if cfg!(target_os = "windows") {
        let os_release = format!("Windows ({arch})");
        let native_stacks = vec![
            "WinUSB Direct USB (nusb)".to_string(),
            "Win32 SetupAPI Serial (COM1..COM256)".to_string(),
            "64-bit Vendor DLLs (PCANBasic.dll / canlib32.dll / vxlapi64.dll)".to_string(),
        ];
        let os_notes = vec![
            "candleLight / gs_usb adapters (1D50:606F, CANable, CANtact) use WinUSB directly via nusb. Modern firmware with Microsoft WCID binds WinUSB automatically; older firmware requires binding 'WinUSB' to Interface 0 once with Zadig.".to_string(),
            "Lawicel SLCAN USB-CDC adapters enumerate as COM ports (COM3..COM256) under 'Ports (COM & LPT)' in Windows Device Manager.".to_string(),
            format!(
                "Commercial SDK drivers (PCANBasic.dll, canlib32.dll, vxlapi64.dll) must match NexusCAN's {arch} process architecture (64-bit DLLs live in C:\\Windows\\System32; 32-bit x86 DLLs in SysWOW64 will be flagged)."
            ),
        ];

        HostEnvironmentDto {
            os,
            arch,
            os_release,
            is_wsl: false,
            udev_rules_present: false,
            serial_permission_hint: None,
            native_stacks,
            os_notes,
        }
    } else if cfg!(target_os = "macos") {
        let macos_ver = read_macos_product_version()
            .map(|v| format!("macOS Darwin {v} ({arch})"))
            .unwrap_or_else(|| format!("macOS Darwin ({arch})"));
        let native_stacks = vec![
            "IOKit Driverless USB (nusb)".to_string(),
            "POSIX Call-Out Serial (/dev/cu.usbmodem*, /dev/cu.usbserial*)".to_string(),
            "MacCAN PCBUSB Library (libPCBUSB.dylib)".to_string(),
        ];
        let os_notes = vec![
            "candleLight / gs_usb adapters (CANable, CANtact, candleLight FD) run 100% driverlessly on macOS via Apple IOKit — no kexts, DriverKit extensions, or Zadig needed!".to_string(),
            "For SLCAN serial adapters on macOS, always select '/dev/cu.*' (Call-Out) instead of '/dev/tty.*' (Dial-In) so open() does not block waiting on DCD carrier detect.".to_string(),
            "PEAK PCAN-USB adapters are supported on macOS via the MacCAN PCBUSB library (libPCBUSB.dylib); Vector XL is Windows-only.".to_string(),
        ];

        HostEnvironmentDto {
            os,
            arch,
            os_release: macos_ver,
            is_wsl: false,
            udev_rules_present: true,
            serial_permission_hint: None,
            native_stacks,
            os_notes,
        }
    } else {
        HostEnvironmentDto {
            os: os.clone(),
            arch: arch.clone(),
            os_release: format!("{os} ({arch})"),
            is_wsl: false,
            udev_rules_present: false,
            serial_permission_hint: None,
            native_stacks: vec!["Cross-OS Rust USB & Serial HAL".to_string()],
            os_notes: Vec::new(),
        }
    }
}

fn read_linux_pretty_name() -> Option<String> {
    let content = fs::read_to_string("/etc/os-release").ok()?;
    for line in content.lines() {
        if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
            let clean = val.trim().trim_matches('"').trim();
            if !clean.is_empty() {
                return Some(clean.to_string());
            }
        }
    }
    None
}

fn read_macos_product_version() -> Option<String> {
    let plist = fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    let mut after_key = false;
    for line in plist.lines() {
        let t = line.trim();
        if t.contains("<key>ProductVersion</key>") {
            after_key = true;
            continue;
        }
        if after_key {
            if let Some(inner) = t
                .strip_prefix("<string>")
                .and_then(|s| s.strip_suffix("</string>"))
            {
                return Some(inner.trim().to_string());
            }
            after_key = false;
        }
    }
    None
}

fn detect_linux_can_udev_rules() -> bool {
    let keywords = [
        "nexuscan",
        "gs_usb",
        "candlelight",
        "1d50",
        "606f",
        "pcan",
        "0c72",
        "kvaser",
        "0bfd",
        "slcan",
    ];
    for dir in [
        "/etc/udev/rules.d",
        "/run/udev/rules.d",
        "/lib/udev/rules.d",
    ] {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if keywords.iter().any(|k| fname.contains(k)) {
                return true;
            }
            if dir == "/etc/udev/rules.d" {
                if let Ok(body) = fs::read_to_string(entry.path()) {
                    let lower = body.to_ascii_lowercase();
                    if lower.contains("1d50")
                        || lower.contains("606f")
                        || lower.contains("0c72")
                        || lower.contains("0bfd")
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn detect_linux_serial_permission_hint() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        for candidate in ["/dev/ttyACM0", "/dev/ttyUSB0"] {
            let p = Path::new(candidate);
            if p.exists() {
                if let Some(false) = linux_has_rw_permission(p) {
                    return Some(format!(
                        "No read/write access to {candidate}: run 'sudo usermod -aG dialout $USER' (or 'uucp' on Arch/Fedora) and re-login."
                    ));
                }
            }
        }
    }
    None
}

// =============================================================================
// 2. Cross-OS USB Bus CAN Hardware Scanner (`scan_usb_can_devices`)
// =============================================================================

struct KnownUsbMatch {
    family: &'static str,
    vendor_fallback: &'static str,
    product_fallback: &'static str,
}

fn classify_usb_vid_pid(vid: u16, pid: u16) -> Option<KnownUsbMatch> {
    if let Some((vendor, product)) = match_candlelight_usb_id(vid, pid) {
        return Some(KnownUsbMatch {
            family: "gs_usb",
            vendor_fallback: vendor,
            product_fallback: product,
        });
    }
    if (vid, pid) == STM32_DFU_USB_ID {
        return Some(KnownUsbMatch {
            family: "dfu_bootloader",
            vendor_fallback: "STMicroelectronics",
            product_fallback: "STM32 DFU Bootloader (BOOT0 Active)",
        });
    }
    if vid == 0x0C72 {
        let prod = match pid {
            0x000C => "PCAN-USB",
            0x000D => "PCAN-USB Pro",
            0x0011 => "PCAN-USB Pro FD",
            0x0012 => "PCAN-USB FD",
            0x0014 => "PCAN-USB X6",
            _ => "PEAK-System PCAN USB Interface",
        };
        return Some(KnownUsbMatch {
            family: "pcan",
            vendor_fallback: "PEAK-System Technik GmbH",
            product_fallback: prod,
        });
    }
    if vid == 0x0BFD {
        return Some(KnownUsbMatch {
            family: "kvaser",
            vendor_fallback: "Kvaser AB",
            product_fallback: "Kvaser USB CAN / CAN-FD Interface",
        });
    }
    if vid == 0x1248 {
        let prod = match pid {
            0x1001..=0x10FF => "Vector VN16xx USB CAN/FD Interface",
            _ => "Vector Informatik USB CAN/FD Interface",
        };
        return Some(KnownUsbMatch {
            family: "vector_xl",
            vendor_fallback: "Vector Informatik GmbH",
            product_fallback: prod,
        });
    }

    match (vid, pid) {
        (0x0483, 0x5740) => Some(KnownUsbMatch {
            family: "slcan",
            vendor_fallback: "STMicroelectronics",
            product_fallback: "STM32 Virtual COM Port (SLCAN)",
        }),
        (0x0403, 0x6001) | (0x0403, 0x6015) => Some(KnownUsbMatch {
            family: "slcan",
            vendor_fallback: "FTDI",
            product_fallback: "FTDI USB-UART (Lawicel CAN232 / CANUSB)",
        }),
        (0x10C4, 0xEA60) => Some(KnownUsbMatch {
            family: "slcan",
            vendor_fallback: "Silicon Labs",
            product_fallback: "CP210x USB-UART Bridge (SLCAN)",
        }),
        (0x1A86, 0x7523) => Some(KnownUsbMatch {
            family: "slcan",
            vendor_fallback: "QinHeng Electronics",
            product_fallback: "CH340 USB-Serial (SLCAN)",
        }),
        (0x16D0, 0x05BE) => Some(KnownUsbMatch {
            family: "slcan",
            vendor_fallback: "fischl.de",
            product_fallback: "USBtin USB-to-CAN (SLCAN)",
        }),
        _ => None,
    }
}

/// Scans the host USB bus via `nusb::list_devices()` (with Linux sysfs enrichment) for all CAN,
/// SLCAN USB-CDC, commercial USB-CAN, and STM32 DFU bootloader devices.
pub fn scan_usb_can_devices(serial_ports: &[SerialPortInfoDto]) -> Vec<UsbCanDeviceDto> {
    let mut out = Vec::new();
    let mut gs_usb_logical_idx = 0usize;

    if let Ok(iter) = nusb::list_devices() {
        let mut raw_list: Vec<(String, String, nusb::DeviceInfo)> = iter
            .map(|d| {
                let (sort_key, human_loc) = usb_device_location_info(&d);
                (sort_key, human_loc, d)
            })
            .collect();
        raw_list.sort_by(|a, b| a.0.cmp(&b.0));

        // Pre-scan gs_usb serial numbers to detect duplicate-serial or missing-serial clone pairs
        let gs_serials: Vec<Option<String>> = raw_list
            .iter()
            .filter(|(_, _, d)| match_candlelight_usb_id(d.vendor_id(), d.product_id()).is_some())
            .map(|(_, _, d)| {
                d.serial_number()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_ascii_uppercase())
            })
            .collect();
        let gs_count = gs_serials.len();

        for (_sort_key, human_location, dev_info) in raw_list {
            let vid = dev_info.vendor_id();
            let pid = dev_info.product_id();
            let Some(known) = classify_usb_vid_pid(vid, pid) else {
                continue;
            };

            let vid_pid = format!("{vid:04X}:{pid:04X}");
            let vendor_name = dev_info
                .manufacturer_string()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(known.vendor_fallback)
                .to_string();
            let product_name = dev_info
                .product_string()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(known.product_fallback)
                .to_string();
            let serial_number = dev_info
                .serial_number()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            let (driver_bound, access_status, suggested_channel) = match known.family {
                "dfu_bootloader" => (
                    false,
                    "STM32 DFU Bootloader Mode (Unshort BOOT0 jumper or flash candleLight_fw)"
                        .to_string(),
                    None,
                ),
                "gs_usb" => {
                    let ch_idx = gs_usb_logical_idx;
                    gs_usb_logical_idx += if pid == 0x6070 { 2 } else { 1 };
                    let has_dup_or_missing_serial = gs_count >= 2
                        && match serial_number.as_deref() {
                            None => true,
                            Some(sn) => {
                                let sn_up = sn.to_ascii_uppercase();
                                gs_serials
                                    .iter()
                                    .filter(|opt| opt.as_deref() == Some(sn_up.as_str()))
                                    .count()
                                    > 1
                            }
                        };
                    inspect_gs_usb_device_access(&dev_info, ch_idx, has_dup_or_missing_serial)
                }
                "slcan" => {
                    let matched_port = serial_ports.iter().find(|sp| {
                        let sn_match = match (&serial_number, &sp.serial_number) {
                            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                            _ => false,
                        };
                        let vp_match = sp
                            .vid_pid
                            .as_deref()
                            .is_some_and(|vp| vp.eq_ignore_ascii_case(&vid_pid));
                        sn_match || vp_match
                    });
                    if let Some(sp) = matched_port {
                        (
                            true,
                            format!("Serial Port Bound ({})", sp.port_name),
                            Some(format!("slcan:{}", sp.port_name)),
                        )
                    } else {
                        (
                            false,
                            "USB Enumerated (Waiting for VCP / CDC Driver)".to_string(),
                            None,
                        )
                    }
                }
                "pcan" | "kvaser" | "vector_xl" => {
                    inspect_vendor_usb_device_access(&dev_info, known.family)
                }
                _ => (false, "Detected on USB Bus".to_string(), None),
            };

            out.push(UsbCanDeviceDto {
                vid_pid,
                vendor_name,
                product_name,
                serial_number,
                bus_number: dev_info.bus_number(),
                device_address: dev_info.device_address(),
                location_info: Some(human_location),
                matched_family: known.family.to_string(),
                driver_bound,
                access_status,
                suggested_channel,
            });
        }
    }

    out
}

fn inspect_gs_usb_device_access(
    dev_info: &nusb::DeviceInfo,
    logical_idx: usize,
    has_dup_or_missing_serial: bool,
) -> (bool, String, Option<String>) {
    // 1. Non-invasive fast check: NEVER touch CreateFileW / WinUsb_Initialize / usbfs on an active NexusCAN channel!
    if is_gs_usb_device_active_in_process(dev_info.id()) {
        return (
            true,
            if cfg!(target_os = "windows") {
                format!("WinUSB Active (Connected in NexusCAN as gs_usb:{logical_idx})")
            } else if cfg!(target_os = "macos") {
                format!("IOKit Active (Connected in NexusCAN as gs_usb:{logical_idx})")
            } else {
                format!("usbfs Active (Connected in NexusCAN as gs_usb:{logical_idx})")
            },
            Some(format!("gs_usb:{logical_idx}")),
        );
    }

    #[cfg(target_os = "linux")]
    {
        let _ = has_dup_or_missing_serial;
        let bus = dev_info.bus_number();
        let addr = dev_info.device_address();
        let ifaces = crate::drivers::gs_usb_drv::find_linux_sysfs_net_ifaces(dev_info.sysfs_path());
        if let Some(first_iface) = ifaces.first() {
            return (
                true,
                format!("Kernel gs_usb Bound (SocketCAN {first_iface})"),
                Some(format!("socketcan:{first_iface}")),
            );
        }
        let usbfs_node = PathBuf::from(format!("/dev/bus/usb/{bus:03}/{addr:03}"));
        match dev_info.open() {
            Ok(_) => (
                true,
                format!("Direct USB Ready ({})", usbfs_node.display()),
                Some(format!("gs_usb:{logical_idx}")),
            ),
            Err(e) if e.kind() == ErrorKind::PermissionDenied => (
                false,
                format!(
                    "USB Permission Denied on {} (Add udev rule or modprobe gs_usb)",
                    usbfs_node.display()
                ),
                Some(format!("gs_usb:{logical_idx}")),
            ),
            Err(e) => (
                false,
                format!("USB Open Error ({e})"),
                Some(format!("gs_usb:{logical_idx}")),
            ),
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Check Windows PnP driver property first before opening any handles!
        let bound_drv = dev_info.driver().unwrap_or("").trim();
        let is_winusb_or_composite =
            bound_drv.eq_ignore_ascii_case("winusb") || bound_drv.eq_ignore_ascii_case("usbccgp");
        if !is_winusb_or_composite {
            let drv_label = if bound_drv.is_empty() {
                "none"
            } else {
                bound_drv
            };
            let status = if has_dup_or_missing_serial {
                format!(
                    "WinUSB Binding Required on This Port (Zadig — driver: {drv_label}, duplicate/empty clone serial)"
                )
            } else {
                format!("WinUSB Binding Required (Zadig — current driver: {drv_label})")
            };
            return (false, status, Some(format!("gs_usb:{logical_idx}")));
        }

        let clone_fail_msg = if has_dup_or_missing_serial {
            "WinUSB Binding Required on This Port (Zadig — duplicate/empty clone serial requires per-port WinUSB binding)"
                .to_string()
        } else {
            "WinUSB Binding Required (Zadig)".to_string()
        };

        match dev_info.open() {
            Ok(dev) => match dev.claim_interface(0) {
                Ok(_iface) => (
                    true,
                    "WinUSB Ready (Direct USB)".to_string(),
                    Some(format!("gs_usb:{logical_idx}")),
                ),
                Err(e) if e.kind() == ErrorKind::PermissionDenied => (
                    true,
                    "WinUSB Bound (Interface Busy / Open in Another App)".to_string(),
                    Some(format!("gs_usb:{logical_idx}")),
                ),
                Err(_) => (false, clone_fail_msg, Some(format!("gs_usb:{logical_idx}"))),
            },
            Err(_) => (false, clone_fail_msg, Some(format!("gs_usb:{logical_idx}"))),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = has_dup_or_missing_serial;
        match dev_info.open() {
            Ok(_) => (
                true,
                "IOKit Ready (Driverless Direct USB)".to_string(),
                Some(format!("gs_usb:{logical_idx}")),
            ),
            Err(e) => (
                false,
                format!("IOKit Access Error ({e})"),
                Some(format!("gs_usb:{logical_idx}")),
            ),
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = (dev_info, has_dup_or_missing_serial);
        (
            true,
            "Direct USB Enumerated".to_string(),
            Some(format!("gs_usb:{logical_idx}")),
        )
    }
}

fn inspect_vendor_usb_device_access(
    dev_info: &nusb::DeviceInfo,
    family: &str,
) -> (bool, String, Option<String>) {
    #[cfg(target_os = "linux")]
    {
        let ifaces = crate::drivers::gs_usb_drv::find_linux_sysfs_net_ifaces(dev_info.sysfs_path());
        if let Some(first_iface) = ifaces.first() {
            return (
                true,
                format!("SocketCAN Bound ({first_iface})"),
                Some(format!("socketcan:{first_iface}")),
            );
        }
    }
    let _ = dev_info;
    let default_ch = match family {
        "pcan" => Some("pcan:PCAN_USBBUS1".to_string()),
        "kvaser" => Some("kvaser:0".to_string()),
        "vector_xl" => Some("vector_xl:0".to_string()),
        _ => None,
    };
    (
        false,
        format!("Hardware Attached (Requires {family} Driver/SDK)"),
        default_ch,
    )
}

// =============================================================================
// 3. Per-Family Cross-OS Diagnostic Probers (7 Families)
// =============================================================================

/// Probes the built-in deterministic simulation driver (`mock0` + `mock1`).
pub fn probe_mock_family() -> DriverFamilyStatusDto {
    let channel_details = vec![
        DetectedChannelDetailDto {
            channel_id: "mock0".to_string(),
            device_id: MOCK0_DEVICE_ID.to_string(),
            label: "mock0 — Synthetic EV Powertrain + Cascaded Mux BMS (CAN-FD)".to_string(),
            state: "virtual".to_string(),
            supports_fd: true,
            mtu: Some(72),
            kernel_or_usb_driver: Some("nexus-hal::mock_drv".to_string()),
            source_path: "in-process://nexus-hal/mock0".to_string(),
            hardware_id: Some("VIRTUAL:MOCK0".to_string()),
            hint_command: None,
        },
        DetectedChannelDetailDto {
            channel_id: "mock1".to_string(),
            device_id: MOCK1_DEVICE_ID.to_string(),
            label: "mock1 — Secondary Synthetic Auxiliary / Charger Bus (CAN-FD)".to_string(),
            state: "virtual".to_string(),
            supports_fd: true,
            mtu: Some(72),
            kernel_or_usb_driver: Some("nexus-hal::mock_drv".to_string()),
            source_path: "in-process://nexus-hal/mock1".to_string(),
            hardware_id: Some("VIRTUAL:MOCK1".to_string()),
            hint_command: None,
        },
    ];

    DriverFamilyStatusDto {
        family_id: "mock".to_string(),
        display_name: "Virtual Simulation Bus (mock0 / mock1)".to_string(),
        installed: true,
        os_supported: true,
        hardware_present: true,
        status_label: "Built-in Ready".to_string(),
        detected_library_or_module: Some("nexus-hal::mock_drv (in-process)".to_string()),
        architecture_note: Some("Pure-Rust deterministic 64-bit monotonic generator".to_string()),
        searched_paths: vec!["in-process://nexus-hal/drivers/mock_drv".to_string()],
        os_source_locations: vec![
            "Built-in Rust Workspace Crate (crates/nexus-hal/src/drivers/mock_drv.rs)".to_string(),
        ],
        detected_channels: vec!["mock0".to_string(), "mock1".to_string()],
        channel_details,
        setup_steps: vec![OsSetupStepDto {
            title: "Zero Setup Required".to_string(),
            description:
                "Select mock:mock0 or mock:mock1 and load the preset EV/BMS databases to test 15 fps–50,000 fps CAN-FD & multiplexed signal decoding on any OS."
                    .to_string(),
            command_or_action: None,
            doc_url: None,
        }],
        install_hint:
            "Built-in deterministic EV Powertrain, BMS & Charger simulation buses; always ready."
                .to_string(),
    }
}

/// Probes Linux Kernel SocketCAN (`can*`, `vcan*`, `slcan*`).
pub fn probe_socketcan_family() -> DriverFamilyStatusDto {
    let env_dto = probe_host_environment();
    probe_socketcan_family_with_env(&env_dto)
}

fn probe_socketcan_family_with_env(host_env: &HostEnvironmentDto) -> DriverFamilyStatusDto {
    if cfg!(target_os = "linux") {
        let searched = vec![
            "/proc/net/can".to_string(),
            "/sys/module/can".to_string(),
            "/sys/module/can_raw".to_string(),
            "/sys/module/vcan".to_string(),
            "/sys/class/net".to_string(),
        ];
        let os_source_locations = vec![
            "/sys/class/net/<iface>/type == 280 (ARPHRD_CAN)".to_string(),
            "/proc/net/can & /sys/module/can_raw".to_string(),
        ];

        let channel_details = inspect_linux_socketcan_channel_details(None);
        let detected_channels: Vec<String> = channel_details
            .iter()
            .map(|c| c.channel_id.clone())
            .collect();

        let found_module = [
            "/proc/net/can",
            "/sys/module/can",
            "/sys/module/can_raw",
            "/sys/module/vcan",
        ]
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| (*s).to_string());

        let has_physical = channel_details.iter().any(|c| c.state != "virtual");
        let installed = found_module.is_some() || !detected_channels.is_empty();
        let down_count = channel_details.iter().filter(|c| c.state == "down").count();

        let status_label = if !detected_channels.is_empty() {
            if down_count > 0 {
                format!(
                    "Kernel Active ({} iface, {} down)",
                    detected_channels.len(),
                    down_count
                )
            } else {
                format!("Kernel Active ({} iface)", detected_channels.len())
            }
        } else if installed {
            "Kernel Module Loaded (No Interface Up)".to_string()
        } else {
            "Kernel CAN Module Not Loaded".to_string()
        };

        let mut setup_steps = vec![
            OsSetupStepDto {
                title: "Create Virtual CAN-FD Bus (vcan0)".to_string(),
                description: "Load Linux SocketCAN virtual interface module and bring vcan0 up with 72-byte CAN-FD MTU.".to_string(),
                command_or_action: Some(
                    "sudo modprobe can can_raw vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set vcan0 mtu 72 up".to_string(),
                ),
                doc_url: Some("https://docs.kernel.org/networking/can.html".to_string()),
            },
            OsSetupStepDto {
                title: "Configure Physical CAN / CAN-FD Interface (can0)".to_string(),
                description: "Set nominal bitrate (e.g. 500 kbps), optional CAN-FD data bitrate (2 Mbps), auto bus-off recovery (100 ms), and bring can0 up.".to_string(),
                command_or_action: Some(
                    "sudo ip link set can0 down && sudo ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on restart-ms 100 && sudo ip link set up can0".to_string(),
                ),
                doc_url: None,
            },
        ];

        if host_env.is_wsl {
            setup_steps.push(OsSetupStepDto {
                title: "WSL2 Kernel & USB Passthrough Note".to_string(),
                description: "Stock WSL2 kernels may require building vcan/gs_usb modules or attaching physical USB-CAN adapters via usbipd-win (NexusCAN can also open attached gs_usb devices directly via usbfs).".to_string(),
                command_or_action: Some("usbipd list && usbipd attach --wsl --busid <BUSID>".to_string()),
                doc_url: Some("https://learn.microsoft.com/en-us/windows/wsl/connect-usb".to_string()),
            });
        }

        DriverFamilyStatusDto {
            family_id: "socketcan".to_string(),
            display_name: "Linux Kernel SocketCAN (can / vcan / slcan)".to_string(),
            installed,
            os_supported: true,
            hardware_present: has_physical || !detected_channels.is_empty(),
            status_label,
            detected_library_or_module: found_module,
            architecture_note: Some(format!("Linux AF_CAN ({})", host_env.arch)),
            searched_paths: searched,
            os_source_locations,
            detected_channels,
            channel_details,
            setup_steps,
            install_hint:
                "Run: sudo modprobe can can_raw vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0"
                    .to_string(),
        }
    } else {
        DriverFamilyStatusDto {
            family_id: "socketcan".to_string(),
            display_name: "Linux Kernel SocketCAN (can / vcan / slcan)".to_string(),
            installed: false,
            os_supported: false,
            hardware_present: false,
            status_label: "Linux-Only Kernel Subsystem".to_string(),
            detected_library_or_module: None,
            architecture_note: Some(
                "AF_CAN (ARPHRD_CAN=280) exists exclusively in the Linux kernel".to_string(),
            ),
            searched_paths: Vec::new(),
            os_source_locations: vec![
                "Not applicable on Windows / macOS (Linux kernel net/can subsystem only)"
                    .to_string(),
            ],
            detected_channels: Vec::new(),
            channel_details: Vec::new(),
            setup_steps: vec![OsSetupStepDto {
                title: "Use Native Cross-OS Drivers on Windows & macOS".to_string(),
                description:
                    "SocketCAN is a Linux kernel network stack (AF_CAN, type=280). On Windows and macOS, connect your hardware directly using gs_usb (candleLight/CANable), SLCAN (COM / /dev/cu.*), PCAN, Kvaser, or Vector XL."
                        .to_string(),
                command_or_action: None,
                doc_url: None,
            }],
            install_hint:
                "SocketCAN is a Linux-only kernel subsystem. On Windows/macOS use gs_usb, SLCAN, PCAN-Basic, Kvaser CANlib, or Vector XL."
                    .to_string(),
        }
    }
}

/// Probes `gs_usb` / `candleLight` USB-CAN adapters (`1D50:606F`, `1D50:6070`, `1209:2323`, `16D0:0F67`, `1CD2:606F`).
pub fn probe_gs_usb_family() -> DriverFamilyStatusDto {
    let env_dto = probe_host_environment();
    let ports = discover_serial_ports();
    let usb = scan_usb_can_devices(&ports);
    probe_gs_usb_family_with_context(&env_dto, &usb)
}

fn probe_gs_usb_family_with_context(
    host_env: &HostEnvironmentDto,
    usb_devices: &[UsbCanDeviceDto],
) -> DriverFamilyStatusDto {
    let gs_usb_units: Vec<&UsbCanDeviceDto> = usb_devices
        .iter()
        .filter(|d| d.matched_family == "gs_usb")
        .collect();
    let dfu_units: Vec<&UsbCanDeviceDto> = usb_devices
        .iter()
        .filter(|d| d.matched_family == "dfu_bootloader")
        .collect();

    let mut searched = Vec::new();
    let mut os_source_locations = Vec::new();
    let mut detected_channels = Vec::new();
    let mut channel_details = Vec::new();
    let mut setup_steps = Vec::new();

    if cfg!(target_os = "linux") {
        let gs_mod = "/sys/module/gs_usb";
        searched.push(gs_mod.to_string());
        searched.push("/sys/bus/usb/devices".to_string());
        searched.push("/dev/bus/usb".to_string());
        os_source_locations
            .push("Linux Kernel Module (/sys/module/gs_usb -> SocketCAN can*)".to_string());
        os_source_locations
            .push("Pure-Rust nusb Direct USB (/dev/bus/usb/BBB/DDD usbfs)".to_string());

        // 1. Any SocketCAN `can*` interfaces backed by kernel `gs_usb`
        for detail in inspect_linux_socketcan_channel_details(Some(&["gs_usb"])) {
            detected_channels.push(detail.channel_id.clone());
            channel_details.push(DetectedChannelDetailDto {
                device_id: format!("gs_usb:{}", detail.channel_id),
                ..detail
            });
        }

        // 2. Any USB `gs_usb` units not bound to SocketCAN (direct `nusb` channels, including multi-channel)
        let mut direct_idx = 0usize;
        for u in &gs_usb_units {
            let bound_to_sc = u
                .suggested_channel
                .as_deref()
                .is_some_and(|s| s.starts_with("socketcan:"));
            let num_ch = if u.vid_pid.eq_ignore_ascii_case("1D50:6070") {
                2usize
            } else {
                1usize
            };
            if !bound_to_sc {
                let loc = u.location_info.as_deref().unwrap_or("USB Direct");
                for ch_offset in 0..num_ch {
                    let ch_id = (direct_idx + ch_offset).to_string();
                    if !detected_channels.contains(&ch_id) {
                        detected_channels.push(ch_id.clone());
                    }
                    let state = if u.driver_bound {
                        "ready"
                    } else {
                        "needs_driver"
                    };
                    let multi_suffix = if num_ch > 1 {
                        format!(" Ch {ch_offset}")
                    } else {
                        String::new()
                    };
                    channel_details.push(DetectedChannelDetailDto {
                        channel_id: ch_id.clone(),
                        device_id: format!("gs_usb:{ch_id}"),
                        label: format!(
                            "[gs_usb:{ch_id}] {}{multi_suffix} ({}) @ {loc} — {}",
                            u.product_name, u.vid_pid, u.access_status
                        ),
                        state: state.to_string(),
                        supports_fd: true,
                        mtu: Some(72),
                        kernel_or_usb_driver: Some("nusb (usbfs direct)".to_string()),
                        source_path: format!(
                            "/dev/bus/usb/{:03}/{:03} ({loc})",
                            u.bus_number, u.device_address
                        ),
                        hardware_id: Some(u.vid_pid.clone()),
                        hint_command: if !u.driver_bound {
                            Some(
                                "sudo modprobe gs_usb || sudo udevadm control --reload-rules && sudo udevadm trigger"
                                    .to_string(),
                            )
                        } else {
                            None
                        },
                    });
                }
            }
            direct_idx += num_ch;
        }

        setup_steps.push(OsSetupStepDto {
            title: "Option A — Native Linux SocketCAN (Recommended)".to_string(),
            description: "Load the mainline gs_usb kernel driver so CANable / candleLight appears automatically as can0.".to_string(),
            command_or_action: Some(
                "sudo modprobe gs_usb && sudo ip link set can0 type can bitrate 500000 && sudo ip link set up can0".to_string(),
            ),
            doc_url: None,
        });
        setup_steps.push(OsSetupStepDto {
            title: "Option B — Rootless Direct USB (udev Rule for nusb)".to_string(),
            description: "Grant user-space read/write permissions to candleLight USB VID:PIDs when gs_usb.ko is not loaded.".to_string(),
            command_or_action: Some(
                "echo 'SUBSYSTEM==\"usb\", ATTR{idVendor}==\"1d50\", ATTR{idProduct}==\"606f\", MODE=\"0666\", TAG+=\"uaccess\"' | sudo tee /etc/udev/rules.d/99-nexuscan-usb.rules && sudo udevadm control --reload-rules && sudo udevadm trigger".to_string(),
            ),
            doc_url: None,
        });
        if host_env.is_wsl {
            setup_steps.push(OsSetupStepDto {
                title: "WSL2 USB Passthrough (usbipd-win)".to_string(),
                description: "Attach the Windows candleLight USB device into WSL2 so /dev/bus/usb sees 1D50:606F.".to_string(),
                command_or_action: Some(
                    "usbipd list  # then: usbipd bind --busid <ID> && usbipd attach --wsl --busid <ID>".to_string(),
                ),
                doc_url: Some("https://learn.microsoft.com/en-us/windows/wsl/connect-usb".to_string()),
            });
        }

        let hw_present = !gs_usb_units.is_empty() || !channel_details.is_empty();
        let all_blocked = !gs_usb_units.is_empty() && gs_usb_units.iter().all(|u| !u.driver_bound);
        let mod_loaded = Path::new(gs_mod).exists();
        let installed = if !gs_usb_units.is_empty() {
            !all_blocked
        } else {
            true
        };

        let status_label = if !dfu_units.is_empty() && gs_usb_units.is_empty() {
            "STM32 DFU Mode Detected (Unshort BOOT0 / Flash Firmware)".to_string()
        } else if !gs_usb_units.is_empty() && all_blocked {
            "USB Permission Denied (udev / modprobe gs_usb)".to_string()
        } else if hw_present {
            format!("Hardware Ready ({} ch)", detected_channels.len())
        } else if mod_loaded {
            "Kernel gs_usb + nusb Ready (No Device)".to_string()
        } else {
            "Built-in nusb Ready (No Device)".to_string()
        };

        let detected_lib = if mod_loaded {
            Some("/sys/module/gs_usb + nexus-hal::gs_usb_drv (nusb)".to_string())
        } else {
            Some("nexus-hal::gs_usb_drv (nusb usbfs)".to_string())
        };

        DriverFamilyStatusDto {
            family_id: "gs_usb".to_string(),
            display_name: "USB Direct candleLight / gs_usb".to_string(),
            installed,
            os_supported: true,
            hardware_present: hw_present,
            status_label,
            detected_library_or_module: detected_lib,
            architecture_note: Some("Pure-Rust zero-C nusb usbfs + SocketCAN smart router".to_string()),
            searched_paths: searched,
            os_source_locations,
            detected_channels,
            channel_details,
            setup_steps,
            install_hint:
                "On Linux run 'sudo modprobe gs_usb' (SocketCAN can0) or install /etc/udev/rules.d/99-nexuscan-usb.rules for direct nusb access."
                    .to_string(),
        }
    } else if cfg!(target_os = "windows") {
        searched.push(
            "Win32 SetupAPI / WinUSB Device Interface GUIDs (1D50:606F, 1209:2323, 1CD2:606F)"
                .to_string(),
        );
        os_source_locations
            .push("Windows PnP USB Enumerator & WinUSB (WinUsb_Initialize)".to_string());
        os_source_locations.push("Built-in Pure-Rust nexus-hal::gs_usb_drv (nusb 0.1)".to_string());

        let mut logical_idx = 0usize;
        for u in &gs_usb_units {
            let loc = u.location_info.as_deref().unwrap_or("Windows USB Port");
            let num_ch = if u.vid_pid.eq_ignore_ascii_case("1D50:6070") {
                2usize
            } else {
                1usize
            };
            for ch_offset in 0..num_ch {
                let ch_id = (logical_idx + ch_offset).to_string();
                detected_channels.push(ch_id.clone());
                let state = if u.access_status.contains("Busy") {
                    "busy"
                } else if u.driver_bound {
                    "ready"
                } else {
                    "needs_driver"
                };
                let multi_suffix = if num_ch > 1 {
                    format!(" Ch {ch_offset}")
                } else {
                    String::new()
                };
                channel_details.push(DetectedChannelDetailDto {
                    channel_id: ch_id.clone(),
                    device_id: format!("gs_usb:{ch_id}"),
                    label: format!(
                        "[gs_usb:{ch_id}] {}{multi_suffix} ({}) @ {loc} — {}",
                        u.product_name, u.vid_pid, u.access_status
                    ),
                    state: state.to_string(),
                    supports_fd: true,
                    mtu: Some(72),
                    kernel_or_usb_driver: Some(if u.driver_bound {
                        "WinUSB".to_string()
                    } else {
                        "Unbound (Zadig WinUSB Required)".to_string()
                    }),
                    source_path: format!(
                        "USB\\VID_{} ({loc})",
                        u.vid_pid.replace(':', "&PID_")
                    ),
                    hardware_id: Some(u.vid_pid.clone()),
                    hint_command: if !u.driver_bound {
                        Some(
                            "Zadig -> Options -> List All Devices -> Select THIS port's Interface 0 -> Bind WinUSB (repeat per USB port for clone boards with identical serials)"
                                .to_string(),
                        )
                    } else {
                        None
                    },
                });
            }
            logical_idx += num_ch;
        }

        setup_steps.push(OsSetupStepDto {
            title: "1. Plug In CANable / candleLight USB Adapter".to_string(),
            description: "Modern candleLight / CANable 2.0 firmware includes Microsoft WCID descriptors so Windows 10/11 binds WinUSB automatically on first plug-in.".to_string(),
            command_or_action: None,
            doc_url: Some("https://canable.io/getting-started.html".to_string()),
        });
        setup_steps.push(OsSetupStepDto {
            title: "2. Bind WinUSB on Interface 0 with Zadig (Per USB Port for Clone Pairs)".to_string(),
            description: "If status shows 'WinUSB Binding Required (Zadig)', launch Zadig -> Options -> List All Devices -> select candleLight Interface 0 -> 'WinUSB' -> Replace Driver. When using TWO identical clone adapters sharing the same/empty USB Serial Number, bind WinUSB on the 2nd USB port's entry too, then open Bus 0 on gs_usb:0 and Bus 1 on gs_usb:1.".to_string(),
            command_or_action: Some("Zadig -> Interface 0 -> Target Driver: WinUSB -> Install/Replace Driver".to_string()),
            doc_url: Some("https://zadig.akeo.ie/".to_string()),
        });

        let hw_present = !gs_usb_units.is_empty();
        let ready_count = gs_usb_units.iter().filter(|u| u.driver_bound).count();
        let unbound_count = gs_usb_units.len().saturating_sub(ready_count);
        let any_ready = ready_count > 0;
        let installed = if hw_present { any_ready } else { true };

        let status_label = if !dfu_units.is_empty() && !hw_present {
            "STM32 DFU Mode Detected (Unshort BOOT0 / Flash candleLight)".to_string()
        } else if hw_present && any_ready && unbound_count > 0 {
            format!("WinUSB Partial ({ready_count} Ready, {unbound_count} Needs Zadig)")
        } else if hw_present && any_ready {
            format!("WinUSB Ready ({} ch)", detected_channels.len())
        } else if hw_present {
            "WinUSB Binding Required (Zadig)".to_string()
        } else {
            "Built-in WinUSB Driver Ready (No Device)".to_string()
        };

        DriverFamilyStatusDto {
            family_id: "gs_usb".to_string(),
            display_name: "USB Direct candleLight / gs_usb".to_string(),
            installed,
            os_supported: true,
            hardware_present: hw_present,
            status_label,
            detected_library_or_module: Some("nexus-hal::gs_usb_drv (nusb WinUSB)".to_string()),
            architecture_note: Some(format!("Native {}-bit WinUSB Direct I/O (zero DLL dependency)", host_env.arch)),
            searched_paths: searched,
            os_source_locations,
            detected_channels,
            channel_details,
            setup_steps,
            install_hint:
                "Plug in a candleLight / CANable / CANtact adapter (1D50:606F); if Windows does not auto-bind WCID WinUSB, bind 'WinUSB' to Interface 0 using Zadig."
                    .to_string(),
        }
    } else {
        // macOS (Apple IOKit driverless USB)
        searched.push(
            "Apple IOKit IOUSBHostDevice Registry (1D50:606F, 1209:2323, 1CD2:606F)".to_string(),
        );
        os_source_locations.push("macOS IOKit User-Space USB (IOUSBDeviceInterface)".to_string());
        os_source_locations.push("Built-in Pure-Rust nexus-hal::gs_usb_drv (nusb 0.1)".to_string());

        let mut logical_idx = 0usize;
        for u in &gs_usb_units {
            let loc = u.location_info.as_deref().unwrap_or("Apple IOKit USB");
            let num_ch = if u.vid_pid.eq_ignore_ascii_case("1D50:6070") {
                2usize
            } else {
                1usize
            };
            for ch_offset in 0..num_ch {
                let ch_id = (logical_idx + ch_offset).to_string();
                detected_channels.push(ch_id.clone());
                let multi_suffix = if num_ch > 1 {
                    format!(" Ch {ch_offset}")
                } else {
                    String::new()
                };
                channel_details.push(DetectedChannelDetailDto {
                    channel_id: ch_id.clone(),
                    device_id: format!("gs_usb:{ch_id}"),
                    label: format!(
                        "[gs_usb:{ch_id}] {}{multi_suffix} ({}) @ {loc} — IOKit Driverless",
                        u.product_name, u.vid_pid
                    ),
                    state: if u.driver_bound { "ready" } else { "busy" }.to_string(),
                    supports_fd: true,
                    mtu: Some(72),
                    kernel_or_usb_driver: Some("Apple IOKit (nusb)".to_string()),
                    source_path: format!(
                        "iokit://usb/{}:{} ({loc})",
                        u.bus_number, u.device_address
                    ),
                    hardware_id: Some(u.vid_pid.clone()),
                    hint_command: None,
                });
            }
            logical_idx += num_ch;
        }

        setup_steps.push(OsSetupStepDto {
            title: "Driverless macOS IOKit Plug-and-Play".to_string(),
            description: "Plug in any candleLight / gs_usb flashed adapter (CANable 1.0/2.0, CANtact, candleLight FD). macOS grants direct user-space IOKit access with zero kexts or drivers.".to_string(),
            command_or_action: None,
            doc_url: Some("https://canable.io/updater/".to_string()),
        });
        setup_steps.push(OsSetupStepDto {
            title: "Verify candleLight Firmware (vs SLCAN)".to_string(),
            description: "If your CANable enumerates as /dev/cu.usbmodem* instead of gs_usb, either connect via the SLCAN family or flash candleLight gs_usb firmware for native CAN-FD & hardware timestamps.".to_string(),
            command_or_action: None,
            doc_url: None,
        });

        let hw_present = !gs_usb_units.is_empty();
        let status_label = if !dfu_units.is_empty() && !hw_present {
            "STM32 DFU Mode Detected (Unshort BOOT0 / Flash candleLight)".to_string()
        } else if hw_present {
            format!("IOKit Ready ({} ch)", detected_channels.len())
        } else {
            "Built-in IOKit Driver Ready (No Device)".to_string()
        };

        DriverFamilyStatusDto {
            family_id: "gs_usb".to_string(),
            display_name: "USB Direct candleLight / gs_usb".to_string(),
            installed: true,
            os_supported: true,
            hardware_present: hw_present,
            status_label,
            detected_library_or_module: Some("nexus-hal::gs_usb_drv (nusb IOKit)".to_string()),
            architecture_note: Some(format!("Native Apple Silicon / Intel ({}) IOKit", host_env.arch)),
            searched_paths: searched,
            os_source_locations,
            detected_channels,
            channel_details,
            setup_steps,
            install_hint:
                "Plug in a candleLight / CANable / CANtact adapter (1D50:606F); macOS connects driverlessly via IOKit."
                    .to_string(),
        }
    }
}

/// Probes the built-in cross-OS Lawicel SLCAN (`serialport`) driver and attached COM/`cu.*`/`ttyUSB`/`ttyACM` ports.
pub fn probe_slcan_family(serial_ports: &[SerialPortInfoDto]) -> DriverFamilyStatusDto {
    let (searched_paths, os_source_locations, setup_steps) = if cfg!(target_os = "windows") {
        (
            vec!["Win32 SetupAPI (COM1..COM256)".to_string()],
            vec![
                "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM".to_string(),
                "Win32 SetupDiGetClassDevs (GUID_DEVINTERFACE_COMPORT)".to_string(),
            ],
            vec![OsSetupStepDto {
                title: "Connect USB-CDC / UART SLCAN Adapter (COMx)".to_string(),
                description:
                    "Windows 10/11 automatically binds usbser.sys for USB-CDC SLCAN boards. Check Device Manager -> Ports (COM & LPT) for the assigned COM port and select serial baud rate (typically 1000000 or 115200)."
                        .to_string(),
                command_or_action: Some("devmgmt.msc".to_string()),
                doc_url: None,
            }],
        )
    } else if cfg!(target_os = "macos") {
        (
            vec![
                "/dev/cu.usbmodem*".to_string(),
                "/dev/cu.usbserial*".to_string(),
            ],
            vec![
                "macOS IOKit IOSerialBSDClient (/dev/cu.* call-out nodes)".to_string(),
            ],
            vec![OsSetupStepDto {
                title: "Use /dev/cu.* Call-Out Port on macOS".to_string(),
                description:
                    "Always choose '/dev/cu.usbmodem*' or '/dev/cu.usbserial*' rather than '/dev/tty.*' so POSIX open() never blocks waiting for DCD carrier detect."
                        .to_string(),
                command_or_action: Some("ls -l /dev/cu.usb*".to_string()),
                doc_url: None,
            }],
        )
    } else {
        (
            vec![
                "/sys/class/tty".to_string(),
                "/dev/ttyUSB*".to_string(),
                "/dev/ttyACM*".to_string(),
            ],
            vec![
                "/sys/class/tty/ttyACM* & /sys/class/tty/ttyUSB*".to_string(),
                "/dev/ttyACM* (cdc_acm) & /dev/ttyUSB* (ftdi_sio / cp210x / ch341)".to_string(),
            ],
            vec![OsSetupStepDto {
                title: "Grant Linux Serial Group Access (dialout / uucp)".to_string(),
                description:
                    "Ensure your user belongs to the 'dialout' (Ubuntu/Debian) or 'uucp' (Arch) group so /dev/ttyACM0 and /dev/ttyUSB0 open without root."
                        .to_string(),
                command_or_action: Some("sudo usermod -aG dialout $USER".to_string()),
                doc_url: None,
            }],
        )
    };

    let detected_channels: Vec<String> = serial_ports.iter().map(|p| p.port_name.clone()).collect();

    let channel_details: Vec<DetectedChannelDetailDto> = serial_ports
        .iter()
        .map(|p| {
            let denied = p
                .os_hint
                .as_deref()
                .is_some_and(|h| h.to_ascii_lowercase().contains("permission denied"));
            let label_prod = p.product.as_deref().unwrap_or(p.port_type.as_str());
            DetectedChannelDetailDto {
                channel_id: p.port_name.clone(),
                device_id: format!("slcan:{}", p.port_name),
                label: match &p.vid_pid {
                    Some(vp) => format!("{} — {label_prod} ({vp})", p.port_name),
                    None => format!("{} — {label_prod}", p.port_name),
                },
                state: if denied { "needs_driver" } else { "ready" }.to_string(),
                supports_fd: true,
                mtu: None,
                kernel_or_usb_driver: Some(p.port_type.clone()),
                source_path: p.port_name.clone(),
                hardware_id: p.vid_pid.clone(),
                hint_command: if denied {
                    Some("sudo usermod -aG dialout $USER".to_string())
                } else {
                    None
                },
            }
        })
        .collect();
    let status_label = if detected_channels.is_empty() {
        "Driver Ready (Enter / Attach Serial Port)".to_string()
    } else {
        format!("Driver Ready ({} port(s) found)", detected_channels.len())
    };

    DriverFamilyStatusDto {
        family_id: "slcan".to_string(),
        display_name: "Serial / USB-CDC Lawicel SLCAN".to_string(),
        installed: true,
        os_supported: true,
        hardware_present: !detected_channels.is_empty(),
        status_label,
        detected_library_or_module: Some("nexus-hal::slcan_drv (serialport 4.7)".to_string()),
        architecture_note: Some("Built-in pure-Rust ASCII Lawicel CAN / CAN-FD codec".to_string()),
        searched_paths,
        os_source_locations,
        detected_channels,
        channel_details,
        setup_steps,
        install_hint:
            "Attach a USB-CDC / UART Lawicel SLCAN adapter (CANable, CAN232, USBtin, STM32) or manually enter the serial port (e.g. COM3, /dev/cu.usbmodem0, /dev/ttyACM0) and baud rate."
                .to_string(),
    }
}

/// Probes PEAK-System `PCAN-Basic` (`PCANBasic.dll` / `libpcanbasic.so` / `libPCBUSB.dylib`) and Linux `peak_usb`.
pub fn probe_pcan_family() -> DriverFamilyStatusDto {
    let ports = discover_serial_ports();
    let usb = scan_usb_can_devices(&ports);
    probe_pcan_family_with_usb(&usb)
}

fn probe_pcan_family_with_usb(usb_devices: &[UsbCanDeviceDto]) -> DriverFamilyStatusDto {
    let pcan_usb: Vec<&UsbCanDeviceDto> = usb_devices
        .iter()
        .filter(|d| d.matched_family == "pcan")
        .collect();

    let mut searched = Vec::new();
    let mut os_source_locations = Vec::new();
    let mut detected_lib: Option<String> = None;
    let mut architecture_note: Option<String> = None;
    let mut detected_channels = Vec::new();
    let mut channel_details = Vec::new();
    let mut setup_steps = Vec::new();

    if cfg!(target_os = "windows") {
        os_source_locations
            .push(r"C:\Windows\System32\PCANBasic.dll (64-bit x64/ARM64)".to_string());
        os_source_locations.push(r"C:\Program Files\PEAK-System\PCAN-Basic API".to_string());

        let candidates = collect_windows_dll_candidates(
            &[
                r"C:\Windows\System32\PCANBasic.dll",
                r"C:\Program Files\PEAK-System\PCAN-Basic API\x64\PCANBasic.dll",
                r"C:\Windows\SysWOW64\PCANBasic.dll",
            ],
            "PCANBasic.dll",
        );

        let (valid_dll, wrong_arch_note) =
            evaluate_windows_dll_candidates(&candidates, &mut searched);
        detected_lib = valid_dll;
        architecture_note = wrong_arch_note;
        if let Some(lib) = detected_lib.clone() {
            append_pcan_basic_attached_channels(
                &lib,
                "PCANBasic.dll",
                &pcan_usb,
                &mut detected_channels,
                &mut channel_details,
                &mut architecture_note,
            );
        }

        setup_steps.push(OsSetupStepDto {
            title: "Install PEAK-System Driver Setup (PEAK-Drivers + PCAN-Basic x64)".to_string(),
            description: "Run PEAK-System Driver Setup and enable the 'PCAN-Basic' option so 64-bit PCANBasic.dll is installed into C:\\Windows\\System32.".to_string(),
            command_or_action: None,
            doc_url: Some("https://www.peak-system.com/PCAN-Basic.239.0.html".to_string()),
        });
    } else if cfg!(target_os = "macos") {
        os_source_locations
            .push("/opt/homebrew/lib/libPCBUSB.dylib (Apple Silicon Homebrew)".to_string());
        os_source_locations.push(
            "/usr/local/lib/libPCBUSB.dylib & /Library/Frameworks/PCBUSB.framework".to_string(),
        );

        for p in [
            "/opt/homebrew/lib/libPCBUSB.dylib",
            "/usr/local/lib/libPCBUSB.dylib",
            "/Library/Frameworks/PCBUSB.framework/PCBUSB",
        ] {
            searched.push(p.to_string());
            if detected_lib.is_none() && Path::new(p).exists() {
                detected_lib = Some(p.to_string());
            }
        }
        if let Some(lib) = detected_lib.clone() {
            append_pcan_basic_attached_channels(
                &lib,
                "libPCBUSB.dylib",
                &pcan_usb,
                &mut detected_channels,
                &mut channel_details,
                &mut architecture_note,
            );
        }

        setup_steps.push(OsSetupStepDto {
            title: "Install MacCAN PCBUSB Library (macOS)".to_string(),
            description: "Download MacCAN PCBUSB and copy libPCBUSB.dylib to /usr/local/lib or /opt/homebrew/lib.".to_string(),
            command_or_action: Some("ls -l /opt/homebrew/lib/libPCBUSB.dylib /usr/local/lib/libPCBUSB.dylib".to_string()),
            doc_url: Some("https://mac-can.com/".to_string()),
        });
    } else {
        os_source_locations.push(
            "Linux Mainline SocketCAN (/sys/module/peak_usb, /sys/module/peak_pciefd)".to_string(),
        );
        os_source_locations.push(
            "PEAK Character/Chardev & SDK (/dev/pcan*, /usr/lib/libpcanbasic.so)".to_string(),
        );

        for p in [
            "/usr/lib/libpcanbasic.so",
            "/usr/local/lib/libpcanbasic.so",
            "/usr/lib/x86_64-linux-gnu/libpcanbasic.so",
            "/usr/lib/aarch64-linux-gnu/libpcanbasic.so",
            "/sys/module/pcan",
            "/sys/module/peak_usb",
            "/sys/module/peak_pciefd",
        ] {
            searched.push(p.to_string());
            if detected_lib.is_none() && Path::new(p).exists() {
                detected_lib = Some(p.to_string());
            }
        }
        searched.push("/dev/pcan*".to_string());
        for dev in scan_dev_prefix("pcan") {
            if detected_lib.is_none() {
                detected_lib = Some(dev.clone());
            }
            detected_channels.push(dev.clone());
            channel_details.push(DetectedChannelDetailDto {
                channel_id: dev.clone(),
                device_id: format!("pcan:{dev}"),
                label: format!("{dev} — PEAK Character Device"),
                state: "ready".to_string(),
                supports_fd: true,
                mtu: Some(72),
                kernel_or_usb_driver: Some("pcan".to_string()),
                source_path: dev,
                hardware_id: pcan_usb.first().map(|u| u.vid_pid.clone()),
                hint_command: None,
            });
        }
        for detail in
            inspect_linux_socketcan_channel_details(Some(&["peak_usb", "peak_pciefd", "pcan"]))
        {
            if !detected_channels.contains(&detail.channel_id) {
                detected_channels.push(detail.channel_id.clone());
                channel_details.push(DetectedChannelDetailDto {
                    device_id: format!("pcan:{}", detail.channel_id),
                    ..detail
                });
            }
        }
        if detected_lib.is_some() && detected_channels.is_empty() {
            detected_channels.push("PCAN_USBBUS1".to_string());
        }

        setup_steps.push(OsSetupStepDto {
            title: "Load Linux Mainline peak_usb Driver (SocketCAN)".to_string(),
            description: "Mainline Linux kernels include peak_usb and peak_pciefd out of the box — plug in PCAN-USB / PCAN-USB FD to get can0.".to_string(),
            command_or_action: Some("sudo modprobe peak_usb && sudo ip link set can0 type can bitrate 500000 && sudo ip link set up can0".to_string()),
            doc_url: None,
        });
    }

    let hw_present = !pcan_usb.is_empty() || !channel_details.is_empty();
    let installed = detected_lib.is_some() || !detected_channels.is_empty();
    let status_label = if installed {
        "Driver Installed".to_string()
    } else if !pcan_usb.is_empty() {
        "USB Hardware Attached — SDK Missing".to_string()
    } else {
        "Driver Not Installed".to_string()
    };

    DriverFamilyStatusDto {
        family_id: "pcan".to_string(),
        display_name: "PEAK-System PCAN-Basic / peak_usb".to_string(),
        installed,
        os_supported: true,
        hardware_present: hw_present,
        status_label,
        detected_library_or_module: detected_lib,
        architecture_note,
        searched_paths: searched,
        os_source_locations,
        detected_channels,
        channel_details,
        setup_steps,
        install_hint:
            "Install PEAK-System PCAN-Basic SDK (64-bit PCANBasic.dll / libpcanbasic.so / macOS libPCBUSB.dylib) or load Linux 'sudo modprobe peak_usb'."
                .to_string(),
    }
}

/// Appends the PCAN channels that PCAN-Basic reports as actually attached (Windows / macOS).
///
/// Only real hardware is listed: an installed DLL with nothing plugged in yields no channels.
/// Enumeration failures are reported through `note` (`architecture_note`) instead of being
/// replaced by guessed channel names.
fn append_pcan_basic_attached_channels(
    library_path: &str,
    library_label: &str,
    pcan_usb: &[&UsbCanDeviceDto],
    detected_channels: &mut Vec<String>,
    channel_details: &mut Vec<DetectedChannelDetailDto>,
    note: &mut Option<String>,
) {
    match pcan_enumerate_attached() {
        Ok(attached) => {
            for ch in attached {
                if detected_channels.contains(&ch.channel_name) {
                    continue;
                }
                detected_channels.push(ch.channel_name.clone());
                channel_details.push(DetectedChannelDetailDto {
                    channel_id: ch.channel_name.clone(),
                    device_id: format!("pcan:{}", ch.channel_name),
                    label: ch.label(),
                    state: ch.state_str().to_string(),
                    supports_fd: ch.supports_fd(),
                    mtu: Some(if ch.supports_fd() { 72 } else { 16 }),
                    kernel_or_usb_driver: Some(library_label.to_string()),
                    source_path: library_path.to_string(),
                    hardware_id: pcan_usb.first().map(|u| u.vid_pid.clone()),
                    hint_command: None,
                });
            }
        }
        Err(e) => {
            let msg = format!("PCAN-Basic channel enumeration failed: {e}");
            *note = Some(match note.take() {
                Some(existing) => format!("{existing}; {msg}"),
                None => msg,
            });
        }
    }
}

/// Probes Kvaser `CANlib` (`canlib32.dll` / `libcanlib.so`) and Linux `kvaser_usb` / `leaf` / `mhydra`.
pub fn probe_kvaser_family() -> DriverFamilyStatusDto {
    let ports = discover_serial_ports();
    let usb = scan_usb_can_devices(&ports);
    probe_kvaser_family_with_usb(&usb)
}

fn probe_kvaser_family_with_usb(usb_devices: &[UsbCanDeviceDto]) -> DriverFamilyStatusDto {
    let kvaser_usb: Vec<&UsbCanDeviceDto> = usb_devices
        .iter()
        .filter(|d| d.matched_family == "kvaser")
        .collect();

    let mut searched = Vec::new();
    let mut os_source_locations = Vec::new();
    let mut detected_lib: Option<String> = None;
    let mut architecture_note: Option<String> = None;
    let mut detected_channels = Vec::new();
    let mut channel_details = Vec::new();
    let mut setup_steps = Vec::new();

    if cfg!(target_os = "windows") {
        os_source_locations.push(
            r"C:\Windows\System32\canlib32.dll (Note: Kvaser names its 64-bit DLL canlib32.dll in System32!)"
                .to_string(),
        );
        os_source_locations.push(r"C:\Program Files\Kvaser\Drivers".to_string());

        let candidates = collect_windows_dll_candidates(
            &[
                r"C:\Windows\System32\canlib32.dll",
                r"C:\Program Files\Kvaser\Canlib\bin\x64\canlib32.dll",
                r"C:\Windows\SysWOW64\canlib32.dll",
            ],
            "canlib32.dll",
        );

        let (valid_dll, arch_note) = evaluate_windows_dll_candidates(&candidates, &mut searched);
        detected_lib = valid_dll;
        architecture_note = arch_note;

        if detected_lib.is_some() {
            for ch in ["0", "1"] {
                detected_channels.push(ch.to_string());
                channel_details.push(DetectedChannelDetailDto {
                    channel_id: ch.to_string(),
                    device_id: format!("kvaser:{ch}"),
                    label: format!("Kvaser CANlib Channel {ch}"),
                    state: if kvaser_usb.is_empty() { "ready" } else { "up" }.to_string(),
                    supports_fd: true,
                    mtu: Some(72),
                    kernel_or_usb_driver: detected_lib.clone(),
                    source_path: detected_lib.clone().unwrap_or_default(),
                    hardware_id: kvaser_usb.first().map(|u| u.vid_pid.clone()),
                    hint_command: None,
                });
            }
        }

        setup_steps.push(OsSetupStepDto {
            title: "Install Kvaser Drivers for Windows + CANlib SDK".to_string(),
            description: "Install Kvaser Drivers for Windows (installs 64-bit PE 0x8664 canlib32.dll into C:\\Windows\\System32).".to_string(),
            command_or_action: None,
            doc_url: Some("https://kvaser.com/download/".to_string()),
        });
    } else if cfg!(target_os = "macos") {
        #[cfg(target_os = "macos")]
        {
            use crate::drivers::kvaser_usb_drv::{
                enumerate, installed_library_path, LIBRARY_PATHS,
            };
            let library_path = LIBRARY_PATHS.iter().find(|path| Path::new(path).exists());
            searched.extend(LIBRARY_PATHS.iter().map(|path| path.to_string()));
            os_source_locations.extend(LIBRARY_PATHS.iter().map(|path| path.to_string()));
            setup_steps.push(OsSetupStepDto {
                title: "Install KvaserUSB library".to_string(),
                description: "Kvaser USB user-space driver with Leaf v3 support.".to_string(),
                command_or_action: Some("See README.md, Kvaser USB on macOS.".to_string()),
                doc_url: Some(
                    "https://github.com/cliffrubio/macOS-CAN-Drivers/tree/main/KvaserUSB"
                        .to_string(),
                ),
            });
            if library_path.is_some() {
                let loaded_path = installed_library_path();
                detected_lib = loaded_path.as_ref().ok().map(|path| path.to_string());
                match enumerate() {
                    Ok(channels) => {
                        for (index, channel) in channels.iter().enumerate() {
                            let id = index.to_string();
                            detected_channels.push(id.clone());
                            channel_details.push(DetectedChannelDetailDto {
                                channel_id: id.clone(),
                                device_id: format!("kvaser:{id}"),
                                label: channel.name(),
                                state: "ready".to_string(),
                                supports_fd: channel.fd_capable != 0,
                                mtu: Some(if channel.fd_capable != 0 { 72 } else { 16 }),
                                kernel_or_usb_driver: Some("libKvaserUSB.dylib".to_string()),
                                source_path: detected_lib.clone().unwrap_or_default(),
                                hardware_id: kvaser_usb.first().map(|u| u.vid_pid.clone()),
                                hint_command: None,
                            });
                        }
                    }
                    Err(error) => architecture_note = Some(error.to_string()),
                }
            }
        }
    } else {
        os_source_locations.push(
            "Linux Mainline SocketCAN (/sys/module/kvaser_usb, /sys/module/kvaser_pciefd)"
                .to_string(),
        );
        os_source_locations.push(
            "Kvaser linuxcan SDK (/usr/lib/libcanlib.so, /sys/module/leaf, /sys/module/mhydra)"
                .to_string(),
        );

        for p in [
            "/usr/lib/libcanlib.so",
            "/usr/local/lib/libcanlib.so",
            "/usr/lib/x86_64-linux-gnu/libcanlib.so",
            "/usr/lib/aarch64-linux-gnu/libcanlib.so",
            "/sys/module/kvcommon",
            "/sys/module/leaf",
            "/sys/module/mhydra",
            "/sys/module/kvaser_usb",
            "/sys/module/kvaser_pciefd",
        ] {
            searched.push(p.to_string());
            if detected_lib.is_none() && Path::new(p).exists() {
                detected_lib = Some(p.to_string());
            }
        }
        for detail in inspect_linux_socketcan_channel_details(Some(&[
            "kvaser_usb",
            "kvaser_pciefd",
            "leaf",
            "mhydra",
            "kvcommon",
        ])) {
            if !detected_channels.contains(&detail.channel_id) {
                detected_channels.push(detail.channel_id.clone());
                channel_details.push(DetectedChannelDetailDto {
                    device_id: format!("kvaser:{}", detail.channel_id),
                    ..detail
                });
            }
        }
        if detected_lib.is_some() && detected_channels.is_empty() {
            detected_channels.push("0".to_string());
        }

        setup_steps.push(OsSetupStepDto {
            title: "Load Linux Mainline kvaser_usb Driver (SocketCAN)".to_string(),
            description: "Kvaser Leaf, U100, Hybrid, and Memorator interfaces work natively with mainline Linux SocketCAN kvaser_usb.".to_string(),
            command_or_action: Some("sudo modprobe kvaser_usb && sudo ip link set can0 type can bitrate 500000 && sudo ip link set up can0".to_string()),
            doc_url: None,
        });
    }

    let hw_present = !kvaser_usb.is_empty() || !channel_details.is_empty();
    let installed = detected_lib.is_some() || !detected_channels.is_empty();
    let status_label = if installed {
        "Driver Installed".to_string()
    } else if !kvaser_usb.is_empty() {
        "USB Hardware Attached — Driver/SDK Missing".to_string()
    } else {
        "Driver Not Installed".to_string()
    };

    DriverFamilyStatusDto {
        family_id: "kvaser".to_string(),
        display_name: "Kvaser CANlib / kvaser_usb".to_string(),
        installed,
        os_supported: true,
        hardware_present: hw_present,
        status_label,
        detected_library_or_module: detected_lib,
        architecture_note,
        searched_paths: searched,
        os_source_locations,
        detected_channels,
        channel_details,
        setup_steps,
        install_hint: if cfg!(target_os = "macos") {
            "Install libKvaserUSB.dylib in /opt/homebrew/lib or /usr/local/lib (see README.md)."
                .to_string()
        } else {
            "Install Kvaser CANlib SDK (64-bit canlib32.dll / linuxcan libcanlib.so) or load Linux 'sudo modprobe kvaser_usb'.".to_string()
        },
    }
}

/// Probes Vector Informatik `XL Driver Library` (`vxlapi64.dll` — Windows-only commercial SDK).
pub fn probe_vector_xl_family() -> DriverFamilyStatusDto {
    let ports = discover_serial_ports();
    let usb = scan_usb_can_devices(&ports);
    probe_vector_xl_family_with_usb(&usb)
}

fn probe_vector_xl_family_with_usb(usb_devices: &[UsbCanDeviceDto]) -> DriverFamilyStatusDto {
    let vector_usb: Vec<&UsbCanDeviceDto> = usb_devices
        .iter()
        .filter(|d| d.matched_family == "vector_xl")
        .collect();

    if cfg!(target_os = "windows") {
        let mut searched = Vec::new();
        let os_source_locations = vec![
            r"C:\Windows\System32\vxlapi64.dll".to_string(),
            r"C:\Program Files (x86)\Vector XL Driver Library\bin\vxlapi64.dll".to_string(),
            r"C:\Users\Public\Documents\Vector\XL Driver Library\bin\vxlapi64.dll".to_string(),
        ];

        let mut candidates = collect_windows_dll_candidates(
            &[
                r"C:\Windows\System32\vxlapi64.dll",
                r"C:\Program Files\Vector XL Driver Library\bin\vxlapi64.dll",
                r"C:\Program Files (x86)\Vector XL Driver Library\bin\vxlapi64.dll",
                r"C:\Users\Public\Documents\Vector\XL Driver Library\bin\vxlapi64.dll",
            ],
            "vxlapi64.dll",
        );
        for legacy32 in [
            r"C:\Windows\SysWOW64\vxlapi.dll",
            r"C:\Program Files (x86)\Vector XL Driver Library\bin\vxlapi.dll",
        ] {
            let p = PathBuf::from(legacy32);
            if !candidates.contains(&p) {
                candidates.push(p);
            }
        }

        let (detected_lib, architecture_note) =
            evaluate_windows_dll_candidates(&candidates, &mut searched);

        let mut detected_channels = Vec::new();
        let mut channel_details = Vec::new();
        if let Some(ref lib) = detected_lib {
            for ch in ["0", "1"] {
                detected_channels.push(ch.to_string());
                channel_details.push(DetectedChannelDetailDto {
                    channel_id: ch.to_string(),
                    device_id: format!("vector_xl:{ch}"),
                    label: format!("Vector XL Virtual/Hardware Channel {ch}"),
                    state: if vector_usb.is_empty() { "ready" } else { "up" }.to_string(),
                    supports_fd: true,
                    mtu: Some(72),
                    kernel_or_usb_driver: Some("vxlapi64.dll".to_string()),
                    source_path: lib.clone(),
                    hardware_id: vector_usb.first().map(|u| u.vid_pid.clone()),
                    hint_command: None,
                });
            }
        }

        let installed = detected_lib.is_some();
        let hw_present = !vector_usb.is_empty();
        let status_label = if installed {
            "Driver Installed (vxlapi64.dll)".to_string()
        } else if hw_present {
            "Vector USB Attached — vxlapi64.dll Missing".to_string()
        } else {
            "Driver Not Installed".to_string()
        };

        DriverFamilyStatusDto {
            family_id: "vector_xl".to_string(),
            display_name: "Vector XL Driver Library (VN1610 / VN1630 / VN1640)".to_string(),
            installed,
            os_supported: true,
            hardware_present: hw_present,
            status_label,
            detected_library_or_module: detected_lib,
            architecture_note,
            searched_paths: searched,
            os_source_locations,
            detected_channels,
            channel_details,
            setup_steps: vec![OsSetupStepDto {
                title: "Install Vector Driver Setup + Vector XL Driver Library".to_string(),
                description:
                    "Install Vector Hardware Config / Driver Setup and ensure 64-bit vxlapi64.dll is placed in C:\\Windows\\System32 or Vector XL Driver Library\\bin."
                        .to_string(),
                command_or_action: None,
                doc_url: Some("https://www.vector.com/int/en/products/products-a-z/libraries-drivers/xl-driver-library/".to_string()),
            }],
            install_hint:
                "Install Vector Driver Setup and Vector XL Driver Library (64-bit vxlapi64.dll) on Windows."
                    .to_string(),
        }
    } else {
        DriverFamilyStatusDto {
            family_id: "vector_xl".to_string(),
            display_name: "Vector XL Driver Library (VN1610 / VN1630 / VN1640)".to_string(),
            installed: false,
            os_supported: false,
            hardware_present: !vector_usb.is_empty(),
            status_label: "Windows-Only Vendor SDK".to_string(),
            detected_library_or_module: None,
            architecture_note: Some(
                "Vector Informatik provides vxlapi64.dll exclusively for 64-bit Windows".to_string(),
            ),
            searched_paths: Vec::new(),
            os_source_locations: vec![
                "Windows-only SDK (C:\\Windows\\System32\\vxlapi64.dll — not distributed for Linux or macOS)"
                    .to_string(),
            ],
            detected_channels: Vec::new(),
            channel_details: Vec::new(),
            setup_steps: vec![OsSetupStepDto {
                title: "Vector XL is Windows-Only".to_string(),
                description:
                    "Vector XL Driver Library (vxlapi64.dll) is only supported on Windows. On Linux or macOS, use SocketCAN, gs_usb (candleLight/CANable), SLCAN, PCAN, or Kvaser."
                        .to_string(),
                command_or_action: None,
                doc_url: None,
            }],
            install_hint:
                "Vector XL Driver Library (vxlapi64.dll) is only available on 64-bit Windows."
                    .to_string(),
        }
    }
}

// =============================================================================
// Shared Helper Routines (Windows PE Validation & Linux Sysfs Net Details)
// =============================================================================

fn collect_windows_dll_candidates(fixed: &[&str], dll_name: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fixed.iter().map(PathBuf::from).collect();
    if let Some(path_os) = env::var_os("PATH") {
        for dir in env::split_paths(&path_os).take(24) {
            let candidate = dir.join(dll_name);
            if !out.contains(&candidate) && candidate.is_file() {
                out.push(candidate);
            }
        }
    }
    out
}

/// Evaluates Windows `.dll` candidates via safe PE header inspection:
/// - Returns `(Some(valid_64bit_path), Some(arch_note))` if a host-compatible 64-bit DLL is found.
/// - Returns `(None, Some("32-bit (x86) DLL detected — 64-bit (x64) DLL required for NexusCAN"))`
///   if ONLY a 32-bit (`0x014C`) DLL was found!
fn evaluate_windows_dll_candidates(
    candidates: &[PathBuf],
    searched: &mut Vec<String>,
) -> (Option<String>, Option<String>) {
    let mut valid_path: Option<String> = None;
    let mut valid_arch_label: Option<String> = None;
    let mut saw_32bit_only = false;

    for p in candidates {
        let s = p.to_string_lossy().to_string();
        searched.push(s.clone());
        if !p.is_file() {
            continue;
        }
        match inspect_pe_dll_file(p) {
            Ok(arch) if arch.matches_host_arch() => {
                if valid_path.is_none() {
                    valid_path = Some(s);
                    valid_arch_label = Some(format!("Verified {} DLL", arch.label()));
                }
            }
            Ok(PeArchitecture::I386) => {
                saw_32bit_only = true;
            }
            Ok(other) => {
                if valid_arch_label.is_none() {
                    valid_arch_label = Some(format!(
                        "Incompatible {} DLL detected — {}-bit DLL required",
                        other.label(),
                        env::consts::ARCH
                    ));
                }
            }
            Err(_) => {}
        }
    }

    if valid_path.is_some() {
        (valid_path, valid_arch_label)
    } else if saw_32bit_only {
        (
            None,
            Some("32-bit (x86) DLL detected — 64-bit (x64) DLL required for NexusCAN".to_string()),
        )
    } else {
        (None, valid_arch_label)
    }
}

fn scan_dev_prefix(prefix: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/dev") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(prefix) {
            out.push(format!("/dev/{name}"));
        }
    }
    out.sort();
    out
}

fn inspect_linux_socketcan_channel_details(
    driver_filter: Option<&[&str]>,
) -> Vec<DetectedChannelDetailDto> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/sys/class/net") else {
        return out;
    };

    for entry in entries.flatten() {
        let iface = entry.file_name().to_string_lossy().to_string();
        let iface_path = entry.path();
        let Ok(dev_type) = fs::read_to_string(iface_path.join("type")) else {
            continue;
        };
        if dev_type.trim() != "280" {
            continue;
        }

        let drv_name = fs::canonicalize(iface_path.join("device").join("driver"))
            .ok()
            .and_then(|c| c.file_name().map(|s| s.to_string_lossy().to_string()));

        if let Some(allowed_drivers) = driver_filter {
            let Some(ref actual_drv) = drv_name else {
                continue;
            };
            if !allowed_drivers
                .iter()
                .any(|allowed| actual_drv.eq_ignore_ascii_case(allowed))
            {
                continue;
            }
        }

        let mtu: u32 = fs::read_to_string(iface_path.join("mtu"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(16);
        let operstate = fs::read_to_string(iface_path.join("operstate"))
            .ok()
            .map(|s| s.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "unknown".to_string());
        let raw_flags: u32 = fs::read_to_string(iface_path.join("flags"))
            .ok()
            .and_then(|s| {
                let clean = s.trim().trim_start_matches("0x").trim_start_matches("0X");
                u32::from_str_radix(clean, 16).ok()
            })
            .unwrap_or(0);
        let rx_packets: u64 = fs::read_to_string(iface_path.join("statistics").join("rx_packets"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);

        let is_up = (raw_flags & 0x1) != 0 && operstate != "down";
        let is_virtual = iface.starts_with("vcan") || iface.starts_with("vxcan");
        let supports_fd = mtu >= 72;

        let state = if !is_up {
            "down"
        } else if is_virtual {
            "virtual"
        } else {
            "up"
        };

        let hint_command = if !is_up {
            if is_virtual {
                Some(format!("sudo ip link set up {iface}"))
            } else {
                Some(format!(
                    "sudo ip link set {iface} type can bitrate 500000 && sudo ip link set up {iface}"
                ))
            }
        } else {
            None
        };

        let effective_drv = drv_name.or_else(|| {
            if is_virtual {
                Some("vcan".to_string())
            } else if iface.starts_with("slcan") {
                Some("slcan".to_string())
            } else {
                None
            }
        });

        let mode_str = if supports_fd {
            "CAN-FD"
        } else {
            "Classical CAN"
        };
        out.push(DetectedChannelDetailDto {
            channel_id: iface.clone(),
            device_id: format!("socketcan:{iface}"),
            label: format!("{iface} — {mode_str} ({operstate}, MTU {mtu}, RX {rx_packets} pkts)"),
            state: state.to_string(),
            supports_fd,
            mtu: Some(mtu),
            kernel_or_usb_driver: effective_drv,
            source_path: iface_path.to_string_lossy().to_string(),
            hardware_id: None,
            hint_command,
        });
    }

    out.sort_by(|a, b| a.channel_id.cmp(&b.channel_id));
    out
}

#[cfg(target_os = "linux")]
fn list_linux_socketcan_interfaces(driver_filter: Option<&[&str]>) -> Vec<String> {
    inspect_linux_socketcan_channel_details(driver_filter)
        .into_iter()
        .map(|d| d.channel_id)
        .collect()
}

/// HIGH-02.3: resolves the exact SocketCAN interface for a vendor family (PCAN / Kvaser /
/// gs_usb) on Linux.
///
/// Only the REQUESTED channel is accepted, and only if it is both a live SocketCAN interface
/// and one of the interfaces bound to this family's kernel driver. There is deliberately no
/// "first interface found" fallback: opening a different physical bus than the one the user
/// selected is a field-safety hazard. A missing channel is reported as an error by the caller.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn resolve_family_socketcan_iface(
    requested_ch: &str,
    family_channels: &[String],
    all_socketcan_ifaces: &[String],
) -> Option<String> {
    let in_family = family_channels.iter().any(|c| c == requested_ch);
    let is_live = all_socketcan_ifaces.iter().any(|c| c == requested_ch);
    (in_family && is_live).then(|| requested_ch.to_string())
}

// =============================================================================
// 4. Vendor SDK Adapter Drivers (`PcanDriver`, `KvaserDriver`, `VectorXlDriver`)
// =============================================================================

/// PEAK-System `PCAN-Basic` / Linux `peak_usb` driver adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct PcanDriver;

impl PcanDriver {
    /// Creates a new [`PcanDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Builds a [`DeviceDescriptor`] for a PCAN channel (`"PCAN_USBBUS1"`, `"can0"`, etc.).
    pub fn descriptor_for_channel(channel: &str) -> DeviceDescriptor {
        let ch = if channel.trim().is_empty() {
            "PCAN_USBBUS1"
        } else {
            channel.trim()
        };
        DeviceDescriptorDto {
            device_id: format!("pcan:{ch}"),
            driver_id: "pcan".to_string(),
            channel_name: ch.to_string(),
            display_name: format!("{ch} — PEAK-System PCAN-Basic / peak_usb"),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: true,
                max_bitrate: 8_000_000,
                is_virtual: false,
            },
        }
    }
}

impl AdapterDriver for PcanDriver {
    fn driver_id(&self) -> &'static str {
        "pcan"
    }

    fn display_name(&self) -> &'static str {
        "PEAK-System PCAN-Basic"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let status = probe_pcan_family();
        if !status.installed {
            return Ok(Vec::new());
        }
        Ok(status
            .detected_channels
            .into_iter()
            .map(|ch| Self::descriptor_for_channel(&ch))
            .collect())
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let requested_ch = config
            .adapter_channel
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let ch = device.channel_name.trim();
                if ch.is_empty() {
                    "PCAN_USBBUS1"
                } else {
                    ch
                }
            });

        let status = probe_pcan_family();

        #[cfg(target_os = "linux")]
        {
            let all_sc = list_linux_socketcan_interfaces(None);
            let target_sc =
                resolve_family_socketcan_iface(requested_ch, &status.detected_channels, &all_sc);

            if let Some(sc_iface) = target_sc {
                let sc_drv = SocketCanDriver::new();
                if let Ok(devs) = sc_drv.discover_devices() {
                    if let Some(sc_desc) = devs.into_iter().find(|d| d.channel_name == sc_iface) {
                        return sc_drv.open_channel(&sc_desc, config);
                    }
                }
            }
        }

        if !status.installed {
            let arch_extra = status
                .architecture_note
                .as_deref()
                .map(|n| format!(" [{n}]"))
                .unwrap_or_default();
            return Err(AdapterError::Driver(format!(
                "PEAK PCAN-Basic driver is not installed on this host{arch_extra} (checked: {}). {}",
                status.searched_paths.join(", "),
                status.install_hint
            )));
        }

        // Native PCAN-Basic path (always on Windows / macOS; on Linux for non-SocketCAN
        // channel names when the PEAK chardev driver + libpcanbasic.so are installed).
        // Not-attached channels yield `DeviceNotFound` listing the actually attached ones.
        let channel = open_pcan_channel(requested_ch, device, config)?;
        Ok(Box::new(channel))
    }
}

/// Kvaser `CANlib` / Linux `kvaser_usb` driver adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct KvaserDriver;

impl KvaserDriver {
    /// Creates a new [`KvaserDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Builds a [`DeviceDescriptor`] for a Kvaser channel (`"0"`, `"can0"`, etc.).
    pub fn descriptor_for_channel(channel: &str) -> DeviceDescriptor {
        let ch = if channel.trim().is_empty() {
            "0"
        } else {
            channel.trim()
        };
        DeviceDescriptorDto {
            device_id: format!("kvaser:{ch}"),
            driver_id: "kvaser".to_string(),
            channel_name: ch.to_string(),
            display_name: format!("Kvaser Ch {ch} — Kvaser CANlib / kvaser_usb"),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: true,
                max_bitrate: 8_000_000,
                is_virtual: false,
            },
        }
    }
}

impl AdapterDriver for KvaserDriver {
    fn driver_id(&self) -> &'static str {
        "kvaser"
    }

    fn display_name(&self) -> &'static str {
        "Kvaser CANlib"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let status = probe_kvaser_family();
        if !status.installed {
            return Ok(Vec::new());
        }
        Ok(status
            .detected_channels
            .into_iter()
            .map(|ch| Self::descriptor_for_channel(&ch))
            .collect())
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let requested_ch = config
            .adapter_channel
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let ch = device.channel_name.trim();
                if ch.is_empty() {
                    "0"
                } else {
                    ch
                }
            });

        #[cfg(target_os = "macos")]
        {
            let index = requested_ch.parse::<usize>().map_err(|_| {
                AdapterError::DeviceNotFound(format!("Invalid Kvaser channel '{requested_ch}'"))
            })?;
            crate::drivers::kvaser_usb_drv::open(index, device, config)
        }

        #[cfg(not(target_os = "macos"))]
        let status = probe_kvaser_family();

        #[cfg(target_os = "linux")]
        {
            let all_sc = list_linux_socketcan_interfaces(None);
            let target_sc =
                resolve_family_socketcan_iface(requested_ch, &status.detected_channels, &all_sc);

            if let Some(sc_iface) = target_sc {
                let sc_drv = SocketCanDriver::new();
                if let Ok(devs) = sc_drv.discover_devices() {
                    if let Some(sc_desc) = devs.into_iter().find(|d| d.channel_name == sc_iface) {
                        return sc_drv.open_channel(&sc_desc, config);
                    }
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            if !status.installed {
                let arch_extra = status
                    .architecture_note
                    .as_deref()
                    .map(|n| format!(" [{n}]"))
                    .unwrap_or_default();
                return Err(AdapterError::Driver(format!(
                "Kvaser CANlib driver is not installed on this host{arch_extra} (checked: {}). {}",
                status.searched_paths.join(", "),
                status.install_hint
            )));
            }

            Err(AdapterError::DeviceNotFound(format!(
            "Kvaser CANlib driver is installed ({}), but hardware channel '{requested_ch}' is not attached or active",
            status
                .detected_library_or_module
                .as_deref()
                .unwrap_or("CANlib")
        )))
        }
    }
}

/// Vector Informatik `XL Driver Library` (`vxlapi64.dll`) driver adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct VectorXlDriver;

impl VectorXlDriver {
    /// Creates a new [`VectorXlDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Builds a [`DeviceDescriptor`] for a Vector XL channel (`"0"`, `"VN1610_CH1"`, etc.).
    pub fn descriptor_for_channel(channel: &str) -> DeviceDescriptor {
        let ch = if channel.trim().is_empty() {
            "0"
        } else {
            channel.trim()
        };
        DeviceDescriptorDto {
            device_id: format!("vector_xl:{ch}"),
            driver_id: "vector_xl".to_string(),
            channel_name: ch.to_string(),
            display_name: format!("Vector XL Ch {ch} — Vector XL Driver Library"),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: true,
                max_bitrate: 8_000_000,
                is_virtual: false,
            },
        }
    }
}

impl AdapterDriver for VectorXlDriver {
    fn driver_id(&self) -> &'static str {
        "vector_xl"
    }

    fn display_name(&self) -> &'static str {
        "Vector XL Driver Library"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let status = probe_vector_xl_family();
        if !status.installed {
            return Ok(Vec::new());
        }
        Ok(status
            .detected_channels
            .into_iter()
            .map(|ch| Self::descriptor_for_channel(&ch))
            .collect())
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let requested_ch = config
            .adapter_channel
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let ch = device.channel_name.trim();
                if ch.is_empty() {
                    "0"
                } else {
                    ch
                }
            });

        let status = probe_vector_xl_family();
        if !status.os_supported {
            return Err(AdapterError::DriverNotAvailable(
                "vector_xl (Vector XL Driver Library vxlapi64.dll is Windows-only)".to_string(),
            ));
        }
        if !status.installed {
            let arch_extra = status
                .architecture_note
                .as_deref()
                .map(|n| format!(" [{n}]"))
                .unwrap_or_default();
            return Err(AdapterError::Driver(format!(
                "Vector XL Driver Library (vxlapi64.dll) is not installed on this Windows host{arch_extra} (checked: {}). {}",
                status.searched_paths.join(", "),
                status.install_hint
            )));
        }

        Err(AdapterError::DeviceNotFound(format!(
            "Vector XL Driver Library is installed ({}), but channel '{requested_ch}' is not assigned in Vector Hardware Config",
            status
                .detected_library_or_module
                .as_deref()
                .unwrap_or("vxlapi64.dll")
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_family_socketcan_iface;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn vendor_family_never_falls_back_to_another_interface() {
        let family = v(&["can1"]);
        let all = v(&["can0", "can1", "vcan0"]);
        assert_eq!(
            resolve_family_socketcan_iface("can1", &family, &all).as_deref(),
            Some("can1")
        );
        // Requested channel missing -> no fallback to the first family / SocketCAN interface.
        assert_eq!(resolve_family_socketcan_iface("can7", &family, &all), None);
        assert_eq!(
            resolve_family_socketcan_iface("PCAN_USBBUS1", &family, &all),
            None
        );
        assert_eq!(resolve_family_socketcan_iface("0", &family, &all), None);
        // A live interface of ANOTHER driver (e.g. vcan0, or a gs_usb can0) is not this family's.
        assert_eq!(resolve_family_socketcan_iface("vcan0", &family, &all), None);
        assert_eq!(resolve_family_socketcan_iface("can0", &family, &all), None);
        // Family channel that is not a live SocketCAN interface (e.g. went down).
        assert_eq!(
            resolve_family_socketcan_iface("can1", &family, &v(&["can0"])),
            None
        );
    }
}
