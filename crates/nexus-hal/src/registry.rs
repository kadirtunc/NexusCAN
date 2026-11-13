//! Multi-driver registry discovering and opening channels across all compiled backends.

use crate::drivers::mock_drv::MockCanDriver;
use crate::drivers::probe::{GsUsbDriver, KvaserDriver, PcanDriver};
use crate::drivers::slcan_drv::SlcanDriver;
#[cfg(target_os = "linux")]
use crate::drivers::socketcan_drv::SocketCanDriver;
use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterDriver, CanChannel, ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use std::sync::Arc;

/// Thread-safe registry of available CAN / CAN-FD hardware and virtual drivers.
#[derive(Clone, Default)]
pub struct DriverRegistry {
    drivers: Vec<Arc<dyn AdapterDriver>>,
}

impl DriverRegistry {
    /// Creates an empty driver registry.
    pub fn new() -> Self {
        Self {
            drivers: Vec::new(),
        }
    }

    /// Creates a registry populated with all built-in drivers supported on the host OS,
    /// prioritizing real kernel/hardware interfaces (`SocketCAN`, `SLCAN`, `gs_usb`, `PCAN`, `Kvaser`)
    /// strictly BEFORE virtual simulation channels (`mock0` + `mock1`):
    /// 1. `SocketCanDriver` (`can*`, `vcan*`, `slcan*` — Linux native)
    /// 2. `SlcanDriver` (Cross-OS Lawicel Serial / USB-CDC via `serialport`)
    /// 3. `GsUsbDriver`, `PcanDriver`, `KvaserDriver` (Cross-OS hardware & SDK drivers)
    /// 4. `MockCanDriver` (`mock0` + `mock1` — virtual simulators always listed last)
    pub fn with_defaults() -> Self {
        let mut reg = Self::new();
        #[cfg(target_os = "linux")]
        {
            reg.register(Arc::new(SocketCanDriver::new()));
        }
        reg.register(Arc::new(SlcanDriver::new()));
        reg.register(Arc::new(GsUsbDriver::new()));
        reg.register(Arc::new(PcanDriver::new()));
        reg.register(Arc::new(KvaserDriver::new()));
        reg.register(Arc::new(MockCanDriver::new()));
        reg
    }

    /// Alias for [`Self::with_defaults`] kept for backward compatibility.
    pub fn with_builtin_drivers() -> Self {
        Self::with_defaults()
    }

    /// Registers an [`AdapterDriver`] backend.
    pub fn register(&mut self, driver: Arc<dyn AdapterDriver>) {
        self.drivers.push(driver);
    }

    /// Discovers all available devices across all registered drivers.
    ///
    /// Individual driver discovery errors are isolated so one unavailable subsystem never blocks others.
    pub fn discover_all(&self) -> Vec<DeviceDescriptor> {
        let mut out = Vec::new();
        for drv in &self.drivers {
            if let Ok(mut devs) = drv.discover_devices() {
                out.append(&mut devs);
            }
        }
        out
    }

    /// Opens a channel by `device_id` (`"mock:mock0"`, `"mock:mock1"`, `"socketcan:vcan0"`,
    /// `"slcan:COM3"`, `"slcan:/dev/ttyUSB0"`, `"pcan:PCAN_USBBUS1"`, `"kvaser:0"`, `"gs_usb:0"`),
    /// supporting manually entered serial ports and explicit driver installation diagnostics.
    ///
    /// # Fail-closed hardware Listen-Only (WP-5)
    ///
    /// When [`ChannelConfig::requires_hardware_listen_only`] is set, a channel whose
    /// [`CanChannel::listen_only_enforcement`] is
    /// [`ListenOnlyEnforcement::SoftwareOnly`] is never returned: the error is
    /// [`AdapterError::hw_listen_only_unavailable`] (message prefix
    /// [`crate::HW_LISTEN_ONLY_UNAVAILABLE_PREFIX`]). Per driver:
    ///
    /// | Driver | Behaviour |
    /// | :--- | :--- |
    /// | `socketcan` (`can*`, `slcan*` netdevs; also `pcan`/`kvaser`/`gs_usb` routed to SocketCAN) | **Fails before open**: the netlink listen-only switch is attempted before any socket exists; on failure anything we changed is reverted and no socket is opened. |
    /// | `socketcan` virtual (`vcan` / `vxcan`, detected from kernel facts: no parent `device` link and no CAN ctrlmode over netlink; never from the name) | n/a: `Virtual`, always allowed. If the facts cannot be read, the interface is treated as physical. |
    /// | `slcan` (serial Lawicel) | **Fails before the CAN channel is opened**: the input is drained until quiet after `C` and before `L`; a still-streaming line means `L` is not sent. `Hardware` only if every setup command (`C`, `Sx`, `Yx`) got `CR` and `L` got a bare `CR` (or the exact echo `L\r` then `CR`; at most 16 bytes scanned). Otherwise (`BEL`, no reply, any other line, or a refused / unanswered setup command) `C` is sent, the serial port is closed, and the error is returned; `O` is never sent. Without the flag the channel opens with `O` instead (Lawicel has no other receive mode), so the adapter ACKs, and it is reported `SoftwareOnly` with the software TX lock. Limit: `Hardware` here is the adapter's claim, not proof (Lawicel cannot read back the mode; some clone firmwares answer `CR` to every command). |
    /// | `pcan` / `kvaser` / `gs_usb` native SDK paths | n/a today: no native backend opens a channel yet (they error or route to SocketCAN). |
    /// | `mock` | n/a: `Virtual`, always allowed. |
    /// | any other / future driver keeping the trait default `SoftwareOnly` | **Closes after open**: this function calls [`CanChannel::close`] and drops the channel before returning, so it never reaches a bus-io thread. |
    pub fn open_by_device_id(
        &self,
        device_id: &str,
        config: &ChannelConfig,
    ) -> Result<(DeviceDescriptor, Box<dyn CanChannel>), AdapterError> {
        let (desc, mut channel) = self.open_by_device_id_unchecked(device_id, config)?;
        if config.requires_hardware_listen_only()
            && channel.listen_only_enforcement() == ListenOnlyEnforcement::SoftwareOnly
        {
            let _ = channel.close();
            drop(channel);
            return Err(AdapterError::hw_listen_only_unavailable(&format!(
                "adapter '{}' (driver '{}') does not support controller silent / listen-only \
                 mode, so it could still ACK frames; the channel was closed without being used. \
                 Use an adapter with hardware listen-only support, or clear \
                 'require hardware listen-only' to accept the software-only TX lock.",
                desc.device_id, desc.driver_id
            )));
        }
        Ok((desc, channel))
    }

    fn open_by_device_id_unchecked(
        &self,
        device_id: &str,
        config: &ChannelConfig,
    ) -> Result<(DeviceDescriptor, Box<dyn CanChannel>), AdapterError> {
        let trimmed_id = device_id.trim();

        // 1. Check exact match among currently enumerated devices first (unless manual SLCAN port override is provided).
        let manual_serial_override = config
            .serial_port
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if manual_serial_override.is_none()
            || !(trimmed_id.starts_with("slcan:")
                || config.driver_family.as_deref() == Some("slcan"))
        {
            for drv in &self.drivers {
                if let Ok(devs) = drv.discover_devices() {
                    if let Some(desc) = devs.into_iter().find(|d| d.device_id == trimmed_id) {
                        let ch = drv.open_channel(&desc, config)?;
                        return Ok((desc, ch));
                    }
                }
            }
        }

        // 2. Smart prefix / driver_family routing for manual serial ports, custom virtual buses, and uninstalled vendor SDK checks.
        let (prefix_family, suffix_channel) = match trimmed_id.split_once(':') {
            Some((fam, rest)) => (Some(fam.trim()), rest.trim()),
            None => (None, trimmed_id),
        };
        let effective_family = prefix_family.or_else(|| {
            config
                .driver_family
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });

        match effective_family {
            Some("slcan") => {
                let port = manual_serial_override.unwrap_or(suffix_channel);
                let desc = SlcanDriver::descriptor_for_port(port);
                let ch = SlcanDriver::new().open_channel(&desc, config)?;
                return Ok((desc, ch));
            }
            Some("pcan") => {
                let ch_name = config
                    .adapter_channel
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(if suffix_channel.is_empty() {
                        "PCAN_USBBUS1"
                    } else {
                        suffix_channel
                    });
                let desc = PcanDriver::descriptor_for_channel(ch_name);
                let ch = PcanDriver::new().open_channel(&desc, config)?;
                return Ok((desc, ch));
            }
            Some("kvaser") => {
                let ch_name = config
                    .adapter_channel
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(if suffix_channel.is_empty() {
                        "0"
                    } else {
                        suffix_channel
                    });
                let desc = KvaserDriver::descriptor_for_channel(ch_name);
                let ch = KvaserDriver::new().open_channel(&desc, config)?;
                return Ok((desc, ch));
            }
            Some("gs_usb") => {
                let ch_name = config
                    .adapter_channel
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(if suffix_channel.is_empty() {
                        "0"
                    } else {
                        suffix_channel
                    });
                let desc = GsUsbDriver::descriptor_for_channel(ch_name);
                let ch = GsUsbDriver::new().open_channel(&desc, config)?;
                return Ok((desc, ch));
            }
            Some("mock") => {
                let ch_name = if suffix_channel.is_empty() {
                    "mock0"
                } else {
                    suffix_channel
                };
                let desc = if ch_name == "mock1" {
                    MockCanDriver::mock1_descriptor()
                } else if ch_name == "mock0" {
                    MockCanDriver::mock0_descriptor()
                } else {
                    DeviceDescriptorDto {
                        device_id: format!("mock:{ch_name}"),
                        driver_id: "mock".to_string(),
                        channel_name: ch_name.to_string(),
                        display_name: format!("{ch_name} — Virtual Simulation CAN-FD Bus"),
                        capabilities: AdapterCapabilitiesDto {
                            supports_fd: true,
                            supports_listen_only: true,
                            supports_hw_timestamps: true,
                            max_bitrate: 8_000_000,
                            is_virtual: true,
                        },
                    }
                };
                let ch = MockCanDriver::new().open_channel(&desc, config)?;
                return Ok((desc, ch));
            }
            Some("socketcan") => {
                let iface = config
                    .adapter_channel
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(suffix_channel);
                #[cfg(target_os = "linux")]
                {
                    let sc_drv = SocketCanDriver::new();
                    if let Ok(devs) = sc_drv.discover_devices() {
                        if let Some(desc) = devs.into_iter().find(|d| d.channel_name == iface) {
                            let ch = sc_drv.open_channel(&desc, config)?;
                            return Ok((desc, ch));
                        }
                    }
                    return Err(AdapterError::DeviceNotFound(format!(
                        "SocketCAN interface '{iface}' not found in /sys/class/net (verify kernel module & 'ip link set up {iface}')"
                    )));
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let _ = iface;
                    return Err(AdapterError::DriverNotAvailable(
                        "socketcan (Linux-only kernel subsystem)".to_string(),
                    ));
                }
            }
            _ => {}
        }

        // Fallback: if serial_port was explicitly supplied without a prefix, route via SlcanDriver.
        if let Some(port) = manual_serial_override {
            let desc = SlcanDriver::descriptor_for_port(port);
            let ch = SlcanDriver::new().open_channel(&desc, config)?;
            return Ok((desc, ch));
        }

        Err(AdapterError::DeviceNotFound(trimmed_id.to_string()))
    }
}
