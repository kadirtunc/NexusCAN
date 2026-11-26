//! macOS Kvaser USB backend using the runtime-loaded KvaserUSB driver.
#![allow(unsafe_code)]

use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, BusHealthSnapshot, BusState, CanChannel, CanFilter, ChannelConfig,
    DeviceDescriptor, ListenOnlyEnforcement,
};
use libloading::Library;
use nexus_core::{FrameFlags, RawCanFrame};
use std::ffi::CStr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Standard Apple Silicon and Intel library installation paths.
pub const LIBRARY_PATHS: [&str; 2] = [
    "/opt/homebrew/lib/libKvaserUSB.dylib",
    "/usr/local/lib/libKvaserUSB.dylib",
];

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ChannelInfo {
    pub handle: u32,
    name: [i8; 64],
    product: [i8; 64],
    pid: u16,
    channel: u8,
    channel_count: u8,
    pub fd_capable: u8,
    available: u8,
    serial: u32,
}

impl ChannelInfo {
    pub fn name(&self) -> String {
        let bytes: Vec<u8> = self
            .name
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[repr(C)]
#[derive(Default)]
struct OpenOptions {
    bitrate: i32,
    data_bitrate: i32,
    can_fd: i32,
    listen_only: i32,
    sample_point: i32,
    tseg1: i32,
    tseg2: i32,
    sjw: i32,
    data_tseg1: i32,
    data_tseg2: i32,
    data_sjw: i32,
}

#[repr(C)]
struct Message {
    id: u32,
    flags: u8,
    dlc: u8,
    len: u8,
    data: [u8; 64],
    ts_us: u64,
}

struct Api {
    _library: Library,
    path: &'static str,
    scan: unsafe extern "C" fn(*mut ChannelInfo, i32) -> i32,
    open: unsafe extern "C" fn(u32, *const OpenOptions) -> i32,
    close: unsafe extern "C" fn(u32),
    read: unsafe extern "C" fn(u32, *mut Message) -> i32,
    write: unsafe extern "C" fn(u32, *const Message) -> i32,
    status: unsafe extern "C" fn(u32, *mut i32, *mut u8, *mut u8) -> i32,
    mode: unsafe extern "C" fn(u32, *mut i32) -> i32,
    error: unsafe extern "C" fn(i32) -> *const std::ffi::c_char,
}

impl Api {
    fn load() -> Result<Self, String> {
        let mut errors = Vec::new();
        for path in LIBRARY_PATHS {
            match Self::load_from(path) {
                Ok(api) => return Ok(api),
                Err(error) => errors.push(format!("{path}: {error}")),
            }
        }
        Err(errors.join("; "))
    }

    fn load_from(path: &'static str) -> Result<Self, String> {
        // SAFETY: load a standard driver path with signatures matching KvaserUSB.h.
        unsafe {
            let library = Library::new(path).map_err(|e| e.to_string())?;
            Ok(Self {
                scan: *library.get(b"kv_scan\0").map_err(|e| e.to_string())?,
                open: *library.get(b"kv_open\0").map_err(|e| e.to_string())?,
                close: *library.get(b"kv_close\0").map_err(|e| e.to_string())?,
                read: *library.get(b"kv_read\0").map_err(|e| e.to_string())?,
                write: *library.get(b"kv_write\0").map_err(|e| e.to_string())?,
                status: *library.get(b"kv_status\0").map_err(|e| e.to_string())?,
                mode: *library
                    .get(b"kv_get_driver_mode\0")
                    .map_err(|e| e.to_string())?,
                error: *library.get(b"kv_strerror\0").map_err(|e| e.to_string())?,
                _library: library,
                path,
            })
        }
    }

    fn check(&self, status: i32) -> Result<(), AdapterError> {
        if status >= 0 {
            return Ok(());
        }
        // SAFETY: kv_strerror returns a static NUL-terminated string.
        let text = unsafe { CStr::from_ptr((self.error)(status)) }.to_string_lossy();
        Err(AdapterError::Driver(format!(
            "KvaserUSB: {text} ({status})"
        )))
    }

    fn channels(&self) -> Result<Vec<ChannelInfo>, AdapterError> {
        // SAFETY: ChannelInfo consists entirely of integer fields.
        let mut channels: [ChannelInfo; 32] = unsafe { std::mem::zeroed() };
        // SAFETY: array has capacity for the stated number of elements.
        let count = unsafe { (self.scan)(channels.as_mut_ptr(), channels.len() as i32) };
        self.check(count)?;
        if count > channels.len() as i32 {
            return Err(AdapterError::Driver("Invalid Kvaser channel count".into()));
        }
        Ok(channels[..count as usize].to_vec())
    }
}

fn api() -> Result<Arc<Api>, AdapterError> {
    static API: OnceLock<Result<Arc<Api>, String>> = OnceLock::new();
    API.get_or_init(|| Api::load().map(Arc::new))
        .clone()
        .map_err(|error| {
            AdapterError::Driver(format!(
                "Kvaser USB driver is not installed or could not be loaded: {error}"
            ))
        })
}

/// Returns the path of the successfully loaded USB driver.
pub fn installed_library_path() -> Result<&'static str, AdapterError> {
    Ok(api()?.path)
}

/// Enumerates real USB channels without bringing a CAN controller bus-on.
pub fn enumerate() -> Result<Vec<ChannelInfo>, AdapterError> {
    api()?.channels()
}

/// Opens the requested zero-based enumerated channel with hardware silent mode when requested.
pub fn open(
    index: usize,
    descriptor: &DeviceDescriptor,
    config: &ChannelConfig,
) -> Result<Box<dyn CanChannel>, AdapterError> {
    let api = api()?;
    let channels = api.channels()?;
    let channel = channels
        .get(index)
        .ok_or_else(|| AdapterError::DeviceNotFound(index.to_string()))?;
    if config.bitrate == 0
        || config.bitrate > 1_000_000
        || (config.enable_fd
            && (channel.fd_capable == 0
                || config.data_bitrate == 0
                || config.data_bitrate > 8_000_000))
    {
        return Err(AdapterError::UnsupportedCapability(
            "Invalid Kvaser CAN bitrates or FD mode".into(),
        ));
    }
    let options = OpenOptions {
        bitrate: config.bitrate as i32,
        data_bitrate: config.data_bitrate as i32,
        can_fd: i32::from(config.enable_fd),
        listen_only: i32::from(config.listen_only),
        ..OpenOptions::default()
    };
    // SAFETY: options matches the C layout and the handle came from kv_scan.
    api.check(unsafe { (api.open)(channel.handle, &options) })?;
    let mut result = KvaserChannel {
        api,
        handle: channel.handle,
        descriptor: descriptor.clone(),
        config: config.clone(),
        closed: false,
        filters: Vec::new(),
    };
    result.descriptor.display_name = channel.name();
    result.descriptor.capabilities.supports_fd = channel.fd_capable != 0;
    if config.listen_only {
        let mut mode = 0;
        // SAFETY: open handle and valid writable integer.
        let status = unsafe { (result.api.mode)(result.handle, &mut mode) };
        if status != 0 || mode != 1 {
            result.close()?;
            return Err(AdapterError::UnsupportedCapability(
                "HW_LISTEN_ONLY_UNAVAILABLE: Kvaser firmware did not confirm silent mode".into(),
            ));
        }
    }
    Ok(Box::new(result))
}

struct KvaserChannel {
    api: Arc<Api>,
    handle: u32,
    descriptor: DeviceDescriptor,
    config: ChannelConfig,
    closed: bool,
    filters: Vec<CanFilter>,
}

impl Drop for KvaserChannel {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

impl CanChannel for KvaserChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }
    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        if !self.closed {
            // SAFETY: handle was successfully opened and is closed exactly once.
            unsafe { (self.api.close)(self.handle) };
            self.closed = true;
        }
        Ok(())
    }

    fn recv_batch(
        &mut self,
        out: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms.min(20)));
        let mut count = 0;
        let mut inspected = 0;
        while count < out.len() {
            if inspected > 0 && Instant::now() >= deadline {
                break;
            }
            inspected += 1;
            // SAFETY: Message contains only integers and matches the driver's ABI.
            let mut msg: Message = unsafe { std::mem::zeroed() };
            // SAFETY: valid open handle and writable Message.
            let status = unsafe { (self.api.read)(self.handle, &mut msg) };
            if status == -6 {
                if count > 0 || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            self.api.check(status)?;
            let Some(frame) = decode_message(&msg, self.config.bus_id)? else {
                continue;
            };
            if !self.filters.is_empty()
                && !self.filters.iter().any(|filter| {
                    (frame.arb_id & filter.mask) == (filter.id & filter.mask)
                        && filter
                            .extended
                            .is_none_or(|extended| extended == frame.is_extended())
                })
            {
                continue;
            }
            out[count] = frame;
            count += 1;
        }
        Ok(count)
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if self.config.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }
        if frame.dlc > 64
            || (!frame.is_fd() && frame.dlc > 8)
            || (frame.is_fd() && (!self.config.enable_fd || frame.is_rtr()))
            || (frame.is_fd()
                && nexus_core::dlc_code_to_len(nexus_core::len_to_canfd_dlc_code(frame.dlc), true)
                    != frame.dlc)
            || frame.arb_id
                > if frame.is_extended() {
                    0x1fff_ffff
                } else {
                    0x7ff
                }
            || frame.is_error()
        {
            return Err(AdapterError::UnsupportedCapability(
                "Invalid Kvaser transmit frame".into(),
            ));
        }
        let msg = Message {
            id: frame.arb_id,
            flags: ((frame.flags & 1) << 1) | ((frame.flags & 2) >> 1) | (frame.flags & 0x1c),
            dlc: nexus_core::len_to_canfd_dlc_code(frame.dlc),
            len: frame.dlc,
            data: frame.data,
            ts_us: 0,
        };
        // SAFETY: valid open handle and initialized C message.
        self.api
            .check(unsafe { (self.api.write)(self.handle, &msg) })
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        self.filters.clear();
        self.filters.extend_from_slice(filters);
        Ok(())
    }

    fn health(&self) -> BusHealthSnapshot {
        let (mut off, mut tec, mut rec) = (0, 0, 0);
        // SAFETY: writable stack outputs and a handle protected by the driver's mutex.
        let status = unsafe { (self.api.status)(self.handle, &mut off, &mut tec, &mut rec) };
        let state = if self.closed || status != 0 {
            BusState::Disconnected
        } else if off != 0 {
            BusState::BusOff
        } else if tec >= 128 || rec >= 128 {
            BusState::Passive
        } else if tec >= 96 || rec >= 96 {
            BusState::Warning
        } else {
            BusState::Active
        };
        BusHealthSnapshot {
            state,
            tx_error_count: u32::from(tec),
            rx_error_count: u32::from(rec),
        }
    }

    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        ListenOnlyEnforcement::Hardware
    }
}

fn decode_message(msg: &Message, bus_id: u8) -> Result<Option<RawCanFrame>, AdapterError> {
    // Vendor status/error payloads do not use NexusCAN's SocketCAN error-frame ABI.
    if msg.flags & 0xc0 != 0 {
        return Ok(None);
    }
    if msg.len > 64 || (msg.flags & 4 == 0 && msg.len > 8) {
        return Err(AdapterError::Driver("Invalid Kvaser frame length".into()));
    }
    let mut frame = RawCanFrame::zeroed();
    frame.timestamp_us = msg.ts_us;
    frame.arb_id = msg.id;
    frame.bus_id = bus_id;
    frame.dlc = msg.len;
    // RTR/EXT and the transmit echo bit occupy different positions in the two ABIs.
    frame.flags = ((msg.flags & 1) << 1)
        | ((msg.flags & 2) >> 1)
        | (msg.flags & 0x1c)
        | ((msg.flags & 0x20) << 1)
        | FrameFlags::HW_TIMESTAMP.bits();
    frame.data = msg.data;
    Ok(Some(frame))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_flags_payload_and_device_timestamp_are_preserved() {
        // SAFETY: Message consists entirely of integer fields.
        let mut msg: Message = unsafe { std::mem::zeroed() };
        msg.id = 0x18daf110;
        msg.flags = 0x02 | 0x04 | 0x08 | 0x10 | 0x20;
        msg.len = 64;
        msg.data = [0x5a; 64];
        msg.ts_us = 123456;
        let frame = decode_message(&msg, 3).unwrap().unwrap();
        assert_eq!(frame.arb_id, msg.id);
        assert_eq!(frame.bus_id, 3);
        assert_eq!(frame.dlc, 64);
        assert_eq!(frame.data, msg.data);
        assert_eq!(frame.timestamp_us, 123456);
        assert!(frame.is_extended());
        assert!(frame.is_fd());
        assert_eq!(frame.flags, 0xdd);
        msg.flags = 0x01; // Classical RTR uses bit 0 in KvaserUSB.
        msg.len = 8;
        let frame = decode_message(&msg, 0).unwrap().unwrap();
        assert!(frame.is_rtr());
        assert!(!frame.is_extended());
    }

    #[test]
    fn vendor_events_are_skipped_and_oversized_payloads_are_rejected() {
        // SAFETY: Message consists entirely of integer fields.
        let mut msg: Message = unsafe { std::mem::zeroed() };
        for event in [0x40, 0x80] {
            msg.flags = event;
            assert!(decode_message(&msg, 0).unwrap().is_none());
        }
        msg.flags = 0;
        msg.len = 9;
        assert!(decode_message(&msg, 0).is_err());
        msg.flags = 4;
        msg.len = 65;
        assert!(decode_message(&msg, 0).is_err());
    }

    #[test]
    fn driver_abi_matches_c_header() {
        assert_eq!(std::mem::size_of::<ChannelInfo>(), 144);
        assert_eq!(std::mem::size_of::<OpenOptions>(), 44);
        assert_eq!(std::mem::size_of::<Message>(), 80);
        assert_eq!(std::mem::offset_of!(Message, ts_us), 72);
    }
}
