//! Cross-OS Lawicel `SLCAN` (Serial / USB-CDC) CAN 2.0 & CAN-FD adapter driver.
//!
//! Built on `serialport` (`default-features = false` for zero `libudev` C-header dependency on Linux/WSL2)
//! while maintaining `#![forbid(unsafe_code)]` and zero heap allocations on hot-path `recv_batch` / `send_frame`.

use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto, SerialPortInfoDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use nexus_core::{
    now_monotonic_us, BusId, CanIdKey, RawCanFrame, EXT_CAN_ID_MASK, MAX_CAN_FD_DLC,
    MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
};
use serialport::{ClearBuffer, SerialPort, SerialPortType};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::time::Duration;

/// Maximum encoded ASCII length of a 64-byte CAN-FD Lawicel frame (`B` + 8 ID + 1 DLC + 128 hex + `\r` = 139B).
pub const MAX_SLCAN_ASCII_LEN: usize = 148;

const CAN_FD_DLC_LEN_TABLE: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
const INTERNAL_QUEUE_CAP: usize = 64;

/// Maps nominal CAN bitrate (bps) to standard Lawicel `S0`..`S8` setup command.
#[inline]
pub const fn slcan_bitrate_command(bitrate: u32) -> &'static [u8] {
    match bitrate {
        0..=10_000 => b"S0\r",
        10_001..=20_000 => b"S1\r",
        20_001..=50_000 => b"S2\r",
        50_001..=100_000 => b"S3\r",
        100_001..=125_000 => b"S4\r",
        125_001..=250_000 => b"S5\r",
        250_001..=500_000 => b"S6\r",
        500_001..=800_000 => b"S7\r",
        _ => b"S8\r",
    }
}

/// Maps CAN-FD data phase bitrate (bps) to CANable 2.0 / candleLight-SLCAN `Y2`..`Y8` command.
#[inline]
pub const fn slcan_fd_data_bitrate_command(data_bitrate: u32) -> &'static [u8] {
    match data_bitrate {
        0..=2_000_000 => b"Y2\r",
        2_000_001..=4_000_000 => b"Y4\r",
        4_000_001..=5_000_000 => b"Y5\r",
        _ => b"Y8\r",
    }
}

/// Builds the exact Lawicel ASCII initialization command sequence for channel startup.
///
/// Enforces `L\r` when `listen_only == true` (passive silent monitoring) and `O\r` otherwise.
pub fn slcan_init_sequence(
    bitrate: u32,
    data_bitrate: u32,
    enable_fd: bool,
    listen_only: bool,
) -> Vec<&'static [u8]> {
    let mut seq = Vec::with_capacity(4);
    seq.push(b"C\r".as_slice());
    seq.push(slcan_bitrate_command(bitrate));
    if enable_fd {
        seq.push(slcan_fd_data_bitrate_command(data_bitrate));
    }
    if listen_only {
        seq.push(b"L\r".as_slice());
    } else {
        seq.push(b"O\r".as_slice());
    }
    seq
}

#[inline]
const fn decode_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[inline]
fn parse_hex_u32(slice: &[u8]) -> Option<u32> {
    if slice.is_empty() || slice.len() > 8 {
        return None;
    }
    let mut val = 0u32;
    for &b in slice {
        let nib = decode_hex_nibble(b)?;
        val = (val << 4) | u32::from(nib);
    }
    Some(val)
}

#[inline]
fn fd_len_to_dlc_code(payload_len: usize) -> (u8, usize) {
    for (code, &fd_len) in CAN_FD_DLC_LEN_TABLE.iter().enumerate() {
        let len_usize = usize::from(fd_len);
        if payload_len <= len_usize {
            return (code as u8, len_usize);
        }
    }
    (15, MAX_CAN_FD_DLC)
}

/// Zero-allocation parser for a single Lawicel SLCAN ASCII line (without trailing `\r`/`\n`).
///
/// Supports:
/// - `tIIILDD..` (11-bit Classical CAN data)
/// - `TIIIIIIIIILDD..` (`T` + 8-hex 29-bit Extended CAN data)
/// - `rIIIL` / `RIIIIIIIIIL` (11-bit / 29-bit RTR frames)
/// - `d`/`D` (11-bit / 29-bit CAN-FD data without BRS)
/// - `b`/`B` (11-bit / 29-bit CAN-FD data with BRS)
pub fn parse_slcan_line(mut line: &[u8], bus_id: BusId, timestamp_us: u64) -> Option<RawCanFrame> {
    while let Some(&last) = line.last() {
        if last == b'\r' || last == b'\n' || last == b' ' {
            line = &line[..line.len() - 1];
        } else {
            break;
        }
    }
    let (&cmd, rest) = line.split_first()?;

    let (is_extended, is_rtr, is_fd, is_brs) = match cmd {
        b't' => (false, false, false, false),
        b'T' => (true, false, false, false),
        b'r' => (false, true, false, false),
        b'R' => (true, true, false, false),
        b'd' => (false, false, true, false),
        b'D' => (true, false, true, false),
        b'b' => (false, false, true, true),
        b'B' => (true, false, true, true),
        _ => return None,
    };

    let id_chars = if is_extended { 8 } else { 3 };
    if rest.len() < id_chars + 1 {
        return None;
    }

    let raw_id = parse_hex_u32(&rest[..id_chars])?;
    let arb_id = if is_extended {
        if raw_id > EXT_CAN_ID_MASK {
            return None;
        }
        raw_id & EXT_CAN_ID_MASK
    } else {
        if raw_id > STD_CAN_ID_MASK {
            return None;
        }
        raw_id & STD_CAN_ID_MASK
    };

    let dlc_nibble = decode_hex_nibble(rest[id_chars])?;
    let payload_hex = &rest[id_chars + 1..];

    let payload_len: usize = if is_fd {
        usize::from(*CAN_FD_DLC_LEN_TABLE.get(usize::from(dlc_nibble))?)
    } else {
        if usize::from(dlc_nibble) > MAX_CLASSICAL_CAN_DLC {
            return None;
        }
        usize::from(dlc_nibble)
    };

    let mut data = [0u8; MAX_CAN_FD_DLC];
    if !is_rtr {
        let needed_hex = payload_len * 2;
        // Allow optional 4-hex-digit Lawicel millisecond timestamp suffix (`ZZZZ`), reject truncated lines.
        if payload_hex.len() != needed_hex && payload_hex.len() != needed_hex + 4 {
            return None;
        }
        for i in 0..payload_len {
            let hi = decode_hex_nibble(payload_hex[i * 2])?;
            let lo = decode_hex_nibble(payload_hex[i * 2 + 1])?;
            data[i] = (hi << 4) | lo;
        }
    }

    let id_key = if is_extended {
        CanIdKey::Extended(arb_id)
    } else {
        CanIdKey::Standard(arb_id as u16)
    };

    if is_rtr {
        RawCanFrame::new_rtr(bus_id, id_key, payload_len as u8, timestamp_us).ok()
    } else if is_fd {
        RawCanFrame::new_fd(bus_id, id_key, &data[..payload_len], is_brs, timestamp_us).ok()
    } else {
        RawCanFrame::new_classical(bus_id, id_key, &data[..payload_len], timestamp_us).ok()
    }
}

/// Zero-allocation formatter encoding a [`RawCanFrame`] into a Lawicel SLCAN ASCII command terminated by `\r`.
pub fn encode_slcan_frame(
    frame: &RawCanFrame,
    out_buf: &mut [u8; MAX_SLCAN_ASCII_LEN],
) -> Result<usize, AdapterError> {
    let payload_len = usize::from(frame.dlc);
    if !frame.is_fd() && payload_len > MAX_CLASSICAL_CAN_DLC {
        return Err(AdapterError::UnsupportedCapability(format!(
            "Classical SLCAN frame length {} exceeds 8 bytes",
            payload_len
        )));
    }
    if payload_len > MAX_CAN_FD_DLC {
        return Err(AdapterError::UnsupportedCapability(format!(
            "CAN-FD SLCAN frame length {} exceeds 64 bytes",
            payload_len
        )));
    }

    let mut pos = 0usize;
    let cmd = if frame.is_fd() {
        match (frame.is_extended(), frame.is_brs()) {
            (false, false) => b'd',
            (true, false) => b'D',
            (false, true) => b'b',
            (true, true) => b'B',
        }
    } else if frame.is_rtr() {
        if frame.is_extended() {
            b'R'
        } else {
            b'r'
        }
    } else if frame.is_extended() {
        b'T'
    } else {
        b't'
    };
    out_buf[pos] = cmd;
    pos += 1;

    if frame.is_extended() {
        let id = frame.arb_id & EXT_CAN_ID_MASK;
        for shift in (0..8).rev() {
            let nib = ((id >> (shift * 4)) & 0xF) as usize;
            out_buf[pos] = HEX_UPPER[nib];
            pos += 1;
        }
    } else {
        let id = frame.arb_id & STD_CAN_ID_MASK;
        for shift in (0..3).rev() {
            let nib = ((id >> (shift * 4)) & 0xF) as usize;
            out_buf[pos] = HEX_UPPER[nib];
            pos += 1;
        }
    }

    let (dlc_code, wire_len) = if frame.is_fd() {
        fd_len_to_dlc_code(payload_len)
    } else {
        (frame.dlc, payload_len)
    };
    out_buf[pos] = HEX_UPPER[usize::from(dlc_code & 0xF)];
    pos += 1;

    if !frame.is_rtr() {
        for i in 0..wire_len {
            let b = if i < payload_len { frame.data[i] } else { 0 };
            out_buf[pos] = HEX_UPPER[usize::from(b >> 4)];
            out_buf[pos + 1] = HEX_UPPER[usize::from(b & 0xF)];
            pos += 2;
        }
    }

    out_buf[pos] = b'\r';
    pos += 1;
    Ok(pos)
}

/// HIGH-01: canonical USB-serial / COM port names accepted for SLCAN even when the OS
/// enumeration does not list them (yet): `/dev/ttyUSB<n>`, `/dev/ttyACM<n>`,
/// `/dev/serial/by-id/<name>`, macOS `/dev/cu.<name>` / `/dev/tty.usb<name>`, Windows
/// `COM<n>` (optionally `\\.\COM<n>`). Anything else (`/dev/mem`, `/dev/sda`, files,
/// `..` traversal, nested paths) is rejected.
pub fn is_canonical_serial_port_name(name: &str) -> bool {
    fn digits(s: &str) -> bool {
        !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit())
    }
    fn simple_component(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 200
            && s != "."
            && s != ".."
            && !s.contains("..")
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'+'))
    }
    if let Some(n) = name.strip_prefix("/dev/ttyUSB").or_else(|| name.strip_prefix("/dev/ttyACM")) {
        return digits(n);
    }
    if let Some(rest) = name.strip_prefix("/dev/serial/by-id/") {
        return simple_component(rest);
    }
    if let Some(rest) = name.strip_prefix("/dev/cu.") {
        return simple_component(rest);
    }
    if let Some(rest) = name.strip_prefix("/dev/tty.usb") {
        return rest.is_empty() || simple_component(rest);
    }
    let win = name.strip_prefix(r"\\.\").unwrap_or(name);
    if win.len() > 3 && win[..3].eq_ignore_ascii_case("COM") {
        return digits(&win[3..]);
    }
    false
}

/// HIGH-01: only ports enumerated by the OS (`serialport::available_ports()` / our sysfs
/// scan) or canonical USB-serial / COM names may be opened as SLCAN adapters.
fn validate_slcan_port(port: &str) -> Result<(), AdapterError> {
    if is_canonical_serial_port_name(port) {
        return Ok(());
    }
    let listed = serialport::available_ports()
        .map(|ports| ports.iter().any(|p| p.port_name == port))
        .unwrap_or(false)
        || discover_serial_ports().iter().any(|p| p.port_name == port);
    if listed {
        return Ok(());
    }
    Err(AdapterError::Driver(format!(
        "Refusing to open '{port}' as an SLCAN adapter: not an enumerated serial port and not a \
         canonical USB-serial name (/dev/ttyUSB*, /dev/ttyACM*, /dev/serial/by-id/*, /dev/cu.*, \
         /dev/tty.usb*, COMn)"
    )))
}

/// Enumerates host serial / USB-CDC ports across Windows, macOS, and Linux (enriching sysfs USB metadata without `libudev`).
pub fn discover_serial_ports() -> Vec<SerialPortInfoDto> {
    let mut by_name: BTreeMap<String, SerialPortInfoDto> = BTreeMap::new();

    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            #[cfg(target_os = "linux")]
            if is_unpopulated_linux_8250_port(&p.port_name) {
                continue;
            }

            // `mut` is only used by the Linux sysfs enrichment below.
            #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
            let mut info = match p.port_type {
                SerialPortType::UsbPort(usb) => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "USB-CDC".to_string(),
                    vid_pid: Some(format!("{:04X}:{:04X}", usb.vid, usb.pid)),
                    manufacturer: usb.manufacturer,
                    product: usb.product,
                },
                SerialPortType::PciPort => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "PCI-UART".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                },
                SerialPortType::BluetoothPort => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "Bluetooth".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                },
                SerialPortType::Unknown => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "Serial".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                },
            };

            #[cfg(target_os = "linux")]
            enrich_linux_sysfs_usb_metadata(&mut info);

            by_name.insert(p.port_name, info);
        }
    }

    #[cfg(target_os = "linux")]
    scan_linux_tty_devices(&mut by_name);

    by_name.into_values().collect()
}

#[cfg(target_os = "linux")]
fn is_unpopulated_linux_8250_port(port_name: &str) -> bool {
    let Some(tty_name) = port_name.strip_prefix("/dev/") else {
        return false;
    };
    if !tty_name.starts_with("ttyS") {
        return false;
    }
    let sys_type = std::path::Path::new("/sys/class/tty")
        .join(tty_name)
        .join("type");
    match std::fs::read_to_string(sys_type) {
        Ok(s) => s.trim() == "0",
        Err(_) => true,
    }
}

#[cfg(target_os = "linux")]
fn enrich_linux_sysfs_usb_metadata(info: &mut SerialPortInfoDto) {
    let tty_name = info
        .port_name
        .strip_prefix("/dev/")
        .unwrap_or(info.port_name.as_str());
    if tty_name.starts_with("ttyUSB") || tty_name.starts_with("ttyACM") {
        info.port_type = "USB-CDC".to_string();
    }

    let dev_link = std::path::Path::new("/sys/class/tty")
        .join(tty_name)
        .join("device");
    let Ok(canon) = std::fs::canonicalize(dev_link) else {
        return;
    };

    let mut cur: Option<&std::path::Path> = Some(canon.as_path());
    for _ in 0..4 {
        let Some(dir) = cur else { break };
        let vid = std::fs::read_to_string(dir.join("idVendor"))
            .ok()
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty());
        let pid = std::fs::read_to_string(dir.join("idProduct"))
            .ok()
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty());
        if let (Some(v), Some(p)) = (vid, pid) {
            info.port_type = "USB-CDC".to_string();
            if info.vid_pid.is_none() {
                info.vid_pid = Some(format!("{v}:{p}"));
            }
            if info.manufacturer.is_none() {
                info.manufacturer = std::fs::read_to_string(dir.join("manufacturer"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
            if info.product.is_none() {
                info.product = std::fs::read_to_string(dir.join("product"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
            break;
        }
        cur = dir.parent();
    }
}

#[cfg(target_os = "linux")]
fn scan_linux_tty_devices(by_name: &mut BTreeMap<String, SerialPortInfoDto>) {
    if let Ok(entries) = std::fs::read_dir("/dev") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("ttyUSB") || name.starts_with("ttyACM") {
                let full_path = format!("/dev/{name}");
                by_name.entry(full_path.clone()).or_insert_with(|| {
                    let mut info = SerialPortInfoDto {
                        port_name: full_path,
                        port_type: "USB-CDC".to_string(),
                        vid_pid: None,
                        manufacturer: None,
                        product: None,
                    };
                    enrich_linux_sysfs_usb_metadata(&mut info);
                    info
                });
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir("/sys/class/tty") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("ttyUSB") || name.starts_with("ttyACM")) {
                continue;
            }
            if !entry.path().join("device").exists() {
                continue;
            }
            let full_path = format!("/dev/{name}");
            by_name.entry(full_path.clone()).or_insert_with(|| {
                let mut info = SerialPortInfoDto {
                    port_name: full_path,
                    port_type: "USB-CDC".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                };
                enrich_linux_sysfs_usb_metadata(&mut info);
                info
            });
        }
    }
}

/// Cross-OS Lawicel `SLCAN` driver (`CAN232`, `USBtin`, `CANable` SLCAN firmware, STM32 USB-CDC).
#[derive(Clone, Copy, Debug, Default)]
pub struct SlcanDriver;

impl SlcanDriver {
    /// Creates a new [`SlcanDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Constructs a [`DeviceDescriptor`] for an arbitrary (discovered or manually entered) serial port.
    pub fn descriptor_for_port(port_name: &str) -> DeviceDescriptor {
        let trimmed = port_name.trim();
        DeviceDescriptorDto {
            device_id: format!("slcan:{trimmed}"),
            driver_id: "slcan".to_string(),
            channel_name: trimmed.to_string(),
            display_name: format!("{trimmed} — Serial / USB-CDC Lawicel SLCAN"),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: false,
                max_bitrate: 1_000_000,
                is_virtual: false,
            },
        }
    }
}

impl AdapterDriver for SlcanDriver {
    fn driver_id(&self) -> &'static str {
        "slcan"
    }

    fn display_name(&self) -> &'static str {
        "Serial / USB-CDC Lawicel SLCAN"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let ports = discover_serial_ports();
        let mut out = Vec::with_capacity(ports.len());
        for p in ports {
            let label_suffix = match (&p.product, &p.vid_pid) {
                (Some(prod), Some(vp)) => format!("SLCAN {prod} ({vp})"),
                (Some(prod), None) => format!("SLCAN {prod}"),
                (None, Some(vp)) => format!("SLCAN USB-CDC ({vp})"),
                (None, None) => format!("Lawicel SLCAN ({})", p.port_type),
            };
            out.push(DeviceDescriptorDto {
                device_id: format!("slcan:{}", p.port_name),
                driver_id: "slcan".to_string(),
                channel_name: p.port_name.clone(),
                display_name: format!("{} — {label_suffix}", p.port_name),
                capabilities: AdapterCapabilitiesDto {
                    supports_fd: true,
                    supports_listen_only: true,
                    supports_hw_timestamps: false,
                    max_bitrate: 1_000_000,
                    is_virtual: false,
                },
            });
        }
        Ok(out)
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let resolved_port = config
            .serial_port
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let ch = device.channel_name.trim();
                if !ch.is_empty() {
                    Some(ch)
                } else {
                    device.device_id.strip_prefix("slcan:").map(str::trim)
                }
            })
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AdapterError::Driver(
                    "SLCAN serial port is required (e.g. COM3, /dev/ttyUSB0, or /dev/ttyACM0)"
                        .to_string(),
                )
            })?
            .to_string();

        validate_slcan_port(&resolved_port)?;

        let baud_rate = config.serial_baud_rate.unwrap_or(1_000_000).max(9_600);
        let assert_dtr_rts = config.serial_dtr_rts.unwrap_or(true);

        let mut port = serialport::new(&resolved_port, baud_rate)
            .timeout(Duration::from_millis(5))
            .open()
            .map_err(|e| {
                AdapterError::Driver(format!(
                    "Failed to open SLCAN serial port '{resolved_port}' at {baud_rate} baud: {e}"
                ))
            })?;

        let _ = port.write_data_terminal_ready(assert_dtr_rts);
        let _ = port.write_request_to_send(assert_dtr_rts);
        let _ = port.clear(ClearBuffer::All);

        for cmd in slcan_init_sequence(
            config.bitrate,
            config.data_bitrate,
            config.enable_fd,
            config.listen_only,
        ) {
            port.write_all(cmd).map_err(|e| {
                AdapterError::Driver(format!(
                    "Failed writing Lawicel init command to '{resolved_port}': {e}"
                ))
            })?;
        }
        let _ = port.flush();

        let mut actual_desc = device.clone();
        if actual_desc.channel_name != resolved_port {
            actual_desc = Self::descriptor_for_port(&resolved_port);
        }

        Ok(Box::new(SlcanChannel {
            descriptor: actual_desc,
            bus_id: config.bus_id,
            listen_only: config.listen_only,
            closed: false,
            port: Some(port),
            current_timeout_ms: 5,
            rx_chunk: [0u8; 512],
            line_buf: [0u8; 256],
            line_len: 0,
            queued: [RawCanFrame::zeroed(); INTERNAL_QUEUE_CAP],
            queued_head: 0,
            queued_len: 0,
            filters: Vec::new(),
            tx_errors: 0,
            rx_errors: 0,
        }))
    }
}

/// Zero-allocation hot-path Lawicel SLCAN channel.
pub struct SlcanChannel {
    descriptor: DeviceDescriptor,
    bus_id: BusId,
    listen_only: bool,
    closed: bool,
    port: Option<Box<dyn SerialPort>>,
    current_timeout_ms: u32,
    rx_chunk: [u8; 512],
    line_buf: [u8; 256],
    line_len: usize,
    queued: [RawCanFrame; INTERNAL_QUEUE_CAP],
    queued_head: usize,
    queued_len: usize,
    filters: Vec<CanFilter>,
    tx_errors: u32,
    rx_errors: u32,
}

impl SlcanChannel {
    #[inline]
    fn matches_filters(&self, frame: &RawCanFrame) -> bool {
        if self.filters.is_empty() {
            return true;
        }
        self.filters.iter().any(|f| {
            let ext_ok = match f.extended {
                Some(ext) => frame.is_extended() == ext,
                None => true,
            };
            ext_ok && ((frame.arb_id & f.mask) == (f.id & f.mask))
        })
    }

    #[inline]
    fn push_queued(&mut self, frame: RawCanFrame) {
        if self.queued_len < INTERNAL_QUEUE_CAP {
            let idx = (self.queued_head + self.queued_len) % INTERNAL_QUEUE_CAP;
            self.queued[idx] = frame;
            self.queued_len += 1;
        } else {
            self.rx_errors = self.rx_errors.saturating_add(1);
        }
    }

    #[inline]
    fn pop_queued(&mut self) -> Option<RawCanFrame> {
        if self.queued_len == 0 {
            return None;
        }
        let f = self.queued[self.queued_head];
        self.queued_head = (self.queued_head + 1) % INTERNAL_QUEUE_CAP;
        self.queued_len -= 1;
        Some(f)
    }
}

impl CanChannel for SlcanChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.closed = true;
        if let Some(mut port) = self.port.take() {
            let _ = port.write_all(b"C\r");
            let _ = port.flush();
        }
        Ok(())
    }

    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }

        let mut written = 0usize;
        while written < out_batch.len() {
            let Some(frame) = self.pop_queued() else {
                break;
            };
            out_batch[written] = frame;
            written += 1;
        }
        if written == out_batch.len() {
            return Ok(written);
        }

        let clamped_timeout = timeout_ms.clamp(1, 10);
        if clamped_timeout != self.current_timeout_ms {
            if let Some(port) = self.port.as_mut() {
                let _ = port.set_timeout(Duration::from_millis(u64::from(clamped_timeout)));
                self.current_timeout_ms = clamped_timeout;
            }
        }

        let n_read = {
            let port = self.port.as_mut().ok_or(AdapterError::ChannelClosed)?;
            match port.read(&mut self.rx_chunk) {
                Ok(n) => n,
                Err(e)
                    if e.kind() == io::ErrorKind::TimedOut
                        || e.kind() == io::ErrorKind::WouldBlock =>
                {
                    0
                }
                Err(e) => return Err(AdapterError::Io(e)),
            }
        };

        if n_read == 0 {
            return Ok(written);
        }

        let ts_us = now_monotonic_us().max(1);
        for i in 0..n_read {
            let byte = self.rx_chunk[i];
            match byte {
                b'\r' | b'\n' => {
                    if self.line_len > 0 {
                        let parsed =
                            parse_slcan_line(&self.line_buf[..self.line_len], self.bus_id, ts_us);
                        self.line_len = 0;
                        match parsed {
                            Some(frame) => {
                                if self.matches_filters(&frame) {
                                    if written < out_batch.len() {
                                        out_batch[written] = frame;
                                        written += 1;
                                    } else {
                                        self.push_queued(frame);
                                    }
                                }
                            }
                            None => {
                                self.rx_errors = self.rx_errors.saturating_add(1);
                            }
                        }
                    }
                }
                b'\x07' => {
                    // Lawicel BELL (NACK)
                    self.line_len = 0;
                    self.tx_errors = self.tx_errors.saturating_add(1);
                }
                _ => {
                    if self.line_len < self.line_buf.len() {
                        self.line_buf[self.line_len] = byte;
                        self.line_len += 1;
                    } else {
                        // Malformed oversized line: discard without allocating.
                        self.line_len = 0;
                        self.rx_errors = self.rx_errors.saturating_add(1);
                    }
                }
            }
        }

        Ok(written)
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }

        let mut wire_buf = [0u8; MAX_SLCAN_ASCII_LEN];
        let encoded_len = encode_slcan_frame(frame, &mut wire_buf)?;

        let port = self.port.as_mut().ok_or(AdapterError::ChannelClosed)?;
        if let Err(e) = port.write_all(&wire_buf[..encoded_len]) {
            self.tx_errors = self.tx_errors.saturating_add(1);
            return Err(AdapterError::Io(e));
        }
        Ok(())
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        self.filters.clear();
        self.filters.extend_from_slice(filters);
        Ok(())
    }

    /// Listen-Only channels are opened with the Lawicel `L` command (adapter-side silent mode).
    /// An adapter that NACKs `L` never opens its CAN channel, so it cannot ACK either.
    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        ListenOnlyEnforcement::Hardware
    }

    fn health(&self) -> BusHealthSnapshot {
        let state = if self.closed {
            BusState::Disconnected
        } else if self.tx_errors >= 128 || self.rx_errors >= 128 {
            BusState::Passive
        } else if self.tx_errors >= 32 || self.rx_errors >= 32 {
            BusState::Warning
        } else {
            BusState::Active
        };
        BusHealthSnapshot {
            state,
            tx_error_count: self.tx_errors,
            rx_error_count: self.rx_errors,
        }
    }
}

impl Drop for SlcanChannel {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_serial_port_names_allowlist() {
        for ok in [
            "/dev/ttyUSB0",
            "/dev/ttyACM12",
            "/dev/serial/by-id/usb-CANable_2.0_ABC123-if00",
            "/dev/cu.usbmodem14101",
            "/dev/tty.usbserial-A1B2",
            "COM3",
            "com17",
            r"\\.\COM12",
        ] {
            assert!(is_canonical_serial_port_name(ok), "{ok} must be accepted");
        }
        for bad in [
            "",
            "/dev/mem",
            "/dev/sda",
            "/dev/ttyS0",
            "/dev/ttyUSB",
            "/dev/ttyUSB0/../../mem",
            "/dev/serial/by-id/../../sda",
            "/dev/serial/by-id/a/b",
            "/dev/cu.",
            "/etc/passwd",
            "COM",
            "COM1;rm",
            "CON",
            "../COM3",
        ] {
            assert!(!is_canonical_serial_port_name(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn open_rejects_non_serial_device_paths() {
        let drv = SlcanDriver::new();
        let desc = SlcanDriver::descriptor_for_port("/dev/mem");
        let cfg = ChannelConfig {
            serial_port: Some("/dev/mem".to_string()),
            ..ChannelConfig::default()
        };
        let err = drv.open_channel(&desc, &cfg).err().expect("must refuse /dev/mem");
        assert!(err.to_string().contains("Refusing to open '/dev/mem'"), "{err}");
    }
}
