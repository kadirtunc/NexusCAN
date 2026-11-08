//! Linux Native SocketCAN (`can*`, `vcan*`, `slcan*`) CAN 2.0 & CAN-FD adapter driver.
//!
//! Strictly gated behind `#[cfg(target_os = "linux")]` so Windows and macOS builds never depend
//! on Linux kernel headers or `socketcan`/`nix` crates.

use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor,
};
use nexus_core::{
    resolve_frame_timestamp_us, BusId, CanIdKey, RawCanFrame, EXT_CAN_ID_MASK, FLAG_BRS,
    FLAG_ERROR, FLAG_ESI, FLAG_EXTENDED, FLAG_FD, FLAG_RTR, STD_CAN_ID_MASK,
};
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
use socketcan::{
    CanAnyFrame, CanDataFrame, CanFdFrame, CanFdSocket, CanFilter as ScFilter, CanRemoteFrame,
    CanSocket, EmbeddedFrame, ExtendedId, Frame as ScFrameTrait, Id, Socket, SocketOptions,
    StandardId,
};
use std::fs;
use std::io;
use std::os::fd::{AsFd, BorrowedFd};
use std::path::Path;

const SYS_CLASS_NET: &str = "/sys/class/net";
const ARPHRD_CAN: &str = "280";

/// Linux SocketCAN auto-discovering hardware/virtual driver (`can*`, `vcan*`, `slcan*`).
#[derive(Clone, Copy, Debug, Default)]
pub struct SocketCanDriver;

impl SocketCanDriver {
    /// Creates a new [`SocketCanDriver`].
    pub const fn new() -> Self {
        Self
    }
}

impl AdapterDriver for SocketCanDriver {
    fn driver_id(&self) -> &'static str {
        "socketcan"
    }

    fn display_name(&self) -> &'static str {
        "Linux Native SocketCAN (Classical CAN & CAN-FD)"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let net_dir = Path::new(SYS_CLASS_NET);
        let entries = match fs::read_dir(net_dir) {
            Ok(rd) => rd,
            Err(_) => return Ok(Vec::new()),
        };

        let mut devices = Vec::new();
        for entry in entries.flatten() {
            let iface = entry.file_name().to_string_lossy().to_string();
            let iface_path = entry.path();

            let dev_type = match fs::read_to_string(iface_path.join("type")) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if dev_type.trim() != ARPHRD_CAN {
                continue;
            }

            let mtu: u32 = fs::read_to_string(iface_path.join("mtu"))
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(16);
            let operstate = fs::read_to_string(iface_path.join("operstate"))
                .ok()
                .map(|s| s.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "unknown".to_string());

            let supports_fd = mtu >= 72;
            let is_virtual = iface.starts_with("vcan") || iface.starts_with("vxcan");
            let mode_tag = if supports_fd { "CAN-FD" } else { "Classical CAN" };

            devices.push(DeviceDescriptorDto {
                device_id: format!("socketcan:{iface}"),
                driver_id: "socketcan".to_string(),
                channel_name: iface.clone(),
                display_name: format!("{iface} — SocketCAN {mode_tag} ({operstate})"),
                capabilities: AdapterCapabilitiesDto {
                    supports_fd,
                    supports_listen_only: true,
                    supports_hw_timestamps: true,
                    max_bitrate: if supports_fd { 8_000_000 } else { 1_000_000 },
                    is_virtual,
                },
            });
        }

        devices.sort_by(|a, b| a.channel_name.cmp(&b.channel_name));
        Ok(devices)
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let iface = &device.channel_name;
        let want_fd = device.capabilities.supports_fd && config.enable_fd;

        let inner = if want_fd {
            match CanFdSocket::open(iface) {
                Ok(sock) => {
                    sock.set_nonblocking(true)?;
                    let _ = sock.set_error_filter_accept_all();
                    SocketHandle::Fd(sock)
                }
                Err(_) => {
                    let sock = CanSocket::open(iface)?;
                    sock.set_nonblocking(true)?;
                    let _ = sock.set_error_filter_accept_all();
                    SocketHandle::Classical(sock)
                }
            }
        } else {
            let sock = CanSocket::open(iface)?;
            sock.set_nonblocking(true)?;
            let _ = sock.set_error_filter_accept_all();
            SocketHandle::Classical(sock)
        };

        Ok(Box::new(SocketCanChannel {
            descriptor: device.clone(),
            bus_id: config.bus_id,
            listen_only: config.listen_only,
            closed: false,
            rx_error_count: 0,
            tx_error_count: 0,
            socket: Some(inner),
        }))
    }
}

enum SocketHandle {
    Classical(CanSocket),
    Fd(CanFdSocket),
}

impl SocketHandle {
    fn as_borrowed_fd(&self) -> BorrowedFd<'_> {
        match self {
            Self::Classical(s) => s.as_fd(),
            Self::Fd(s) => s.as_fd(),
        }
    }
}

/// Active Linux SocketCAN channel supporting `poll()` + `MSG_DONTWAIT` non-blocking burst drain.
pub struct SocketCanChannel {
    descriptor: DeviceDescriptor,
    bus_id: BusId,
    listen_only: bool,
    closed: bool,
    rx_error_count: u32,
    tx_error_count: u32,
    socket: Option<SocketHandle>,
}

impl SocketCanChannel {
    fn read_one_nonblocking(&mut self) -> Result<Option<RawCanFrame>, AdapterError> {
        let sock = self.socket.as_ref().ok_or(AdapterError::ChannelClosed)?;
        let (timestamp_us, _) = resolve_frame_timestamp_us(None);

        match sock {
            SocketHandle::Classical(s) => match s.read_frame() {
                Ok(frame) => {
                    let raw = convert_classical_frame(frame, self.bus_id, timestamp_us);
                    if raw.is_error() {
                        self.rx_error_count = self.rx_error_count.saturating_add(1);
                    }
                    Ok(Some(raw))
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(None),
                Err(err) if err.kind() == io::ErrorKind::Interrupted => Ok(None),
                Err(err) => Err(AdapterError::Io(err)),
            },
            SocketHandle::Fd(s) => match s.read_frame() {
                Ok(any_frame) => {
                    let raw = convert_any_frame(any_frame, self.bus_id, timestamp_us);
                    if raw.is_error() {
                        self.rx_error_count = self.rx_error_count.saturating_add(1);
                    }
                    Ok(Some(raw))
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(None),
                Err(err) if err.kind() == io::ErrorKind::Interrupted => Ok(None),
                Err(err) => Err(AdapterError::Io(err)),
            },
        }
    }
}

impl CanChannel for SocketCanChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.closed = true;
        self.socket = None;
        Ok(())
    }

    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.closed || self.socket.is_none() {
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }

        let mut count = 0usize;

        // Fast-path: attempt immediate non-blocking read before invoking poll()
        if let Some(first) = self.read_one_nonblocking()? {
            out_batch[0] = first;
            count = 1;
        } else if timeout_ms > 0 {
            let poll_ready = {
                let sock = self.socket.as_ref().ok_or(AdapterError::ChannelClosed)?;
                let mut fds = [PollFd::new(sock.as_borrowed_fd(), PollFlags::POLLIN)];
                let poll_timeout =
                    PollTimeout::try_from(timeout_ms).unwrap_or(PollTimeout::MAX);
                match poll(&mut fds, poll_timeout) {
                    Ok(n) => n > 0,
                    Err(nix::errno::Errno::EINTR) => false,
                    Err(errno) => return Err(AdapterError::Io(io::Error::from(errno))),
                }
            };
            if !poll_ready {
                return Ok(0);
            }
        } else {
            return Ok(0);
        }

        // Burst-drain remaining ready frames from kernel socket buffer up to out_batch.len()
        while count < out_batch.len() {
            match self.read_one_nonblocking()? {
                Some(frame) => {
                    out_batch[count] = frame;
                    count += 1;
                }
                None => break,
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

        let id = make_socketcan_id(frame.can_id_key())?;
        let payload = frame.payload();
        let sock = self.socket.as_ref().ok_or(AdapterError::ChannelClosed)?;

        match sock {
            SocketHandle::Classical(s) => {
                if frame.is_fd() {
                    return Err(AdapterError::UnsupportedCapability(
                        "Cannot transmit CAN-FD frame on Classical SocketCAN socket".to_string(),
                    ));
                }
                if frame.is_rtr() {
                    let rtr = CanRemoteFrame::new_remote(id, usize::from(frame.dlc.min(8)))
                        .ok_or_else(|| {
                            AdapterError::Driver("Invalid Classical CAN RTR DLC".to_string())
                        })?;
                    s.write_frame(&rtr).map_err(|e| {
                        self.tx_error_count = self.tx_error_count.saturating_add(1);
                        AdapterError::Io(e)
                    })?;
                } else {
                    let df = CanDataFrame::new(id, payload).ok_or_else(|| {
                        AdapterError::Driver("Invalid Classical CAN payload length".to_string())
                    })?;
                    s.write_frame(&df).map_err(|e| {
                        self.tx_error_count = self.tx_error_count.saturating_add(1);
                        AdapterError::Io(e)
                    })?;
                }
            }
            SocketHandle::Fd(s) => {
                if frame.is_fd() {
                    let mut fd_frame = CanFdFrame::new(id, payload).ok_or_else(|| {
                        AdapterError::Driver("Invalid CAN-FD payload length".to_string())
                    })?;
                    fd_frame.set_brs(frame.is_brs());
                    fd_frame.set_esi(frame.is_esi());
                    s.write_frame(&fd_frame).map_err(|e| {
                        self.tx_error_count = self.tx_error_count.saturating_add(1);
                        AdapterError::Io(e)
                    })?;
                } else if frame.is_rtr() {
                    let rtr = CanRemoteFrame::new_remote(id, usize::from(frame.dlc.min(8)))
                        .ok_or_else(|| {
                            AdapterError::Driver("Invalid Classical CAN RTR DLC".to_string())
                        })?;
                    s.write_frame(&rtr).map_err(|e| {
                        self.tx_error_count = self.tx_error_count.saturating_add(1);
                        AdapterError::Io(e)
                    })?;
                } else {
                    let df = CanDataFrame::new(id, payload).ok_or_else(|| {
                        AdapterError::Driver("Invalid Classical CAN payload length".to_string())
                    })?;
                    s.write_frame(&df).map_err(|e| {
                        self.tx_error_count = self.tx_error_count.saturating_add(1);
                        AdapterError::Io(e)
                    })?;
                }
            }
        }

        Ok(())
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        let sock = self.socket.as_ref().ok_or(AdapterError::ChannelClosed)?;
        if filters.is_empty() {
            match sock {
                SocketHandle::Classical(s) => s.set_filter_accept_all()?,
                SocketHandle::Fd(s) => s.set_filter_accept_all()?,
            }
            return Ok(());
        }

        let sc_filters: Vec<ScFilter> = filters
            .iter()
            .map(|f| ScFilter::new(f.id, f.mask))
            .collect();
        match sock {
            SocketHandle::Classical(s) => s.set_filters(&sc_filters)?,
            SocketHandle::Fd(s) => s.set_filters(&sc_filters)?,
        }
        Ok(())
    }

    fn health(&self) -> BusHealthSnapshot {
        if self.closed || self.socket.is_none() {
            return BusHealthSnapshot {
                state: BusState::Disconnected,
                tx_error_count: self.tx_error_count,
                rx_error_count: self.rx_error_count,
            };
        }

        let oper_path = Path::new(SYS_CLASS_NET)
            .join(&self.descriptor.channel_name)
            .join("operstate");
        let oper = fs::read_to_string(oper_path).unwrap_or_default();
        let state = if oper.trim().eq_ignore_ascii_case("down") {
            BusState::Disconnected
        } else {
            BusState::Active
        };

        BusHealthSnapshot {
            state,
            tx_error_count: self.tx_error_count,
            rx_error_count: self.rx_error_count,
        }
    }
}

#[inline]
fn extract_clean_id_and_flag(id: Id) -> (u32, u8) {
    match id {
        Id::Standard(std_id) => (u32::from(std_id.as_raw()) & STD_CAN_ID_MASK, 0),
        Id::Extended(ext_id) => (ext_id.as_raw() & EXT_CAN_ID_MASK, FLAG_EXTENDED),
    }
}

#[inline]
fn make_socketcan_id(key: CanIdKey) -> Result<Id, AdapterError> {
    match key {
        CanIdKey::Standard(raw) => StandardId::new(raw)
            .map(Id::Standard)
            .ok_or_else(|| AdapterError::Driver(format!("Invalid 11-bit CAN ID 0x{raw:X}"))),
        CanIdKey::Extended(raw) => ExtendedId::new(raw)
            .map(Id::Extended)
            .ok_or_else(|| AdapterError::Driver(format!("Invalid 29-bit CAN ID 0x{raw:X}"))),
    }
}

#[inline]
fn convert_classical_frame(
    frame: socketcan::CanFrame,
    bus_id: BusId,
    timestamp_us: u64,
) -> RawCanFrame {
    let mut out = RawCanFrame::zeroed();
    out.timestamp_us = timestamp_us;
    out.bus_id = bus_id;

    match frame {
        socketcan::CanFrame::Data(df) => {
            let (arb_id, ext_flag) = extract_clean_id_and_flag(df.id());
            let bytes = df.data();
            let len = bytes.len().min(8);
            out.arb_id = arb_id;
            out.dlc = len as u8;
            out.flags = ext_flag;
            out.data[..len].copy_from_slice(&bytes[..len]);
        }
        socketcan::CanFrame::Remote(rf) => {
            let (arb_id, ext_flag) = extract_clean_id_and_flag(rf.id());
            out.arb_id = arb_id;
            out.dlc = (rf.dlc() as u8).min(8);
            out.flags = ext_flag | FLAG_RTR;
        }
        socketcan::CanFrame::Error(ef) => {
            out.arb_id = ef.id_word() & EXT_CAN_ID_MASK;
            let bytes = ef.data();
            let len = bytes.len().min(8);
            out.dlc = len as u8;
            out.flags = FLAG_ERROR;
            out.data[..len].copy_from_slice(&bytes[..len]);
        }
    }

    out
}

#[inline]
fn convert_any_frame(any: CanAnyFrame, bus_id: BusId, timestamp_us: u64) -> RawCanFrame {
    match any {
        CanAnyFrame::Normal(df) => {
            convert_classical_frame(socketcan::CanFrame::Data(df), bus_id, timestamp_us)
        }
        CanAnyFrame::Remote(rf) => {
            convert_classical_frame(socketcan::CanFrame::Remote(rf), bus_id, timestamp_us)
        }
        CanAnyFrame::Error(ef) => {
            convert_classical_frame(socketcan::CanFrame::Error(ef), bus_id, timestamp_us)
        }
        CanAnyFrame::Fd(fdf) => {
            let mut out = RawCanFrame::zeroed();
            out.timestamp_us = timestamp_us;
            out.bus_id = bus_id;
            let (arb_id, ext_flag) = extract_clean_id_and_flag(fdf.id());
            let bytes = fdf.data();
            let len = bytes.len().min(64);
            let mut flags = ext_flag | FLAG_FD;
            if fdf.is_brs() {
                flags |= FLAG_BRS;
            }
            if fdf.is_esi() {
                flags |= FLAG_ESI;
            }
            out.arb_id = arb_id;
            out.dlc = len as u8;
            out.flags = flags;
            out.data[..len].copy_from_slice(&bytes[..len]);
            out
        }
    }
}
