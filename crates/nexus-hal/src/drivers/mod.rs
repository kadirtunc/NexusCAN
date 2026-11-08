//! Built-in cross-platform and OS-native CAN / CAN-FD adapter drivers.

pub mod mock_drv;
pub mod probe;
pub mod slcan_drv;
#[cfg(target_os = "linux")]
pub mod socketcan_drv;
