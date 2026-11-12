//! WP-5 fail-closed option: `ChannelConfigDto.require_hardware_listen_only`.
//!
//! A test-only adapter (defined here, never part of the shipped crate) keeps the trait default
//! `ListenOnlyEnforcement::SoftwareOnly`, like a physical controller that cannot be silenced.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nexus_core::RawCanFrame;
use nexus_hal::{
    AdapterCapabilities, AdapterCapabilitiesDto, AdapterDriver, AdapterError, BusHealthSnapshot,
    CanChannel, CanFilter, ChannelConfig, ChannelConfigDto, DeviceDescriptor, DeviceDescriptorDto,
    DriverRegistry, PipelineEngine, HW_LISTEN_ONLY_UNAVAILABLE_PREFIX, MOCK0_DEVICE_ID,
};

const SOFT_DEVICE_ID: &str = "softonly:0";

/// Counts channels that are open (constructed and neither closed nor dropped).
#[derive(Default)]
struct OpenCounter(AtomicUsize);

struct SoftOnlyDriver {
    open: Arc<OpenCounter>,
}

fn soft_descriptor() -> DeviceDescriptorDto {
    DeviceDescriptorDto {
        device_id: SOFT_DEVICE_ID.to_string(),
        driver_id: "softonly".to_string(),
        channel_name: "soft0".to_string(),
        display_name: "soft0 (test: no hardware listen-only)".to_string(),
        capabilities: AdapterCapabilitiesDto {
            supports_fd: false,
            supports_listen_only: true,
            supports_hw_timestamps: false,
            max_bitrate: 1_000_000,
            is_virtual: false,
        },
    }
}

impl AdapterDriver for SoftOnlyDriver {
    fn driver_id(&self) -> &'static str {
        "softonly"
    }
    fn display_name(&self) -> &'static str {
        "Test adapter without hardware listen-only"
    }
    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        Ok(vec![soft_descriptor()])
    }
    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        self.open.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(SoftOnlyChannel {
            descriptor: device.clone(),
            listen_only: config.listen_only,
            open: Some(Arc::clone(&self.open)),
        }))
    }
}

struct SoftOnlyChannel {
    descriptor: DeviceDescriptor,
    listen_only: bool,
    open: Option<Arc<OpenCounter>>,
}

impl SoftOnlyChannel {
    fn release(&mut self) {
        if let Some(c) = self.open.take() {
            c.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for SoftOnlyChannel {
    fn drop(&mut self) {
        self.release();
    }
}

// `listen_only_enforcement` intentionally NOT overridden: trait default `SoftwareOnly`.
impl CanChannel for SoftOnlyChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }
    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }
    fn close(&mut self) -> Result<(), AdapterError> {
        self.release();
        Ok(())
    }
    fn recv_batch(
        &mut self,
        _out: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.open.is_none() {
            return Err(AdapterError::ChannelClosed);
        }
        std::thread::sleep(Duration::from_millis(u64::from(timeout_ms.min(5))));
        Ok(0)
    }
    fn send_frame(&mut self, _frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }
        Ok(())
    }
    fn set_filters(&mut self, _filters: &[CanFilter]) -> Result<(), AdapterError> {
        Ok(())
    }
    fn health(&self) -> BusHealthSnapshot {
        BusHealthSnapshot::default()
    }
}

fn soft_engine() -> (PipelineEngine, Arc<OpenCounter>) {
    let open = Arc::new(OpenCounter::default());
    let mut reg = DriverRegistry::new();
    reg.register(Arc::new(SoftOnlyDriver {
        open: Arc::clone(&open),
    }));
    (PipelineEngine::with_registry(reg), open)
}

fn cfg(listen_only: bool, require_hw: bool) -> ChannelConfigDto {
    ChannelConfigDto {
        bus_id: 0,
        listen_only,
        require_hardware_listen_only: require_hw,
        mock_fps_preset: Some(500),
        ..ChannelConfigDto::default()
    }
}

fn snapshot_bus_count(engine: &PipelineEngine) -> usize {
    engine.flush_snapshot_now().expect("snapshot").buses.len()
}

#[test]
fn software_only_channel_is_refused_and_closed_when_flag_set() {
    let (engine, open) = soft_engine();
    let err = engine
        .cmd_connect_bus(SOFT_DEVICE_ID.to_string(), cfg(true, true))
        .expect_err("fail-closed must refuse a software-only listen-only channel");
    let msg = err.to_string();
    assert!(msg.starts_with(HW_LISTEN_ONLY_UNAVAILABLE_PREFIX), "{msg}");
    assert!(err.is_hw_listen_only_unavailable());
    // IPC serialization (Tauri `AppError` / bridge) is the Display string.
    let wire = serde_json::to_value(&err).expect("serialize");
    assert!(wire
        .as_str()
        .is_some_and(|s| s.starts_with("HW_LISTEN_ONLY_UNAVAILABLE: ")));

    assert_eq!(open.0.load(Ordering::SeqCst), 0, "channel left open");
    assert_eq!(snapshot_bus_count(&engine), 0, "bus must not be present");
    assert!(
        engine.cmd_disconnect_bus(0).is_err(),
        "bus must not be connected"
    );

    // Not left in a wedged state: the same slot connects once the flag is cleared.
    let dto = engine
        .cmd_connect_bus(SOFT_DEVICE_ID.to_string(), cfg(true, false))
        .expect("connect without flag");
    assert_eq!(dto.listen_only_enforcement.as_deref(), Some("softwareOnly"));
}

#[test]
fn software_only_channel_connects_without_flag() {
    let (engine, open) = soft_engine();
    let dto = engine
        .cmd_connect_bus(SOFT_DEVICE_ID.to_string(), cfg(true, false))
        .expect("existing behaviour: software-only fallback");
    assert!(dto.listen_only && !dto.tx_armed);
    assert_eq!(dto.listen_only_enforcement.as_deref(), Some("softwareOnly"));
    assert_eq!(open.0.load(Ordering::SeqCst), 1);
    assert_eq!(snapshot_bus_count(&engine), 1);
    engine.cmd_disconnect_bus(0).expect("disconnect");
    assert_eq!(open.0.load(Ordering::SeqCst), 0);
}

#[test]
fn flag_is_ignored_for_active_channels_and_kept_across_set_bus_mode() {
    let (engine, open) = soft_engine();
    // Active (not listen-only): the flag has nothing to enforce.
    let dto = engine
        .cmd_connect_bus(SOFT_DEVICE_ID.to_string(), cfg(false, true))
        .expect("active connect");
    assert!(!dto.listen_only);
    assert!(dto.listen_only_enforcement.is_none());

    // Re-open into listen-only: stored flag still set -> refused, bus stays disconnected.
    let err = engine
        .cmd_set_bus_mode(0, true, false)
        .expect_err("re-open into software-only listen-only must be refused");
    assert!(
        err.to_string()
            .starts_with(HW_LISTEN_ONLY_UNAVAILABLE_PREFIX),
        "{err}"
    );
    assert_eq!(open.0.load(Ordering::SeqCst), 0, "channel left open");
    assert_eq!(snapshot_bus_count(&engine), 0);
}

#[test]
fn registry_never_returns_software_only_channel_when_required() {
    let open = Arc::new(OpenCounter::default());
    let mut reg = DriverRegistry::new();
    reg.register(Arc::new(SoftOnlyDriver {
        open: Arc::clone(&open),
    }));
    let err = match reg.open_by_device_id(SOFT_DEVICE_ID, &cfg(true, true)) {
        Ok(_) => panic!("must refuse"),
        Err(e) => e,
    };
    assert!(err.is_hw_listen_only_unavailable(), "{err}");
    assert_eq!(open.0.load(Ordering::SeqCst), 0);
}

#[test]
fn virtual_mock_connects_with_flag() {
    let engine = PipelineEngine::new();
    let dto = engine
        .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg(true, true))
        .expect("virtual channels are unaffected");
    assert_eq!(dto.listen_only_enforcement.as_deref(), Some("virtual"));
    engine.cmd_disconnect_bus(0).expect("disconnect");
}

#[cfg(target_os = "linux")]
#[test]
fn vcan_connects_with_flag() {
    if !std::path::Path::new("/sys/class/net/vcan0").exists() {
        eprintln!("vcan0 not present; skipping");
        return;
    }
    let engine = PipelineEngine::new();
    let dto = engine
        .cmd_connect_bus("socketcan:vcan0".to_string(), cfg(true, true))
        .expect("vcan0 is virtual: allowed fail-closed");
    assert!(dto.listen_only);
    assert_eq!(dto.listen_only_enforcement.as_deref(), Some("virtual"));
    engine.cmd_disconnect_bus(0).expect("disconnect");
}

#[test]
fn serde_default_and_camel_case_name() {
    let without: ChannelConfigDto = serde_json::from_value(serde_json::json!({
        "busId": 0, "bitrate": 500000, "dataBitrate": 2000000,
        "enableFd": true, "listenOnly": true
    }))
    .expect("missing field deserializes");
    assert!(!without.require_hardware_listen_only);
    assert!(!ChannelConfigDto::default().require_hardware_listen_only);

    let with: ChannelConfigDto = serde_json::from_value(serde_json::json!({
        "busId": 0, "bitrate": 500000, "dataBitrate": 2000000,
        "enableFd": true, "listenOnly": true, "requireHardwareListenOnly": true
    }))
    .expect("camelCase field");
    assert!(with.require_hardware_listen_only);
    assert!(with.requires_hardware_listen_only());

    let v = serde_json::to_value(&with).expect("serialize");
    assert_eq!(v["requireHardwareListenOnly"], true, "{v}");
}
