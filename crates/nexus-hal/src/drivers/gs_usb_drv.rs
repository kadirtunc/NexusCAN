//! Pure-Rust Cross-OS (`Linux` usbfs, `Windows` WinUSB, `macOS` IOKit) `gs_usb` / `candleLight`
//! CAN 2.0 & ISO 11898-1 CAN-FD USB driver built on `nusb`.
//!
//! ### Architectural Guarantees
//! - **`#![forbid(unsafe_code)]`**: Zero C dependencies (`libusb` not required) and zero `unsafe` blocks.
//! - **Zero Heap Allocations on Hot Path**: Bulk IN recycles pre-allocated `RequestBuffer`s via
//!   `RequestBuffer::reuse`; Bulk OUT recycles a fixed pool of pre-allocated 80-byte buffers via
//!   `ResponseBuffer::reuse`; frames travel through a bounded `RawCanFrame` (80-byte `Copy`) ring.
//! - **Hardware Safety (`Listen-Only` Default)**: Hardware `GS_CAN_MODE_LISTEN_ONLY` is enforced in
//!   the CAN controller silicon when `config.listen_only == true`, and `send_frame` immediately
//!   rejects transmissions with [`AdapterError::ListenOnlyMode`].
//! - **Fast Deterministic Shutdown (`< 25 ms`)**: Custom Waker-backed `ShutdownSignal` wakes the
//!   cancel-safe `Queue::next_complete()` future in `< 1 ms`, cancels pending URBs, and resets the
//!   adapter channel (`GS_CAN_MODE_RESET`).

use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use crossbeam_channel::{bounded, Receiver, TrySendError};
use futures_lite::future::{block_on, or, poll_once};
use nexus_core::{
    dlc_code_to_len, len_to_canfd_dlc_code, now_monotonic_us, BusId, RawCanFrame, EXT_CAN_ID_MASK,
    FLAG_BRS, FLAG_ERROR, FLAG_ESI, FLAG_EXTENDED, FLAG_FD, FLAG_HW_TIMESTAMP, FLAG_RTR,
    MAX_CAN_FD_DLC, MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
};
use nusb::transfer::{
    Control, ControlType, Direction, EndpointType, Queue, Recipient, RequestBuffer, ResponseBuffer,
    TransferError,
};
use nusb::{Device, DeviceId, DeviceInfo, Interface};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::future::Future;
use std::io::ErrorKind;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::task::{Context, Poll, Waker};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[cfg(target_os = "linux")]
use crate::drivers::socketcan_drv::SocketCanDriver;

/// Supported `gs_usb` / `candleLight` USB `(VID, PID, VendorName, ProductName)` tuples.
pub const CANDLELIGHT_USB_IDS: &[(u16, u16, &str, &str)] = &[
    (
        0x1D50,
        0x606F,
        "OpenMoko / Geschwister Schneider",
        "candleLight / CANable / gs_usb",
    ),
    (0x1209, 0x2323, "Linklayer Labs", "CANtact (gs_usb)"),
    (0x16D0, 0x0F67, "MCS / Microchip", "gs_usb CAN Interface"),
    (0x1CD2, 0x606F, "Symetric", "candleLight FD"),
    (
        0x1D50,
        0x6070,
        "OpenMoko",
        "gs_usb Multi-Channel CAN Interface",
    ),
];

/// STM32 ROM DFU Bootloader `(VID, PID)` — detected when a CANable / candleLight board has `BOOT0` shorted
/// or lacks application firmware (must NOT be opened as `gs_usb`).
pub const STM32_DFU_USB_ID: (u16, u16) = (0x0483, 0xDF11);

// =============================================================================
// Mainline Linux `drivers/net/can/usb/gs_usb.c` Protocol Constants
// =============================================================================

/// Negotiates little-endian host frame byte order (`0x0000BEEF` -> `[0xEF, 0xBE, 0x00, 0x00]`).
pub const GS_USB_BREQ_HOST_FORMAT: u8 = 0;
/// Configures nominal (arbitration-phase) bit timing (`struct gs_device_bittiming`, 20 bytes LE).
pub const GS_USB_BREQ_BITTIMING: u8 = 1;
/// Starts or resets a CAN channel (`struct gs_device_mode`, 8 bytes LE).
pub const GS_USB_BREQ_MODE: u8 = 2;
/// Reads bus error counters (optional).
pub const GS_USB_BREQ_BERR: u8 = 3;
/// Queries nominal bit-timing capabilities & feature bitmask (`struct gs_device_bt_const`, 40 bytes LE).
pub const GS_USB_BREQ_BT_CONST: u8 = 4;
/// Queries channel count (`icount`) and firmware/hardware version (`struct gs_device_config`, 12 bytes LE).
pub const GS_USB_BREQ_DEVICE_CONFIG: u8 = 5;
/// Reads current 32-bit hardware microsecond counter.
pub const GS_USB_BREQ_TIMESTAMP: u8 = 6;
/// Blinks adapter LED to identify physical unit.
pub const GS_USB_BREQ_IDENTIFY: u8 = 7;
/// Configures CAN-FD data-phase bit timing (`struct gs_device_bittiming`, 20 bytes LE).
pub const GS_USB_BREQ_DATA_BITTIMING: u8 = 10;
/// Queries extended CAN-FD data-phase bit-timing limits (`struct gs_device_bt_const_extended`, 72 bytes LE).
pub const GS_USB_BREQ_BT_CONST_EXT: u8 = 11;

/// Resets/stops a `gs_usb` channel (`GS_CAN_MODE_RESET`).
pub const GS_CAN_MODE_RESET: u32 = 0;
/// Starts a `gs_usb` channel (`GS_CAN_MODE_START`).
pub const GS_CAN_MODE_START: u32 = 1;

/// Controller capability: supports hardware Listen-Only mode (`BIT(0)`).
pub const GS_CAN_FEATURE_LISTEN_ONLY: u32 = 1 << 0;
/// Controller capability: supports internal Loopback mode (`BIT(1)`).
pub const GS_CAN_FEATURE_LOOP_BACK: u32 = 1 << 1;
/// Controller capability: appends 32-bit hardware microsecond timestamps to RX frames (`BIT(4)`).
pub const GS_CAN_FEATURE_HW_TIMESTAMP: u32 = 1 << 4;
/// Controller capability: supports ISO 11898-1 CAN-FD 64-byte payloads & BRS (`BIT(8)`).
pub const GS_CAN_FEATURE_FD: u32 = 1 << 8;
/// Controller capability: supports `GS_USB_BREQ_BT_CONST_EXT` (`BIT(10)`).
pub const GS_CAN_FEATURE_BT_CONST_EXT: u32 = 1 << 10;
/// Controller capability: supports bus error reporting frames (`BIT(12)`).
pub const GS_CAN_FEATURE_BERR_REPORTING: u32 = 1 << 12;

/// Mode flag: hardware passive Listen-Only mode (`BIT(0)`).
pub const GS_CAN_MODE_LISTEN_ONLY: u32 = 1 << 0;
/// Mode flag: append 32-bit microsecond hardware timestamp to Bulk IN frames (`BIT(4)`).
pub const GS_CAN_MODE_HW_TIMESTAMP: u32 = 1 << 4;
/// Mode flag: enable ISO 11898-1 CAN-FD operation (`BIT(8)`).
pub const GS_CAN_MODE_FD: u32 = 1 << 8;
/// Mode flag: enable bus error reporting (`BIT(12)`).
pub const GS_CAN_MODE_BERR_REPORTING: u32 = 1 << 12;

/// `gs_host_frame.echo_id` marker indicating a true RX frame received from the CAN bus (`0xFFFF_FFFF`).
pub const GS_USB_ECHO_ID_RX: u32 = 0xFFFF_FFFF;

/// `gs_host_frame.can_id` 29-bit Extended Frame Format flag (`CAN_EFF_FLAG`).
pub const GS_CAN_ID_EFF_FLAG: u32 = 0x8000_0000;
/// `gs_host_frame.can_id` Remote Transmission Request flag (`CAN_RTR_FLAG`).
pub const GS_CAN_ID_RTR_FLAG: u32 = 0x4000_0000;
/// `gs_host_frame.can_id` Bus Error frame flag (`CAN_ERR_FLAG`).
pub const GS_CAN_ID_ERR_FLAG: u32 = 0x2000_0000;

/// `gs_host_frame.flags`: adapter RX FIFO overflowed (`BIT(0)`).
pub const GS_CAN_FLAG_OVERFLOW: u8 = 1 << 0;
/// `gs_host_frame.flags`: ISO 11898-1 CAN-FD frame (`BIT(1)`).
pub const GS_CAN_FLAG_FD: u8 = 1 << 1;
/// `gs_host_frame.flags`: CAN-FD Bit Rate Switch (`BIT(2)`).
pub const GS_CAN_FLAG_BRS: u8 = 1 << 2;
/// `gs_host_frame.flags`: CAN-FD Error State Indicator (`BIT(3)`).
pub const GS_CAN_FLAG_ESI: u8 = 1 << 3;

/// Maximum wire size of a `gs_host_frame` (12B header + 64B CAN-FD payload + 4B HW timestamp = 80 bytes).
pub const GS_MAX_WIRE_FRAME_LEN: usize = 80;

const CONTROL_TIMEOUT: Duration = Duration::from_millis(500);
const RX_RING_CAPACITY: usize = 8_192;
const RX_INFLIGHT_URBS: usize = 8;
const TX_BUFFER_POOL_CAP: usize = 16;
const MAX_MULTI_CHANNELS: usize = 4;

/// Returns `(vendor_name, product_name)` if `(vid, pid)` is a supported `gs_usb` / `candleLight` adapter.
#[inline]
pub fn match_candlelight_usb_id(vid: u16, pid: u16) -> Option<(&'static str, &'static str)> {
    CANDLELIGHT_USB_IDS
        .iter()
        .find(|&&(v, p, _, _)| v == vid && p == pid)
        .map(|&(_, _, vendor, product)| (vendor, product))
}

/// Tracks unique OS-level [`DeviceId`]s (`DevInst` on Windows, `(bus, addr)` on Linux,
/// `registry_entry_id` on macOS) of `gs_usb` interfaces currently open in this NexusCAN process.
///
/// Keying by `DeviceId` (instead of `(bus_number, device_address)`) prevents collisions on Windows
/// where multiple xHCI root hubs report `bus_number == 0` and `device_address == 1`, while still
/// allowing genuine multi-channel single-USB-interface adapters (`1D50:6070`) to share Interface 0!
static ACTIVE_GS_USB_DEVICES: OnceLock<Mutex<HashMap<DeviceId, Weak<SharedGsUsbAdapter>>>> =
    OnceLock::new();

fn active_gs_usb_map() -> &'static Mutex<HashMap<DeviceId, Weak<SharedGsUsbAdapter>>> {
    ACTIVE_GS_USB_DEVICES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns `true` if NexusCAN currently holds an active `GsUsbChannel` on `dev_id`.
pub fn is_gs_usb_device_active_in_process(dev_id: DeviceId) -> bool {
    let mut guard = active_gs_usb_map().lock();
    if let Some(weak) = guard.get(&dev_id) {
        if weak.strong_count() > 0 {
            return true;
        }
        guard.remove(&dev_id);
    }
    false
}

/// Returns a bitmask (`1 << hw_ch`) of channels currently open in NexusCAN on `dev_id`.
pub(crate) fn active_gs_usb_channels_mask(dev_id: DeviceId) -> u8 {
    let mut guard = active_gs_usb_map().lock();
    if let Some(weak) = guard.get(&dev_id) {
        if let Some(shared) = weak.upgrade() {
            let slots = shared.slots.lock();
            let mut mask = 0u8;
            for (idx, slot) in slots.iter().enumerate() {
                if slot.is_some() && idx < 8 {
                    mask |= 1u8 << idx;
                }
            }
            return mask;
        }
        guard.remove(&dev_id);
    }
    0
}

/// Returns `(deterministic_sort_key, human_readable_location)` for a physical USB device across
/// Windows, Linux, and macOS so two identical clone `candleLight` (`1D50:606F`) adapters with
/// duplicate or missing USB serial numbers are always sorted and labeled distinctly.
pub fn usb_device_location_info(dev_info: &DeviceInfo) -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        let bus = dev_info.bus_number();
        let port = dev_info.port_number();
        let addr = dev_info.device_address();
        let inst_upper = dev_info
            .instance_id()
            .to_string_lossy()
            .trim()
            .to_ascii_uppercase();
        let inst_tail = inst_upper
            .rsplit('\\')
            .next()
            .unwrap_or(inst_upper.as_str());
        let short_tail: String = inst_tail.chars().take(18).collect();
        let sort_key = format!("{bus:03}:{port:04}:{addr:03}:{inst_upper}");
        let human_location = if short_tail.is_empty() {
            format!("Bus {bus} Port #{port} Addr {addr}")
        } else {
            format!("Bus {bus} Port #{port} Addr {addr} [{short_tail}]")
        };
        (sort_key, human_location)
    }

    #[cfg(target_os = "linux")]
    {
        let bus = dev_info.bus_number();
        let addr = dev_info.device_address();
        let sysfs_base = dev_info
            .sysfs_path()
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{bus}-{addr}"));
        let sort_key = format!("{bus:03}:{addr:03}:{sysfs_base}");
        let human_location = format!("USB {sysfs_base} (Bus {bus} Addr {addr})");
        (sort_key, human_location)
    }

    #[cfg(target_os = "macos")]
    {
        let loc = dev_info.location_id();
        let bus = dev_info.bus_number();
        let addr = dev_info.device_address();
        let sort_key = format!("{loc:08X}:{bus:03}:{addr:03}");
        let human_location = format!("Loc 0x{loc:08X} (Bus {bus} Addr {addr})");
        (sort_key, human_location)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let bus = dev_info.bus_number();
        let addr = dev_info.device_address();
        (
            format!("{bus:03}:{addr:03}"),
            format!("Bus {bus} Addr {addr}"),
        )
    }
}

/// Returns the hub port number on Windows (`Some(port_number)`), or `None` on platforms where
/// topology is encoded in `sysfs_path` / `location_id`.
#[inline]
pub fn usb_device_port_number(dev_info: &DeviceInfo) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        Some(dev_info.port_number())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dev_info;
        None
    }
}

/// Solved bit-timing parameters for `GS_USB_BREQ_BITTIMING` / `GS_USB_BREQ_DATA_BITTIMING`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GsUsbBitTiming {
    pub prop_seg: u32,
    pub phase_seg1: u32,
    pub phase_seg2: u32,
    pub sjw: u32,
    pub brp: u32,
    pub actual_bitrate: u32,
    pub sample_point_permille: u32,
}

impl GsUsbBitTiming {
    /// Serializes `struct gs_device_bittiming` into its exact 20-byte little-endian USB control payload.
    #[inline]
    pub fn to_le_bytes(self) -> [u8; 20] {
        let mut buf = [0u8; 20];
        buf[0..4].copy_from_slice(&self.prop_seg.to_le_bytes());
        buf[4..8].copy_from_slice(&self.phase_seg1.to_le_bytes());
        buf[8..12].copy_from_slice(&self.phase_seg2.to_le_bytes());
        buf[12..16].copy_from_slice(&self.sjw.to_le_bytes());
        buf[16..20].copy_from_slice(&self.brp.to_le_bytes());
        buf
    }
}

/// Deterministic ISO 11898-1 / CiA 601-3 bit-timing solver for `gs_usb` CAN & CAN-FD controllers
/// (e.g., 48 MHz STM32F042/F072, 80 MHz / 160 MHz / 170 MHz STM32G431, LPC546xx,ATSAME51).
///
/// Target sample points:
/// - `875` permille (`87.5%`) for nominal arbitration phase
/// - `750` permille (`75.0%`) for accelerated CAN-FD data phase
#[allow(clippy::too_many_arguments)]
pub fn compute_gs_usb_bittiming(
    fclk_can: u32,
    bitrate_bps: u32,
    tseg1_min: u32,
    tseg1_max: u32,
    tseg2_min: u32,
    tseg2_max: u32,
    sjw_max: u32,
    brp_min: u32,
    brp_max: u32,
    brp_inc: u32,
    target_sp_permille: u32,
) -> Result<GsUsbBitTiming, AdapterError> {
    if fclk_can == 0 || bitrate_bps == 0 {
        return Err(AdapterError::UnsupportedCapability(format!(
            "Invalid gs_usb clock ({fclk_can} Hz) or target bitrate ({bitrate_bps} bps)"
        )));
    }
    let seg1_lo = tseg1_min.max(1);
    let seg1_hi = tseg1_max.max(seg1_lo);
    let seg2_lo = tseg2_min.max(1);
    let seg2_hi = tseg2_max.max(seg2_lo);
    let brp_lo = brp_min.max(1);
    let brp_hi = brp_max.max(brp_lo);
    let step = brp_inc.max(1);
    let clamped_sp = target_sp_permille.clamp(500, 950);

    let min_tq = 1u64 + u64::from(seg1_lo) + u64::from(seg2_lo);
    let max_tq = 1u64 + u64::from(seg1_hi) + u64::from(seg2_hi);
    let fclk = u64::from(fclk_can);
    let target_rate = u64::from(bitrate_bps);

    // Score tuple: (bitrate_err_ppm, sp_err_basis_points, small_tseg2_penalty, brp)
    let mut best: Option<((u64, u64, u8, u32), GsUsbBitTiming)> = None;

    let mut brp = brp_lo;
    while brp <= brp_hi {
        let denom = target_rate.saturating_mul(u64::from(brp));
        if let Some(ideal_tq) = fclk.saturating_add(denom / 2).checked_div(denom) {
            let tq_start = ideal_tq.saturating_sub(1).max(min_tq);
            let tq_end = ideal_tq.saturating_add(1).min(max_tq);

            for total_tq in tq_start..=tq_end {
                if total_tq < min_tq || total_tq > max_tq {
                    continue;
                }
                let actual_rate = fclk / (u64::from(brp) * total_tq);
                if actual_rate == 0 {
                    continue;
                }
                let rate_diff = actual_rate.abs_diff(target_rate);
                let rate_err_ppm = (rate_diff * 1_000_000) / target_rate;
                // ISO 11898-1 oscillator tolerance safety gate: reject > 2.5% bitrate deviation
                if rate_err_ppm > 25_000 {
                    continue;
                }

                // Ideal (1 + tseg1) = round(total_tq * clamped_sp / 1000)
                let ideal_sync_plus_seg1 = (total_tq * u64::from(clamped_sp) + 500) / 1_000;
                for delta in [0i64, -1, 1, -2, 2] {
                    let sync_seg1_i64 = (ideal_sync_plus_seg1 as i64) + delta;
                    if sync_seg1_i64 < 2 || sync_seg1_i64 >= (total_tq as i64) {
                        continue;
                    }
                    let tseg1 = (sync_seg1_i64 - 1) as u32;
                    let tseg2 = (total_tq as u32) - 1 - tseg1;
                    if tseg1 < seg1_lo || tseg1 > seg1_hi || tseg2 < seg2_lo || tseg2 > seg2_hi {
                        continue;
                    }

                    // 0.01% basis-point precision for sample point comparison
                    let sp_bp = ((10_000u64 * (1 + u64::from(tseg1))) + (total_tq / 2)) / total_tq;
                    let sp_err_bp = sp_bp.abs_diff(u64::from(clamped_sp) * 10);
                    let sp_permille =
                        (((1_000u64 * (1 + u64::from(tseg1))) + (total_tq / 2)) / total_tq) as u32;

                    let prop_seg = (tseg1 / 2).max(1).min(tseg1.saturating_sub(1).max(1));
                    let phase_seg1 = tseg1 - (if tseg1 > 1 { prop_seg } else { 0 });
                    let final_prop = if tseg1 == 1 { 0 } else { prop_seg };
                    let sjw = tseg2.min(sjw_max.max(1)).max(1);
                    let small_tseg2_penalty = u8::from(tseg2 < 2);

                    let candidate = GsUsbBitTiming {
                        prop_seg: final_prop,
                        phase_seg1,
                        phase_seg2: tseg2,
                        sjw,
                        brp,
                        actual_bitrate: actual_rate as u32,
                        sample_point_permille: sp_permille,
                    };
                    let score = (rate_err_ppm, sp_err_bp, small_tseg2_penalty, brp);

                    if best.as_ref().is_none_or(|(b_score, _)| score < *b_score) {
                        best = Some((score, candidate));
                    }
                }
            }
        }

        match brp.checked_add(step) {
            Some(next) if next > brp => brp = next,
            _ => break,
        }
    }

    best.map(|(_, bt)| bt).ok_or_else(|| {
        AdapterError::UnsupportedCapability(format!(
            "Cannot solve valid gs_usb bit-timing for {bitrate_bps} bps from {fclk_can} Hz CAN clock"
        ))
    })
}

///Parsed `struct gs_device_config` (12 bytes LE).
#[derive(Clone, Copy, Debug)]
pub struct GsDeviceConfig {
    pub num_channels: usize,
    pub sw_version: u32,
    pub hw_version: u32,
}

impl GsDeviceConfig {
    pub fn from_le_bytes(buf: &[u8]) -> Option<Self> {
        if buf.len() < 12 {
            return None;
        }
        let icount = usize::from(buf[3]);
        let num_channels = (icount + 1).clamp(1, MAX_MULTI_CHANNELS);
        let sw_version = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let hw_version = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        Some(Self {
            num_channels,
            sw_version,
            hw_version,
        })
    }
}

/// Parsed `struct gs_device_bt_const` (40 bytes LE) + optional extended CAN-FD data limits (72 bytes LE).
#[derive(Clone, Copy, Debug)]
pub struct GsBtCapabilities {
    pub feature: u32,
    pub fclk_can: u32,
    pub tseg1_min: u32,
    pub tseg1_max: u32,
    pub tseg2_min: u32,
    pub tseg2_max: u32,
    pub sjw_max: u32,
    pub brp_min: u32,
    pub brp_max: u32,
    pub brp_inc: u32,
    pub dtseg1_min: u32,
    pub dtseg1_max: u32,
    pub dtseg2_min: u32,
    pub dtseg2_max: u32,
    pub dsjw_max: u32,
    pub dbrp_min: u32,
    pub dbrp_max: u32,
    pub dbrp_inc: u32,
}

impl GsBtCapabilities {
    pub fn from_bt_const_bytes(buf: &[u8]) -> Option<Self> {
        if buf.len() < 40 {
            return None;
        }
        let rd = |off: usize| -> u32 {
            u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
        };
        let tseg1_min = rd(8);
        let tseg1_max = rd(12);
        let tseg2_min = rd(16);
        let tseg2_max = rd(20);
        let sjw_max = rd(24);
        let brp_min = rd(28);
        let brp_max = rd(32);
        let brp_inc = rd(36);
        Some(Self {
            feature: rd(0),
            fclk_can: rd(4),
            tseg1_min,
            tseg1_max,
            tseg2_min,
            tseg2_max,
            sjw_max,
            brp_min,
            brp_max,
            brp_inc,
            dtseg1_min: tseg1_min,
            dtseg1_max: tseg1_max,
            dtseg2_min: tseg2_min,
            dtseg2_max: tseg2_max,
            dsjw_max: sjw_max,
            dbrp_min: brp_min,
            dbrp_max: brp_max,
            dbrp_inc: brp_inc,
        })
    }

    pub fn apply_bt_const_ext_bytes(&mut self, buf: &[u8]) {
        if buf.len() < 72 {
            return;
        }
        let rd = |off: usize| -> u32 {
            u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
        };
        self.dtseg1_min = rd(40).max(1);
        self.dtseg1_max = rd(44).max(self.dtseg1_min);
        self.dtseg2_min = rd(48).max(1);
        self.dtseg2_max = rd(52).max(self.dtseg2_min);
        self.dsjw_max = rd(56).max(1);
        self.dbrp_min = rd(60).max(1);
        self.dbrp_max = rd(64).max(self.dbrp_min);
        self.dbrp_inc = rd(68).max(1);
    }

    #[inline]
    pub const fn supports_fd(&self) -> bool {
        (self.feature & GS_CAN_FEATURE_FD) != 0
    }

    #[inline]
    pub const fn supports_hw_timestamp(&self) -> bool {
        (self.feature & GS_CAN_FEATURE_HW_TIMESTAMP) != 0
    }

    #[inline]
    pub const fn supports_listen_only(&self) -> bool {
        (self.feature & GS_CAN_FEATURE_LISTEN_ONLY) != 0
    }

    #[inline]
    pub const fn has_bt_const_ext(&self) -> bool {
        (self.feature & GS_CAN_FEATURE_BT_CONST_EXT) != 0
    }
}

/// Decoded Bulk IN `gs_host_frame` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GsDecodedPacket {
    /// Genuine CAN / CAN-FD / Error frame received from the bus (`echo_id == 0xFFFF_FFFF`).
    RxFrame {
        channel: u8,
        frame: RawCanFrame,
        overflow: bool,
        raw_hw_ts_us: Option<u32>,
    },
    /// Firmware TX completion echo (`echo_id != 0xFFFF_FFFF`), skipped on RX path to prevent self-duplication.
    TxEcho { channel: u8, echo_id: u32 },
}

/// Zero-allocation encoder packing an 80-byte [`RawCanFrame`] into a `gs_host_frame` stack buffer
/// (`20` bytes for Classical CAN, `76` bytes for ISO 11898-1 CAN-FD).
#[inline]
pub fn encode_gs_host_frame(
    frame: &RawCanFrame,
    hw_channel: u8,
    echo_id: u32,
    out_buf: &mut [u8; GS_MAX_WIRE_FRAME_LEN],
) -> Result<usize, AdapterError> {
    let payload_len = usize::from(frame.dlc);
    if !frame.is_fd() && payload_len > MAX_CLASSICAL_CAN_DLC {
        return Err(AdapterError::UnsupportedCapability(format!(
            "Classical gs_usb frame payload length {payload_len} exceeds 8 bytes"
        )));
    }
    if payload_len > MAX_CAN_FD_DLC {
        return Err(AdapterError::UnsupportedCapability(format!(
            "CAN-FD gs_usb frame payload length {payload_len} exceeds 64 bytes"
        )));
    }

    out_buf.fill(0);
    out_buf[0..4].copy_from_slice(&echo_id.to_le_bytes());

    let mut raw_id = if frame.is_extended() {
        (frame.arb_id & EXT_CAN_ID_MASK) | GS_CAN_ID_EFF_FLAG
    } else if frame.is_error() {
        (frame.arb_id & EXT_CAN_ID_MASK) | GS_CAN_ID_ERR_FLAG
    } else {
        frame.arb_id & STD_CAN_ID_MASK
    };
    if frame.is_rtr() && !frame.is_fd() {
        raw_id |= GS_CAN_ID_RTR_FLAG;
    }
    if frame.is_error() {
        raw_id |= GS_CAN_ID_ERR_FLAG;
    }
    out_buf[4..8].copy_from_slice(&raw_id.to_le_bytes());

    if frame.is_fd() {
        let dlc_code = len_to_canfd_dlc_code(frame.dlc);
        let mut gs_flags = GS_CAN_FLAG_FD;
        if frame.is_brs() {
            gs_flags |= GS_CAN_FLAG_BRS;
        }
        if frame.is_esi() {
            gs_flags |= GS_CAN_FLAG_ESI;
        }
        out_buf[8] = dlc_code;
        out_buf[9] = hw_channel;
        out_buf[10] = gs_flags;
        out_buf[11] = 0;
        out_buf[12..12 + payload_len].copy_from_slice(&frame.data[..payload_len]);
        Ok(76)
    } else {
        out_buf[8] = frame.dlc.min(8);
        out_buf[9] = hw_channel;
        out_buf[10] = 0;
        out_buf[11] = 0;
        if !frame.is_rtr() {
            out_buf[12..12 + payload_len].copy_from_slice(&frame.data[..payload_len]);
        }
        Ok(20)
    }
}

/// Zero-allocation decoder unpacking a `gs_host_frame` USB Bulk IN packet into an 80-byte [`RawCanFrame`].
#[inline]
pub fn decode_gs_host_frame(
    wire: &[u8],
    bus_id: BusId,
    hw_timestamp_enabled: bool,
    fallback_monotonic_us: u64,
) -> Option<GsDecodedPacket> {
    if wire.len() < 20 {
        return None;
    }

    let echo_id = u32::from_le_bytes([wire[0], wire[1], wire[2], wire[3]]);
    let raw_can_id = u32::from_le_bytes([wire[4], wire[5], wire[6], wire[7]]);
    let can_dlc = wire[8];
    let channel = wire[9];
    let gs_flags = wire[10];

    if echo_id != GS_USB_ECHO_ID_RX {
        return Some(GsDecodedPacket::TxEcho { channel, echo_id });
    }

    let is_fd = (gs_flags & GS_CAN_FLAG_FD) != 0;
    if is_fd && wire.len() < 76 {
        return None;
    }

    let is_ext = (raw_can_id & GS_CAN_ID_EFF_FLAG) != 0;
    let is_rtr = !is_fd && (raw_can_id & GS_CAN_ID_RTR_FLAG) != 0;
    let is_err = (raw_can_id & GS_CAN_ID_ERR_FLAG) != 0;

    let arb_id = if is_ext || is_err {
        raw_can_id & EXT_CAN_ID_MASK
    } else {
        raw_can_id & STD_CAN_ID_MASK
    };

    let payload_len = usize::from(dlc_code_to_len(can_dlc & 0x0F, is_fd));

    let raw_hw_ts_us = if is_fd {
        if hw_timestamp_enabled && wire.len() >= 80 {
            Some(u32::from_le_bytes([wire[76], wire[77], wire[78], wire[79]]))
        } else {
            None
        }
    } else if hw_timestamp_enabled && wire.len() >= 24 {
        Some(u32::from_le_bytes([wire[20], wire[21], wire[22], wire[23]]))
    } else {
        None
    };

    let mut frame_flags = 0u8;
    if is_ext {
        frame_flags |= FLAG_EXTENDED;
    }
    if is_rtr {
        frame_flags |= FLAG_RTR;
    }
    if is_fd {
        frame_flags |= FLAG_FD;
        if (gs_flags & GS_CAN_FLAG_BRS) != 0 {
            frame_flags |= FLAG_BRS;
        }
        if (gs_flags & GS_CAN_FLAG_ESI) != 0 {
            frame_flags |= FLAG_ESI;
        }
    }
    if is_err {
        frame_flags |= FLAG_ERROR;
    }

    let timestamp_us = match raw_hw_ts_us {
        Some(ts32) => {
            frame_flags |= FLAG_HW_TIMESTAMP;
            u64::from(ts32).max(1)
        }
        None => fallback_monotonic_us.max(1),
    };

    let mut frame = RawCanFrame::zeroed();
    frame.timestamp_us = timestamp_us;
    frame.arb_id = arb_id;
    frame.bus_id = bus_id;
    frame.dlc = payload_len as u8;
    frame.flags = frame_flags;

    if !is_rtr {
        let max_copy = if is_fd { 64 } else { 8 };
        let copy_len = payload_len.min(max_copy);
        frame.data[..copy_len].copy_from_slice(&wire[12..12 + copy_len]);
    }

    Some(GsDecodedPacket::RxFrame {
        channel,
        frame,
        overflow: (gs_flags & GS_CAN_FLAG_OVERFLOW) != 0,
        raw_hw_ts_us,
    })
}

// =============================================================================
// Lock-Free Waker Shutdown Signal for `< 25 ms` Cancel-Safe USB Queue Teardown
// =============================================================================

struct ShutdownSignal {
    stopped: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl ShutdownSignal {
    fn new() -> Self {
        Self {
            stopped: AtomicBool::new(false),
            waker: Mutex::new(None),
        }
    }

    fn trigger(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(w) = self.waker.lock().take() {
            w.wake();
        }
    }

    #[inline]
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn wait(&self) -> ShutdownWait<'_> {
        ShutdownWait { signal: self }
    }
}

struct ShutdownWait<'a> {
    signal: &'a ShutdownSignal,
}

impl Future for ShutdownWait<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.signal.is_stopped() {
            return Poll::Ready(());
        }
        *self.signal.waker.lock() = Some(cx.waker().clone());
        if self.signal.is_stopped() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

// =============================================================================
// Multi-Channel Shared USB Interface Demux (`0..=icount`)
// =============================================================================

struct ChannelRxSlot {
    bus_id: BusId,
    hw_ts_enabled: bool,
    sender: crossbeam_channel::Sender<RawCanFrame>,
    bus_state: Arc<AtomicU8>,
    tx_errors: Arc<AtomicU32>,
    rx_errors: Arc<AtomicU32>,
}

struct SharedGsUsbAdapter {
    key: DeviceId,
    _device: Device,
    interface: Interface,
    iface_number: u8,
    num_channels: usize,
    out_ep: u8,
    slots: Arc<Mutex<[Option<ChannelRxSlot>; MAX_MULTI_CHANNELS]>>,
    shutdown: Arc<ShutdownSignal>,
    rx_join: Mutex<Option<JoinHandle<()>>>,
}

impl SharedGsUsbAdapter {
    fn open_or_reuse(dev_info: &DeviceInfo) -> Result<Arc<Self>, AdapterError> {
        let key = dev_info.id();
        {
            let mut guard = active_gs_usb_map().lock();
            if let Some(weak) = guard.get(&key) {
                if let Some(existing) = weak.upgrade() {
                    return Ok(existing);
                }
                guard.remove(&key);
            }
        }

        let vid_pid = format!("{:04X}:{:04X}", dev_info.vendor_id(), dev_info.product_id());
        let prod_name = dev_info
            .product_string()
            .or_else(|| {
                match_candlelight_usb_id(dev_info.vendor_id(), dev_info.product_id())
                    .map(|(_, p)| p)
            })
            .unwrap_or("candleLight USB-CAN");
        let serial_suffix = dev_info
            .serial_number()
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!(", S/N: {}", s.trim()))
            .unwrap_or_default();

        let device = dev_info.open().map_err(|e| {
            format_platform_usb_open_error(&vid_pid, prod_name, &serial_suffix, dev_info, &e)
        })?;

        // Claim Interface 0 (on Linux direct-USB fallback when SocketCAN is unavailable, detach kernel driver cleanly)
        let iface_number = 0u8;
        let interface = {
            #[cfg(target_os = "linux")]
            {
                device.detach_and_claim_interface(iface_number)
            }
            #[cfg(not(target_os = "linux"))]
            {
                device.claim_interface(iface_number)
            }
        }
        .map_err(|e| {
            format_platform_usb_claim_error(&vid_pid, prod_name, &serial_suffix, dev_info, &e)
        })?;

        // Inspect alternate setting 0 descriptors to discover Bulk IN & Bulk OUT endpoints dynamically
        let (in_ep, in_mps, out_ep) = inspect_bulk_endpoints(&interface);

        // Negotiate little-endian host frame format (`0x0000BEEF`)
        let host_fmt = 0x0000_BEEFu32.to_le_bytes();
        if let Err(err) = control_out_vendor(
            &interface,
            iface_number,
            GS_USB_BREQ_HOST_FORMAT,
            1,
            &host_fmt,
        ) {
            // Fallback with wValue = 0 for custom gs_usb clones
            control_out_vendor(
                &interface,
                iface_number,
                GS_USB_BREQ_HOST_FORMAT,
                0,
                &host_fmt,
            )
            .map_err(|_| {
                AdapterError::Driver(format!(
                    "gs_usb GS_USB_BREQ_HOST_FORMAT failed on {vid_pid} ({prod_name}): {err}"
                ))
            })?;
        }

        // Query `GS_USB_BREQ_DEVICE_CONFIG` (12 bytes)
        let mut dev_cfg_buf = [0u8; 12];
        let cfg_len = control_in_vendor(
            &interface,
            iface_number,
            GS_USB_BREQ_DEVICE_CONFIG,
            1,
            &mut dev_cfg_buf,
        )
        .or_else(|_| {
            control_in_vendor(
                &interface,
                iface_number,
                GS_USB_BREQ_DEVICE_CONFIG,
                0,
                &mut dev_cfg_buf,
            )
        })
        .map_err(|e| {
            AdapterError::Driver(format!(
                "gs_usb GS_USB_BREQ_DEVICE_CONFIG failed on {vid_pid} ({prod_name}): {e}"
            ))
        })?;

        let dev_cfg =
            GsDeviceConfig::from_le_bytes(&dev_cfg_buf[..cfg_len]).unwrap_or(GsDeviceConfig {
                num_channels: 1,
                sw_version: 0,
                hw_version: 0,
            });

        let slots: Arc<Mutex<[Option<ChannelRxSlot>; MAX_MULTI_CHANNELS]>> =
            Arc::new(Mutex::new([None, None, None, None]));
        let shutdown = Arc::new(ShutdownSignal::new());

        // Bulk IN transfer size MUST be an integer multiple of endpoint max_packet_size and >= 80 bytes
        let mps = in_mps.max(64);
        let rx_transfer_size = GS_MAX_WIRE_FRAME_LEN.div_ceil(mps) * mps;

        let rx_iface = interface.clone();
        let rx_slots = Arc::clone(&slots);
        let rx_shutdown = Arc::clone(&shutdown);
        let num_channels = dev_cfg.num_channels;

        let (_, loc_label) = usb_device_location_info(dev_info);
        let thread_slug: String = loc_label
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(12)
            .collect();
        let rx_join = thread::Builder::new()
            .name(format!("nexus-gsusb-rx-{thread_slug}"))
            .spawn(move || {
                run_gs_usb_bulk_in_worker(
                    key,
                    rx_iface,
                    in_ep,
                    rx_transfer_size,
                    num_channels,
                    rx_slots,
                    rx_shutdown,
                );
            })
            .map_err(AdapterError::Io)?;

        let shared = Arc::new(Self {
            key,
            _device: device,
            interface,
            iface_number,
            num_channels,
            out_ep,
            slots,
            shutdown,
            rx_join: Mutex::new(Some(rx_join)),
        });

        active_gs_usb_map()
            .lock()
            .insert(key, Arc::downgrade(&shared));

        Ok(shared)
    }

    fn query_bt_capabilities(&self, ch_index: u8) -> Result<GsBtCapabilities, AdapterError> {
        let mut bt_buf = [0u8; 40];
        let n = control_in_vendor(
            &self.interface,
            self.iface_number,
            GS_USB_BREQ_BT_CONST,
            u16::from(ch_index),
            &mut bt_buf,
        )
        .map_err(|e| {
            AdapterError::Driver(format!(
                "gs_usb GS_USB_BREQ_BT_CONST failed on channel {ch_index}: {e}"
            ))
        })?;

        let mut caps = GsBtCapabilities::from_bt_const_bytes(&bt_buf[..n]).ok_or_else(|| {
            AdapterError::Driver(format!(
                "gs_usb GS_USB_BREQ_BT_CONST returned short {n}-byte payload (expected 40B)"
            ))
        })?;

        if caps.has_bt_const_ext() {
            let mut ext_buf = [0u8; 72];
            if let Ok(ext_n) = control_in_vendor(
                &self.interface,
                self.iface_number,
                GS_USB_BREQ_BT_CONST_EXT,
                u16::from(ch_index),
                &mut ext_buf,
            ) {
                caps.apply_bt_const_ext_bytes(&ext_buf[..ext_n]);
            }
        }

        Ok(caps)
    }

    fn stop_channel_and_maybe_teardown(&self, ch_index: u8) {
        let mut any_remaining = false;
        {
            let mut guard = self.slots.lock();
            if usize::from(ch_index) < guard.len() {
                guard[usize::from(ch_index)] = None;
            }
            for slot in guard.iter() {
                if slot.is_some() {
                    any_remaining = true;
                }
            }
        }

        // Send `GS_CAN_MODE_RESET` (mode = 0, flags = 0) for this channel
        let reset_payload = [0u8; 8];
        let _ = control_out_vendor(
            &self.interface,
            self.iface_number,
            GS_USB_BREQ_MODE,
            u16::from(ch_index),
            &reset_payload,
        );

        if !any_remaining {
            self.shutdown.trigger();
            if let Some(handle) = self.rx_join.lock().take() {
                let _ = handle.join();
            }
            active_gs_usb_map().lock().remove(&self.key);
        }
    }
}

impl Drop for SharedGsUsbAdapter {
    fn drop(&mut self) {
        self.shutdown.trigger();
        if let Some(handle) = self.rx_join.lock().take() {
            let _ = handle.join();
        }
        active_gs_usb_map().lock().remove(&self.key);
    }
}

fn run_gs_usb_bulk_in_worker(
    key: DeviceId,
    interface: Interface,
    in_ep: u8,
    transfer_size: usize,
    num_channels: usize,
    slots: Arc<Mutex<[Option<ChannelRxSlot>; MAX_MULTI_CHANNELS]>>,
    shutdown: Arc<ShutdownSignal>,
) {
    let mut in_queue = interface.bulk_in_queue(in_ep);
    while in_queue.pending() < RX_INFLIGHT_URBS {
        in_queue.submit(RequestBuffer::new(transfer_size));
    }

    // Per-channel 32-bit hardware microsecond wrap-around extension (`~71.58 min` period)
    let mut last_ts32 = [0u32; MAX_MULTI_CHANNELS];
    let mut wrap_high = [0u64; MAX_MULTI_CHANNELS];

    while !shutdown.is_stopped() {
        let maybe_comp = block_on(or(async { Some(in_queue.next_complete().await) }, async {
            shutdown.wait().await;
            None
        }));

        let Some(completion) = maybe_comp else {
            break;
        };

        match completion.status {
            Ok(()) => {
                let data = &completion.data;
                if data.len() >= 20 {
                    let mono_us = now_monotonic_us().max(1);
                    let raw_ch = usize::from(data[9]);
                    let slot_idx = if num_channels <= 1 {
                        0
                    } else {
                        raw_ch.min(MAX_MULTI_CHANNELS - 1)
                    };

                    let guard = slots.lock();
                    if let Some(slot) = guard[slot_idx].as_ref() {
                        if let Some(GsDecodedPacket::RxFrame {
                            mut frame,
                            overflow,
                            raw_hw_ts_us,
                            ..
                        }) = decode_gs_host_frame(data, slot.bus_id, slot.hw_ts_enabled, mono_us)
                        {
                            if let Some(ts32) = raw_hw_ts_us {
                                let prev = last_ts32[slot_idx];
                                if prev > 0xC000_0000 && ts32 < 0x4000_0000 {
                                    wrap_high[slot_idx] =
                                        wrap_high[slot_idx].saturating_add(1u64 << 32);
                                }
                                last_ts32[slot_idx] = ts32;
                                frame.timestamp_us = (wrap_high[slot_idx] | u64::from(ts32)).max(1);
                            }

                            if overflow {
                                slot.rx_errors.fetch_add(1, Ordering::Relaxed);
                            }

                            if frame.is_error() {
                                update_health_from_gs_error_frame(
                                    &frame,
                                    &slot.bus_state,
                                    &slot.tx_errors,
                                    &slot.rx_errors,
                                );
                            }

                            match slot.sender.try_send(frame) {
                                Ok(()) => {}
                                Err(TrySendError::Full(_)) => {
                                    slot.rx_errors.fetch_add(1, Ordering::Relaxed);
                                }
                                Err(TrySendError::Disconnected(_)) => {}
                            }
                        }
                    }
                }

                if !shutdown.is_stopped() {
                    in_queue.submit(RequestBuffer::reuse(completion.data, transfer_size));
                }
            }
            Err(TransferError::Disconnected) => {
                {
                    let mut guard = slots.lock();
                    for slot_opt in guard.iter_mut() {
                        if let Some(slot) = slot_opt.take() {
                            slot.bus_state
                                .store(BusState::Disconnected.to_u8(), Ordering::Release);
                            drop(slot.sender);
                        }
                    }
                }
                active_gs_usb_map().lock().remove(&key);
                break;
            }
            Err(TransferError::Cancelled) => break,
            Err(TransferError::Stall) => {
                let _ = in_queue.clear_halt();
                if !shutdown.is_stopped() {
                    in_queue.submit(RequestBuffer::reuse(completion.data, transfer_size));
                }
            }
            Err(_) => {
                let guard = slots.lock();
                for slot in guard.iter().flatten() {
                    slot.rx_errors.fetch_add(1, Ordering::Relaxed);
                }
                if !shutdown.is_stopped() {
                    in_queue.submit(RequestBuffer::reuse(completion.data, transfer_size));
                }
            }
        }
    }

    in_queue.cancel_all();
}

#[inline]
fn update_health_from_gs_error_frame(
    frame: &RawCanFrame,
    bus_state: &AtomicU8,
    tx_errors: &AtomicU32,
    rx_errors: &AtomicU32,
) {
    let (maybe_state, maybe_cnt) =
        crate::error_frame::extract_bus_health_from_error_frame(frame.arb_id, frame.payload());
    if let Some((tec, rec)) = maybe_cnt {
        tx_errors.store(tec, Ordering::Relaxed);
        rx_errors.store(rec, Ordering::Relaxed);
    } else {
        rx_errors.fetch_add(1, Ordering::Relaxed);
    }
    if let Some(st) = maybe_state {
        bus_state.store(st.to_u8(), Ordering::Release);
    }
}

fn inspect_bulk_endpoints(interface: &Interface) -> (u8, usize, u8) {
    let mut in_ep = 0x81u8;
    let mut in_mps = 64usize;
    let mut out_ep = 0x02u8;
    let mut found_in = false;
    let mut found_out = false;

    for alt in interface.descriptors() {
        if alt.alternate_setting() != 0 {
            continue;
        }
        for ep in alt.endpoints() {
            if ep.transfer_type() != EndpointType::Bulk {
                continue;
            }
            match ep.direction() {
                Direction::In if !found_in => {
                    in_ep = ep.address();
                    in_mps = ep.max_packet_size().max(64);
                    found_in = true;
                }
                Direction::Out if !found_out => {
                    out_ep = ep.address();
                    found_out = true;
                }
                _ => {}
            }
        }
    }

    (in_ep, in_mps, out_ep)
}

fn control_out_vendor(
    interface: &Interface,
    iface_number: u8,
    request: u8,
    value: u16,
    data: &[u8],
) -> Result<usize, TransferError> {
    interface.control_out_blocking(
        Control {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request,
            value,
            index: u16::from(iface_number),
        },
        data,
        CONTROL_TIMEOUT,
    )
}

fn control_in_vendor(
    interface: &Interface,
    iface_number: u8,
    request: u8,
    value: u16,
    data: &mut [u8],
) -> Result<usize, TransferError> {
    interface.control_in_blocking(
        Control {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request,
            value,
            index: u16::from(iface_number),
        },
        data,
        CONTROL_TIMEOUT,
    )
}

fn format_platform_usb_open_error(
    vid_pid: &str,
    prod_name: &str,
    serial_suffix: &str,
    dev_info: &DeviceInfo,
    err: &std::io::Error,
) -> AdapterError {
    let (_, human_loc) = usb_device_location_info(dev_info);
    if cfg!(target_os = "windows") {
        return AdapterError::Driver(format!(
            "USB device {vid_pid} ({prod_name}{serial_suffix}, {human_loc}) was detected on Windows USB bus, \
             but opening Direct USB failed ({err}). Bind the 'WinUSB' driver to Interface 0 using Zadig \
             (Options -> List All Devices -> select '{prod_name}' -> WinUSB -> Replace Driver), or close any other application holding the handle. \
             Note: if using two identical clone candleLight boards with the same/missing USB Serial Number, Windows assigns a per-port instance ID that requires binding WinUSB via Zadig on the second USB port as well!"
        ));
    }
    if cfg!(target_os = "linux") && err.kind() == ErrorKind::PermissionDenied {
        return AdapterError::Driver(format!(
            "Permission denied opening USB device {vid_pid} ({prod_name}{serial_suffix}, {human_loc}) at /dev/bus/usb/{:03}/{:03}. \
             Either load SocketCAN ('sudo modprobe gs_usb') or install a udev rule in /etc/udev/rules.d/99-nexuscan-usb.rules: \
             SUBSYSTEM==\"usb\", ATTR{{idVendor}}==\"{:04x}\", ATTR{{idProduct}}==\"{:04x}\", MODE=\"0666\", TAG+=\"uaccess\"",
            dev_info.bus_number(),
            dev_info.device_address(),
            dev_info.vendor_id(),
            dev_info.product_id()
        ));
    }
    AdapterError::Driver(format!(
        "Failed to open gs_usb device {vid_pid} ({prod_name}{serial_suffix}, {human_loc}): {err}"
    ))
}

fn format_platform_usb_claim_error(
    vid_pid: &str,
    prod_name: &str,
    serial_suffix: &str,
    dev_info: &DeviceInfo,
    err: &std::io::Error,
) -> AdapterError {
    let (_, human_loc) = usb_device_location_info(dev_info);
    if cfg!(target_os = "windows") {
        if err.kind() == ErrorKind::PermissionDenied {
            return AdapterError::Driver(format!(
                "USB device {vid_pid} ({prod_name}{serial_suffix}, {human_loc}) has WinUSB bound, but Interface 0 is currently busy ({err}). \
                 Close any other CAN tool (SavvyCAN, cangaroo, python-can) holding the WinUSB handle, or select the other gs_usb channel index if connecting a second adapter."
            ));
        }
        return AdapterError::Driver(format!(
            "USB device {vid_pid} ({prod_name}{serial_suffix}, {human_loc}) was detected on Windows USB bus, \
             but WinUSB is not bound to Interface 0 ({err}). Open Zadig -> Options -> List All Devices -> select '{prod_name} (Interface 0)' -> bind 'WinUSB' -> Replace Driver. \
             (If you plugged in a second clone candleLight sharing the same USB Serial Number, bind WinUSB via Zadig on that second USB port's entry too!)"
        ));
    }
    AdapterError::Driver(format!(
        "Failed claiming USB Interface 0 on {vid_pid} ({prod_name}{serial_suffix}, {human_loc}): {err}"
    ))
}

// =============================================================================
// Active `GsUsbChannel` Implementing `CanChannel`
// =============================================================================

/// Pure-Rust hot-path `gs_usb` / `candleLight` USB CAN / CAN-FD channel.
pub struct GsUsbChannel {
    descriptor: DeviceDescriptor,
    shared: Option<Arc<SharedGsUsbAdapter>>,
    hw_channel_index: u8,
    listen_only: bool,
    listen_only_enforcement: ListenOnlyEnforcement,
    supports_fd: bool,
    closed: bool,
    rx_receiver: Receiver<RawCanFrame>,
    out_queue: Option<Queue<Vec<u8>>>,
    free_tx_bufs: Vec<Vec<u8>>,
    filters: Vec<CanFilter>,
    bus_state: Arc<AtomicU8>,
    tx_errors: Arc<AtomicU32>,
    rx_errors: Arc<AtomicU32>,
}

impl GsUsbChannel {
    fn open_direct_usb(
        dev_info: &DeviceInfo,
        hw_channel_index: u8,
        logical_channel_index: usize,
        human_location: &str,
        base_descriptor: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Self, AdapterError> {
        let shared = SharedGsUsbAdapter::open_or_reuse(dev_info)?;
        if usize::from(hw_channel_index) >= shared.num_channels {
            return Err(AdapterError::DeviceNotFound(format!(
                "Requested gs_usb channel {hw_channel_index}, but adapter at {human_location} only exposes {} channel(s) (0..{})",
                shared.num_channels,
                shared.num_channels.saturating_sub(1)
            )));
        }

        if shared.slots.lock()[usize::from(hw_channel_index)].is_some() {
            return Err(AdapterError::Driver(format!(
                "gs_usb:{logical_channel_index} (hw ch {hw_channel_index} @ {human_location}) is already open in NexusCAN"
            )));
        }

        let bt_caps = shared.query_bt_capabilities(hw_channel_index)?;
        let hw_supports_listen_only = (bt_caps.feature & GS_CAN_FEATURE_LISTEN_ONLY) != 0;
        if config.requires_hardware_listen_only() && !hw_supports_listen_only {
            shared.stop_channel_and_maybe_teardown(hw_channel_index);
            return Err(AdapterError::hw_listen_only_unavailable(&format!(
                "gs_usb:{logical_channel_index} (hw ch {hw_channel_index} @ {human_location}) \
                 firmware did not advertise GS_CAN_FEATURE_LISTEN_ONLY (feature=0x{:08X}); \
                 refusing to start the CAN controller so it never ACKs frames on the bus.",
                bt_caps.feature
            )));
        }

        let nominal_bt = compute_gs_usb_bittiming(
            bt_caps.fclk_can,
            config.bitrate.max(10_000),
            bt_caps.tseg1_min,
            bt_caps.tseg1_max,
            bt_caps.tseg2_min,
            bt_caps.tseg2_max,
            bt_caps.sjw_max,
            bt_caps.brp_min,
            bt_caps.brp_max,
            bt_caps.brp_inc,
            875,
        )?;

        // Reset channel cleanly before applying bit timing
        let reset_mode = [0u8; 8];
        let _ = control_out_vendor(
            &shared.interface,
            shared.iface_number,
            GS_USB_BREQ_MODE,
            u16::from(hw_channel_index),
            &reset_mode,
        );

        let nom_bytes = nominal_bt.to_le_bytes();
        control_out_vendor(
            &shared.interface,
            shared.iface_number,
            GS_USB_BREQ_BITTIMING,
            u16::from(hw_channel_index),
            &nom_bytes,
        )
        .map_err(|e| {
            AdapterError::Driver(format!(
                "gs_usb GS_USB_BREQ_BITTIMING ({} bps) failed on ch {hw_channel_index}: {e}",
                config.bitrate
            ))
        })?;

        let enable_fd_hw = config.enable_fd && bt_caps.supports_fd();
        if enable_fd_hw {
            let data_bt = compute_gs_usb_bittiming(
                bt_caps.fclk_can,
                config.data_bitrate.max(config.bitrate).max(500_000),
                bt_caps.dtseg1_min,
                bt_caps.dtseg1_max,
                bt_caps.dtseg2_min,
                bt_caps.dtseg2_max,
                bt_caps.dsjw_max,
                bt_caps.dbrp_min,
                bt_caps.dbrp_max,
                bt_caps.dbrp_inc,
                750,
            )?;
            let data_bytes = data_bt.to_le_bytes();
            control_out_vendor(
                &shared.interface,
                shared.iface_number,
                GS_USB_BREQ_DATA_BITTIMING,
                u16::from(hw_channel_index),
                &data_bytes,
            )
            .map_err(|e| {
                AdapterError::Driver(format!(
                    "gs_usb GS_USB_BREQ_DATA_BITTIMING ({} bps) failed on ch {hw_channel_index}: {e}",
                    config.data_bitrate
                ))
            })?;
        }

        let hw_ts_enabled = bt_caps.supports_hw_timestamp();
        let mut mode_flags = 0u32;
        let listen_only_enforcement = if config.listen_only {
            if hw_supports_listen_only {
                mode_flags |= GS_CAN_MODE_LISTEN_ONLY;
                ListenOnlyEnforcement::Hardware
            } else {
                ListenOnlyEnforcement::SoftwareOnly
            }
        } else {
            ListenOnlyEnforcement::SoftwareOnly
        };
        if enable_fd_hw {
            mode_flags |= GS_CAN_MODE_FD;
        }
        if hw_ts_enabled {
            mode_flags |= GS_CAN_MODE_HW_TIMESTAMP;
        }
        if (bt_caps.feature & GS_CAN_FEATURE_BERR_REPORTING) != 0 {
            mode_flags |= GS_CAN_MODE_BERR_REPORTING;
        }

        let mut start_mode = [0u8; 8];
        start_mode[0..4].copy_from_slice(&GS_CAN_MODE_START.to_le_bytes());
        start_mode[4..8].copy_from_slice(&mode_flags.to_le_bytes());
        control_out_vendor(
            &shared.interface,
            shared.iface_number,
            GS_USB_BREQ_MODE,
            u16::from(hw_channel_index),
            &start_mode,
        )
        .map_err(|e| {
            AdapterError::Driver(format!(
                "gs_usb GS_USB_BREQ_MODE(START) failed on ch {hw_channel_index}: {e}"
            ))
        })?;

        let (rx_tx, rx_rx) = bounded::<RawCanFrame>(RX_RING_CAPACITY);
        let bus_state = Arc::new(AtomicU8::new(BusState::Active.to_u8()));
        let tx_errors = Arc::new(AtomicU32::new(0));
        let rx_errors = Arc::new(AtomicU32::new(0));

        shared.slots.lock()[usize::from(hw_channel_index)] = Some(ChannelRxSlot {
            bus_id: config.bus_id,
            hw_ts_enabled,
            sender: rx_tx,
            bus_state: Arc::clone(&bus_state),
            tx_errors: Arc::clone(&tx_errors),
            rx_errors: Arc::clone(&rx_errors),
        });

        let out_queue = shared.interface.bulk_out_queue(shared.out_ep);
        let mut free_tx_bufs = Vec::with_capacity(TX_BUFFER_POOL_CAP);
        for _ in 0..TX_BUFFER_POOL_CAP {
            free_tx_bufs.push(Vec::with_capacity(GS_MAX_WIRE_FRAME_LEN));
        }

        let mut descriptor = base_descriptor.clone();
        let ch_str = logical_channel_index.to_string();
        let prod_label = dev_info
            .product_string()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                match_candlelight_usb_id(dev_info.vendor_id(), dev_info.product_id())
                    .map(|(_, p)| p)
            })
            .unwrap_or("candleLight / gs_usb");
        descriptor.device_id = format!("gs_usb:{ch_str}");
        descriptor.channel_name = ch_str.clone();
        descriptor.display_name = format!(
            "[gs_usb:{ch_str}] {prod_label} ({:04X}:{:04X}) @ {human_location}",
            dev_info.vendor_id(),
            dev_info.product_id()
        );
        descriptor.capabilities = AdapterCapabilitiesDto {
            supports_fd: bt_caps.supports_fd(),
            supports_listen_only: hw_supports_listen_only,
            supports_hw_timestamps: hw_ts_enabled,
            max_bitrate: if bt_caps.supports_fd() {
                8_000_000
            } else {
                1_000_000
            },
            is_virtual: false,
        };

        Ok(Self {
            descriptor,
            shared: Some(shared),
            hw_channel_index,
            listen_only: config.listen_only,
            listen_only_enforcement,
            supports_fd: enable_fd_hw,
            closed: false,
            rx_receiver: rx_rx,
            out_queue: Some(out_queue),
            free_tx_bufs,
            filters: Vec::new(),
            bus_state,
            tx_errors,
            rx_errors,
        })
    }

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

    fn reap_completed_tx_nonblocking(&mut self) {
        let Some(out_q) = self.out_queue.as_mut() else {
            return;
        };
        while out_q.pending() > 0 {
            let Some(comp) = block_on(poll_once(out_q.next_complete())) else {
                break;
            };
            Self::record_tx_completion(
                comp,
                &self.tx_errors,
                &self.bus_state,
                &mut self.free_tx_bufs,
            );
        }
    }

    fn record_tx_completion(
        comp: nusb::transfer::Completion<ResponseBuffer>,
        tx_errors: &AtomicU32,
        bus_state: &AtomicU8,
        free_tx_bufs: &mut Vec<Vec<u8>>,
    ) {
        if let Err(err) = comp.status {
            tx_errors.fetch_add(1, Ordering::Relaxed);
            if err == TransferError::Disconnected {
                bus_state.store(BusState::Disconnected.to_u8(), Ordering::Release);
            }
        }
        let recycled = comp.data.reuse();
        if free_tx_bufs.len() < TX_BUFFER_POOL_CAP {
            free_tx_bufs.push(recycled);
        }
    }
}

impl CanChannel for GsUsbChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        if let Some(mut out_q) = self.out_queue.take() {
            out_q.cancel_all();
        }
        if let Some(shared) = self.shared.take() {
            shared.stop_channel_and_maybe_teardown(self.hw_channel_index);
        }
        self.bus_state
            .store(BusState::Disconnected.to_u8(), Ordering::Release);
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
        if BusState::from_u8(self.bus_state.load(Ordering::Acquire)) == BusState::Disconnected {
            self.closed = true;
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }

        // Opportunistically recycle completed TX URB buffers with zero blocking
        self.reap_completed_tx_nonblocking();
        if BusState::from_u8(self.bus_state.load(Ordering::Acquire)) == BusState::Disconnected {
            self.closed = true;
            return Err(AdapterError::ChannelClosed);
        }

        let mut count = 0usize;

        // 1. Drain any immediately ready frames first
        while count < out_batch.len() {
            match self.rx_receiver.try_recv() {
                Ok(frame) => {
                    if self.matches_filters(&frame) {
                        out_batch[count] = frame;
                        count += 1;
                    }
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    if count > 0 {
                        break;
                    }
                    self.closed = true;
                    self.bus_state
                        .store(BusState::Disconnected.to_u8(), Ordering::Release);
                    return Err(AdapterError::ChannelClosed);
                }
            }
        }
        if count > 0 || timeout_ms == 0 {
            return Ok(count);
        }

        // 2. Idle wait up to `timeout_ms` (~0% CPU) for the first frame
        let wait_dur = Duration::from_millis(u64::from(timeout_ms.min(20)));
        match self.rx_receiver.recv_timeout(wait_dur) {
            Ok(first) => {
                if self.matches_filters(&first) {
                    out_batch[0] = first;
                    count = 1;
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => return Ok(0),
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                self.closed = true;
                self.bus_state
                    .store(BusState::Disconnected.to_u8(), Ordering::Release);
                return Err(AdapterError::ChannelClosed);
            }
        }

        // 3. Burst-drain remaining queued frames up to `out_batch.len()`
        while count < out_batch.len() {
            match self.rx_receiver.try_recv() {
                Ok(frame) => {
                    if self.matches_filters(&frame) {
                        out_batch[count] = frame;
                        count += 1;
                    }
                }
                Err(_) => break,
            }
        }

        Ok(count)
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }
        if frame.is_fd() && !self.supports_fd {
            return Err(AdapterError::UnsupportedCapability(
                "CAN-FD transmission is not enabled or supported on this gs_usb channel"
                    .to_string(),
            ));
        }

        let mut wire_stack = [0u8; GS_MAX_WIRE_FRAME_LEN];
        let wire_len = encode_gs_host_frame(frame, self.hw_channel_index, 0, &mut wire_stack)?;

        self.reap_completed_tx_nonblocking();

        // If all 16 pre-allocated TX URBs are currently in-flight on the USB controller, await one completion
        if self.free_tx_bufs.is_empty() {
            let maybe_comp = if let Some(out_q) = self.out_queue.as_mut() {
                if out_q.pending() > 0 {
                    Some(block_on(out_q.next_complete()))
                } else {
                    None
                }
            } else {
                return Err(AdapterError::ChannelClosed);
            };

            if let Some(comp) = maybe_comp {
                Self::record_tx_completion(
                    comp,
                    &self.tx_errors,
                    &self.bus_state,
                    &mut self.free_tx_bufs,
                );
            }
        }

        let mut tx_buf = self
            .free_tx_bufs
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(GS_MAX_WIRE_FRAME_LEN));
        tx_buf.clear();
        tx_buf.extend_from_slice(&wire_stack[..wire_len]);

        let out_q = self.out_queue.as_mut().ok_or(AdapterError::ChannelClosed)?;
        out_q.submit(tx_buf);
        Ok(())
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        self.filters.clear();
        self.filters.extend_from_slice(filters);
        Ok(())
    }

    fn health(&self) -> BusHealthSnapshot {
        if self.closed {
            return BusHealthSnapshot {
                state: BusState::Disconnected,
                tx_error_count: self.tx_errors.load(Ordering::Relaxed),
                rx_error_count: self.rx_errors.load(Ordering::Relaxed),
            };
        }
        BusHealthSnapshot {
            state: BusState::from_u8(self.bus_state.load(Ordering::Acquire)),
            tx_error_count: self.tx_errors.load(Ordering::Relaxed),
            rx_error_count: self.rx_errors.load(Ordering::Relaxed),
        }
    }

    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        self.listen_only_enforcement
    }
}

impl Drop for GsUsbChannel {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

// =============================================================================
// `GsUsbDriver` Discovery & Smart Linux/Windows/macOS Routing
// =============================================================================

/// Discovered `gs_usb` physical USB adapter entry used by both `GsUsbDriver` and `probe_gs_usb_family`.
#[derive(Clone, Debug)]
pub(crate) struct EnumeratedGsUsbUnit {
    pub dev_info: DeviceInfo,
    pub vid_pid: String,
    pub vendor_name: String,
    pub product_name: String,
    pub serial_number: Option<String>,
    pub sort_key: String,
    pub human_location: String,
    pub port_number: Option<u32>,
    pub linux_socketcan_ifaces: Vec<String>,
}

pub(crate) fn enumerate_connected_gs_usb_units() -> Vec<EnumeratedGsUsbUnit> {
    let mut units = Vec::new();
    let Ok(iter) = nusb::list_devices() else {
        return units;
    };

    for dev_info in iter {
        let Some((fallback_vendor, fallback_prod)) =
            match_candlelight_usb_id(dev_info.vendor_id(), dev_info.product_id())
        else {
            continue;
        };

        let vid_pid = format!("{:04X}:{:04X}", dev_info.vendor_id(), dev_info.product_id());
        let vendor_name = dev_info
            .manufacturer_string()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_vendor)
            .to_string();
        let product_name = dev_info
            .product_string()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_prod)
            .to_string();
        let serial_number = dev_info
            .serial_number()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let (sort_key, human_location) = usb_device_location_info(&dev_info);
        let port_number = usb_device_port_number(&dev_info);

        #[cfg(target_os = "linux")]
        let linux_socketcan_ifaces = find_linux_sysfs_net_ifaces(dev_info.sysfs_path());
        #[cfg(not(target_os = "linux"))]
        let linux_socketcan_ifaces = Vec::new();

        units.push(EnumeratedGsUsbUnit {
            dev_info,
            vid_pid,
            vendor_name,
            product_name,
            serial_number,
            sort_key,
            human_location,
            port_number,
            linux_socketcan_ifaces,
        });
    }

    units.sort_by(|a, b| a.sort_key.cmp(&b.sort_key));
    units
}

#[cfg(target_os = "linux")]
pub(crate) fn find_linux_sysfs_net_ifaces(usb_sysfs_path: &std::path::Path) -> Vec<String> {
    let mut ifaces = Vec::new();
    let Ok(entries) = std::fs::read_dir(usb_sysfs_path) else {
        return ifaces;
    };
    for entry in entries.flatten() {
        let sub_path = entry.path();
        let net_dir = sub_path.join("net");
        if let Ok(net_entries) = std::fs::read_dir(net_dir) {
            for net_entry in net_entries.flatten() {
                let iface = net_entry.file_name().to_string_lossy().to_string();
                if !ifaces.contains(&iface) {
                    ifaces.push(iface);
                }
            }
        }
    }
    ifaces.sort();
    ifaces
}

/// Pure, OS-independent representation of an attached `gs_usb` unit used by [`resolve_gs_usb_candidate`]
/// to deterministically resolve multi-device targets (including clone adapters with identical serials).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GsUsbTargetCandidate {
    pub vid_pid: String,
    pub product_name: String,
    pub serial_number: Option<String>,
    pub bus_number: u8,
    pub port_number: Option<u32>,
    pub device_address: u8,
    pub human_location: String,
    pub num_channels: usize,
    /// Bitmask (`1 << hw_ch`) of channels on this physical adapter already open in NexusCAN.
    pub active_channels_mask: u8,
}

impl GsUsbTargetCandidate {
    #[inline]
    pub const fn is_channel_active(&self, hw_ch: u8) -> bool {
        if hw_ch >= 8 {
            return false;
        }
        (self.active_channels_mask & (1u8 << hw_ch)) != 0
    }
}

/// Resolves a user/UI channel selector (`"0"`, `"1"`, `"gs_usb:1"`, `"bus:port:addr"`, `"bus:addr"`,
/// or `"SERIAL"`) into `(unit_index, hw_channel_index, flat_logical_index)`.
///
/// - If matching by serial number or `(bus, addr)` encounters multiple identical clone adapters,
///   automatically prefers a unit whose target channel is **not** already active in NexusCAN.
/// - If an explicit channel index (e.g. `"0"`) is already connected in NexusCAN, returns an actionable
///   error listing the exact other available `gs_usb` channel indices and their USB port locations!
pub fn resolve_gs_usb_candidate(
    candidates: &[GsUsbTargetCandidate],
    selector: &str,
) -> Result<(usize, u8, usize), AdapterError> {
    let raw_trimmed = selector
        .trim()
        .strip_prefix("gs_usb:")
        .unwrap_or(selector.trim());
    let trimmed = if raw_trimmed.is_empty() {
        "0"
    } else {
        raw_trimmed
    };

    let total_logical_channels: usize = candidates.iter().map(|c| c.num_channels.max(1)).sum();

    let logical_index_of = |unit_idx: usize, hw_ch: u8| -> usize {
        let prefix: usize = candidates[..unit_idx]
            .iter()
            .map(|c| c.num_channels.max(1))
            .sum();
        prefix + usize::from(hw_ch)
    };

    let build_already_open_err = |unit_idx: usize, hw_ch: u8| -> AdapterError {
        let chosen = &candidates[unit_idx];
        let chosen_logical = logical_index_of(unit_idx, hw_ch);
        let mut free_options = Vec::new();
        let mut cursor = 0usize;
        for c in candidates {
            let n_ch = c.num_channels.max(1);
            for ch in 0..n_ch {
                let ch_u8 = ch as u8;
                let flat_idx = cursor + ch;
                if !c.is_channel_active(ch_u8) {
                    free_options.push(format!(
                        "'{flat_idx}' (gs_usb:{flat_idx} — {} @ {})",
                        c.product_name, c.human_location
                    ));
                }
            }
            cursor += n_ch;
        }

        if free_options.is_empty() {
            AdapterError::Driver(format!(
                "gs_usb:{chosen_logical} ({} @ {}) is already connected in NexusCAN, and no other free candleLight USB channels are currently attached.",
                chosen.product_name, chosen.human_location
            ))
        } else {
            AdapterError::Driver(format!(
                "gs_usb:{chosen_logical} ({} @ {}) is already connected in NexusCAN. To connect your other attached candleLight adapter(s), select channel: {}.",
                chosen.product_name,
                chosen.human_location,
                free_options.join(", ")
            ))
        }
    };

    // 1. Flat logical channel index (`"0"`, `"1"`, ...) when within `0..total_logical_channels`
    if !trimmed.contains(':') {
        if let Ok(target_idx) = trimmed.parse::<usize>() {
            if target_idx < total_logical_channels {
                let mut cursor = 0usize;
                for (u_idx, c) in candidates.iter().enumerate() {
                    let ch_count = c.num_channels.max(1);
                    if target_idx < cursor + ch_count {
                        let hw_ch = (target_idx - cursor) as u8;
                        if !c.is_channel_active(hw_ch) {
                            return Ok((u_idx, hw_ch, target_idx));
                        }
                        // Hot-unplug / hot-replug index-shift fallback:
                        // When 1 of 2+ identical candleLight adapters is unplugged and replugged,
                        // OS port/DevInst sorting can swap logical indices (`gs_usb:0` <-> `gs_usb:1`)
                        // while the surviving adapter remains active. Automatically select the first
                        // free (non-active) gs_usb channel, and only fail if ALL channels are active!
                        let mut free_cursor = 0usize;
                        for (free_u_idx, free_c) in candidates.iter().enumerate() {
                            let free_ch_count = free_c.num_channels.max(1);
                            for free_ch in 0..free_ch_count {
                                if !free_c.is_channel_active(free_ch as u8) {
                                    return Ok((free_u_idx, free_ch as u8, free_cursor + free_ch));
                                }
                            }
                            free_cursor += free_ch_count;
                        }
                        return Err(build_already_open_err(u_idx, hw_ch));
                    }
                    cursor += ch_count;
                }
            }
        }
    }

    // 2. Colon-delimited topology selectors: `"bus:port:addr[:ch]"` or `"bus:addr[:ch]"`
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() >= 2 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
        if parts.len() == 4 {
            if let (Ok(bus), Ok(port), Ok(addr), Ok(ch)) = (
                parts[0].parse::<u8>(),
                parts[1].parse::<u32>(),
                parts[2].parse::<u8>(),
                parts[3].parse::<u8>(),
            ) {
                let matches: Vec<usize> = candidates
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| {
                        c.bus_number == bus
                            && c.port_number == Some(port)
                            && c.device_address == addr
                    })
                    .map(|(i, _)| i)
                    .collect();
                if let Some(&u_idx) = matches
                    .iter()
                    .find(|&&i| !candidates[i].is_channel_active(ch))
                    .or_else(|| matches.first())
                {
                    if candidates[u_idx].is_channel_active(ch) {
                        return Err(build_already_open_err(u_idx, ch));
                    }
                    return Ok((u_idx, ch, logical_index_of(u_idx, ch)));
                }
            }
        } else if parts.len() == 3 {
            // Try `"bus:port:addr"` (ch = 0) first if `port_number` matches; otherwise `"bus:addr:ch"`
            if let (Ok(bus), Ok(mid), Ok(last)) = (
                parts[0].parse::<u8>(),
                parts[1].parse::<u32>(),
                parts[2].parse::<u8>(),
            ) {
                let bpa_matches: Vec<usize> = candidates
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| {
                        c.bus_number == bus
                            && c.port_number == Some(mid)
                            && c.device_address == last
                    })
                    .map(|(i, _)| i)
                    .collect();
                if let Some(&u_idx) = bpa_matches
                    .iter()
                    .find(|&&i| !candidates[i].is_channel_active(0))
                    .or_else(|| bpa_matches.first())
                {
                    if candidates[u_idx].is_channel_active(0) {
                        return Err(build_already_open_err(u_idx, 0));
                    }
                    return Ok((u_idx, 0, logical_index_of(u_idx, 0)));
                }

                if let Ok(addr_u8) = u8::try_from(mid) {
                    let ch = last;
                    let bac_matches: Vec<usize> = candidates
                        .iter()
                        .enumerate()
                        .filter(|(_, c)| c.bus_number == bus && c.device_address == addr_u8)
                        .map(|(i, _)| i)
                        .collect();
                    if let Some(&u_idx) = bac_matches
                        .iter()
                        .find(|&&i| !candidates[i].is_channel_active(ch))
                        .or_else(|| bac_matches.first())
                    {
                        if candidates[u_idx].is_channel_active(ch) {
                            return Err(build_already_open_err(u_idx, ch));
                        }
                        return Ok((u_idx, ch, logical_index_of(u_idx, ch)));
                    }
                }
            }
        } else if parts.len() == 2 {
            if let (Ok(bus), Ok(addr)) = (parts[0].parse::<u8>(), parts[1].parse::<u8>()) {
                let ba_matches: Vec<usize> = candidates
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.bus_number == bus && c.device_address == addr)
                    .map(|(i, _)| i)
                    .collect();
                if let Some(&u_idx) = ba_matches
                    .iter()
                    .find(|&&i| !candidates[i].is_channel_active(0))
                    .or_else(|| ba_matches.first())
                {
                    if candidates[u_idx].is_channel_active(0) {
                        return Err(build_already_open_err(u_idx, 0));
                    }
                    return Ok((u_idx, 0, logical_index_of(u_idx, 0)));
                }
            }
        }
    }

    // 3. Match by USB Serial Number (`"SN"` or `"SN:ch"`), preferring an inactive unit when clone boards share a serial!
    let (sn_candidate, sn_ch) = match trimmed.split_once(':') {
        Some((s, c)) => (s, c.parse::<u8>().unwrap_or(0)),
        None => (trimmed, 0u8),
    };
    let sn_matches: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c.serial_number
                .as_deref()
                .is_some_and(|sn| sn.eq_ignore_ascii_case(sn_candidate))
        })
        .map(|(i, _)| i)
        .collect();
    if let Some(&u_idx) = sn_matches
        .iter()
        .find(|&&i| !candidates[i].is_channel_active(sn_ch))
        .or_else(|| sn_matches.first())
    {
        if candidates[u_idx].is_channel_active(sn_ch) {
            return Err(build_already_open_err(u_idx, sn_ch));
        }
        return Ok((u_idx, sn_ch, logical_index_of(u_idx, sn_ch)));
    }

    let available_summary: Vec<String> = (0..candidates.len())
        .flat_map(|u_idx| {
            let c = &candidates[u_idx];
            (0..c.num_channels.max(1)).map(move |ch| {
                let flat = logical_index_of(u_idx, ch as u8);
                format!("gs_usb:{flat} ({})", c.human_location)
            })
        })
        .collect();

    Err(AdapterError::DeviceNotFound(format!(
        "gs_usb channel '{selector}' did not match any of the {} connected candleLight USB adapter(s). Available channels: {}",
        candidates.len(),
        available_summary.join(", ")
    )))
}

/// Cross-OS `gs_usb` / `candleLight` driver (`nusb` Direct USB on Windows, macOS, and Linux usbfs,
/// with smart SocketCAN routing on Linux when `gs_usb.ko` already exposes `can*`).
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
            display_name: format!("[gs_usb:{ch}] USB Direct candleLight / gs_usb"),
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
        let units = enumerate_connected_gs_usb_units();
        let mut out = Vec::new();
        let mut logical_idx = 0usize;

        for unit in units {
            let supports_fd_hint = true;

            if !unit.linux_socketcan_ifaces.is_empty() {
                for iface in &unit.linux_socketcan_ifaces {
                    out.push(DeviceDescriptorDto {
                        device_id: format!("gs_usb:{iface}"),
                        driver_id: "gs_usb".to_string(),
                        channel_name: iface.clone(),
                        display_name: format!(
                            "{iface} — {} ({}) @ {} [gs_usb]",
                            unit.product_name, unit.vid_pid, unit.human_location
                        ),
                        capabilities: AdapterCapabilitiesDto {
                            supports_fd: supports_fd_hint,
                            supports_listen_only: true,
                            supports_hw_timestamps: true,
                            max_bitrate: 8_000_000,
                            is_virtual: false,
                        },
                    });
                }
                logical_idx += unit.linux_socketcan_ifaces.len();
                continue;
            }

            let num_ch = if unit.dev_info.product_id() == 0x6070 {
                2usize
            } else {
                1usize
            };

            for hw_ch in 0..num_ch {
                let ch_str = logical_idx.to_string();
                let sn_label = unit
                    .serial_number
                    .as_deref()
                    .map(|s| format!(" S/N:{s}"))
                    .unwrap_or_default();
                let multi_suffix = if num_ch > 1 {
                    format!(" Ch {hw_ch}")
                } else {
                    String::new()
                };

                out.push(DeviceDescriptorDto {
                    device_id: format!("gs_usb:{ch_str}"),
                    driver_id: "gs_usb".to_string(),
                    channel_name: ch_str.clone(),
                    display_name: format!(
                        "[gs_usb:{ch_str}] {} {}{multi_suffix} ({}{sn_label}) @ {}",
                        unit.vendor_name, unit.product_name, unit.vid_pid, unit.human_location
                    ),
                    capabilities: AdapterCapabilitiesDto {
                        supports_fd: supports_fd_hint,
                        supports_listen_only: true,
                        supports_hw_timestamps: true,
                        max_bitrate: 8_000_000,
                        is_virtual: false,
                    },
                });
                logical_idx += 1;
            }
        }

        Ok(out)
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

        // 1. Linux Smart Routing: if requested_ch is a SocketCAN interface name (`can0`), or `"0"` when
        //    ONLY a single SocketCAN-bound `gs_usb` adapter exists, route cleanly via SocketCanDriver!
        //    Note: if multiple `gs_usb` adapters are attached and the user requests `"1"`, resolve the 2nd unit properly!
        #[cfg(target_os = "linux")]
        {
            let units = enumerate_connected_gs_usb_units();
            let sc_drv = SocketCanDriver::new();
            if let Ok(sc_devs) = sc_drv.discover_devices() {
                let is_gs_usb_sc = units
                    .iter()
                    .any(|u| u.linux_socketcan_ifaces.iter().any(|i| i == requested_ch));
                if is_gs_usb_sc {
                    if let Some(sc_desc) = sc_devs.iter().find(|d| d.channel_name == requested_ch) {
                        return sc_drv.open_channel(sc_desc, config);
                    }
                }

                if let Ok(req_idx) = requested_ch.trim_start_matches("gs_usb:").parse::<usize>() {
                    if let Some(target_unit) = units.get(req_idx) {
                        if let Some(sc_iface) = target_unit.linux_socketcan_ifaces.first() {
                            if let Some(sc_desc) =
                                sc_devs.iter().find(|d| d.channel_name == *sc_iface)
                            {
                                return sc_drv.open_channel(sc_desc, config);
                            }
                        }
                    }
                }
            }
        }

        // 2. Pure-Rust `nusb` Direct USB resolution (by logical index `"0"` / `"1"`, `"bus:port:addr"`, `"bus:addr"`, or serial!)
        let units = enumerate_connected_gs_usb_units();
        if units.is_empty() {
            if let Ok(mut all_usb) = nusb::list_devices() {
                if all_usb.any(|d| (d.vendor_id(), d.product_id()) == STM32_DFU_USB_ID) {
                    return Err(AdapterError::Driver(
                        "Detected STM32 DFU Bootloader (0483:DF11) instead of gs_usb / candleLight firmware! \
                         Unshort the BOOT0 jumper/button and power-cycle the CANable adapter, or flash candleLight_fw."
                            .to_string(),
                    ));
                }
            }

            let os_hint = if cfg!(target_os = "windows") {
                "Attach a candleLight / CANable / CANtact USB adapter (1D50:606F, 1209:2323) and bind WinUSB to Interface 0 via Zadig."
            } else if cfg!(target_os = "macos") {
                "Attach a candleLight / CANable / CANtact USB adapter (1D50:606F, 1209:2323); macOS IOKit connects driverlessly."
            } else {
                "Attach a candleLight / CANable / CANtact USB adapter (1D50:606F, 1209:2323); if using WSL2, pass it through via 'usbipd attach --wsl --busid <ID>'."
            };
            return Err(AdapterError::DeviceNotFound(format!(
                "No gs_usb / candleLight USB adapter ('{requested_ch}') detected on USB bus. {os_hint}"
            )));
        }

        let (target_unit, hw_ch, flat_logical_idx) = resolve_gs_usb_target(&units, requested_ch)?;
        let ch = GsUsbChannel::open_direct_usb(
            &target_unit.dev_info,
            hw_ch,
            flat_logical_idx,
            &target_unit.human_location,
            device,
            config,
        )?;
        Ok(Box::new(ch))
    }
}

fn resolve_gs_usb_target<'a>(
    units: &'a [EnumeratedGsUsbUnit],
    selector: &str,
) -> Result<(&'a EnumeratedGsUsbUnit, u8, usize), AdapterError> {
    let candidates: Vec<GsUsbTargetCandidate> = units
        .iter()
        .map(|u| GsUsbTargetCandidate {
            vid_pid: u.vid_pid.clone(),
            product_name: u.product_name.clone(),
            serial_number: u.serial_number.clone(),
            bus_number: u.dev_info.bus_number(),
            port_number: u.port_number,
            device_address: u.dev_info.device_address(),
            human_location: u.human_location.clone(),
            num_channels: if u.dev_info.product_id() == 0x6070 {
                2
            } else {
                1
            },
            active_channels_mask: active_gs_usb_channels_mask(u.dev_info.id()),
        })
        .collect();

    let (unit_idx, hw_ch, flat_logical_idx) = resolve_gs_usb_candidate(&candidates, selector)?;
    Ok((&units[unit_idx], hw_ch, flat_logical_idx))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_dual_clone_candidates(
        unit0_active_mask: u8,
        unit1_active_mask: u8,
    ) -> Vec<GsUsbTargetCandidate> {
        vec![
            GsUsbTargetCandidate {
                vid_pid: "1D50:606F".to_string(),
                product_name: "candleLight USB-CAN".to_string(),
                serial_number: Some("00000000001A".to_string()), // Identical clone serial!
                bus_number: 0, // Identical Windows bus_number = 0!
                port_number: Some(2),
                device_address: 1, // Identical Windows device_address = 1!
                human_location: "Bus 0 Port #2 Addr 1 [6&1111&0&2]".to_string(),
                num_channels: 1,
                active_channels_mask: unit0_active_mask,
            },
            GsUsbTargetCandidate {
                vid_pid: "1D50:606F".to_string(),
                product_name: "candleLight USB-CAN".to_string(),
                serial_number: Some("00000000001A".to_string()), // Identical clone serial!
                bus_number: 0, // Identical Windows bus_number = 0!
                port_number: Some(5),
                device_address: 1, // Identical Windows device_address = 1!
                human_location: "Bus 0 Port #5 Addr 1 [6&2222&0&5]".to_string(),
                num_channels: 1,
                active_channels_mask: unit1_active_mask,
            },
        ]
    }

    #[test]
    fn dual_identical_candlelight_clones_distinct_indices_and_actionable_already_open_hint() {
        // 1. Both units idle -> "0" resolves to Unit 0, "1" resolves to Unit 1
        let idle = make_dual_clone_candidates(0, 0);
        assert_eq!(resolve_gs_usb_candidate(&idle, "0").unwrap(), (0, 0, 0));
        assert_eq!(
            resolve_gs_usb_candidate(&idle, "gs_usb:0").unwrap(),
            (0, 0, 0)
        );
        assert_eq!(resolve_gs_usb_candidate(&idle, "1").unwrap(), (1, 0, 1));
        assert_eq!(
            resolve_gs_usb_candidate(&idle, "gs_usb:1").unwrap(),
            (1, 0, 1)
        );

        // 2. Unit 0 already connected on Bus 0 (`active_channels_mask = 0b1`):
        //    - Selecting "1" connects cleanly to Unit 1!
        //    - Selecting duplicate serial "00000000001A" or colliding "0:1" (`bus:addr`) automatically
        //      routes to the FREE Unit 1 instead of colliding with Unit 0!
        //    - Selecting `bus:port:addr` ("0:2:1" vs "0:5:1") targets the exact physical port!
        let unit0_busy = make_dual_clone_candidates(0b1, 0);
        assert_eq!(
            resolve_gs_usb_candidate(&unit0_busy, "1").unwrap(),
            (1, 0, 1)
        );
        assert_eq!(
            resolve_gs_usb_candidate(&unit0_busy, "00000000001A").unwrap(),
            (1, 0, 1),
            "duplicate clone serial must auto-select the non-active physical unit"
        );
        assert_eq!(
            resolve_gs_usb_candidate(&unit0_busy, "0:1").unwrap(),
            (1, 0, 1),
            "colliding Windows (bus=0, addr=1) selector must auto-select the free unit"
        );
        assert_eq!(
            resolve_gs_usb_candidate(&unit0_busy, "0:5:1").unwrap(),
            (1, 0, 1)
        );

        // 3. Hot-unplug / hot-replug index shift:
        //    When original Unit 0 was unplugged and replugged at Port #7 (sorting to index 1 while
        //    the surviving adapter shifted to index 0), requesting "0" MUST automatically select
        //    the free replugged Unit 1 `(1, 0, 1)`, and requesting "0" when BOTH units are active
        //    MUST return the "already connected" error!
        assert_eq!(
            resolve_gs_usb_candidate(&unit0_busy, "0").unwrap(),
            (1, 0, 1),
            "hot-replug index shift must auto-resolve numeric '0' to the free replugged unit 1"
        );
        let unit1_busy = make_dual_clone_candidates(0, 0b1);
        assert_eq!(
            resolve_gs_usb_candidate(&unit1_busy, "1").unwrap(),
            (0, 0, 0),
            "hot-replug index shift must auto-resolve numeric '1' to the free replugged unit 0"
        );

        let both_busy = make_dual_clone_candidates(0b1, 0b1);
        let both_err = resolve_gs_usb_candidate(&both_busy, "0").expect_err(
            "when ALL gs_usb channels are active, '0' must fail with already connected",
        );
        assert!(
            both_err.to_string().contains("already connected"),
            "unexpected msg: {both_err}"
        );

        // 4. Explicitly targeting an already-open physical USB port ("0:2:1") while Unit 1 is free
        //    MUST fail and point to the free '1' (gs_usb:1, Port #5) channel!
        let port_err = resolve_gs_usb_candidate(&unit0_busy, "0:2:1")
            .expect_err("explicitly targeting busy physical port 0:2:1 must fail");
        let msg = port_err.to_string();
        assert!(msg.contains("gs_usb:0"), "unexpected msg: {msg}");
        assert!(
            msg.contains("'1' (gs_usb:1"),
            "must suggest free channel '1' (gs_usb:1): {msg}"
        );
        assert!(
            msg.contains("Port #5"),
            "must display physical USB port of second adapter: {msg}"
        );
    }

    #[test]
    fn multi_channel_1d50_6070_plus_single_channel_flat_indexing() {
        let candidates = vec![
            GsUsbTargetCandidate {
                vid_pid: "1D50:6070".to_string(),
                product_name: "gs_usb Dual-Channel".to_string(),
                serial_number: None,
                bus_number: 1,
                port_number: Some(1),
                device_address: 2,
                human_location: "Bus 1 Port #1 Addr 2".to_string(),
                num_channels: 2,
                active_channels_mask: 0b01, // hw ch 0 open, hw ch 1 free!
            },
            GsUsbTargetCandidate {
                vid_pid: "1D50:606F".to_string(),
                product_name: "CANable 2.0".to_string(),
                serial_number: None,
                bus_number: 1,
                port_number: Some(4),
                device_address: 3,
                human_location: "Bus 1 Port #4 Addr 3".to_string(),
                num_channels: 1,
                active_channels_mask: 0,
            },
        ];

        // Numeric "0" auto-advances past active hw ch 0 to free hw ch 1 `(0, 1, 1)`
        assert_eq!(
            resolve_gs_usb_candidate(&candidates, "0").unwrap(),
            (0, 1, 1)
        );
        // Explicit topology selector `1:1:2:0` targets busy hw ch 0 and fails
        assert!(resolve_gs_usb_candidate(&candidates, "1:1:2:0").is_err());
        assert_eq!(
            resolve_gs_usb_candidate(&candidates, "1").unwrap(),
            (0, 1, 1)
        );
        assert_eq!(
            resolve_gs_usb_candidate(&candidates, "2").unwrap(),
            (1, 0, 2)
        );
    }
}
