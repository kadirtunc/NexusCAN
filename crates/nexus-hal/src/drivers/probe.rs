//! Cross-OS CAN hardware & driver installation verifier (`cmd_probe_drivers`),
//! plus `PcanDriver`, `KvaserDriver`, and `GsUsbDriver` adapter discovery & smart routing.
//!
//! Preserves `#![forbid(unsafe_code)]` across Linux, Windows, and macOS by inspecting OS kernel
//! modules (`/sys/module/*`, `/proc/net/can`), sysfs USB descriptors (`/sys/bus/usb/devices`),
//! character devices (`/dev/pcan*`), and SDK shared library installation paths (`PCANBasic.dll`,
//! `libpcanbasic.so`, `canlib32.dll`, `libcanlib.so`, `libPCBUSB.dylib`).

use crate::drivers::mock_drv::{MOCK0_DEVICE_ID, MOCK1_DEVICE_ID};
use crate::drivers::slcan_drv::discover_serial_ports;
#[cfg(target_os = "linux")]
use crate::drivers::socketcan_drv::SocketCanDriver;
use crate::dto::{
    AdapterCapabilitiesDto, DeviceDescriptorDto, DriverFamilyStatusDto, DriverProbeReportDto,
    SerialPortInfoDto,
};
use crate::error::AdapterError;
use crate::traits::{AdapterDriver, CanChannel, ChannelConfig, DeviceDescriptor};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CANDLELIGHT_USB_IDS: &[(&str, &str)] = &[
    ("1d50", "606f"), // OpenMoko / candleLight / CANable / rusEFI
    ("1209", "2323"), // Linklayer CANtact
    ("16d0", "0f67"), // Microchip / gs_usb compatible
    ("1cd2", "606f"), // Symetric / candleLight FD
];

/// Runs a live diagnostic check of all 6 CAN driver families and enumerates host serial/USB-CDC ports.
pub fn probe_all_drivers() -> DriverProbeReportDto {
    let checked_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let serial_ports = discover_serial_ports();

    let families = vec![
        probe_mock_family(),
        probe_socketcan_family(),
        probe_slcan_family(&serial_ports),
        probe_pcan_family(),
        probe_kvaser_family(),
        probe_gs_usb_family(),
    ];

    DriverProbeReportDto {
        host_os: env::consts::OS.to_string(),
        checked_at_ms,
        families,
        serial_ports,
    }
}

/// Probes the built-in deterministic simulation driver (`mock0` + `mock1`).
pub fn probe_mock_family() -> DriverFamilyStatusDto {
    let _ = (MOCK0_DEVICE_ID, MOCK1_DEVICE_ID);
    DriverFamilyStatusDto {
        family_id: "mock".to_string(),
        display_name: "Virtual Simulation Bus (mock0 / mock1)".to_string(),
        installed: true,
        status_label: "Built-in Ready".to_string(),
        detected_library_or_module: Some("nexus-hal::mock_drv (in-process)".to_string()),
        searched_paths: Vec::new(),
        detected_channels: vec!["mock0".to_string(), "mock1".to_string()],
        install_hint:
            "Built-in deterministic EV Powertrain, BMS & Charger simulation buses; always ready."
                .to_string(),
    }
}

/// Probes Linux Kernel SocketCAN (`can*`, `vcan*`, `slcan*`).
pub fn probe_socketcan_family() -> DriverFamilyStatusDto {
    if cfg!(target_os = "linux") {
        let searched = vec![
            "/proc/net/can".to_string(),
            "/sys/module/can".to_string(),
            "/sys/module/can_raw".to_string(),
            "/sys/module/vcan".to_string(),
            "/sys/class/net".to_string(),
        ];

        let detected_channels = list_linux_socketcan_interfaces(None);
        let found_module = [
            "/proc/net/can",
            "/sys/module/can",
            "/sys/module/can_raw",
            "/sys/module/vcan",
        ]
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| (*s).to_string());

        let installed = found_module.is_some() || !detected_channels.is_empty();
        let status_label = if !detected_channels.is_empty() {
            format!("Kernel Active ({} iface)", detected_channels.len())
        } else if installed {
            "Kernel Module Loaded (No Interface Up)".to_string()
        } else {
            "Kernel CAN Module Not Loaded".to_string()
        };

        DriverFamilyStatusDto {
            family_id: "socketcan".to_string(),
            display_name: "Linux Kernel SocketCAN (can / vcan / slcan)".to_string(),
            installed,
            status_label,
            detected_library_or_module: found_module,
            searched_paths: searched,
            detected_channels,
            install_hint:
                "Run: sudo modprobe can can_raw vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0"
                    .to_string(),
        }
    } else {
        DriverFamilyStatusDto {
            family_id: "socketcan".to_string(),
            display_name: "Linux Kernel SocketCAN (can / vcan / slcan)".to_string(),
            installed: false,
            status_label: "Linux-Only Kernel Subsystem".to_string(),
            detected_library_or_module: None,
            searched_paths: Vec::new(),
            detected_channels: Vec::new(),
            install_hint:
                "SocketCAN is a Linux-only kernel subsystem. On Windows/macOS use SLCAN, PCAN-Basic, Kvaser CANlib, or gs_usb."
                    .to_string(),
        }
    }
}

/// Probes the built-in cross-OS Lawicel SLCAN (`serialport`) driver and attached COM/`ttyUSB`/`ttyACM` ports.
pub fn probe_slcan_family(serial_ports: &[SerialPortInfoDto]) -> DriverFamilyStatusDto {
    let searched_paths = if cfg!(target_os = "windows") {
        vec!["Win32 SetupAPI (COM1..COM256)".to_string()]
    } else if cfg!(target_os = "macos") {
        vec![
            "/dev/cu.usbmodem*".to_string(),
            "/dev/cu.usbserial*".to_string(),
        ]
    } else {
        vec![
            "/sys/class/tty".to_string(),
            "/dev/ttyUSB*".to_string(),
            "/dev/ttyACM*".to_string(),
        ]
    };

    let detected_channels: Vec<String> = serial_ports.iter().map(|p| p.port_name.clone()).collect();
    let status_label = if detected_channels.is_empty() {
        "Driver Ready (Enter / Attach Serial Port)".to_string()
    } else {
        format!("Driver Ready ({} port(s) found)", detected_channels.len())
    };

    DriverFamilyStatusDto {
        family_id: "slcan".to_string(),
        display_name: "Serial / USB-CDC Lawicel SLCAN".to_string(),
        installed: true,
        status_label,
        detected_library_or_module: Some("nexus-hal::slcan_drv (serialport 4.7)".to_string()),
        searched_paths,
        detected_channels,
        install_hint:
            "Attach a USB-CDC / UART Lawicel SLCAN adapter (CANable, CAN232, USBtin, STM32) or manually enter the serial port (e.g. COM3, /dev/ttyUSB0, /dev/ttyACM0) and baud rate."
                .to_string(),
    }
}

/// Probes PEAK-System `PCAN-Basic` (`PCANBasic.dll` / `libpcanbasic.so` / `libPCBUSB.dylib`) and Linux `peak_usb`.
pub fn probe_pcan_family() -> DriverFamilyStatusDto {
    let mut searched = Vec::new();
    let mut detected_lib: Option<String> = None;
    let mut detected_channels = Vec::new();

    if cfg!(target_os = "windows") {
        let candidates = collect_windows_dll_candidates(
            &[
                r"C:\Windows\System32\PCANBasic.dll",
                r"C:\Windows\SysWOW64\PCANBasic.dll",
            ],
            "PCANBasic.dll",
        );
        for p in candidates {
            let s = p.to_string_lossy().to_string();
            if detected_lib.is_none() && p.is_file() {
                detected_lib = Some(s.clone());
            }
            searched.push(s);
        }
        if detected_lib.is_some() {
            detected_channels.push("PCAN_USBBUS1".to_string());
            detected_channels.push("PCAN_USBBUS2".to_string());
        }
    } else if cfg!(target_os = "macos") {
        for p in [
            "/usr/local/lib/libPCBUSB.dylib",
            "/opt/homebrew/lib/libPCBUSB.dylib",
        ] {
            searched.push(p.to_string());
            if detected_lib.is_none() && Path::new(p).exists() {
                detected_lib = Some(p.to_string());
            }
        }
        if detected_lib.is_some() {
            detected_channels.push("PCAN_USBBUS1".to_string());
        }
    } else {
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
            detected_channels.push(dev);
        }
        for iface in list_linux_socketcan_interfaces(Some(&["peak_usb", "peak_pciefd", "pcan"])) {
            if !detected_channels.contains(&iface) {
                detected_channels.push(iface);
            }
        }
        if detected_lib.is_some() && detected_channels.is_empty() {
            detected_channels.push("PCAN_USBBUS1".to_string());
        }
    }

    let installed = detected_lib.is_some() || !detected_channels.is_empty();
    let status_label = if installed {
        "Driver Installed".to_string()
    } else {
        "Driver Not Installed".to_string()
    };

    DriverFamilyStatusDto {
        family_id: "pcan".to_string(),
        display_name: "PEAK-System PCAN-Basic / peak_usb".to_string(),
        installed,
        status_label,
        detected_library_or_module: detected_lib,
        searched_paths: searched,
        detected_channels,
        install_hint:
            "Install PEAK-System PCAN-Basic SDK (PCANBasic.dll / libpcanbasic.so / macOS PCBUSB) or load Linux 'sudo modprobe peak_usb'."
                .to_string(),
    }
}

/// Probes Kvaser `CANlib` (`canlib32.dll` / `libcanlib.so`) and Linux `kvaser_usb` / `leaf` / `mhydra`.
pub fn probe_kvaser_family() -> DriverFamilyStatusDto {
    let mut searched = Vec::new();
    let mut detected_lib: Option<String> = None;
    let mut detected_channels = Vec::new();

    if cfg!(target_os = "windows") {
        let candidates = collect_windows_dll_candidates(
            &[
                r"C:\Windows\System32\canlib32.dll",
                r"C:\Windows\SysWOW64\canlib32.dll",
            ],
            "canlib32.dll",
        );
        for p in candidates {
            let s = p.to_string_lossy().to_string();
            if detected_lib.is_none() && p.is_file() {
                detected_lib = Some(s.clone());
            }
            searched.push(s);
        }
        if detected_lib.is_some() {
            detected_channels.push("0".to_string());
            detected_channels.push("1".to_string());
        }
    } else if cfg!(target_os = "macos") {
        for p in [
            "/usr/local/lib/libcanlib.dylib",
            "/opt/homebrew/lib/libcanlib.dylib",
        ] {
            searched.push(p.to_string());
            if detected_lib.is_none() && Path::new(p).exists() {
                detected_lib = Some(p.to_string());
            }
        }
        if detected_lib.is_some() {
            detected_channels.push("0".to_string());
        }
    } else {
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
        for iface in list_linux_socketcan_interfaces(Some(&[
            "kvaser_usb",
            "kvaser_pciefd",
            "leaf",
            "mhydra",
            "kvcommon",
        ])) {
            if !detected_channels.contains(&iface) {
                detected_channels.push(iface);
            }
        }
        if detected_lib.is_some() && detected_channels.is_empty() {
            detected_channels.push("0".to_string());
        }
    }

    let installed = detected_lib.is_some() || !detected_channels.is_empty();
    let status_label = if installed {
        "Driver Installed".to_string()
    } else {
        "Driver Not Installed".to_string()
    };

    DriverFamilyStatusDto {
        family_id: "kvaser".to_string(),
        display_name: "Kvaser CANlib / kvaser_usb".to_string(),
        installed,
        status_label,
        detected_library_or_module: detected_lib,
        searched_paths: searched,
        detected_channels,
        install_hint:
            "Install Kvaser CANlib SDK (canlib32.dll / linuxcan libcanlib.so) or load Linux 'sudo modprobe kvaser_usb'."
                .to_string(),
    }
}

/// Probes `gs_usb` / `candleLight` USB-CAN adapters (`1d50:606f`, `1209:2323`).
pub fn probe_gs_usb_family() -> DriverFamilyStatusDto {
    let mut searched = Vec::new();
    let mut detected_lib: Option<String> = None;
    let mut detected_channels = Vec::new();

    if cfg!(target_os = "linux") {
        let gs_mod = "/sys/module/gs_usb";
        let usb_dir = "/sys/bus/usb/devices";
        searched.push(gs_mod.to_string());
        searched.push(usb_dir.to_string());

        if Path::new(gs_mod).exists() {
            detected_lib = Some(gs_mod.to_string());
        }

        for usb_label in scan_linux_candlelight_usb_devices() {
            if detected_lib.is_none() {
                detected_lib = Some(usb_label.clone());
            }
            detected_channels.push(usb_label);
        }

        for iface in list_linux_socketcan_interfaces(Some(&["gs_usb"])) {
            if !detected_channels.contains(&iface) {
                detected_channels.insert(0, iface);
            }
        }
    } else if cfg!(target_os = "windows") {
        searched.push("WinUSB / Zadig USB (1D50:606F, 1209:2323)".to_string());
    } else {
        searched.push("IOKit / libusb USB (1D50:606F, 1209:2323)".to_string());
    }

    let installed = detected_lib.is_some() || !detected_channels.is_empty();
    let status_label = if installed {
        "Kernel / USB Device Detected".to_string()
    } else if cfg!(target_os = "linux") {
        "Module Not Loaded / No Device".to_string()
    } else {
        "No candleLight USB Detected".to_string()
    };

    DriverFamilyStatusDto {
        family_id: "gs_usb".to_string(),
        display_name: "USB Direct candleLight / gs_usb".to_string(),
        installed,
        status_label,
        detected_library_or_module: detected_lib,
        searched_paths: searched,
        detected_channels,
        install_hint:
            "On Linux run 'sudo modprobe gs_usb' (exposes can0 via SocketCAN); on Windows bind WinUSB with Zadig for 1D50:606F or use SLCAN firmware."
                .to_string(),
    }
}

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

fn list_linux_socketcan_interfaces(driver_filter: Option<&[&str]>) -> Vec<String> {
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

        if let Some(allowed_drivers) = driver_filter {
            let drv_link = iface_path.join("device").join("driver");
            let Ok(canon) = fs::canonicalize(drv_link) else {
                continue;
            };
            let Some(drv_name) = canon.file_name().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            if !allowed_drivers
                .iter()
                .any(|allowed| drv_name.eq_ignore_ascii_case(allowed))
            {
                continue;
            }
        }

        out.push(iface);
    }
    out.sort();
    out
}

fn scan_linux_candlelight_usb_devices() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/sys/bus/usb/devices") else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let vid = fs::read_to_string(p.join("idVendor"))
            .ok()
            .map(|s| s.trim().to_ascii_lowercase());
        let pid = fs::read_to_string(p.join("idProduct"))
            .ok()
            .map(|s| s.trim().to_ascii_lowercase());
        let (Some(v), Some(pr)) = (vid, pid) else {
            continue;
        };
        if CANDLELIGHT_USB_IDS
            .iter()
            .any(|(cv, cp)| v == *cv && pr == *cp)
        {
            let prod = fs::read_to_string(p.join("product"))
                .ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| "candleLight USB-CAN".to_string());
            out.push(format!(
                "usb:{}:{} ({prod})",
                v.to_ascii_uppercase(),
                pr.to_ascii_uppercase()
            ));
        }
    }
    out.sort();
    out
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
            return Err(AdapterError::Driver(format!(
                "PEAK PCAN-Basic driver is not installed on this host (checked: {}). Install PEAK PCAN-Basic SDK or Linux peak_usb driver.",
                status.searched_paths.join(", ")
            )));
        }

        Err(AdapterError::DeviceNotFound(format!(
            "PEAK PCAN driver is installed ({}), but hardware channel '{requested_ch}' is not attached or active",
            status
                .detected_library_or_module
                .as_deref()
                .unwrap_or("PCAN-Basic")
        )))
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

        if !status.installed {
            return Err(AdapterError::Driver(format!(
                "Kvaser CANlib driver is not installed on this host (checked: {}). Install Kvaser CANlib SDK / Linux SocketCAN kvaser_usb.",
                status.searched_paths.join(", ")
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

/// `gs_usb` / `candleLight` USB-CAN adapter router.
#[derive(Clone, Copy, Debug, Default)]
pub struct GsUsbDriver;

impl GsUsbDriver {
    /// Creates a new [`GsUsbDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Builds a [`DeviceDescriptor`] for a `gs_usb` / `candleLight` channel.
    pub fn descriptor_for_channel(channel: &str) -> DeviceDescriptor {
        let ch = if channel.trim().is_empty() {
            "0"
        } else {
            channel.trim()
        };
        DeviceDescriptorDto {
            device_id: format!("gs_usb:{ch}"),
            driver_id: "gs_usb".to_string(),
            channel_name: ch.to_string(),
            display_name: format!("{ch} — USB Direct candleLight / gs_usb"),
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

impl AdapterDriver for GsUsbDriver {
    fn driver_id(&self) -> &'static str {
        "gs_usb"
    }

    fn display_name(&self) -> &'static str {
        "USB Direct candleLight / gs_usb"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let status = probe_gs_usb_family();
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

        let status = probe_gs_usb_family();

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

        Err(AdapterError::Driver(format!(
            "gs_usb / candleLight device '{requested_ch}' is not ready on this host (checked: {}). {}",
            status.searched_paths.join(", "),
            status.install_hint
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
