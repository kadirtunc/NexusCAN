//! PEAK-System `PCAN-Basic` native backend loaded at runtime through `libloading`.
//!
//! - **Windows:** `PCANBasic.dll` (64-bit, `C:\Windows\System32` first, then the PEAK SDK folder,
//!   then the regular DLL search order).
//! - **Linux:** `libpcanbasic.so` (PEAK chardev driver + PCAN-Basic for Linux). Mainline
//!   `peak_usb` SocketCAN interfaces are routed to the SocketCAN driver before this backend.
//! - **macOS:** MacCAN `libPCBUSB.dylib` (PCAN-Basic compatible API).
//!
//! ### Guarantees
//! - The library is loaded lazily on first use. If it is missing the application still starts;
//!   every entry point returns a descriptive error instead. A successful load is cached for the
//!   process lifetime (the [`Library`] lives inside the `Arc`-shared [`PcanApi`], so every
//!   resolved function pointer is valid for as long as any [`PcanChannel`] exists). A failed load
//!   is NOT cached, so installing the PEAK driver does not require an application restart.
//! - **Listen-Only default (CLAUDE.md §3.4):** `PCAN_LISTEN_ONLY` is set BEFORE
//!   `CAN_Initialize*`, so the controller never ACKs a frame. If that is refused and the config
//!   requires hardware listen-only, the channel is never initialized.
//! - **Zero-allocation hot path:** `recv_batch` / `send_frame` only use stack `TPCANMsg*`
//!   structures and the caller's `&mut [RawCanFrame]`.
//! - **Bounded waits:** `recv_batch` polls `CAN_Read*` until `PCAN_ERROR_QRCVEMPTY`, then sleeps
//!   in `<= 1 ms` slices for at most `min(timeout_ms, 20)` ms (no busy spin, `< 25 ms` shutdown).
//!
//! Struct layouts and constants follow PEAK's `PCANBasic.h` (default C alignment, no packing).

#![allow(unsafe_code)]

use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, BusHealthSnapshot, BusState, CanChannel, CanFilter, ChannelConfig,
    DeviceDescriptor, ListenOnlyEnforcement,
};
use libloading::Library;
use nexus_core::{
    dlc_code_to_len, len_to_canfd_dlc_code, now_monotonic_us, BusId, RawCanFrame, EXT_CAN_ID_MASK,
    FLAG_BRS, FLAG_ESI, FLAG_EXTENDED, FLAG_FD, FLAG_HW_TIMESTAMP, FLAG_RTR, FLAG_TX,
    MAX_CAN_FD_DLC, MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
};
use parking_lot::Mutex;
use std::ffi::{c_char, c_void, CString};
use std::mem::{offset_of, size_of};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

// =============================================================================
// PCANBasic.h constants
// =============================================================================

/// `TPCANHandle` (`WORD`).
pub type TpcanHandle = u16;
/// `TPCANStatus` (`DWORD`).
pub type TpcanStatus = u32;

/// Undefined / default channel used for global parameters (`PCAN_NONEBUS`).
pub const PCAN_NONEBUS: TpcanHandle = 0x00;

/// No error.
pub const PCAN_ERROR_OK: TpcanStatus = 0x0000_0000;
/// Transmit buffer in CAN controller is full.
pub const PCAN_ERROR_XMTFULL: TpcanStatus = 0x0000_0001;
/// CAN controller was read too late.
pub const PCAN_ERROR_OVERRUN: TpcanStatus = 0x0000_0002;
/// Bus error: an error counter reached the 'light' limit.
pub const PCAN_ERROR_BUSLIGHT: TpcanStatus = 0x0000_0004;
/// Bus error: an error counter reached the 'heavy' / warning limit.
pub const PCAN_ERROR_BUSHEAVY: TpcanStatus = 0x0000_0008;
/// Alias of [`PCAN_ERROR_BUSHEAVY`].
pub const PCAN_ERROR_BUSWARNING: TpcanStatus = PCAN_ERROR_BUSHEAVY;
/// Bus error: the CAN controller is error passive.
pub const PCAN_ERROR_BUSPASSIVE: TpcanStatus = 0x0004_0000;
/// Bus error: the CAN controller is in bus-off state.
pub const PCAN_ERROR_BUSOFF: TpcanStatus = 0x0000_0010;
/// Mask for all bus errors.
pub const PCAN_ERROR_ANYBUSERR: TpcanStatus = PCAN_ERROR_BUSWARNING
    | PCAN_ERROR_BUSLIGHT
    | PCAN_ERROR_BUSHEAVY
    | PCAN_ERROR_BUSOFF
    | PCAN_ERROR_BUSPASSIVE;
/// Receive queue is empty.
pub const PCAN_ERROR_QRCVEMPTY: TpcanStatus = 0x0000_0020;
/// Receive queue was read too late.
pub const PCAN_ERROR_QOVERRUN: TpcanStatus = 0x0000_0040;
/// Transmit queue is full.
pub const PCAN_ERROR_QXMTFULL: TpcanStatus = 0x0000_0080;
/// Test of the CAN controller hardware registers failed.
pub const PCAN_ERROR_REGTEST: TpcanStatus = 0x0000_0100;
/// Driver not loaded.
pub const PCAN_ERROR_NODRIVER: TpcanStatus = 0x0000_0200;
/// Hardware already in use by a Net (value inside the [`PCAN_ERROR_ILLHANDLE`] field).
pub const PCAN_ERROR_HWINUSE: TpcanStatus = 0x0000_0400;
/// A client is already connected to the Net (value inside the [`PCAN_ERROR_ILLHANDLE`] field).
pub const PCAN_ERROR_NETINUSE: TpcanStatus = 0x0000_0800;
/// Hardware handle is invalid / not attached (value inside the [`PCAN_ERROR_ILLHANDLE`] field).
pub const PCAN_ERROR_ILLHW: TpcanStatus = 0x0000_1400;
/// Net handle is invalid.
pub const PCAN_ERROR_ILLNET: TpcanStatus = 0x0000_1800;
/// Client handle is invalid.
pub const PCAN_ERROR_ILLCLIENT: TpcanStatus = 0x0000_1C00;
/// Mask of the handle-error field (`ILLHW | ILLNET | ILLCLIENT`). Values inside this field are
/// enumerated codes, not independent bits.
pub const PCAN_ERROR_ILLHANDLE: TpcanStatus =
    PCAN_ERROR_ILLHW | PCAN_ERROR_ILLNET | PCAN_ERROR_ILLCLIENT;
/// Resource (FIFO, Client, timeout) cannot be created.
pub const PCAN_ERROR_RESOURCE: TpcanStatus = 0x0000_2000;
/// Invalid parameter.
pub const PCAN_ERROR_ILLPARAMTYPE: TpcanStatus = 0x0000_4000;
/// Invalid parameter value.
pub const PCAN_ERROR_ILLPARAMVAL: TpcanStatus = 0x0000_8000;
/// Unknown error.
pub const PCAN_ERROR_UNKNOWN: TpcanStatus = 0x0001_0000;
/// Invalid data, function, or action.
pub const PCAN_ERROR_ILLDATA: TpcanStatus = 0x0002_0000;
/// Driver object state is wrong for the attempted operation.
pub const PCAN_ERROR_ILLMODE: TpcanStatus = 0x0008_0000;
/// Operation succeeded but irregularities were registered (e.g. bitrate differs from the one
/// already in use by PCAN-View).
pub const PCAN_ERROR_CAUTION: TpcanStatus = 0x0200_0000;
/// Channel is not initialized / already initialized.
pub const PCAN_ERROR_INITIALIZE: TpcanStatus = 0x0400_0000;
/// Invalid operation.
pub const PCAN_ERROR_ILLOPERATION: TpcanStatus = 0x0800_0000;

/// `PCAN_DEVICE_ID` parameter (`DWORD`).
pub const PCAN_DEVICE_ID: u8 = 0x01;
/// `PCAN_MESSAGE_FILTER` parameter (`DWORD`, `PCAN_FILTER_*`).
pub const PCAN_MESSAGE_FILTER: u8 = 0x04;
/// `PCAN_BUSOFF_AUTORESET` parameter (`DWORD`, `PCAN_PARAMETER_ON/OFF`).
pub const PCAN_BUSOFF_AUTORESET: u8 = 0x07;
/// `PCAN_LISTEN_ONLY` parameter (`DWORD`, `PCAN_PARAMETER_ON/OFF`; settable before init).
pub const PCAN_LISTEN_ONLY: u8 = 0x08;
/// `PCAN_CHANNEL_CONDITION` parameter (`DWORD`, `PCAN_CHANNEL_*`).
pub const PCAN_CHANNEL_CONDITION: u8 = 0x0D;
/// `PCAN_HARDWARE_NAME` parameter (`char[MAX_LENGTH_HARDWARE_NAME]`).
pub const PCAN_HARDWARE_NAME: u8 = 0x0E;
/// `PCAN_CHANNEL_FEATURES` parameter (`DWORD`, `FEATURE_*`).
pub const PCAN_CHANNEL_FEATURES: u8 = 0x16;
/// `PCAN_ATTACHED_CHANNELS_COUNT` parameter (`DWORD`, queried on [`PCAN_NONEBUS`]).
pub const PCAN_ATTACHED_CHANNELS_COUNT: u8 = 0x2A;
/// `PCAN_ATTACHED_CHANNELS` parameter (`TPCANChannelInformation[]`, queried on [`PCAN_NONEBUS`]).
pub const PCAN_ATTACHED_CHANNELS: u8 = 0x2B;

/// Parameter value: off.
pub const PCAN_PARAMETER_OFF: u32 = 0x00;
/// Parameter value: on.
pub const PCAN_PARAMETER_ON: u32 = 0x01;
/// Message filter: closed (no frames pass).
pub const PCAN_FILTER_CLOSE: u32 = 0x00;
/// Message filter: fully open (all frames pass).
pub const PCAN_FILTER_OPEN: u32 = 0x01;

/// Channel condition: not available.
pub const PCAN_CHANNEL_UNAVAILABLE: u32 = 0x00;
/// Channel condition: available, can be initialized.
pub const PCAN_CHANNEL_AVAILABLE: u32 = 0x01;
/// Channel condition: in use by another application.
pub const PCAN_CHANNEL_OCCUPIED: u32 = 0x02;
/// Channel condition: in use by PCAN-View, but can still be connected (shared).
pub const PCAN_CHANNEL_PCANVIEW: u32 = PCAN_CHANNEL_AVAILABLE | PCAN_CHANNEL_OCCUPIED;

/// Channel feature: CAN-FD capable.
pub const FEATURE_FD_CAPABLE: u32 = 0x01;

/// `MAX_LENGTH_HARDWARE_NAME` (32 characters + terminator).
pub const MAX_LENGTH_HARDWARE_NAME: usize = 33;

/// Message type: standard 11-bit data frame.
pub const PCAN_MESSAGE_STANDARD: u8 = 0x00;
/// Message type: remote request.
pub const PCAN_MESSAGE_RTR: u8 = 0x01;
/// Message type: extended 29-bit ID.
pub const PCAN_MESSAGE_EXTENDED: u8 = 0x02;
/// Message type: CAN-FD frame.
pub const PCAN_MESSAGE_FD: u8 = 0x04;
/// Message type: CAN-FD bit rate switch.
pub const PCAN_MESSAGE_BRS: u8 = 0x08;
/// Message type: CAN-FD error state indicator.
pub const PCAN_MESSAGE_ESI: u8 = 0x10;
/// Message type: echo of a frame sent by this client.
pub const PCAN_MESSAGE_ECHO: u8 = 0x20;
/// Message type: error frame.
pub const PCAN_MESSAGE_ERRFRAME: u8 = 0x40;
/// Message type: PCAN status message.
pub const PCAN_MESSAGE_STATUS: u8 = 0x80;

/// `CAN_FilterMessages` mode: 11-bit IDs.
pub const PCAN_MODE_STANDARD: u8 = PCAN_MESSAGE_STANDARD;
/// `CAN_FilterMessages` mode: 29-bit IDs.
pub const PCAN_MODE_EXTENDED: u8 = PCAN_MESSAGE_EXTENDED;

/// `CAN_GetErrorText` language: English.
const PCAN_LANGUAGE_ENGLISH: u16 = 0x09;
/// `CAN_GetErrorText` requires a buffer of at least 256 bytes.
const PCAN_ERROR_TEXT_LEN: usize = 256;

/// CAN-FD controller clock used for the generated `TPCANBitrateFD` strings.
pub const PCAN_FD_CLOCK_HZ: u32 = 80_000_000;

/// `recv_batch` never waits longer than this, regardless of the caller's timeout.
const MAX_RECV_WAIT_MS: u32 = 20;

// =============================================================================
// PCANBasic.h structures (default C alignment)
// =============================================================================

/// `TPCANMsg` — Classical CAN message.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TpcanMsg {
    /// 11/29-bit message identifier.
    pub id: u32,
    /// `PCAN_MESSAGE_*` bitmask.
    pub msgtype: u8,
    /// Data length code (`0..=8`).
    pub len: u8,
    /// Payload.
    pub data: [u8; 8],
}

/// `TPCANTimestamp` — receive timestamp of a Classical CAN message.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TpcanTimestamp {
    /// Base value: milliseconds `0 .. 2^32 - 1`.
    pub millis: u32,
    /// Roll-arounds of `millis`.
    pub millis_overflow: u16,
    /// Microseconds `0..999`.
    pub micros: u16,
}

/// `TPCANMsgFD` — CAN-FD message.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TpcanMsgFd {
    /// 11/29-bit message identifier.
    pub id: u32,
    /// `PCAN_MESSAGE_*` bitmask.
    pub msgtype: u8,
    /// ISO 11898-1 DLC code (`0..=15`).
    pub dlc: u8,
    /// Payload.
    pub data: [u8; 64],
}

impl Default for TpcanMsgFd {
    fn default() -> Self {
        Self {
            id: 0,
            msgtype: 0,
            dlc: 0,
            data: [0u8; 64],
        }
    }
}

/// `TPCANChannelInformation` — one entry of `PCAN_ATTACHED_CHANNELS`.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TpcanChannelInformation {
    /// PCAN channel handle.
    pub channel_handle: TpcanHandle,
    /// Kind of PCAN device (`TPCANDevice`).
    pub device_type: u8,
    /// CAN controller number.
    pub controller_number: u8,
    /// Device capabilities flags (`FEATURE_*`).
    pub device_features: u32,
    /// NUL-terminated device name.
    pub device_name: [u8; MAX_LENGTH_HARDWARE_NAME],
    /// Device number.
    pub device_id: u32,
    /// Availability status (`PCAN_CHANNEL_*`).
    pub channel_condition: u32,
}

impl Default for TpcanChannelInformation {
    fn default() -> Self {
        Self {
            channel_handle: 0,
            device_type: 0,
            controller_number: 0,
            device_features: 0,
            device_name: [0u8; MAX_LENGTH_HARDWARE_NAME],
            device_id: 0,
            channel_condition: 0,
        }
    }
}

// Compile-time ABI checks against PCANBasic.h (default alignment).
const _: () = {
    assert!(size_of::<TpcanMsg>() == 16);
    assert!(offset_of!(TpcanMsg, msgtype) == 4);
    assert!(offset_of!(TpcanMsg, len) == 5);
    assert!(offset_of!(TpcanMsg, data) == 6);
    assert!(size_of::<TpcanTimestamp>() == 8);
    assert!(offset_of!(TpcanTimestamp, millis_overflow) == 4);
    assert!(offset_of!(TpcanTimestamp, micros) == 6);
    assert!(size_of::<TpcanMsgFd>() == 72);
    assert!(offset_of!(TpcanMsgFd, msgtype) == 4);
    assert!(offset_of!(TpcanMsgFd, dlc) == 5);
    assert!(offset_of!(TpcanMsgFd, data) == 6);
    assert!(size_of::<TpcanChannelInformation>() == 52);
    assert!(offset_of!(TpcanChannelInformation, device_type) == 2);
    assert!(offset_of!(TpcanChannelInformation, controller_number) == 3);
    assert!(offset_of!(TpcanChannelInformation, device_features) == 4);
    assert!(offset_of!(TpcanChannelInformation, device_name) == 8);
    assert!(offset_of!(TpcanChannelInformation, device_id) == 44);
    assert!(offset_of!(TpcanChannelInformation, channel_condition) == 48);
};

// =============================================================================
// Runtime-loaded API table
// =============================================================================

type FnInitialize = unsafe extern "system" fn(TpcanHandle, u16, u8, u32, u16) -> TpcanStatus;
type FnInitializeFd = unsafe extern "system" fn(TpcanHandle, *const c_char) -> TpcanStatus;
type FnUninitialize = unsafe extern "system" fn(TpcanHandle) -> TpcanStatus;
type FnRead =
    unsafe extern "system" fn(TpcanHandle, *mut TpcanMsg, *mut TpcanTimestamp) -> TpcanStatus;
type FnReadFd = unsafe extern "system" fn(TpcanHandle, *mut TpcanMsgFd, *mut u64) -> TpcanStatus;
type FnWrite = unsafe extern "system" fn(TpcanHandle, *mut TpcanMsg) -> TpcanStatus;
type FnWriteFd = unsafe extern "system" fn(TpcanHandle, *mut TpcanMsgFd) -> TpcanStatus;
type FnGetStatus = unsafe extern "system" fn(TpcanHandle) -> TpcanStatus;
type FnValue = unsafe extern "system" fn(TpcanHandle, u8, *mut c_void, u32) -> TpcanStatus;
type FnGetErrorText = unsafe extern "system" fn(TpcanStatus, u16, *mut c_char) -> TpcanStatus;
type FnFilterMessages = unsafe extern "system" fn(TpcanHandle, u32, u32, u8) -> TpcanStatus;

/// Resolved PCAN-Basic entry points. The owning [`Library`] is stored alongside, so every
/// function pointer stays valid for the lifetime of this struct.
pub struct PcanApi {
    initialize: FnInitialize,
    initialize_fd: Option<FnInitializeFd>,
    uninitialize: FnUninitialize,
    read: FnRead,
    read_fd: Option<FnReadFd>,
    write: FnWrite,
    write_fd: Option<FnWriteFd>,
    get_status: FnGetStatus,
    get_value: FnValue,
    set_value: FnValue,
    get_error_text: FnGetErrorText,
    filter_messages: Option<FnFilterMessages>,
    library_path: String,
    _library: Library,
}

impl std::fmt::Debug for PcanApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PcanApi")
            .field("library_path", &self.library_path)
            .field("fd_api", &self.has_fd_api())
            .finish()
    }
}

/// Resolves `name` from `lib` as a function pointer of type `T`.
///
/// # Safety
/// `T` must be the exact `extern "system"` function pointer type of the exported symbol.
unsafe fn resolve<T: Copy>(lib: &Library, name: &str) -> Result<T, String> {
    let mut sym_name = Vec::with_capacity(name.len() + 1);
    sym_name.extend_from_slice(name.as_bytes());
    sym_name.push(0);
    // SAFETY: the caller guarantees `T` matches the C prototype of `name`; the returned
    // pointer is copied out and only used while `lib` (stored in `PcanApi`) is alive.
    let sym =
        unsafe { lib.get::<T>(&sym_name) }.map_err(|e| format!("missing symbol {name}: {e}"))?;
    Ok(*sym)
}

impl PcanApi {
    fn from_library(library: Library, library_path: String) -> Result<Self, String> {
        // SAFETY: every type below matches the PCANBasic.h prototype of the named export
        // (`extern "system"` = `__stdcall` on Win32, C ABI elsewhere).
        unsafe {
            Ok(Self {
                initialize: resolve(&library, "CAN_Initialize")?,
                initialize_fd: resolve(&library, "CAN_InitializeFD").ok(),
                uninitialize: resolve(&library, "CAN_Uninitialize")?,
                read: resolve(&library, "CAN_Read")?,
                read_fd: resolve(&library, "CAN_ReadFD").ok(),
                write: resolve(&library, "CAN_Write")?,
                write_fd: resolve(&library, "CAN_WriteFD").ok(),
                get_status: resolve(&library, "CAN_GetStatus")?,
                get_value: resolve(&library, "CAN_GetValue")?,
                set_value: resolve(&library, "CAN_SetValue")?,
                get_error_text: resolve(&library, "CAN_GetErrorText")?,
                filter_messages: resolve(&library, "CAN_FilterMessages").ok(),
                library_path,
                _library: library,
            })
        }
    }

    /// Path / name the library was loaded from.
    pub fn library_path(&self) -> &str {
        &self.library_path
    }

    /// `true` when `CAN_InitializeFD`, `CAN_ReadFD` and `CAN_WriteFD` are all exported.
    pub fn has_fd_api(&self) -> bool {
        self.initialize_fd.is_some() && self.read_fd.is_some() && self.write_fd.is_some()
    }

    /// Human-readable text for a `TPCANStatus` (`CAN_GetErrorText`, English), always suffixed
    /// with the hex code. Falls back to a built-in name table if the DLL call fails.
    pub fn error_text(&self, status: TpcanStatus) -> String {
        let mut buf = [0 as c_char; PCAN_ERROR_TEXT_LEN];
        // SAFETY: PCAN-Basic writes a NUL-terminated string of at most 256 bytes into `buf`.
        let rc = unsafe { (self.get_error_text)(status, PCAN_LANGUAGE_ENGLISH, buf.as_mut_ptr()) };
        if rc == PCAN_ERROR_OK {
            let bytes: Vec<u8> = buf
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as u8)
                .collect();
            let text = String::from_utf8_lossy(&bytes).trim().to_string();
            if !text.is_empty() {
                return format!("{text} (0x{status:X})");
            }
        }
        format!("{} (0x{status:X})", pcan_status_name(status))
    }

    /// `CAN_GetValue` for a `DWORD` parameter.
    pub fn get_u32(&self, handle: TpcanHandle, param: u8) -> Result<u32, TpcanStatus> {
        let mut value: u32 = 0;
        // SAFETY: `value` is a valid, writable 4-byte buffer and its exact size is passed.
        let st = unsafe {
            (self.get_value)(
                handle,
                param,
                (&mut value as *mut u32).cast::<c_void>(),
                size_of::<u32>() as u32,
            )
        };
        if st == PCAN_ERROR_OK {
            Ok(value)
        } else {
            Err(st)
        }
    }

    /// `CAN_SetValue` for a `DWORD` parameter.
    pub fn set_u32(&self, handle: TpcanHandle, param: u8, value: u32) -> Result<(), TpcanStatus> {
        let mut v = value;
        // SAFETY: `v` is a valid 4-byte buffer and its exact size is passed.
        let st = unsafe {
            (self.set_value)(
                handle,
                param,
                (&mut v as *mut u32).cast::<c_void>(),
                size_of::<u32>() as u32,
            )
        };
        if st == PCAN_ERROR_OK {
            Ok(())
        } else {
            Err(st)
        }
    }

    /// `CAN_GetStatus`.
    pub fn status(&self, handle: TpcanHandle) -> TpcanStatus {
        // SAFETY: plain value call; an invalid handle yields an error status, not UB.
        unsafe { (self.get_status)(handle) }
    }

    fn hardware_name(&self, handle: TpcanHandle) -> Option<String> {
        let mut buf = [0u8; MAX_LENGTH_HARDWARE_NAME];
        // SAFETY: `buf` is writable and its exact length is passed as the buffer size.
        let st = unsafe {
            (self.get_value)(
                handle,
                PCAN_HARDWARE_NAME,
                buf.as_mut_ptr().cast::<c_void>(),
                buf.len() as u32,
            )
        };
        (st == PCAN_ERROR_OK).then(|| c_bytes_to_string(&buf))
    }

    /// Lists every attached PCAN channel (`PCAN_ATTACHED_CHANNELS`), falling back to a
    /// `PCAN_CHANNEL_CONDITION` scan of the USB / PCI handles on PCAN-Basic versions that do
    /// not know the attached-channels parameters (e.g. older DLLs, MacCAN PCBUSB).
    pub fn enumerate_attached(&self) -> Vec<PcanAttachedChannel> {
        match self.enumerate_via_attached_channels() {
            Ok(list) => list,
            Err(_) => self.enumerate_via_condition_scan(),
        }
    }

    fn enumerate_via_attached_channels(&self) -> Result<Vec<PcanAttachedChannel>, TpcanStatus> {
        let count = self.get_u32(PCAN_NONEBUS, PCAN_ATTACHED_CHANNELS_COUNT)?;
        if count == 0 {
            return Ok(Vec::new());
        }
        // Headroom for a device plugged in between the two calls; unused entries stay zeroed
        // (handle 0) and are filtered out below.
        let slots = (count as usize).min(64) + 4;
        let mut buf = vec![TpcanChannelInformation::default(); slots];
        // SAFETY: `buf` holds `slots` contiguous `TPCANChannelInformation` entries with
        // PCANBasic.h layout (checked at compile time); the exact byte size is passed.
        let st = unsafe {
            (self.get_value)(
                PCAN_NONEBUS,
                PCAN_ATTACHED_CHANNELS,
                buf.as_mut_ptr().cast::<c_void>(),
                (slots * size_of::<TpcanChannelInformation>()) as u32,
            )
        };
        if st != PCAN_ERROR_OK {
            return Err(st);
        }
        Ok(buf
            .iter()
            .filter(|info| info.channel_handle != PCAN_NONEBUS)
            .filter(|info| info.channel_condition != PCAN_CHANNEL_UNAVAILABLE)
            .map(PcanAttachedChannel::from_info)
            .collect())
    }

    fn enumerate_via_condition_scan(&self) -> Vec<PcanAttachedChannel> {
        let mut out = Vec::new();
        for handle in PCAN_USB_HANDLES.iter().chain(PCAN_PCI_HANDLES.iter()) {
            let Ok(condition) = self.get_u32(*handle, PCAN_CHANNEL_CONDITION) else {
                continue;
            };
            if condition & (PCAN_CHANNEL_AVAILABLE | PCAN_CHANNEL_OCCUPIED) == 0 {
                continue;
            }
            out.push(PcanAttachedChannel {
                handle: *handle,
                channel_name: pcan_channel_name_from_handle(*handle),
                device_type: 0,
                controller_number: 0,
                device_features: self.get_u32(*handle, PCAN_CHANNEL_FEATURES).unwrap_or(0),
                device_name: self.hardware_name(*handle).unwrap_or_default(),
                device_id: self.get_u32(*handle, PCAN_DEVICE_ID).unwrap_or(0),
                condition,
            });
        }
        out
    }
}

static PCAN_API: Mutex<Option<Arc<PcanApi>>> = parking_lot::const_mutex(None);

/// Library names / absolute paths tried in order (absolute paths first to avoid DLL search
/// order hijacking; the bare name last lets the OS loader find non-standard installs).
pub fn pcan_library_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &[
            r"C:\Windows\System32\PCANBasic.dll",
            r"C:\Program Files\PEAK-System\PCAN-Basic API\x64\PCANBasic.dll",
            "PCANBasic.dll",
        ]
    }
    #[cfg(target_os = "macos")]
    {
        &[
            "/opt/homebrew/lib/libPCBUSB.dylib",
            "/usr/local/lib/libPCBUSB.dylib",
            "/Library/Frameworks/PCBUSB.framework/PCBUSB",
            "libPCBUSB.dylib",
        ]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        &[
            "/usr/lib/libpcanbasic.so",
            "/usr/local/lib/libpcanbasic.so",
            "/usr/lib/x86_64-linux-gnu/libpcanbasic.so",
            "/usr/lib/aarch64-linux-gnu/libpcanbasic.so",
            "libpcanbasic.so",
        ]
    }
}

/// Loads (once) and returns the shared PCAN-Basic API table.
///
/// Successful loads are cached for the process lifetime; failures are retried on the next call
/// so a driver installed while NexusCAN runs is picked up without a restart.
pub fn pcan_api() -> Result<Arc<PcanApi>, String> {
    let mut guard = PCAN_API.lock();
    if let Some(api) = guard.as_ref() {
        return Ok(Arc::clone(api));
    }
    let mut errors = Vec::new();
    for candidate in pcan_library_candidates() {
        let is_path = candidate.contains('/') || candidate.contains('\\');
        if is_path && !std::path::Path::new(candidate).exists() {
            continue;
        }
        // SAFETY: loading the vendor PCAN-Basic library runs its initialization routines;
        // this is the documented way to use PCAN-Basic and is done at most once per process.
        match unsafe { Library::new(candidate) } {
            Ok(lib) => match PcanApi::from_library(lib, (*candidate).to_string()) {
                Ok(api) => {
                    let api = Arc::new(api);
                    *guard = Some(Arc::clone(&api));
                    return Ok(api);
                }
                Err(e) => errors.push(format!("{candidate}: {e}")),
            },
            Err(e) => errors.push(format!("{candidate}: {e}")),
        }
    }
    if errors.is_empty() {
        Err(format!(
            "PCAN-Basic library not found (searched: {})",
            pcan_library_candidates().join(", ")
        ))
    } else {
        Err(format!(
            "PCAN-Basic library could not be loaded ({})",
            errors.join("; ")
        ))
    }
}

/// Enumerates the PCAN channels that are actually attached to this host.
///
/// Returns `Err` only if the PCAN-Basic library cannot be loaded.
pub fn pcan_enumerate_attached() -> Result<Vec<PcanAttachedChannel>, String> {
    Ok(pcan_api()?.enumerate_attached())
}

/// One attached PCAN channel as reported by PCAN-Basic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PcanAttachedChannel {
    pub handle: TpcanHandle,
    /// Canonical channel name (`"PCAN_USBBUS1"`).
    pub channel_name: String,
    pub device_type: u8,
    pub controller_number: u8,
    pub device_features: u32,
    /// Device name (`"PCAN-USB FD"`); may be empty.
    pub device_name: String,
    pub device_id: u32,
    /// `PCAN_CHANNEL_*` condition.
    pub condition: u32,
}

impl PcanAttachedChannel {
    fn from_info(info: &TpcanChannelInformation) -> Self {
        Self {
            handle: info.channel_handle,
            channel_name: pcan_channel_name_from_handle(info.channel_handle),
            device_type: info.device_type,
            controller_number: info.controller_number,
            device_features: info.device_features,
            device_name: c_bytes_to_string(&info.device_name),
            device_id: info.device_id,
            condition: info.channel_condition,
        }
    }

    /// `true` if the channel is CAN-FD capable (`FEATURE_FD_CAPABLE`).
    pub const fn supports_fd(&self) -> bool {
        self.device_features & FEATURE_FD_CAPABLE != 0
    }

    /// `true` if this client can initialize the channel (`AVAILABLE` or shared `PCANVIEW`).
    pub const fn is_connectable(&self) -> bool {
        self.condition & PCAN_CHANNEL_AVAILABLE != 0
    }

    /// `true` if exclusively occupied by another application (not connectable).
    pub const fn is_occupied_exclusive(&self) -> bool {
        self.condition == PCAN_CHANNEL_OCCUPIED
    }

    /// Probe state string: `"up"` when free, `"occupied"` when in use (also by PCAN-View).
    pub const fn state_str(&self) -> &'static str {
        if self.condition == PCAN_CHANNEL_AVAILABLE {
            "up"
        } else {
            "occupied"
        }
    }

    /// UI label, e.g. `"PCAN_USBBUS1 — PCAN-USB FD (ID 0x1)"`.
    pub fn label(&self) -> String {
        let name = if self.device_name.is_empty() {
            "PEAK PCAN device"
        } else {
            self.device_name.as_str()
        };
        let suffix = match self.condition {
            PCAN_CHANNEL_OCCUPIED => " [in use by another application]",
            PCAN_CHANNEL_PCANVIEW => " [shared with PCAN-View]",
            _ => "",
        };
        format!(
            "{} — {name} (ID 0x{:X}){suffix}",
            self.channel_name, self.device_id
        )
    }
}

fn c_bytes_to_string(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

// =============================================================================
// Pure helpers (unit-tested without hardware)
// =============================================================================

/// `PCAN_USBBUS1..16`.
pub const PCAN_USB_HANDLES: [TpcanHandle; 16] = [
    0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x509, 0x50A, 0x50B, 0x50C, 0x50D, 0x50E,
    0x50F, 0x510,
];
/// `PCAN_PCIBUS1..16`.
pub const PCAN_PCI_HANDLES: [TpcanHandle; 16] = [
    0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x409, 0x40A, 0x40B, 0x40C, 0x40D, 0x40E,
    0x40F, 0x410,
];
/// `PCAN_LANBUS1..16`.
pub const PCAN_LAN_HANDLES: [TpcanHandle; 16] = [
    0x801, 0x802, 0x803, 0x804, 0x805, 0x806, 0x807, 0x808, 0x809, 0x80A, 0x80B, 0x80C, 0x80D,
    0x80E, 0x80F, 0x810,
];

const HANDLE_FAMILIES: [(&str, &[TpcanHandle; 16]); 3] = [
    ("USBBUS", &PCAN_USB_HANDLES),
    ("PCIBUS", &PCAN_PCI_HANDLES),
    ("LANBUS", &PCAN_LAN_HANDLES),
];

/// Parses a channel name (`"PCAN_USBBUS1"`, `"usbbus3"`, `"pcan:PCAN_PCIBUS2"`) or a numeric
/// handle (`"0x51"`, `"81"`) into a `TPCANHandle`. `PCAN_NONEBUS` (0) is rejected.
pub fn pcan_channel_handle_from_name(name: &str) -> Option<TpcanHandle> {
    let s = name.trim();
    let s = s.strip_prefix("pcan:").unwrap_or(s).trim();
    if s.is_empty() {
        return None;
    }
    let upper = s.to_ascii_uppercase();

    let numeric = if let Some(hex) = upper.strip_prefix("0X") {
        u16::from_str_radix(hex, 16).ok()
    } else if upper.bytes().all(|b| b.is_ascii_digit()) {
        upper.parse::<u16>().ok()
    } else {
        None
    };
    if let Some(h) = numeric {
        return (h != PCAN_NONEBUS).then_some(h);
    }

    let body = upper.strip_prefix("PCAN_").unwrap_or(&upper);
    for (prefix, handles) in HANDLE_FAMILIES {
        if let Some(idx) = body.strip_prefix(prefix) {
            let n: usize = idx.parse().ok()?;
            return (1..=16).contains(&n).then(|| handles[n - 1]);
        }
    }
    None
}

/// Canonical channel name for a handle (`0x51` → `"PCAN_USBBUS1"`); unknown handles are
/// rendered as `"0x<hex>"` (accepted back by [`pcan_channel_handle_from_name`]).
pub fn pcan_channel_name_from_handle(handle: TpcanHandle) -> String {
    for (prefix, handles) in HANDLE_FAMILIES {
        if let Some(pos) = handles.iter().position(|&h| h == handle) {
            return format!("PCAN_{prefix}{}", pos + 1);
        }
    }
    format!("0x{handle:X}")
}

/// Classical CAN `BTR0BTR1` register value (`PCAN_BAUD_*`) for a nominal bitrate.
pub const fn pcan_btr0btr1_for_bitrate(bitrate: u32) -> Option<u16> {
    match bitrate {
        1_000_000 => Some(0x0014),
        800_000 => Some(0x0016),
        500_000 => Some(0x001C),
        250_000 => Some(0x011C),
        125_000 => Some(0x031C),
        100_000 => Some(0x432F),
        95_000 | 95_238 => Some(0xC34E),
        83_000 | 83_333 => Some(0x852B),
        50_000 => Some(0x472F),
        47_000 | 47_619 => Some(0x1414),
        33_000 | 33_333 => Some(0x8B2F),
        20_000 => Some(0x532F),
        10_000 => Some(0x672F),
        5_000 => Some(0x7F7F),
        _ => None,
    }
}

/// CAN-FD bit timing for an 80 MHz PCAN-FD controller clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PcanFdTiming {
    pub nom_brp: u32,
    pub nom_tseg1: u32,
    pub nom_tseg2: u32,
    pub nom_sjw: u32,
    pub data_brp: u32,
    pub data_tseg1: u32,
    pub data_tseg2: u32,
    pub data_sjw: u32,
}

impl PcanFdTiming {
    /// `TPCANBitrateFD` string for `CAN_InitializeFD`.
    pub fn to_bitrate_string(&self) -> String {
        format!(
            "f_clock_mhz={}, nom_brp={}, nom_tseg1={}, nom_tseg2={}, nom_sjw={}, data_brp={}, data_tseg1={}, data_tseg2={}, data_sjw={}",
            PCAN_FD_CLOCK_HZ / 1_000_000,
            self.nom_brp,
            self.nom_tseg1,
            self.nom_tseg2,
            self.nom_sjw,
            self.data_brp,
            self.data_tseg1,
            self.data_tseg2,
            self.data_sjw
        )
    }
}

/// PCAN-Basic FD segment limits.
struct PhaseLimits {
    tseg1_max: u32,
    tseg2_max: u32,
    sjw_max: u32,
}

const NOMINAL_LIMITS: PhaseLimits = PhaseLimits {
    tseg1_max: 256,
    tseg2_max: 128,
    sjw_max: 128,
};
const DATA_LIMITS: PhaseLimits = PhaseLimits {
    tseg1_max: 32,
    tseg2_max: 16,
    sjw_max: 16,
};
const MAX_BRP: u32 = 1024;
/// Preferred upper bound of time quanta per data bit (keeps the data phase on the same,
/// reasonably coarse prescaler as PEAK's reference presets, e.g. 500k/2M → brp 2).
const PREFERRED_MAX_DATA_TQ: u32 = 25;

/// Returns `(tq_per_bit, tseg1, tseg2, sjw)` for one phase, or `None` if `brp` does not divide
/// the clock exactly for `bitrate` or the segments exceed `limits`.
fn fit_phase(
    bitrate: u32,
    brp: u32,
    sample_point_permille: u32,
    limits: &PhaseLimits,
) -> Option<(u32, u32, u32, u32)> {
    let denom = u64::from(brp) * u64::from(bitrate);
    if denom == 0 || u64::from(PCAN_FD_CLOCK_HZ) % denom != 0 {
        return None;
    }
    let tq = u32::try_from(u64::from(PCAN_FD_CLOCK_HZ) / denom).ok()?;
    if tq < 4 {
        return None;
    }
    let tseg2 = ((tq * (1000 - sample_point_permille) + 500) / 1000).max(1);
    let tseg1 = tq.checked_sub(1 + tseg2)?;
    if tseg1 < 1 || tseg1 > limits.tseg1_max || tseg2 > limits.tseg2_max {
        return None;
    }
    Some((tq, tseg1, tseg2, tseg2.min(limits.sjw_max)))
}

/// Computes CAN-FD bit timing (80 MHz clock, 80 % nominal sample point, 80 % data sample point
/// up to 2 Mbit/s and 75 % above). Prefers one common prescaler for both phases (CiA 601-3).
pub fn pcan_fd_timing(nominal_bitrate: u32, data_bitrate: u32) -> Result<PcanFdTiming, String> {
    if nominal_bitrate == 0 || data_bitrate == 0 {
        return Err("CAN-FD nominal and data bitrates must be non-zero".to_string());
    }
    if data_bitrate < nominal_bitrate {
        return Err(format!(
            "CAN-FD data bitrate ({data_bitrate} bit/s) must be >= nominal bitrate ({nominal_bitrate} bit/s)"
        ));
    }
    let nom_sp = 800;
    let data_sp = if data_bitrate > 2_000_000 { 750 } else { 800 };

    let build = |nb: u32, n: (u32, u32, u32, u32), db: u32, d: (u32, u32, u32, u32)| PcanFdTiming {
        nom_brp: nb,
        nom_tseg1: n.1,
        nom_tseg2: n.2,
        nom_sjw: n.3,
        data_brp: db,
        data_tseg1: d.1,
        data_tseg2: d.2,
        data_sjw: d.3,
    };

    let common = |max_data_tq: u32| {
        (1..=MAX_BRP).find_map(|brp| {
            let n = fit_phase(nominal_bitrate, brp, nom_sp, &NOMINAL_LIMITS)?;
            let d = fit_phase(data_bitrate, brp, data_sp, &DATA_LIMITS)?;
            (d.0 <= max_data_tq).then(|| build(brp, n, brp, d))
        })
    };
    if let Some(t) = common(PREFERRED_MAX_DATA_TQ).or_else(|| common(u32::MAX)) {
        return Ok(t);
    }

    // Independent prescalers as a last resort.
    let nom = (1..=MAX_BRP)
        .find_map(|brp| fit_phase(nominal_bitrate, brp, nom_sp, &NOMINAL_LIMITS).map(|n| (brp, n)));
    let data = (1..=MAX_BRP)
        .find_map(|brp| fit_phase(data_bitrate, brp, data_sp, &DATA_LIMITS).map(|d| (brp, d)));
    match (nom, data) {
        (Some((nb, n)), Some((db, d))) => Ok(build(nb, n, db, d)),
        (None, _) => Err(format!(
            "nominal bitrate {nominal_bitrate} bit/s cannot be derived exactly from the 80 MHz PCAN-FD clock"
        )),
        (_, None) => Err(format!(
            "data bitrate {data_bitrate} bit/s cannot be derived exactly from the 80 MHz PCAN-FD clock"
        )),
    }
}

/// Converts a Classical `TPCANTimestamp` to microseconds:
/// `micros + 1000 * millis + 0x1_0000_0000 * 1000 * millis_overflow`.
pub const fn pcan_timestamp_to_us(ts: &TpcanTimestamp) -> u64 {
    ts.micros as u64 + 1000 * ts.millis as u64 + 0x1_0000_0000 * 1000 * ts.millis_overflow as u64
}

/// Outcome of decoding one received PCAN message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PcanRxDecoded {
    /// A data / remote frame ready for the pipeline.
    Frame(RawCanFrame),
    /// `PCAN_MESSAGE_STATUS` (bus state change notification).
    Status,
    /// `PCAN_MESSAGE_ERRFRAME` (PCAN-specific error frame layout; not forwarded).
    ErrorFrame,
}

/// Maps a received PCAN message to a [`RawCanFrame`].
///
/// `dlc_field` is `TPCANMsg::LEN` for the classic API (`fd_api == false`) or the DLC code
/// `TPCANMsgFD::DLC` for the FD API. A zero `timestamp_us` falls back to the monotonic clock.
pub fn decode_pcan_rx(
    id: u32,
    msgtype: u8,
    dlc_field: u8,
    data: &[u8],
    fd_api: bool,
    timestamp_us: u64,
    bus_id: BusId,
) -> PcanRxDecoded {
    if msgtype & PCAN_MESSAGE_STATUS != 0 {
        return PcanRxDecoded::Status;
    }
    if msgtype & PCAN_MESSAGE_ERRFRAME != 0 {
        return PcanRxDecoded::ErrorFrame;
    }

    let is_ext = msgtype & PCAN_MESSAGE_EXTENDED != 0;
    let is_fd = msgtype & PCAN_MESSAGE_FD != 0;
    let is_rtr = !is_fd && msgtype & PCAN_MESSAGE_RTR != 0;

    let mut flags = 0u8;
    if is_ext {
        flags |= FLAG_EXTENDED;
    }
    if is_rtr {
        flags |= FLAG_RTR;
    }
    if is_fd {
        flags |= FLAG_FD;
        if msgtype & PCAN_MESSAGE_BRS != 0 {
            flags |= FLAG_BRS;
        }
        if msgtype & PCAN_MESSAGE_ESI != 0 {
            flags |= FLAG_ESI;
        }
    }
    if msgtype & PCAN_MESSAGE_ECHO != 0 {
        flags |= FLAG_TX;
    }

    let len = if fd_api {
        dlc_code_to_len(dlc_field & 0x0F, is_fd)
    } else {
        dlc_field.min(MAX_CLASSICAL_CAN_DLC as u8)
    };

    let mut frame = RawCanFrame::zeroed();
    frame.timestamp_us = if timestamp_us > 0 {
        flags |= FLAG_HW_TIMESTAMP;
        timestamp_us
    } else {
        now_monotonic_us().max(1)
    };
    frame.arb_id = id
        & if is_ext {
            EXT_CAN_ID_MASK
        } else {
            STD_CAN_ID_MASK
        };
    frame.bus_id = bus_id;
    frame.dlc = len;
    frame.flags = flags;
    if !is_rtr {
        let n = usize::from(len).min(data.len()).min(MAX_CAN_FD_DLC);
        frame.data[..n].copy_from_slice(&data[..n]);
    }
    PcanRxDecoded::Frame(frame)
}

/// `PCAN_MESSAGE_*` type byte for transmitting `frame`.
pub const fn pcan_msgtype_for_frame(frame: &RawCanFrame) -> u8 {
    let mut t = PCAN_MESSAGE_STANDARD;
    if frame.is_extended() {
        t |= PCAN_MESSAGE_EXTENDED;
    }
    if frame.is_fd() {
        t |= PCAN_MESSAGE_FD;
        if frame.is_brs() {
            t |= PCAN_MESSAGE_BRS;
        }
    } else if frame.is_rtr() {
        t |= PCAN_MESSAGE_RTR;
    }
    t
}

/// Maps a `CAN_GetStatus` result to a [`BusState`].
pub const fn pcan_status_to_bus_state(status: TpcanStatus) -> BusState {
    if is_fatal_channel_status(status) {
        BusState::Disconnected
    } else if status & PCAN_ERROR_BUSOFF != 0 {
        BusState::BusOff
    } else if status & PCAN_ERROR_BUSPASSIVE != 0 {
        BusState::Passive
    } else if status & (PCAN_ERROR_BUSHEAVY | PCAN_ERROR_BUSLIGHT) != 0 {
        BusState::Warning
    } else {
        BusState::Active
    }
}

/// `true` if `status` means the channel / device is gone (unplugged, driver unloaded, channel
/// no longer initialized).
pub const fn is_fatal_channel_status(status: TpcanStatus) -> bool {
    let handle_field = status & PCAN_ERROR_ILLHANDLE;
    handle_field == PCAN_ERROR_ILLHW
        || handle_field == PCAN_ERROR_ILLNET
        || handle_field == PCAN_ERROR_ILLCLIENT
        || status & (PCAN_ERROR_NODRIVER | PCAN_ERROR_INITIALIZE) != 0
}

/// `true` if `CAN_Initialize*` failed because another client holds the channel.
pub const fn is_in_use_status(status: TpcanStatus) -> bool {
    let handle_field = status & PCAN_ERROR_ILLHANDLE;
    handle_field == PCAN_ERROR_HWINUSE
        || handle_field == PCAN_ERROR_NETINUSE
        || status & PCAN_ERROR_INITIALIZE != 0
}

/// Built-in name of the most significant error in `status` (fallback for `CAN_GetErrorText`).
pub const fn pcan_status_name(status: TpcanStatus) -> &'static str {
    let handle_field = status & PCAN_ERROR_ILLHANDLE;
    if status == PCAN_ERROR_OK {
        "No error"
    } else if handle_field == PCAN_ERROR_ILLHW {
        "PCAN_ERROR_ILLHW: hardware handle is invalid or the device is not attached"
    } else if handle_field == PCAN_ERROR_ILLNET {
        "PCAN_ERROR_ILLNET: net handle is invalid"
    } else if handle_field == PCAN_ERROR_ILLCLIENT {
        "PCAN_ERROR_ILLCLIENT: client handle is invalid"
    } else if handle_field == PCAN_ERROR_HWINUSE {
        "PCAN_ERROR_HWINUSE: hardware already in use"
    } else if handle_field == PCAN_ERROR_NETINUSE {
        "PCAN_ERROR_NETINUSE: net already in use"
    } else if status & PCAN_ERROR_INITIALIZE != 0 {
        "PCAN_ERROR_INITIALIZE: channel not initialized or already initialized"
    } else if status & PCAN_ERROR_NODRIVER != 0 {
        "PCAN_ERROR_NODRIVER: PEAK device driver not loaded"
    } else if status & PCAN_ERROR_BUSOFF != 0 {
        "PCAN_ERROR_BUSOFF: bus-off"
    } else if status & PCAN_ERROR_BUSPASSIVE != 0 {
        "PCAN_ERROR_BUSPASSIVE: error passive"
    } else if status & PCAN_ERROR_BUSHEAVY != 0 {
        "PCAN_ERROR_BUSHEAVY: error warning"
    } else if status & PCAN_ERROR_BUSLIGHT != 0 {
        "PCAN_ERROR_BUSLIGHT: error counters above light limit"
    } else if status & PCAN_ERROR_QRCVEMPTY != 0 {
        "PCAN_ERROR_QRCVEMPTY: receive queue empty"
    } else if status & (PCAN_ERROR_XMTFULL | PCAN_ERROR_QXMTFULL) != 0 {
        "PCAN_ERROR_QXMTFULL: transmit queue full"
    } else if status & (PCAN_ERROR_OVERRUN | PCAN_ERROR_QOVERRUN) != 0 {
        "PCAN_ERROR_QOVERRUN: receive overrun"
    } else if status & PCAN_ERROR_ILLPARAMTYPE != 0 {
        "PCAN_ERROR_ILLPARAMTYPE: invalid parameter"
    } else if status & PCAN_ERROR_ILLPARAMVAL != 0 {
        "PCAN_ERROR_ILLPARAMVAL: invalid parameter value"
    } else if status & PCAN_ERROR_ILLOPERATION != 0 {
        "PCAN_ERROR_ILLOPERATION: invalid operation"
    } else if status & PCAN_ERROR_ILLMODE != 0 {
        "PCAN_ERROR_ILLMODE: driver object state is wrong for this operation"
    } else if status & PCAN_ERROR_CAUTION != 0 {
        "PCAN_ERROR_CAUTION: operation succeeded with irregularities"
    } else if status & PCAN_ERROR_RESOURCE != 0 {
        "PCAN_ERROR_RESOURCE: resource cannot be created"
    } else {
        "PCAN-Basic error"
    }
}

/// Inclusive `(from, to, mode)` range for a hardware pre-filter that is a SUPERSET of
/// `filters`, or `None` if no safe single range exists (mixed / unspecified frame types).
/// The exact match is always re-checked in software.
pub fn pcan_prefilter_range(filters: &[CanFilter]) -> Option<(u32, u32, u8)> {
    let ext = filters.first()?.extended?;
    if filters.iter().any(|f| f.extended != Some(ext)) {
        return None;
    }
    let width = if ext {
        EXT_CAN_ID_MASK
    } else {
        STD_CAN_ID_MASK
    };
    let mut lo = u32::MAX;
    let mut hi = 0u32;
    for f in filters {
        let mask = f.mask & width;
        let base = f.id & mask;
        lo = lo.min(base);
        hi = hi.max(base | (!mask & width));
    }
    let mode = if ext {
        PCAN_MODE_EXTENDED
    } else {
        PCAN_MODE_STANDARD
    };
    Some((lo, hi, mode))
}

// =============================================================================
// Channel
// =============================================================================

enum ReadOutcome {
    Frame(RawCanFrame),
    Skip,
    Empty,
    Fatal,
    Failed(TpcanStatus),
}

/// An initialized PCAN-Basic channel.
pub struct PcanChannel {
    api: Arc<PcanApi>,
    handle: TpcanHandle,
    channel_name: String,
    descriptor: DeviceDescriptor,
    bus_id: BusId,
    fd_active: bool,
    listen_only: bool,
    enforcement: ListenOnlyEnforcement,
    initialized: bool,
    disconnected: bool,
    filters: Vec<CanFilter>,
    rx_errors: u32,
    tx_errors: u32,
}

impl std::fmt::Debug for PcanChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PcanChannel")
            .field("channel", &self.channel_name)
            .field("handle", &format_args!("0x{:X}", self.handle))
            .field("fd_active", &self.fd_active)
            .field("listen_only", &self.listen_only)
            .field("enforcement", &self.enforcement)
            .finish()
    }
}

impl PcanChannel {
    /// PCAN-Basic channel handle.
    pub const fn handle(&self) -> TpcanHandle {
        self.handle
    }

    /// `true` if the channel was initialized with `CAN_InitializeFD`.
    pub const fn fd_active(&self) -> bool {
        self.fd_active
    }

    fn matches_filters(&self, frame: &RawCanFrame) -> bool {
        self.filters.is_empty()
            || self.filters.iter().any(|f| {
                let ext_ok = match f.extended {
                    Some(ext) => frame.is_extended() == ext,
                    None => true,
                };
                ext_ok && (frame.arb_id & f.mask) == (f.id & f.mask)
            })
    }

    fn note_bus_status(&mut self, status: TpcanStatus) {
        if status & (PCAN_ERROR_OVERRUN | PCAN_ERROR_QOVERRUN) != 0 {
            self.rx_errors = self.rx_errors.saturating_add(1);
        }
    }

    fn classify(&mut self, st: TpcanStatus) -> Option<ReadOutcome> {
        if st == PCAN_ERROR_OK {
            return None;
        }
        if st & PCAN_ERROR_QRCVEMPTY != 0 {
            self.note_bus_status(st);
            return Some(ReadOutcome::Empty);
        }
        if is_fatal_channel_status(st) {
            return Some(ReadOutcome::Fatal);
        }
        let soft = PCAN_ERROR_ANYBUSERR | PCAN_ERROR_OVERRUN | PCAN_ERROR_QOVERRUN;
        if st & !soft == 0 {
            // Bus-state / overrun notification: the buffer still holds a message (a status
            // message on bus errors, which `decode_pcan_rx` skips).
            self.note_bus_status(st);
            return None;
        }
        Some(ReadOutcome::Failed(st))
    }

    fn read_one(&mut self) -> ReadOutcome {
        if self.fd_active {
            let Some(read_fd) = self.api.read_fd else {
                return ReadOutcome::Failed(PCAN_ERROR_ILLOPERATION);
            };
            let mut msg = TpcanMsgFd::default();
            let mut ts: u64 = 0;
            // SAFETY: `msg` / `ts` are valid writable `TPCANMsgFD` / `TPCANTimestampFD` (UINT64).
            let st = unsafe { read_fd(self.handle, &mut msg, &mut ts) };
            if let Some(outcome) = self.classify(st) {
                return outcome;
            }
            self.decoded(decode_pcan_rx(
                msg.id,
                msg.msgtype,
                msg.dlc,
                &msg.data,
                true,
                ts,
                self.bus_id,
            ))
        } else {
            let mut msg = TpcanMsg::default();
            let mut ts = TpcanTimestamp::default();
            // SAFETY: `msg` / `ts` are valid writable `TPCANMsg` / `TPCANTimestamp` structs.
            let st = unsafe { (self.api.read)(self.handle, &mut msg, &mut ts) };
            if let Some(outcome) = self.classify(st) {
                return outcome;
            }
            self.decoded(decode_pcan_rx(
                msg.id,
                msg.msgtype,
                msg.len,
                &msg.data,
                false,
                pcan_timestamp_to_us(&ts),
                self.bus_id,
            ))
        }
    }

    fn decoded(&mut self, d: PcanRxDecoded) -> ReadOutcome {
        match d {
            PcanRxDecoded::Frame(f) => ReadOutcome::Frame(f),
            PcanRxDecoded::Status => ReadOutcome::Skip,
            PcanRxDecoded::ErrorFrame => {
                self.rx_errors = self.rx_errors.saturating_add(1);
                ReadOutcome::Skip
            }
        }
    }

    fn uninitialize_once(&mut self) {
        if self.initialized {
            self.initialized = false;
            // SAFETY: the handle was successfully initialized by this channel and is released
            // exactly once (guarded by `initialized`).
            let _ = unsafe { (self.api.uninitialize)(self.handle) };
        }
    }
}

impl CanChannel for PcanChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.uninitialize_once();
        Ok(())
    }

    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if !self.initialized || self.disconnected {
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }

        let mut count = 0usize;
        // Bounds the drain loop even if the driver keeps returning skipped status messages.
        let mut budget = out_batch.len().saturating_mul(4).max(64);
        let mut deadline: Option<Instant> = None;

        loop {
            while count < out_batch.len() && budget > 0 {
                budget -= 1;
                match self.read_one() {
                    ReadOutcome::Frame(frame) => {
                        if self.matches_filters(&frame) {
                            out_batch[count] = frame;
                            count += 1;
                        }
                    }
                    ReadOutcome::Skip => {}
                    ReadOutcome::Empty => break,
                    ReadOutcome::Fatal => {
                        self.disconnected = true;
                        return if count > 0 {
                            Ok(count)
                        } else {
                            Err(AdapterError::ChannelClosed)
                        };
                    }
                    ReadOutcome::Failed(st) => {
                        self.rx_errors = self.rx_errors.saturating_add(1);
                        if count > 0 {
                            return Ok(count);
                        }
                        return Err(AdapterError::Driver(format!(
                            "PCAN read failed on {}: {}",
                            self.channel_name,
                            self.api.error_text(st)
                        )));
                    }
                }
            }
            if count > 0 || timeout_ms == 0 || budget == 0 {
                return Ok(count);
            }
            let now = Instant::now();
            let dl = *deadline.get_or_insert_with(|| {
                now + Duration::from_millis(u64::from(timeout_ms.min(MAX_RECV_WAIT_MS)))
            });
            if now >= dl {
                return Ok(0);
            }
            thread::sleep((dl - now).min(Duration::from_millis(1)));
        }
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if !self.initialized || self.disconnected {
            return Err(AdapterError::ChannelClosed);
        }
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }
        if frame.is_fd() && !self.fd_active {
            return Err(AdapterError::UnsupportedCapability(format!(
                "CAN-FD transmission is not enabled on PCAN channel {}",
                self.channel_name
            )));
        }

        let id = frame.arb_id
            & if frame.is_extended() {
                EXT_CAN_ID_MASK
            } else {
                STD_CAN_ID_MASK
            };
        let msgtype = pcan_msgtype_for_frame(frame);

        let st = if self.fd_active {
            let Some(write_fd) = self.api.write_fd else {
                return Err(AdapterError::ChannelClosed);
            };
            let mut msg = TpcanMsgFd {
                id,
                msgtype,
                ..TpcanMsgFd::default()
            };
            let len = if frame.is_fd() {
                let code = len_to_canfd_dlc_code(frame.dlc.min(MAX_CAN_FD_DLC as u8));
                msg.dlc = code;
                usize::from(dlc_code_to_len(code, true))
            } else {
                let l = frame.dlc.min(MAX_CLASSICAL_CAN_DLC as u8);
                msg.dlc = l;
                usize::from(l)
            };
            if !frame.is_rtr() || frame.is_fd() {
                msg.data[..len].copy_from_slice(&frame.data[..len]);
            }
            // SAFETY: `msg` is a valid, initialized `TPCANMsgFD` on the stack.
            unsafe { write_fd(self.handle, &mut msg) }
        } else {
            let len = frame.dlc.min(MAX_CLASSICAL_CAN_DLC as u8);
            let mut msg = TpcanMsg {
                id,
                msgtype,
                len,
                data: [0u8; 8],
            };
            if !frame.is_rtr() {
                let n = usize::from(len);
                msg.data[..n].copy_from_slice(&frame.data[..n]);
            }
            // SAFETY: `msg` is a valid, initialized `TPCANMsg` on the stack.
            unsafe { (self.api.write)(self.handle, &mut msg) }
        };

        if st == PCAN_ERROR_OK {
            return Ok(());
        }
        self.tx_errors = self.tx_errors.saturating_add(1);
        if is_fatal_channel_status(st) {
            self.disconnected = true;
            return Err(AdapterError::ChannelClosed);
        }
        Err(AdapterError::Driver(format!(
            "PCAN write failed on {}: {}",
            self.channel_name,
            self.api.error_text(st)
        )))
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        self.filters.clear();
        self.filters.extend_from_slice(filters);

        if !self.initialized || self.disconnected {
            return Ok(());
        }
        // Optional hardware pre-filter (always a superset; exact match is done in software).
        match (pcan_prefilter_range(filters), self.api.filter_messages) {
            (Some((from, to, mode)), Some(filter_messages)) => {
                let closed = self
                    .api
                    .set_u32(self.handle, PCAN_MESSAGE_FILTER, PCAN_FILTER_CLOSE)
                    .is_ok();
                // SAFETY: plain value call on an initialized handle.
                let st = unsafe { filter_messages(self.handle, from, to, mode) };
                if !closed || st != PCAN_ERROR_OK {
                    // Never leave the controller filter narrower than the software filter.
                    let _ = self
                        .api
                        .set_u32(self.handle, PCAN_MESSAGE_FILTER, PCAN_FILTER_OPEN);
                }
            }
            _ => {
                let _ = self
                    .api
                    .set_u32(self.handle, PCAN_MESSAGE_FILTER, PCAN_FILTER_OPEN);
            }
        }
        Ok(())
    }

    fn health(&self) -> BusHealthSnapshot {
        let state = if !self.initialized || self.disconnected {
            BusState::Disconnected
        } else {
            pcan_status_to_bus_state(self.api.status(self.handle))
        };
        BusHealthSnapshot {
            state,
            tx_error_count: self.tx_errors,
            rx_error_count: self.rx_errors,
        }
    }

    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        self.enforcement
    }
}

impl Drop for PcanChannel {
    fn drop(&mut self) {
        self.uninitialize_once();
    }
}

// =============================================================================
// Open
// =============================================================================

/// Opens `requested_channel` (`"PCAN_USBBUS1"`, `"0x51"`, ...) through PCAN-Basic.
///
/// Order of operations (nothing touches the bus before step 4):
/// 1. resolve handle + validate bitrate,
/// 2. check the attached-channel list (not attached → `DeviceNotFound` listing attached ones;
///    exclusively occupied → clear "in use" error),
/// 3. `PCAN_LISTEN_ONLY = ON` (or OFF) BEFORE initialization,
/// 4. `CAN_Initialize` / `CAN_InitializeFD`,
/// 5. read back `PCAN_LISTEN_ONLY` to decide `Hardware` vs `SoftwareOnly` enforcement.
pub fn open_pcan_channel(
    requested_channel: &str,
    device: &DeviceDescriptor,
    config: &ChannelConfig,
) -> Result<PcanChannel, AdapterError> {
    let handle = pcan_channel_handle_from_name(requested_channel).ok_or_else(|| {
        AdapterError::DeviceNotFound(format!(
            "{requested_channel} (not a valid PCAN-Basic channel name; expected e.g. PCAN_USBBUS1)"
        ))
    })?;
    let name = pcan_channel_name_from_handle(handle);

    let api = pcan_api().map_err(|e| {
        let linux_hint = if cfg!(target_os = "linux") {
            " On Linux, mainline peak_usb adapters appear as SocketCAN interfaces (can0, ...) and should be selected by interface name."
        } else {
            ""
        };
        AdapterError::Driver(format!(
            "PEAK PCAN-Basic library is required to open {name}: {e}.{linux_hint}"
        ))
    })?;

    let attached = api.enumerate_attached();
    let info = attached.iter().find(|c| c.handle == handle).cloned();
    // Direct per-handle check covers handles the fallback scan does not visit (LAN).
    let direct_condition = if info.is_none() {
        api.get_u32(handle, PCAN_CHANNEL_CONDITION).ok()
    } else {
        None
    };
    match (&info, direct_condition) {
        (None, Some(PCAN_CHANNEL_OCCUPIED)) => {
            return Err(AdapterError::Driver(format!(
                "PCAN channel {name} is in use by another application (PCAN-View or another CAN tool); disconnect it there and retry"
            )));
        }
        (None, Some(cond)) if cond & PCAN_CHANNEL_AVAILABLE != 0 => {}
        (None, _) => {
            let list = if attached.is_empty() {
                "none".to_string()
            } else {
                attached
                    .iter()
                    .map(|c| c.channel_name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            return Err(AdapterError::DeviceNotFound(format!(
                "{name} (PEAK PCAN-Basic reports this channel is not attached; attached channels: {list})"
            )));
        }
        (Some(ch), _) if ch.is_occupied_exclusive() => {
            return Err(AdapterError::Driver(format!(
                "PCAN channel {name} is in use by another application (PCAN-View or another CAN tool); disconnect it there and retry"
            )));
        }
        (Some(_), _) => {}
    }

    let fd_capable = match &info {
        Some(ch) => ch.supports_fd(),
        None => api
            .get_u32(handle, PCAN_CHANNEL_FEATURES)
            .map_or(true, |f| f & FEATURE_FD_CAPABLE != 0),
    };
    let fd_active = config.enable_fd && fd_capable && api.has_fd_api();

    // 1. Validate timing before touching the hardware.
    enum Init {
        Classic(u16),
        Fd(CString),
    }
    let init = if fd_active {
        let timing = pcan_fd_timing(config.bitrate, config.data_bitrate).map_err(|e| {
            AdapterError::UnsupportedCapability(format!("PCAN-FD bit timing for {name}: {e}"))
        })?;
        let s = CString::new(timing.to_bitrate_string()).map_err(|_| {
            AdapterError::UnsupportedCapability("invalid PCAN-FD bitrate string".to_string())
        })?;
        Init::Fd(s)
    } else {
        let btr = pcan_btr0btr1_for_bitrate(config.bitrate).ok_or_else(|| {
            AdapterError::UnsupportedCapability(format!(
                "bitrate {} bit/s is not a PCAN-Basic Classical CAN preset (supported: 1M, 800k, 500k, 250k, 125k, 100k, 95.238k, 83.333k, 50k, 47.619k, 33.333k, 20k, 10k, 5k)",
                config.bitrate
            ))
        })?;
        Init::Classic(btr)
    };

    // 3. Listen-Only BEFORE initialization: the controller never ACKs.
    let mut lo_pre_status = PCAN_ERROR_OK;
    if config.listen_only {
        if let Err(st) = api.set_u32(handle, PCAN_LISTEN_ONLY, PCAN_PARAMETER_ON) {
            lo_pre_status = st;
            if config.requires_hardware_listen_only() {
                return Err(AdapterError::hw_listen_only_unavailable(&format!(
                    "PCAN-Basic refused PCAN_LISTEN_ONLY before initialization on {name} ({}); the channel was not initialized.",
                    api.error_text(st)
                )));
            }
        }
    } else {
        let _ = api.set_u32(handle, PCAN_LISTEN_ONLY, PCAN_PARAMETER_OFF);
    }
    let lo_pre_ok = config.listen_only && lo_pre_status == PCAN_ERROR_OK;

    // 4. Initialize.
    let st = match &init {
        // SAFETY: plain value call; HwType / IOPort / Interrupt are 0 for plug-and-play hardware.
        Init::Classic(btr) => unsafe { (api.initialize)(handle, *btr, 0, 0, 0) },
        Init::Fd(s) => match api.initialize_fd {
            // SAFETY: `s` is a valid NUL-terminated string that outlives the call.
            Some(init_fd) => unsafe { init_fd(handle, s.as_ptr()) },
            None => PCAN_ERROR_ILLOPERATION,
        },
    };
    if st != PCAN_ERROR_OK && st != PCAN_ERROR_CAUTION {
        let text = api.error_text(st);
        if is_in_use_status(st) {
            return Err(AdapterError::Driver(format!(
                "PCAN channel {name} is in use by another application (PCAN-View or another CAN tool): {text}"
            )));
        }
        if st & PCAN_ERROR_ILLHANDLE == PCAN_ERROR_ILLHW {
            return Err(AdapterError::DeviceNotFound(format!(
                "{name} (PEAK PCAN-Basic: {text})"
            )));
        }
        let func = if fd_active {
            "CAN_InitializeFD"
        } else {
            "CAN_Initialize"
        };
        return Err(AdapterError::Driver(format!(
            "{func} failed on {name}: {text}"
        )));
    }

    let mut channel = PcanChannel {
        api: Arc::clone(&api),
        handle,
        channel_name: name.clone(),
        descriptor: device.clone(),
        bus_id: config.bus_id,
        fd_active,
        listen_only: config.listen_only,
        enforcement: ListenOnlyEnforcement::SoftwareOnly,
        initialized: true,
        disconnected: false,
        filters: Vec::new(),
        rx_errors: 0,
        tx_errors: 0,
    };

    // 5. Confirm Listen-Only on the initialized channel.
    if config.listen_only {
        if !lo_pre_ok {
            let _ = api.set_u32(handle, PCAN_LISTEN_ONLY, PCAN_PARAMETER_ON);
        }
        let confirmed = match api.get_u32(handle, PCAN_LISTEN_ONLY) {
            Ok(v) => v == PCAN_PARAMETER_ON,
            Err(_) => lo_pre_ok,
        };
        if confirmed {
            channel.enforcement = ListenOnlyEnforcement::Hardware;
        } else if config.requires_hardware_listen_only() {
            channel.uninitialize_once();
            return Err(AdapterError::hw_listen_only_unavailable(&format!(
                "PCAN channel {name} did not confirm PCAN_LISTEN_ONLY after initialization; the channel was closed without being used."
            )));
        }
    }

    let _ = api.set_u32(handle, PCAN_BUSOFF_AUTORESET, PCAN_PARAMETER_ON);

    channel.descriptor.channel_name = name.clone();
    channel.descriptor.capabilities.supports_fd = fd_active;
    channel.descriptor.capabilities.supports_listen_only = true;
    channel.descriptor.capabilities.supports_hw_timestamps = true;
    channel.descriptor.capabilities.is_virtual = false;
    if let Some(ch) = &info {
        channel.descriptor.display_name = ch.label();
    }
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn struct_sizes_match_pcanbasic_h() {
        assert_eq!(size_of::<TpcanMsg>(), 16);
        assert_eq!(size_of::<TpcanTimestamp>(), 8);
        assert_eq!(size_of::<TpcanMsgFd>(), 72);
        assert_eq!(size_of::<TpcanChannelInformation>(), 52);
    }

    #[test]
    fn channel_name_handle_map_roundtrips() {
        assert_eq!(pcan_channel_handle_from_name("PCAN_USBBUS1"), Some(0x51));
        assert_eq!(pcan_channel_handle_from_name("PCAN_USBBUS8"), Some(0x58));
        assert_eq!(pcan_channel_handle_from_name("PCAN_USBBUS9"), Some(0x509));
        assert_eq!(pcan_channel_handle_from_name("PCAN_USBBUS16"), Some(0x510));
        assert_eq!(pcan_channel_handle_from_name("PCAN_PCIBUS1"), Some(0x41));
        assert_eq!(pcan_channel_handle_from_name("PCAN_PCIBUS9"), Some(0x409));
        assert_eq!(pcan_channel_handle_from_name("PCAN_PCIBUS16"), Some(0x410));
        assert_eq!(pcan_channel_handle_from_name("PCAN_LANBUS1"), Some(0x801));
        assert_eq!(pcan_channel_handle_from_name("PCAN_LANBUS16"), Some(0x810));
        assert_eq!(pcan_channel_handle_from_name(" pcan_usbbus2 "), Some(0x52));
        assert_eq!(pcan_channel_handle_from_name("usbbus3"), Some(0x53));
        assert_eq!(
            pcan_channel_handle_from_name("pcan:PCAN_USBBUS1"),
            Some(0x51)
        );
        assert_eq!(pcan_channel_handle_from_name("0x51"), Some(0x51));
        assert_eq!(pcan_channel_handle_from_name("0X509"), Some(0x509));
        assert_eq!(pcan_channel_handle_from_name("81"), Some(0x51));
        assert_eq!(pcan_channel_handle_from_name("0"), None);
        assert_eq!(pcan_channel_handle_from_name("PCAN_USBBUS0"), None);
        assert_eq!(pcan_channel_handle_from_name("PCAN_USBBUS17"), None);
        assert_eq!(pcan_channel_handle_from_name("can0"), None);
        assert_eq!(pcan_channel_handle_from_name(""), None);

        for handles in [PCAN_USB_HANDLES, PCAN_PCI_HANDLES, PCAN_LAN_HANDLES] {
            for h in handles {
                let name = pcan_channel_name_from_handle(h);
                assert_eq!(pcan_channel_handle_from_name(&name), Some(h), "{name}");
            }
        }
        assert_eq!(pcan_channel_name_from_handle(0x51), "PCAN_USBBUS1");
        assert_eq!(pcan_channel_name_from_handle(0x510), "PCAN_USBBUS16");
        assert_eq!(pcan_channel_name_from_handle(0x21), "0x21");
        assert_eq!(pcan_channel_handle_from_name("0x21"), Some(0x21));
    }

    #[test]
    fn btr0btr1_lookup() {
        assert_eq!(pcan_btr0btr1_for_bitrate(1_000_000), Some(0x0014));
        assert_eq!(pcan_btr0btr1_for_bitrate(800_000), Some(0x0016));
        assert_eq!(pcan_btr0btr1_for_bitrate(500_000), Some(0x001C));
        assert_eq!(pcan_btr0btr1_for_bitrate(250_000), Some(0x011C));
        assert_eq!(pcan_btr0btr1_for_bitrate(125_000), Some(0x031C));
        assert_eq!(pcan_btr0btr1_for_bitrate(100_000), Some(0x432F));
        assert_eq!(pcan_btr0btr1_for_bitrate(95_238), Some(0xC34E));
        assert_eq!(pcan_btr0btr1_for_bitrate(83_333), Some(0x852B));
        assert_eq!(pcan_btr0btr1_for_bitrate(50_000), Some(0x472F));
        assert_eq!(pcan_btr0btr1_for_bitrate(47_619), Some(0x1414));
        assert_eq!(pcan_btr0btr1_for_bitrate(33_333), Some(0x8B2F));
        assert_eq!(pcan_btr0btr1_for_bitrate(20_000), Some(0x532F));
        assert_eq!(pcan_btr0btr1_for_bitrate(10_000), Some(0x672F));
        assert_eq!(pcan_btr0btr1_for_bitrate(5_000), Some(0x7F7F));
        assert_eq!(pcan_btr0btr1_for_bitrate(666_666), None);
        assert_eq!(pcan_btr0btr1_for_bitrate(0), None);
    }

    #[test]
    fn fd_timing_500k_2m_matches_peak_reference() {
        let t = pcan_fd_timing(500_000, 2_000_000).expect("500k/2M");
        assert_eq!(
            t.to_bitrate_string(),
            "f_clock_mhz=80, nom_brp=2, nom_tseg1=63, nom_tseg2=16, nom_sjw=16, data_brp=2, data_tseg1=15, data_tseg2=4, data_sjw=4"
        );
    }

    #[test]
    fn fd_timing_common_rates_are_exact_and_within_limits() {
        for (nom, data) in [
            (125_000, 500_000),
            (250_000, 1_000_000),
            (250_000, 2_000_000),
            (500_000, 1_000_000),
            (500_000, 2_000_000),
            (500_000, 4_000_000),
            (500_000, 5_000_000),
            (500_000, 8_000_000),
            (1_000_000, 2_000_000),
            (1_000_000, 4_000_000),
            (1_000_000, 5_000_000),
            (1_000_000, 8_000_000),
        ] {
            let t = pcan_fd_timing(nom, data).unwrap_or_else(|e| panic!("{nom}/{data}: {e}"));
            let nom_tq = 1 + t.nom_tseg1 + t.nom_tseg2;
            let data_tq = 1 + t.data_tseg1 + t.data_tseg2;
            assert_eq!(PCAN_FD_CLOCK_HZ / (t.nom_brp * nom_tq), nom, "{t:?}");
            assert_eq!(PCAN_FD_CLOCK_HZ / (t.data_brp * data_tq), data, "{t:?}");
            assert_eq!(PCAN_FD_CLOCK_HZ % (t.nom_brp * nom_tq), 0);
            assert_eq!(PCAN_FD_CLOCK_HZ % (t.data_brp * data_tq), 0);
            assert!(t.nom_tseg1 <= 256 && t.nom_tseg2 <= 128 && t.nom_sjw <= t.nom_tseg2);
            assert!(t.data_tseg1 <= 32 && t.data_tseg2 <= 16 && t.data_sjw <= t.data_tseg2);
            assert!(t.nom_sjw >= 1 && t.data_sjw >= 1);
        }
        assert!(pcan_fd_timing(500_000, 250_000).is_err());
        assert!(pcan_fd_timing(0, 2_000_000).is_err());
        assert!(pcan_fd_timing(500_000, 3_000_000).is_err());
    }

    #[test]
    fn classic_timestamp_to_micros() {
        let ts = TpcanTimestamp {
            millis: 1234,
            millis_overflow: 0,
            micros: 567,
        };
        assert_eq!(pcan_timestamp_to_us(&ts), 1_234_567);
        let ts = TpcanTimestamp {
            millis: 1,
            millis_overflow: 2,
            micros: 3,
        };
        assert_eq!(
            pcan_timestamp_to_us(&ts),
            3 + 1000 + 2 * 0x1_0000_0000 * 1000
        );
        let max = TpcanTimestamp {
            millis: u32::MAX,
            millis_overflow: u16::MAX,
            micros: 999,
        };
        assert!(pcan_timestamp_to_us(&max) > 0);
    }

    #[test]
    fn decode_classic_standard_and_extended() {
        let data = [1, 2, 3, 4, 5, 6, 7, 8];
        let PcanRxDecoded::Frame(f) =
            decode_pcan_rx(0x7FF, PCAN_MESSAGE_STANDARD, 8, &data, false, 42, 3)
        else {
            panic!("expected frame");
        };
        assert_eq!(f.arb_id, 0x7FF);
        assert_eq!(f.dlc, 8);
        assert_eq!(f.bus_id, 3);
        assert_eq!(f.timestamp_us, 42);
        assert_eq!(f.flags, FLAG_HW_TIMESTAMP);
        assert_eq!(f.payload(), &data);

        let PcanRxDecoded::Frame(f) =
            decode_pcan_rx(0xFFFF_FFFF, PCAN_MESSAGE_EXTENDED, 12, &data, false, 1, 0)
        else {
            panic!("expected frame");
        };
        assert_eq!(f.arb_id, EXT_CAN_ID_MASK);
        assert_eq!(f.dlc, 8, "classic LEN clamps to 8");
        assert!(f.is_extended() && !f.is_fd());
    }

    #[test]
    fn decode_rtr_fd_brs_esi_echo_flags() {
        let PcanRxDecoded::Frame(f) = decode_pcan_rx(
            0x123,
            PCAN_MESSAGE_RTR | PCAN_MESSAGE_EXTENDED,
            4,
            &[9, 9, 9, 9, 9, 9, 9, 9],
            false,
            0,
            1,
        ) else {
            panic!("expected frame");
        };
        assert!(f.is_rtr() && f.is_extended());
        assert_eq!(f.dlc, 4);
        assert_eq!(f.data, [0u8; 64], "RTR carries no payload");
        assert!(!f.has_hw_timestamp() && f.timestamp_us > 0);

        let mut data = [0u8; 64];
        for (i, b) in data.iter_mut().enumerate() {
            *b = i as u8;
        }
        let PcanRxDecoded::Frame(f) = decode_pcan_rx(
            0x18DA_F110,
            PCAN_MESSAGE_FD
                | PCAN_MESSAGE_BRS
                | PCAN_MESSAGE_ESI
                | PCAN_MESSAGE_EXTENDED
                | PCAN_MESSAGE_ECHO,
            15,
            &data,
            true,
            7,
            2,
        ) else {
            panic!("expected frame");
        };
        assert_eq!(
            f.flags,
            FLAG_FD | FLAG_BRS | FLAG_ESI | FLAG_EXTENDED | FLAG_TX | FLAG_HW_TIMESTAMP
        );
        assert_eq!(f.dlc, 64);
        assert_eq!(f.data, data);

        let PcanRxDecoded::Frame(f) = decode_pcan_rx(0x100, PCAN_MESSAGE_FD, 9, &data, true, 7, 0)
        else {
            panic!("expected frame");
        };
        assert_eq!(f.dlc, 12);
        assert_eq!(f.payload(), &data[..12]);

        // Classic frame received through the FD API: DLC code 9..15 clamps to 8.
        let PcanRxDecoded::Frame(f) = decode_pcan_rx(0x100, PCAN_MESSAGE_BRS, 9, &data, true, 7, 0)
        else {
            panic!("expected frame");
        };
        assert_eq!(f.dlc, 8);
        assert!(!f.is_fd() && !f.is_brs(), "BRS ignored without FD");

        assert_eq!(
            decode_pcan_rx(0, PCAN_MESSAGE_STATUS, 4, &data, false, 1, 0),
            PcanRxDecoded::Status
        );
        assert_eq!(
            decode_pcan_rx(0, PCAN_MESSAGE_ERRFRAME, 4, &data, true, 1, 0),
            PcanRxDecoded::ErrorFrame
        );
    }

    #[test]
    fn tx_msgtype_mapping() {
        let mut f = RawCanFrame::zeroed();
        assert_eq!(pcan_msgtype_for_frame(&f), PCAN_MESSAGE_STANDARD);
        f.flags = FLAG_EXTENDED | FLAG_RTR;
        assert_eq!(
            pcan_msgtype_for_frame(&f),
            PCAN_MESSAGE_EXTENDED | PCAN_MESSAGE_RTR
        );
        f.flags = FLAG_FD | FLAG_BRS;
        assert_eq!(
            pcan_msgtype_for_frame(&f),
            PCAN_MESSAGE_FD | PCAN_MESSAGE_BRS
        );
        f.flags = FLAG_BRS;
        assert_eq!(pcan_msgtype_for_frame(&f), PCAN_MESSAGE_STANDARD);
    }

    #[test]
    fn status_mapping() {
        assert_eq!(pcan_status_to_bus_state(PCAN_ERROR_OK), BusState::Active);
        assert_eq!(
            pcan_status_to_bus_state(PCAN_ERROR_BUSLIGHT),
            BusState::Warning
        );
        assert_eq!(
            pcan_status_to_bus_state(PCAN_ERROR_BUSHEAVY),
            BusState::Warning
        );
        assert_eq!(
            pcan_status_to_bus_state(PCAN_ERROR_BUSPASSIVE),
            BusState::Passive
        );
        assert_eq!(
            pcan_status_to_bus_state(PCAN_ERROR_BUSOFF | PCAN_ERROR_BUSPASSIVE),
            BusState::BusOff
        );
        assert_eq!(
            pcan_status_to_bus_state(PCAN_ERROR_ILLHW),
            BusState::Disconnected
        );
        assert_eq!(
            pcan_status_to_bus_state(PCAN_ERROR_INITIALIZE),
            BusState::Disconnected
        );
        // HWINUSE / NETINUSE share bits with ILLHW but are distinct field values.
        assert!(!is_fatal_channel_status(PCAN_ERROR_HWINUSE));
        assert!(!is_fatal_channel_status(PCAN_ERROR_NETINUSE));
        assert!(is_in_use_status(PCAN_ERROR_HWINUSE));
        assert!(is_in_use_status(PCAN_ERROR_NETINUSE));
        assert!(is_in_use_status(PCAN_ERROR_INITIALIZE));
        assert!(!is_in_use_status(PCAN_ERROR_ILLHW));
        assert!(pcan_status_name(PCAN_ERROR_ILLHW).starts_with("PCAN_ERROR_ILLHW"));
    }

    #[test]
    fn prefilter_range_is_superset_or_none() {
        assert_eq!(pcan_prefilter_range(&[]), None);
        let std_exact = [
            CanFilter {
                id: 0x100,
                mask: 0x7FF,
                extended: Some(false),
            },
            CanFilter {
                id: 0x200,
                mask: 0x7F0,
                extended: Some(false),
            },
        ];
        assert_eq!(
            pcan_prefilter_range(&std_exact),
            Some((0x100, 0x20F, PCAN_MODE_STANDARD))
        );
        let mixed = [
            std_exact[0],
            CanFilter {
                id: 0x100,
                mask: 0x7FF,
                extended: None,
            },
        ];
        assert_eq!(pcan_prefilter_range(&mixed), None);
        let ext = [CanFilter {
            id: 0x18FE_F100,
            mask: 0x00FF_FF00,
            extended: Some(true),
        }];
        let (lo, hi, mode) = pcan_prefilter_range(&ext).expect("ext");
        assert_eq!(mode, PCAN_MODE_EXTENDED);
        assert_eq!(lo, 0x00FE_F100);
        assert_eq!(hi, 0x1FFE_F1FF);
    }

    #[test]
    fn attached_channel_state_and_label() {
        let mut ch = PcanAttachedChannel {
            handle: 0x51,
            channel_name: "PCAN_USBBUS1".to_string(),
            device_type: 5,
            controller_number: 0,
            device_features: FEATURE_FD_CAPABLE,
            device_name: "PCAN-USB FD".to_string(),
            device_id: 1,
            condition: PCAN_CHANNEL_AVAILABLE,
        };
        assert_eq!(ch.state_str(), "up");
        assert!(ch.supports_fd() && ch.is_connectable() && !ch.is_occupied_exclusive());
        assert_eq!(ch.label(), "PCAN_USBBUS1 — PCAN-USB FD (ID 0x1)");
        ch.condition = PCAN_CHANNEL_PCANVIEW;
        assert_eq!(ch.state_str(), "occupied");
        assert!(ch.is_connectable());
        ch.condition = PCAN_CHANNEL_OCCUPIED;
        assert!(!ch.is_connectable() && ch.is_occupied_exclusive());

        let mut info = TpcanChannelInformation {
            channel_handle: 0x52,
            device_features: 0,
            device_id: 0x2A,
            channel_condition: PCAN_CHANNEL_AVAILABLE,
            ..TpcanChannelInformation::default()
        };
        info.device_name[..8].copy_from_slice(b"PCAN-USB");
        let parsed = PcanAttachedChannel::from_info(&info);
        assert_eq!(parsed.channel_name, "PCAN_USBBUS2");
        assert_eq!(parsed.device_name, "PCAN-USB");
        assert!(!parsed.supports_fd());
        assert_eq!(parsed.label(), "PCAN_USBBUS2 — PCAN-USB (ID 0x2A)");
    }
}
