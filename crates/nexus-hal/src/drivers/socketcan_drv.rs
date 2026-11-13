//! Linux Native SocketCAN (`can*`, `vcan*`, `slcan*`) CAN 2.0 & CAN-FD adapter driver.
//!
//! Strictly gated behind `#[cfg(target_os = "linux")]` so Windows and macOS builds never depend
//! on Linux kernel headers or `socketcan`/`nix` crates.

use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use nexus_core::{
    resolve_frame_timestamp_us, BusId, CanIdKey, RawCanFrame, EXT_CAN_ID_MASK, FLAG_BRS,
    FLAG_ERROR, FLAG_ESI, FLAG_EXTENDED, FLAG_FD, FLAG_RTR, STD_CAN_ID_MASK,
};
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
use socketcan::nl::CanCtrlModes;
use socketcan::{
    CanAnyFrame, CanCtrlMode, CanDataFrame, CanFdFrame, CanFdSocket, CanFilter as ScFilter,
    CanInterface, CanRemoteFrame, CanSocket, EmbeddedFrame, ExtendedId, Frame as ScFrameTrait, Id,
    Socket, SocketOptions, StandardId,
};
use std::fs;
use std::io;
use std::os::fd::{AsFd, BorrowedFd};
use std::path::Path;

const SYS_CLASS_NET: &str = "/sys/class/net";

/// Linux `CAN_EFF_FLAG` (bit 31 of `can_id`): frame uses a 29-bit extended identifier.
const LINUX_CAN_EFF_FLAG: u32 = 0x8000_0000;

/// MED-07: maps a [`CanFilter`] to the kernel `struct can_filter` `(can_id, can_mask)` pair.
///
/// The kernel compares `CAN_EFF_FLAG` as part of the id only when it is set in the mask:
/// * `extended == Some(true)`  → EFF bit set in id and mask: 29-bit frames only.
/// * `extended == Some(false)` → EFF bit clear in id, set in mask: 11-bit frames only.
/// * `extended == None`        → EFF bit clear in the mask: matches both formats.
pub(crate) fn kernel_filter(f: &CanFilter) -> (u32, u32) {
    match f.extended {
        Some(true) => (
            (f.id & EXT_CAN_ID_MASK) | LINUX_CAN_EFF_FLAG,
            (f.mask & EXT_CAN_ID_MASK) | LINUX_CAN_EFF_FLAG,
        ),
        Some(false) => (
            f.id & STD_CAN_ID_MASK,
            (f.mask & STD_CAN_ID_MASK) | LINUX_CAN_EFF_FLAG,
        ),
        None => (f.id & EXT_CAN_ID_MASK, f.mask & EXT_CAN_ID_MASK),
    }
}
const ARPHRD_CAN: &str = "280";

/// Set to `1` to never touch the controller mode via netlink (Listen-Only then stays a
/// software-only TX lock and is reported as such). For sites where taking `canX` down for a
/// few milliseconds is not acceptable.
pub const ENV_DISABLE_HW_LISTEN_ONLY: &str = "NEXUS_SOCKETCAN_NO_HW_LISTEN_ONLY";

/// Kernel facts used to decide whether a SocketCAN netdev is virtual (`vcan` / `vxcan`).
///
/// The netlink link kind (`IFLA_INFO_KIND`) is not exposed by the `socketcan` crate's
/// `InterfaceDetails`, and querying it directly would need a new direct `neli` dependency. So
/// virtualness is derived from two facts that only a virtual CAN netdev has *together*:
/// * no `/sys/class/net/<iface>/device` link (no USB/PCI/SPI/platform parent device), and
/// * no CAN link data over netlink (`IFLA_INFO_DATA` / `IFLA_CAN_CTRLMODE`). Every kernel
///   `candev` driver (link kind `"can"`) reports a ctrlmode, `vcan` / `vxcan` never do.
///
/// `slcan` netdevs also lack a parent device, but they are `candev`s and report a ctrlmode,
/// so they are NOT virtual (their listen-only state is then decided by the ctrlmode logic).
/// The interface name is never consulted: a physical controller renamed to `vcan*` (udev rule,
/// `ip link set name`) stays physical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IfaceKindFacts {
    /// `Some(true)` = `device` link present; `None` = unknown (interface missing, I/O error).
    has_parent_device: Option<bool>,
    /// `Some(true)` = netlink reported CAN ctrlmode data; `None` = netlink query failed.
    reports_can_ctrlmode: Option<bool>,
}

/// Pure classifier for [`IfaceKindFacts`]. Fail-safe: any unknown fact → NOT virtual, so the
/// interface goes through the hardware listen-only / fail-closed path.
const fn classify_virtual(facts: IfaceKindFacts) -> bool {
    matches!(
        facts,
        IfaceKindFacts {
            has_parent_device: Some(false),
            reports_can_ctrlmode: Some(false),
        }
    )
}

/// Reads [`IfaceKindFacts`] for `iface` (read-only sysfs + unprivileged netlink `GETLINK`).
fn iface_kind_facts(iface: &str) -> IfaceKindFacts {
    let dir = Path::new(SYS_CLASS_NET).join(iface);
    let has_parent_device = if dir.is_dir() {
        match fs::symlink_metadata(dir.join("device")) {
            Ok(_) => Some(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        }
    } else {
        None
    };
    let reports_can_ctrlmode = CanInterface::open(iface)
        .ok()
        .and_then(|nl| nl.details().ok())
        .map(|d| d.can.ctrl_mode.is_some());
    IfaceKindFacts {
        has_parent_device,
        reports_can_ctrlmode,
    }
}

/// `vcan` / `vxcan` have no physical controller (no ACK slot to suppress). Decided from kernel
/// facts, never from the name (see [`IfaceKindFacts`]); unknown → not virtual.
fn is_virtual_iface(iface: &str) -> bool {
    classify_virtual(iface_kind_facts(iface))
}

/// Outcome of trying to put a physical controller into listen-only ctrlmode (D-005).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HwListenOnlyOutcome {
    enforcement: ListenOnlyEnforcement,
    /// `true` when WE switched the controller into listen-only and must switch it back on close.
    restore_on_close: bool,
}

/// D-005: tries to put the CAN controller of `iface` into the kernel `listen-only` ctrlmode
/// (`ip link set canX type can listen-only on`) before our socket is opened.
///
/// * `vcan` / `vxcan` (by kernel facts, not by name; see [`is_virtual_iface`]) →
///   [`ListenOnlyEnforcement::Virtual`], only a read-only netlink query, no mode change.
/// * Controller already in listen-only → `Hardware` (left as is, not restored).
/// * Needs `CAP_NET_ADMIN`. The kernel refuses ctrlmode changes while the link is up
///   (`EBUSY`), so the link is taken down, reconfigured and brought up again (this resets the
///   controller and briefly interrupts other sockets on the interface).
/// * Any failure (no privilege, driver without listen-only support such as `slcan`, netlink
///   error) → `SoftwareOnly`; the link is brought back up if we took it down.
fn try_enable_hw_listen_only(iface: &str) -> HwListenOnlyOutcome {
    let software = HwListenOnlyOutcome {
        enforcement: ListenOnlyEnforcement::SoftwareOnly,
        restore_on_close: false,
    };
    if is_virtual_iface(iface) {
        return HwListenOnlyOutcome {
            enforcement: ListenOnlyEnforcement::Virtual,
            restore_on_close: false,
        };
    }
    if std::env::var(ENV_DISABLE_HW_LISTEN_ONLY).is_ok_and(|v| v.trim() == "1") {
        return software;
    }
    let Ok(nl) = CanInterface::open(iface) else {
        return software;
    };
    let Ok(details) = nl.details() else {
        return software;
    };
    let Some(modes) = details.can.ctrl_mode else {
        // No CAN link info (not a netlink-configurable CAN controller).
        return software;
    };
    if modes.has_mode(CanCtrlMode::ListenOnly) {
        return HwListenOnlyOutcome {
            enforcement: ListenOnlyEnforcement::Hardware,
            restore_on_close: false,
        };
    }

    let was_up = details.is_up;
    let applied = if nl.set_ctrlmode(CanCtrlMode::ListenOnly, true).is_ok() {
        true
    } else if was_up && nl.bring_down().is_ok() {
        let ok = nl.set_ctrlmode(CanCtrlMode::ListenOnly, true).is_ok();
        // Always try to bring the link back, whether or not the mode change worked.
        let up_ok = nl.bring_up().is_ok();
        if ok && !up_ok {
            // Leave the interface usable rather than silently half-configured.
            let _ = nl.set_ctrlmode(CanCtrlMode::ListenOnly, false);
            let _ = nl.bring_up();
            false
        } else {
            ok
        }
    } else {
        false
    };
    if !applied {
        return software;
    }
    let verified = nl
        .details()
        .ok()
        .and_then(|d| d.can.ctrl_mode)
        .is_some_and(|m: CanCtrlModes| m.has_mode(CanCtrlMode::ListenOnly));
    HwListenOnlyOutcome {
        enforcement: if verified {
            ListenOnlyEnforcement::Hardware
        } else {
            ListenOnlyEnforcement::SoftwareOnly
        },
        restore_on_close: true,
    }
}

/// Reverts [`try_enable_hw_listen_only`] (best effort, cold path on channel close).
fn restore_hw_listen_only(iface: &str) {
    let Ok(nl) = CanInterface::open(iface) else {
        return;
    };
    if nl.set_ctrlmode(CanCtrlMode::ListenOnly, false).is_ok() {
        return;
    }
    let was_up = nl.details().map(|d| d.is_up).unwrap_or(true);
    if was_up && nl.bring_down().is_ok() {
        let _ = nl.set_ctrlmode(CanCtrlMode::ListenOnly, false);
        let _ = nl.bring_up();
    }
}

/// Fail-closed gate (WP-5 `require_hardware_listen_only`), evaluated right after
/// [`try_enable_hw_listen_only`] and BEFORE any CAN socket is opened.
///
/// Returns `Err` when hardware listen-only was required but only `SoftwareOnly` could be
/// achieved; a ctrlmode change we made (applied but not verified) is reverted first. Note that
/// the failed attempt itself never leaves the controller in a different mode than we found it
/// (a link we took down to retry is brought back up).
///
/// Honest limit: if `iface` is already UP in normal mode, its controller ACKs frames on its own,
/// independent of NexusCAN (the kernel driver does that while the link is up, with or without
/// sockets). We cannot prevent that; fail-closed only guarantees NexusCAN does not run on it and
/// never presents it as passive.
fn fail_closed_gate(
    iface: &str,
    outcome: HwListenOnlyOutcome,
    required: bool,
) -> Result<(), AdapterError> {
    if !required || outcome.enforcement != ListenOnlyEnforcement::SoftwareOnly {
        return Ok(());
    }
    if outcome.restore_on_close {
        restore_hw_listen_only(iface);
    }
    let env_note = if std::env::var(ENV_DISABLE_HW_LISTEN_ONLY).is_ok_and(|v| v.trim() == "1") {
        format!(" Note: {ENV_DISABLE_HW_LISTEN_ONLY}=1 is set, which disables the netlink switch.")
    } else {
        String::new()
    };
    Err(AdapterError::hw_listen_only_unavailable(&format!(
        "SocketCAN interface '{iface}' could not be put into controller listen-only mode, so \
         it was not opened. Grant CAP_NET_ADMIN to NexusCAN (e.g. `sudo setcap \
         cap_net_admin+ep <binary>`), or configure the interface beforehand: `sudo ip link set \
         {iface} down && sudo ip link set {iface} type can listen-only on && sudo ip link set \
         {iface} up` (drivers without listen-only ctrlmode, such as slcand netdevs, cannot be \
         used fail-closed).{env_note}"
    )))
}

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
            let is_virtual = is_virtual_iface(&iface);
            let mode_tag = if supports_fd {
                "CAN-FD"
            } else {
                "Classical CAN"
            };

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

        // D-005: real controller silent mode BEFORE our socket exists (link may bounce).
        // WP-5 fail-closed: with `require_hardware_listen_only`, refuse here, before any socket
        // is opened, if only the software TX lock is possible.
        let hw_listen_only = if config.listen_only {
            let outcome = try_enable_hw_listen_only(iface);
            fail_closed_gate(iface, outcome, config.require_hardware_listen_only)?;
            Some(outcome)
        } else {
            None
        };

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
            listen_only_enforcement: hw_listen_only
                .map_or(ListenOnlyEnforcement::SoftwareOnly, |o| o.enforcement),
            restore_hw_listen_only: hw_listen_only.is_some_and(|o| o.restore_on_close),
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
    listen_only_enforcement: ListenOnlyEnforcement,
    /// We switched the controller into listen-only ctrlmode and must revert it on close.
    restore_hw_listen_only: bool,
    closed: bool,
    rx_error_count: u32,
    tx_error_count: u32,
    socket: Option<SocketHandle>,
}

impl Drop for SocketCanChannel {
    fn drop(&mut self) {
        self.socket = None;
        self.revert_hw_listen_only();
    }
}

impl SocketCanChannel {
    fn revert_hw_listen_only(&mut self) {
        if std::mem::take(&mut self.restore_hw_listen_only) {
            restore_hw_listen_only(&self.descriptor.channel_name);
        }
    }

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
        self.revert_hw_listen_only();
        Ok(())
    }

    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        self.listen_only_enforcement
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
                let poll_timeout = PollTimeout::try_from(timeout_ms).unwrap_or(PollTimeout::MAX);
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
            .map(|f| {
                let (id, mask) = kernel_filter(f);
                ScFilter::new(id, mask)
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Kernel `can_filter` semantics: `(rx_id & mask) == (filter_id & mask)`.
    fn kernel_accepts(filter: (u32, u32), raw_can_id: u32) -> bool {
        (raw_can_id & filter.1) == (filter.0 & filter.1)
    }

    #[test]
    fn kernel_filter_sets_eff_flag_per_extended_selector() {
        let std_frame_0x123 = 0x123u32;
        let ext_frame_0x123 = 0x123u32 | LINUX_CAN_EFF_FLAG;

        let ext_only = kernel_filter(&CanFilter {
            id: 0x123,
            mask: 0x1FFF_FFFF,
            extended: Some(true),
        });
        assert_eq!(ext_only, (0x8000_0123, 0x9FFF_FFFF));
        assert!(kernel_accepts(ext_only, ext_frame_0x123));
        assert!(!kernel_accepts(ext_only, std_frame_0x123));

        let std_only = kernel_filter(&CanFilter {
            id: 0x123,
            mask: 0x7FF,
            extended: Some(false),
        });
        assert_eq!(std_only, (0x123, 0x8000_07FF));
        assert!(kernel_accepts(std_only, std_frame_0x123));
        assert!(!kernel_accepts(std_only, ext_frame_0x123));
        // Standard filter ids are masked to 11 bits.
        assert_eq!(
            kernel_filter(&CanFilter {
                id: 0xFFFF,
                mask: 0xFFFF,
                extended: Some(false)
            })
            .0,
            0x7FF
        );

        let both = kernel_filter(&CanFilter {
            id: 0x123,
            mask: 0x7FF,
            extended: None,
        });
        assert_eq!(both, (0x123, 0x7FF));
        assert!(kernel_accepts(both, std_frame_0x123));
        assert!(kernel_accepts(both, ext_frame_0x123));
        // Caller-supplied flag bits never leak into the kernel filter.
        assert_eq!(
            kernel_filter(&CanFilter {
                id: 0xE000_0123,
                mask: 0xFFFF_FFFF,
                extended: None
            }),
            (0x123, 0x1FFF_FFFF)
        );
    }

    #[test]
    fn virtual_classification_requires_both_kernel_facts() {
        let facts = |dev, ctrl| IfaceKindFacts {
            has_parent_device: dev,
            reports_can_ctrlmode: ctrl,
        };
        // vcan / vxcan: no parent device, no CAN link data.
        assert!(classify_virtual(facts(Some(false), Some(false))));
        // slcan: no parent device, but a candev with ctrlmode → physical path.
        assert!(!classify_virtual(facts(Some(false), Some(true))));
        // USB/PCI controller (whatever its name, e.g. renamed to `vcan0`).
        assert!(!classify_virtual(facts(Some(true), Some(true))));
        assert!(!classify_virtual(facts(Some(true), Some(false))));
        // Any unknown fact → fail-safe, not virtual.
        for f in [
            facts(None, Some(false)),
            facts(Some(false), None),
            facts(None, None),
        ] {
            assert!(!classify_virtual(f), "{f:?}");
        }
    }

    /// Names alone never make an interface virtual: missing `vcan*` / `vxcan*` names (facts
    /// unknown) go through the hardware path and degrade to `SoftwareOnly`.
    #[test]
    fn virtual_looking_names_are_not_trusted() {
        for name in ["vcan_nexus_missing", "vxcan_nexus_missing"] {
            assert!(!is_virtual_iface(name), "{name}");
            let out = try_enable_hw_listen_only(name);
            assert_eq!(out.enforcement, ListenOnlyEnforcement::SoftwareOnly);
            assert!(!out.restore_on_close);
        }
    }

    /// A real `vcan0` (when present) is classified virtual from kernel facts.
    #[test]
    fn real_vcan_is_virtual_when_present() {
        if !Path::new(SYS_CLASS_NET).join("vcan0").exists() {
            eprintln!("vcan0 not present; skipping");
            return;
        }
        let facts = iface_kind_facts("vcan0");
        assert_eq!(
            facts,
            IfaceKindFacts {
                has_parent_device: Some(false),
                reports_can_ctrlmode: Some(false),
            }
        );
        let out = try_enable_hw_listen_only("vcan0");
        assert_eq!(out.enforcement, ListenOnlyEnforcement::Virtual);
        assert!(!out.restore_on_close);
    }

    #[test]
    fn fail_closed_gate_only_rejects_required_software_only() {
        let sw = HwListenOnlyOutcome {
            enforcement: ListenOnlyEnforcement::SoftwareOnly,
            restore_on_close: false,
        };
        let err = fail_closed_gate("can_nexus_missing_wp5", sw, true).expect_err("must refuse");
        assert!(err.is_hw_listen_only_unavailable(), "{err}");
        assert!(err.to_string().contains("CAP_NET_ADMIN"), "{err}");
        assert!(fail_closed_gate("can_nexus_missing_wp5", sw, false).is_ok());
        for enforcement in [
            ListenOnlyEnforcement::Hardware,
            ListenOnlyEnforcement::Virtual,
        ] {
            let ok = HwListenOnlyOutcome {
                enforcement,
                restore_on_close: false,
            };
            assert!(fail_closed_gate("can_nexus_missing_wp5", ok, true).is_ok());
        }
    }

    /// The refusal happens before any socket is opened: on a missing physical interface the
    /// error is the fail-closed refusal, not the socket-open I/O error.
    #[test]
    fn open_refuses_before_socket_when_hw_listen_only_required() {
        let desc = DeviceDescriptorDto {
            device_id: "socketcan:can_nexus_missing_wp5".to_string(),
            driver_id: "socketcan".to_string(),
            channel_name: "can_nexus_missing_wp5".to_string(),
            display_name: String::new(),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: false,
                supports_listen_only: true,
                supports_hw_timestamps: true,
                max_bitrate: 1_000_000,
                is_virtual: false,
            },
        };
        let cfg = ChannelConfig {
            listen_only: true,
            require_hardware_listen_only: true,
            ..ChannelConfig::default()
        };
        let err = match SocketCanDriver::new().open_channel(&desc, &cfg) {
            Ok(_) => panic!("must not open"),
            Err(e) => e,
        };
        assert!(err.is_hw_listen_only_unavailable(), "{err}");

        // Without the flag the same open proceeds to the socket (and fails there: no iface).
        let cfg = ChannelConfig {
            require_hardware_listen_only: false,
            ..cfg
        };
        let err = match SocketCanDriver::new().open_channel(&desc, &cfg) {
            Ok(_) => panic!("missing iface cannot open"),
            Err(e) => e,
        };
        assert!(!err.is_hw_listen_only_unavailable(), "{err}");
    }

    #[test]
    fn missing_interface_degrades_to_software_only() {
        let out = try_enable_hw_listen_only("can_nexus_missing_d005");
        assert_eq!(out.enforcement, ListenOnlyEnforcement::SoftwareOnly);
        assert!(!out.restore_on_close);
    }
}
