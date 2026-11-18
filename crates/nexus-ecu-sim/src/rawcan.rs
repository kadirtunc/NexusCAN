//! Minimal `CAN_RAW` receive socket filtered to one CAN ID (Linux). Used for
//! the functional request ID: the simulator decodes Single Frames itself
//! (see [`crate::functional`]) so multi-frame functional requests never get
//! a FlowControl.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use crate::isotp::{wait_readable, CAN_EFF_FLAG};

const CAN_RAW: libc::c_int = 1;
const SOL_CAN_RAW: libc::c_int = 101;
const CAN_RAW_FILTER: libc::c_int = 1;
const CAN_RAW_FD_FRAMES: libc::c_int = 5;
const CAN_RTR_FLAG: u32 = 0x4000_0000;
const CAN_SFF_MASK: u32 = 0x0000_07FF;
const CAN_EFF_MASK: u32 = 0x1FFF_FFFF;
const CANFD_MTU: usize = 72;

#[repr(C)]
struct CanFilter {
    can_id: u32,
    can_mask: u32,
}

#[repr(C)]
struct SockaddrCan {
    can_family: libc::sa_family_t,
    can_ifindex: libc::c_int,
    _addr: [u8; 16],
}

pub struct RawCanSocket {
    fd: OwnedFd,
}

impl RawCanSocket {
    /// Opens a CAN_RAW socket on `iface` receiving only data frames with `id`.
    pub fn open(iface: &str, id: u32, extended: bool, fd_frames: bool) -> io::Result<Self> {
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
        let raw =
            unsafe { libc::socket(libc::PF_CAN, libc::SOCK_RAW | libc::SOCK_CLOEXEC, CAN_RAW) };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: freshly created, owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let filter = if extended {
            CanFilter {
                can_id: (id & CAN_EFF_MASK) | CAN_EFF_FLAG,
                can_mask: CAN_EFF_MASK | CAN_EFF_FLAG | CAN_RTR_FLAG,
            }
        } else {
            CanFilter {
                can_id: id & CAN_SFF_MASK,
                can_mask: CAN_SFF_MASK | CAN_EFF_FLAG | CAN_RTR_FLAG,
            }
        };
        // SAFETY: valid option struct of the given size.
        let r = unsafe {
            libc::setsockopt(
                raw,
                SOL_CAN_RAW,
                CAN_RAW_FILTER,
                (&filter as *const CanFilter).cast(),
                std::mem::size_of::<CanFilter>() as libc::socklen_t,
            )
        };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        if fd_frames {
            let on: libc::c_int = 1;
            // SAFETY: valid int option.
            let r = unsafe {
                libc::setsockopt(
                    raw,
                    SOL_CAN_RAW,
                    CAN_RAW_FD_FRAMES,
                    (&on as *const libc::c_int).cast(),
                    std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                )
            };
            if r < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let addr = SockaddrCan {
            can_family: libc::AF_CAN as libc::sa_family_t,
            can_ifindex: ifindex as libc::c_int,
            _addr: [0; 16],
        };
        // SAFETY: valid sockaddr_can of the given length.
        let r = unsafe {
            libc::bind(
                raw,
                (&addr as *const SockaddrCan).cast(),
                std::mem::size_of::<SockaddrCan>() as libc::socklen_t,
            )
        };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { fd })
    }

    /// Reads one frame; returns its data bytes (length = DLC-decoded length).
    pub fn recv(&self) -> io::Result<Vec<u8>> {
        let mut frame = [0u8; CANFD_MTU];
        // SAFETY: buffer valid for CANFD_MTU bytes.
        let n = unsafe { libc::read(self.fd.as_raw_fd(), frame.as_mut_ptr().cast(), CANFD_MTU) };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        let n = n as usize;
        if n != 16 && n != CANFD_MTU {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected CAN frame size {n}"),
            ));
        }
        let len = usize::from(frame[4]).min(n - 8);
        Ok(frame[8..8 + len].to_vec())
    }

    /// Returns every frame queued right now.
    pub fn drain(&self) -> Vec<Vec<u8>> {
        let mut v = Vec::new();
        while let Ok(r) = wait_readable(&[self.fd.as_raw_fd()], std::time::Duration::ZERO) {
            if r.first() != Some(&true) {
                break;
            }
            match self.recv() {
                Ok(f) => v.push(f),
                Err(_) => break,
            }
        }
        v
    }
}

impl AsRawFd for RawCanSocket {
    fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}
