//! WP-5 (HIGH-02.1): `BusHealthDto.listenOnlyEnforcement` is reported for every connected
//! listen-only bus and serializes exactly as `"hardware" | "softwareOnly" | "virtual"`, or
//! `null` while the bus is active.

use nexus_hal::{ChannelConfigDto, ListenOnlyEnforcement, PipelineEngine, MOCK0_DEVICE_ID};

#[test]
fn wire_strings_are_camel_case() {
    assert_eq!(ListenOnlyEnforcement::Hardware.as_str(), "hardware");
    assert_eq!(ListenOnlyEnforcement::SoftwareOnly.as_str(), "softwareOnly");
    assert_eq!(ListenOnlyEnforcement::Virtual.as_str(), "virtual");
}

fn connect_json(engine: &PipelineEngine, device: &str, listen_only: bool) -> serde_json::Value {
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only,
        mock_fps_preset: Some(500),
        ..ChannelConfigDto::default()
    };
    let dto = engine
        .cmd_connect_bus(device.to_string(), cfg)
        .unwrap_or_else(|e| panic!("connect {device}: {e}"));
    serde_json::to_value(dto).expect("serialize")
}

#[test]
fn mock_listen_only_is_virtual_and_active_is_null() {
    let engine = PipelineEngine::new();
    let v = connect_json(&engine, MOCK0_DEVICE_ID, true);
    assert_eq!(v["listenOnlyEnforcement"], "virtual", "{v}");
    let snap = serde_json::to_value(engine.flush_snapshot_now().expect("snap")).expect("json");
    assert_eq!(snap["buses"][0]["listenOnlyEnforcement"], "virtual");
    engine.cmd_disconnect_bus(0).expect("disconnect");

    let v = connect_json(&engine, MOCK0_DEVICE_ID, false);
    let obj = v.as_object().expect("object");
    assert!(
        obj.contains_key("listenOnlyEnforcement"),
        "key must be present: {v}"
    );
    assert!(v["listenOnlyEnforcement"].is_null(), "{v}");

    // Mode switch to listen-only re-populates it.
    let dto = engine
        .cmd_set_bus_mode(0, true, false)
        .expect("to listen-only");
    assert_eq!(dto.listen_only_enforcement.as_deref(), Some("virtual"));
}

/// vcan0 (if present): passive listen-only connection, never transmits.
#[cfg(target_os = "linux")]
#[test]
fn vcan_listen_only_is_virtual() {
    if !std::path::Path::new("/sys/class/net/vcan0").exists() {
        eprintln!("vcan0 not present; skipping");
        return;
    }
    let engine = PipelineEngine::new();
    let v = connect_json(&engine, "socketcan:vcan0", true);
    assert_eq!(v["listenOnly"], true);
    assert_eq!(v["listenOnlyEnforcement"], "virtual", "{v}");
    engine.cmd_disconnect_bus(0).expect("disconnect");
}
