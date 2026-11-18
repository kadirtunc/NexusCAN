//! Minimal safe wrapper around the Linux kernel ISO 15765-2 socket
//! (`PF_CAN`, `SOCK_DGRAM`, `CAN_ISOTP`, `linux/can/isotp.h`).
//!
//! Constants and option structs are declared locally (rather than relying on
//! a specific `libc` version exposing them) and match the kernel UAPI.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Duration;

const CAN_ISOTP: libc::c_int = 6;
const SOL_CAN_BASE: libc::c_int = 100;
const SOL_CAN_ISOTP: libc::c_int = SOL_CAN_BASE + CAN_ISOTP;

const CAN_ISOTP_OPTS: libc::c_int = 1;
const CAN_ISOTP_RECV_FC: libc::c_int = 2;
const CAN_ISOTP_LL_OPTS: libc::c_int = 5;

const CAN_ISOTP_TX_PADDING: u32 = 0x0004;
const CAN_ISOTP_WAIT_TX_DONE: u32 = 0x0400;
const CAN_ISOTP_SF_BROADCAST: u32 = 0x0800;

pub const CAN_EFF_FLAG: u32 = 0x8000_0000;
const CAN_MTU: u8 = 16;
const CANFD_MTU: u8 = 72;
const CANFD_BRS: u8 = 0x01;

#[repr(C)]
struct CanIsotpOptions {
    flags: u32,
    frame_txtime: u32,
    ext_address: u8,
    txpad_content: u8,
    rxpad_content: u8,
    rx_ext_address: u8,
}

#[repr(C)]
struct CanIsotpFcOptions {
    bs: u8,
    stmin: u8,
    wftmax: u8,
}

#[repr(C)]
struct CanIsotpLlOptions {
    mtu: u8,
    tx_dl: u8,
    tx_flags: u8,
}

/// `struct sockaddr_can` with the `tp` member of the address union; padded to
/// the kernel's 24-byte size (the union also holds the 16-byte j1939 member).
#[repr(C)]
struct SockaddrCanTp {
    can_family: libc::sa_family_t,
    can_ifindex: libc::c_int,
    rx_id: u32,
    tx_id: u32,
    _pad: [u8; 8],
}

#[derive(Debug, Clone, Default)]
pub struct IsoTpOptions {
    /// Pad transmitted frames to 8 (or the FD DLC) with this byte.
    pub padding: Option<u8>,
    /// STmin we request from the peer in our FlowControl frames (µs).
    pub stmin_us: u32,
    /// BlockSize we request from the peer in our FlowControl frames.
    pub block_size: u8,
    /// 29-bit CAN identifiers.
    pub extended: bool,
    /// CAN FD link layer (64-byte frames, BRS).
    pub fd: bool,
    /// 1-to-N functional sender (`CAN_ISOTP_SF_BROADCAST`): the kernel only
    /// transmits Single Frames and rejects longer PDUs (test clients).
    pub sf_broadcast: bool,
}

/// Encodes an STmin in µs into the ISO 15765-2 FlowControl byte.
pub fn encode_stmin(us: u32) -> u8 {
    match us {
        0..=99 => 0,
        100..=999 => 0xF0 + (us / 100) as u8,
        _ => (us / 1000).min(127) as u8,
    }
}

#[derive(Debug)]
pub struct IsoTpSocket {
    fd: OwnedFd,
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(r)
    }
}

fn setopt<T>(fd: RawFd, name: libc::c_int, val: &T) -> io::Result<()> {
    // SAFETY: `val` points to a properly initialised #[repr(C)] value of the
    // size passed; the kernel copies it.
    cvt(unsafe {
        libc::setsockopt(
            fd,
            SOL_CAN_ISOTP,
            name,
            (val as *const T).cast(),
            std::mem::size_of::<T>() as libc::socklen_t,
        )
    })
    .map(|_| ())
}

impl IsoTpSocket {
    /// Opens and binds an ISO-TP socket: receives on `rx_id`, sends on `tx_id`.
    pub fn open(iface: &str, rx_id: u32, tx_id: u32, opts: &IsoTpOptions) -> io::Result<Self> {
        let name = CString::new(iface)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad interface name"))?;
        // SAFETY: valid NUL-terminated string.
        let ifindex = unsafe { libc::if_nametoindex(name.as_ptr()) };
        if ifindex == 0 {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("CAN interface '{iface}' not found"),
            ));
        }
        // SAFETY: plain socket(2) call.
        let raw = cvt(unsafe {
            libc::socket(
                libc::PF_CAN,
                libc::SOCK_DGRAM | libc::SOCK_CLOEXEC,
                CAN_ISOTP,
            )
        })
        .map_err(|e| {
            io::Error::new(
                e.kind(),
                format!(
                    "socket(PF_CAN, CAN_ISOTP) failed: {e} (is the can-isotp module available?)"
                ),
            )
        })?;
        // SAFETY: `raw` is a freshly created, owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };

        let mut flags = CAN_ISOTP_WAIT_TX_DONE;
        if opts.padding.is_some() {
            flags |= CAN_ISOTP_TX_PADDING;
        }
        if opts.sf_broadcast {
            flags |= CAN_ISOTP_SF_BROADCAST;
        }
        let o = CanIsotpOptions {
            flags,
            frame_txtime: 0,
            ext_address: 0,
            txpad_content: opts.padding.unwrap_or(0xCC),
            rxpad_content: 0,
            rx_ext_address: 0,
        };
        setopt(raw, CAN_ISOTP_OPTS, &o)?;
        let fc = CanIsotpFcOptions {
            bs: opts.block_size,
            stmin: encode_stmin(opts.stmin_us),
            wftmax: 0,
        };
        setopt(raw, CAN_ISOTP_RECV_FC, &fc)?;
        if opts.fd {
            let ll = CanIsotpLlOptions {
                mtu: CANFD_MTU,
                tx_dl: 64,
                tx_flags: CANFD_BRS,
            };
            setopt(raw, CAN_ISOTP_LL_OPTS, &ll)?;
        } else {
            let ll = CanIsotpLlOptions {
                mtu: CAN_MTU,
                tx_dl: 8,
                tx_flags: 0,
            };
            setopt(raw, CAN_ISOTP_LL_OPTS, &ll)?;
        }

        let eff = if opts.extended { CAN_EFF_FLAG } else { 0 };
        let addr = SockaddrCanTp {
            can_family: libc::AF_CAN as libc::sa_family_t,
            can_ifindex: ifindex as libc::c_int,
            rx_id: rx_id | eff,
            tx_id: tx_id | eff,
            _pad: [0; 8],
        };
        // SAFETY: `addr` is a valid sockaddr_can of the given length.
        cvt(unsafe {
            libc::bind(
                raw,
                (&addr as *const SockaddrCanTp).cast(),
                std::mem::size_of::<SockaddrCanTp>() as libc::socklen_t,
            )
        })?;
        Ok(Self { fd })
    }

    /// Sends one complete PDU (blocks until transmitted: WAIT_TX_DONE).
    pub fn send(&self, pdu: &[u8]) -> io::Result<()> {
        // SAFETY: buffer valid for `pdu.len()` bytes.
        let n = unsafe { libc::write(self.fd.as_raw_fd(), pdu.as_ptr().cast(), pdu.len()) };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        if n as usize != pdu.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "short ISO-TP write",
            ));
        }
        Ok(())
    }

    /// Blocking receive of one complete PDU.
    pub fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        // SAFETY: buffer valid for `buf.len()` bytes.
        let n = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }

    /// Receives one PDU or returns `Ok(None)` after `timeout`.
    pub fn recv_timeout(&self, buf: &mut [u8], timeout: Duration) -> io::Result<Option<usize>> {
        if wait_readable(&[self.fd.as_raw_fd()], timeout)?.first() == Some(&true) {
            self.recv(buf).map(Some)
        } else {
            Ok(None)
        }
    }

    /// Discards every queued PDU.
    pub fn drain(&self) -> usize {
        self.drain_collect().len()
    }

    /// Removes and returns every queued PDU.
    pub fn drain_collect(&self) -> Vec<Vec<u8>> {
        let mut buf = vec![0u8; 8192];
        let mut v = Vec::new();
        while let Ok(Some(n)) = self.recv_timeout(&mut buf, Duration::ZERO) {
            v.push(buf[..n].to_vec());
        }
        v
    }
}

impl AsRawFd for IsoTpSocket {
    fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}

/// poll(2) on `fds` for readability; returns per-fd readiness. `EINTR` is
/// reported as "nothing ready".
pub fn wait_readable(fds: &[RawFd], timeout: Duration) -> io::Result<Vec<bool>> {
    let mut p: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let ms = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
    // SAFETY: `p` is a valid array of pollfd of the given length.
    let r = unsafe { libc::poll(p.as_mut_ptr(), p.len() as libc::nfds_t, ms) };
    if r < 0 {
        let e = io::Error::last_os_error();
        if e.kind() == io::ErrorKind::Interrupted {
            return Ok(vec![false; fds.len()]);
        }
        return Err(e);
    }
    Ok(p.iter()
        .map(|x| x.revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stmin_encoding() {
        assert_eq!(encode_stmin(0), 0x00);
        assert_eq!(encode_stmin(99), 0x00);
        assert_eq!(encode_stmin(100), 0xF1);
        assert_eq!(encode_stmin(900), 0xF9);
        assert_eq!(encode_stmin(1000), 0x01);
        assert_eq!(encode_stmin(20_000), 20);
        assert_eq!(encode_stmin(500_000), 127);
    }

    #[test]
    fn sockaddr_layout_matches_kernel() {
        assert_eq!(std::mem::size_of::<SockaddrCanTp>(), 24);
        assert_eq!(std::mem::size_of::<CanIsotpOptions>(), 12);
        assert_eq!(std::mem::size_of::<CanIsotpFcOptions>(), 3);
    }
}
