//! # nexus-cloud
//!
//! Standalone, non-blocking Read-Only Cloud Telemetry Bridge & Device Pairing
//! client crate for `NexusCAN` (`NexusCAN` <-> `NexusCANCloud`).
//!
//! ### Core Architectural Guarantees
//! 1. **Zero Local Hot-Path Backpressure:** Subscribes exclusively via
//!    `tokio::sync::broadcast::Receiver<BridgeTelemetryFrame>`. Slow or disconnected
//!    WAN links trigger `RecvError::Lagged(skipped)` drops without ever blocking
//!    local 60 FPS `NexusCAN` CAN / CAN-FD analysis.
//! 2. **Compile-Time & Runtime Read-Only Safety:** No `nexus-hal` dependency and no
//!    remote CAN `TX` or `Arm Active Bus` message variants exist.
//! 3. **Two-Plane SHA-256 Schema Deduplication & Adaptive Cadence (`2Hz`..`60Hz`).**

#![forbid(unsafe_code)]

pub mod cadence;
pub mod client;
pub mod pairing;
pub mod protocol;
pub mod sha256;

pub use cadence::{CadenceDecimator, ExponentialBackoff};
pub use client::{
    spawn_bridge_client, BoxFuture, BridgeClientConfig, BridgeClientError, BridgeClientHandle,
    BridgeClientMetrics, BridgeConnector, BridgeTransport, ChannelBridgeTransport, SchemaUploader,
    TcpWsConnector,
};
pub use pairing::{
    DeviceApiToken, DevicePairingState, PairingCode, PairingError, DEVICE_TOKEN_PREFIX,
    PAIRING_PREFIX,
};
pub use protocol::{
    parse_inbound_cloud_message, BridgeHelloFrame, BridgeStreamStateKind, BridgeTargetHz,
    BridgeTelemetryFrame, BusHealthWireDto, BusStateKind, CaptureStatusFrame,
    ChronologicalFrameWireDto, CloudProtocolError, CycleHealthKind, FrameTelemetryWireDto,
    InboundCloudMessage, LiveSignalWireDto, RateControlFrame, SchemaAckFrame, SchemaAckStatus,
};
pub use sha256::{sha256_digest, sha256_hex};

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;
    use tokio::sync::{broadcast, mpsc};

    use super::*;

    #[test]
    fn pairing_code_and_redacted_token_validation() {
        let code = PairingCode::parse(" nxc-9f3a-b72c ").expect("valid pairing code");
        assert_eq!(code.as_str(), "NXC-9F3A-B72C");

        assert!(PairingCode::parse("NXC-123-4567").is_err());
        assert!(PairingCode::parse("BAD-9F3A-B72C").is_err());
        assert!(PairingCode::parse("NXC-9F3$-B72C").is_err());

        let tok = DeviceApiToken::parse("nxc_tok_9f3a88cc771122334455").expect("valid token");
        let debug_str = format!("{tok:?}");
        let display_str = format!("{tok}");
        assert!(!debug_str.contains("88cc771122334455"));
        assert!(!display_str.contains("88cc771122334455"));
        assert!(debug_str.contains("[REDACTED]"));
        assert_eq!(
            tok.bearer_header_value(),
            "Bearer nxc_tok_9f3a88cc771122334455"
        );
    }

    #[test]
    fn read_only_cloud_safety_blocks_remote_can_tx_and_arm_bus() {
        let forbidden_payloads = [
            r#"{"type":"TX","arbId":257,"data":[1,2,3,4]}"#,
            r#"{"type":"CAN_TX","arbId":257}"#,
            r#"{"type":"SEND_FRAME","busId":0}"#,
            r#"{"type":"CMD_ARM_ACTIVE_BUS","busId":0}"#,
            r#"{"type":"ARM_ACTIVE_BUS"}"#,
            r#"{"type":"PERIODIC_TX","cycleMs":10}"#,
        ];

        for bad_json in forbidden_payloads {
            let err = parse_inbound_cloud_message(bad_json)
                .expect_err("actuation command must be rejected");
            assert!(
                matches!(err, CloudProtocolError::ForbiddenRemoteActuationCommand(_)),
                "Expected ForbiddenRemoteActuationCommand, got {err:?}"
            );
        }

        let unknown_err =
            parse_inbound_cloud_message(r#"{"type":"REMOTE_SHELL_EXEC"}"#).unwrap_err();
        assert!(matches!(
            unknown_err,
            CloudProtocolError::UnknownInboundCommand(_)
        ));
    }

    #[test]
    fn cadence_decimator_accurately_scales_60hz_to_20hz_and_2hz() {
        // Simulate 3 seconds of 60Hz snapshots (180 frames at 16,666 us intervals)
        let mut dec_20 = CadenceDecimator::new(BridgeTargetHz::Hz20);
        let mut emitted_20 = 0usize;
        for i in 0..180u64 {
            if dec_20.should_emit(i * 16_666) {
                emitted_20 += 1;
            }
        }
        // 3 sec * 20 Hz = 60 frames
        assert_eq!(emitted_20, 60);

        let mut dec_2 = CadenceDecimator::new(BridgeTargetHz::Hz2);
        let mut emitted_2 = 0usize;
        for i in 0..180u64 {
            if dec_2.should_emit(i * 16_666) {
                emitted_2 += 1;
            }
        }
        // 3 sec * 2 Hz = 6 frames
        assert_eq!(emitted_2, 6);

        let mut dec_60 = CadenceDecimator::new(BridgeTargetHz::Hz60);
        let mut emitted_60 = 0usize;
        for i in 0..180u64 {
            if dec_60.should_emit(i * 16_666) {
                emitted_60 += 1;
            }
        }
        assert_eq!(emitted_60, 180);
    }

    #[test]
    fn exponential_backoff_clamps_and_resets() {
        let mut backoff = ExponentialBackoff::new(500, 5_000);
        assert_eq!(backoff.next_delay(), Duration::from_millis(500));
        assert_eq!(backoff.next_delay(), Duration::from_millis(1_000));
        assert_eq!(backoff.next_delay(), Duration::from_millis(2_000));
        assert_eq!(backoff.next_delay(), Duration::from_millis(4_000));
        assert_eq!(backoff.next_delay(), Duration::from_millis(5_000));
        assert_eq!(backoff.next_delay(), Duration::from_millis(5_000));
        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_millis(500));
    }

    struct MockTestConnector {
        inbound_rx_slot: Mutex<Option<mpsc::Receiver<String>>>,
        outbound_tx: mpsc::Sender<String>,
    }

    impl BridgeConnector for MockTestConnector {
        fn connect<'a>(
            &'a self,
            _config: &'a BridgeClientConfig,
        ) -> BoxFuture<'a, Result<Box<dyn BridgeTransport>, BridgeClientError>> {
            Box::pin(async move {
                let rx = self.inbound_rx_slot.lock().take().ok_or_else(|| {
                    BridgeClientError::ConnectionClosed { code: None }
                })?;
                let transport: Box<dyn BridgeTransport> =
                    Box::new(ChannelBridgeTransport::new(self.outbound_tx.clone(), rx));
                Ok(transport)
            })
        }
    }

    struct CountingUploader {
        calls: AtomicUsize,
    }

    impl SchemaUploader for CountingUploader {
        fn upload_schema<'a>(
            &'a self,
            _project_id: &'a str,
            _db_name: &'a str,
            _sha256_hex: &'a str,
            _raw_bytes: &'a [u8],
        ) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok("dbc_ver_uploaded_1".to_string())
            })
        }
    }

    #[tokio::test]
    async fn two_plane_handshake_rate_control_and_read_only_violation_defense() {
        let (telemetry_tx, telemetry_rx) = broadcast::channel::<BridgeTelemetryFrame>(64);
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(64);
        let (cloud_to_desktop_tx, cloud_to_desktop_rx) = mpsc::channel::<String>(64);

        let connector = Arc::new(MockTestConnector {
            inbound_rx_slot: Mutex::new(Some(cloud_to_desktop_rx)),
            outbound_tx,
        });
        let uploader = Arc::new(CountingUploader {
            calls: AtomicUsize::new(0),
        });

        let raw_dbc = b"VERSION \"1.0\"\nBO_ 257 Msg1: 8 ECU1\n";
        let expected_sha = sha256_hex(raw_dbc);

        let cfg = BridgeClientConfig {
            endpoint_url: "ws://127.0.0.1:3000/api/bridge/ws".to_string(),
            device_id: "dev_bench_01".to_string(),
            project_id: "proj_ev_01".to_string(),
            app_version: "0.1.0".to_string(),
            host_os: "Linux".to_string(),
            token: DeviceApiToken::parse("nxc_tok_test_secret_12345678").unwrap(),
            preferred_active_hz: BridgeTargetHz::Hz20,
            active_db_name: Some("sample.dbc".to_string()),
            raw_database_bytes: Some(raw_dbc.to_vec()),
            backoff_base_ms: 50,
            backoff_max_ms: 200,
        };

        let handle = spawn_bridge_client(
            cfg,
            telemetry_rx,
            connector,
            Some(uploader.clone()),
        );

        // 1. Expect Plane-1 BRIDGE_HELLO with exact SHA-256
        let hello_raw = tokio::time::timeout(Duration::from_secs(2), outbound_rx.recv())
            .await
            .expect("hello timeout")
            .expect("hello payload");
        let hello: BridgeHelloFrame = serde_json::from_str(&hello_raw).unwrap();
        assert_eq!(hello.msg_type, "BRIDGE_HELLO");
        assert_eq!(hello.schema_sha256.as_deref(), Some(expected_sha.as_str()));

        // 2. Cloud responds SCHEMA_ACK(upload_required) + RATE_CONTROL(2Hz) + malicious TX frame
        cloud_to_desktop_tx
            .send(r#"{"type":"SCHEMA_ACK","status":"upload_required","dbcVersionId":null}"#.to_string())
            .await
            .unwrap();
        cloud_to_desktop_tx
            .send(r#"{"type":"RATE_CONTROL","targetHz":2,"reason":"idle_no_viewers"}"#.to_string())
            .await
            .unwrap();
        cloud_to_desktop_tx
            .send(r#"{"type":"CMD_ARM_ACTIVE_BUS","busId":0}"#.to_string())
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(30)).await;

        // 3. Emit 60 frames (1 second at 60Hz) -> at 2Hz idle rate, only 2 frames should forward!
        for i in 0..60u64 {
            let _ = telemetry_tx.send(BridgeTelemetryFrame::empty_heartbeat(i + 1, i * 16_666));
        }

        tokio::time::sleep(Duration::from_millis(40)).await;
        let snap = handle.metrics_snapshot();
        assert_eq!(uploader.calls.load(Ordering::SeqCst), 1);
        assert_eq!(snap.schema_uploads_triggered, 1);
        assert_eq!(snap.current_target_hz, BridgeTargetHz::Hz2);
        assert_eq!(snap.security_violations_rejected, 1);
        assert_eq!(snap.snapshots_forwarded, 2);
        assert_eq!(snap.snapshots_decimated, 58);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn stalled_wan_sink_triggers_lag_drops_with_zero_local_pipeline_blocking() {
        // Tiny 8-slot broadcast ring buffer simulating fast 60Hz local CAN pipeline
        let (telemetry_tx, telemetry_rx) = broadcast::channel::<BridgeTelemetryFrame>(8);
        // Tiny 1-slot outbound transport channel that we intentionally DO NOT read at first!
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(1);
        let (_cloud_tx, cloud_rx) = mpsc::channel::<String>(8);

        let connector = Arc::new(MockTestConnector {
            inbound_rx_slot: Mutex::new(Some(cloud_rx)),
            outbound_tx,
        });

        let cfg = BridgeClientConfig {
            endpoint_url: "ws://127.0.0.1:3000/api/bridge/ws".to_string(),
            device_id: "dev_lag_01".to_string(),
            project_id: "proj_lag_01".to_string(),
            app_version: "0.1.0".to_string(),
            host_os: "Linux".to_string(),
            token: DeviceApiToken::parse("nxc_tok_lag_test_1234567890").unwrap(),
            preferred_active_hz: BridgeTargetHz::Hz60,
            active_db_name: None,
            raw_database_bytes: None,
            backoff_base_ms: 20,
            backoff_max_ms: 100,
        };

        let handle = spawn_bridge_client(cfg, telemetry_rx, connector, None);
        tokio::time::sleep(Duration::from_millis(15)).await;

        // Publish 500 frames locally while WAN socket is completely stalled/full:
        // Local publish MUST complete in < 5ms (zero local backpressure!).
        let start = Instant::now();
        for seq in 1..=500u64 {
            let _ = telemetry_tx.send(BridgeTelemetryFrame::empty_heartbeat(seq, seq * 16_666));
        }
        let local_publish_elapsed = start.elapsed();
        assert!(
            local_publish_elapsed < Duration::from_millis(25),
            "Local CAN pipeline was delayed: {local_publish_elapsed:?}"
        );

        // Now unblock WAN sink by draining outbound frames
        while let Ok(Some(_)) =
            tokio::time::timeout(Duration::from_millis(30), outbound_rx.recv()).await
        {}

        // Send 1 fresh frame after recovery
        let _ = telemetry_tx.send(BridgeTelemetryFrame::empty_heartbeat(501, 501 * 16_666));
        let recovered = tokio::time::timeout(Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("recovered frame timeout")
            .expect("recovered frame");
        let parsed: BridgeTelemetryFrame = serde_json::from_str(&recovered).unwrap();
        assert_eq!(parsed.seq, 501);

        let metrics = handle.metrics_snapshot();
        assert!(
            metrics.lagged_dropped_snapshots > 400,
            "Expected RecvError::Lagged drops > 400, got {}",
            metrics.lagged_dropped_snapshots
        );

        handle.shutdown().await;
    }
}
