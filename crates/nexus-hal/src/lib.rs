//! # nexus-hal
//!
//! Two-layer Universal Hardware Abstraction Layer (`AdapterDriver` + `CanChannel`),
//! Linux native `SocketCAN` (`can*`, `vcan*`, `slcan*`), cross-OS synthetic multi-mux `mock0`,
//! and lock-free 60Hz `StateTable` Telemetry Pipeline for NexusCAN.

#![forbid(unsafe_code)]

pub mod drivers;
pub mod dto;
pub mod error;
pub mod pipeline;
pub mod registry;
pub mod seedkey;
pub mod storage;
pub mod traits;

pub use drivers::mock_drv::{MockCanChannel, MockCanDriver, MOCK0_DEVICE_ID, MOCK1_DEVICE_ID};
pub use drivers::probe::{probe_all_drivers, GsUsbDriver, KvaserDriver, PcanDriver};
pub use drivers::slcan_drv::{
    discover_serial_ports, encode_slcan_frame, parse_slcan_line, slcan_bitrate_command,
    slcan_init_sequence, SlcanChannel, SlcanDriver, MAX_SLCAN_ASCII_LEN,
};
#[cfg(target_os = "linux")]
pub use drivers::socketcan_drv::{SocketCanChannel, SocketCanDriver};
pub use dto::{
    AdapterCapabilitiesDto, BusHealthDto, ChannelConfigDto, ChronologicalFrameDto,
    DeviceDescriptorDto, DriverFamilyStatusDto, DriverProbeReportDto, FrameTelemetryDto,
    LiveSignalDto, PanicStopResultDto, PeriodicTxJobDto, ProjectSummaryDto, ResetSessionResultDto,
    SerialPortInfoDto,
    TelemetrySnapshotDto, TxTransmitResultDto,
};
pub use error::{AdapterError, HalError};
pub use pipeline::{
    sanitize_project_stem,
    state_table::{
        MuxPathKey, RetainedSignalSlot, StateTable, BYTE_HIGHLIGHT_WINDOW_US,
        CHRONOLOGICAL_RING_CAP, MAX_BUS_SLOTS, MAX_STATE_TABLE_MESSAGES,
    },
    tx_scheduler::{find_clamped_signals, PeriodicJobEntry, TxScheduler},
    PipelineEngine, FRAME_RING_CAPACITY, SNAPSHOT_INTERVAL_US,
};
pub use registry::DriverRegistry;
pub use traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::{CanIdKey, RawCanFrame};
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn mock0_discovery_listen_only_safety_arming_and_panic_stop() {
        let engine = PipelineEngine::new();
        let devices = engine.cmd_list_devices();
        assert!(
            devices.iter().any(|d| d.device_id == MOCK0_DEVICE_ID),
            "mock:mock0 must always be discovered on every OS"
        );
        assert!(
            devices.iter().any(|d| d.device_id == MOCK1_DEVICE_ID),
            "mock:mock1 must always be discovered on every OS"
        );

        let schema = engine
            .cmd_load_preset_databases()
            .expect("preset sample_vehicle.dbc + sample_bms.kcd should load cleanly");
        assert!(schema.messages.len() >= 8);
        assert!(schema.signals.len() >= 40);

        // 1. Default Listen-Only connection rejects arming and TX!
        let ro_cfg = ChannelConfigDto {
            bus_id: 0,
            bitrate: 500_000,
            data_bitrate: 2_000_000,
            enable_fd: true,
            listen_only: true,
            mock_fps_preset: Some(2_000),
            ..ChannelConfigDto::default()
        };
        let ro_health = engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), ro_cfg)
            .expect("connect mock0 listen_only");
        assert!(ro_health.connected);
        assert!(ro_health.listen_only);
        assert!(!ro_health.tx_armed);

        let arm_err = engine
            .cmd_arm_active_bus(0, true)
            .expect_err("must reject arming Listen-Only bus");
        assert!(
            arm_err
                .to_string()
                .contains("Cannot arm TX while channel is opened in Listen-Only mode"),
            "unexpected error: {arm_err}"
        );

        assert!(engine
            .cmd_transmit_signal_frame(0, 0x101, false, vec![], None, None)
            .is_err());

        let t_disc = Instant::now();
        engine
            .cmd_disconnect_bus(0)
            .expect("clean disconnect bus 0");
        assert!(
            t_disc.elapsed() < Duration::from_millis(25),
            "bus shutdown exceeded 25ms invariant: {:?}",
            t_disc.elapsed()
        );

        // 2. Reconnect with listen_only = false; TX still blocked until explicitly armed!
        let rw_cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(2_000),
            ..ChannelConfigDto::default()
        };
        let rw_health = engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), rw_cfg)
            .expect("connect mock0 active-capable");
        assert!(!rw_health.listen_only);
        assert!(!rw_health.tx_armed);

        assert!(engine
            .cmd_transmit_signal_frame(0, 0x101, false, vec![], None, None)
            .is_err());

        // Explicitly arm active bus
        let armed_health = engine
            .cmd_arm_active_bus(0, true)
            .expect("arm active bus 0");
        assert!(armed_health.tx_armed);

        // Find MotorSpeedRpm signal ID (bounds [-16000, 16000]) and request 25_000 rpm to verify clamping!
        let rpm_sig = schema
            .signals
            .iter()
            .find(|s| s.name == "MotorSpeedRpm")
            .expect("MotorSpeedRpm in preset schema");

        let tx_res = engine
            .cmd_transmit_signal_frame(
                0,
                0x101,
                false,
                vec![(rpm_sig.signal_id, 25_000.0)],
                Some(5),
                Some("TorqueStepTest".to_string()),
            )
            .expect("transmit periodic 0x101 with clamping");

        assert!(tx_res.job_id.is_some());
        assert_eq!(tx_res.encoded_dlc, 8);
        assert_eq!(tx_res.clamped_signals, vec![rpm_sig.signal_id]);
        assert_eq!(engine.cmd_list_periodic_tx().len(), 1);

        thread::sleep(Duration::from_millis(25));
        let jobs_before = engine.cmd_list_periodic_tx();
        assert!(
            jobs_before[0].sent_count >= 2,
            "periodic TX scheduler should increment sent_count"
        );

        // Engage Panic Stop -> immediately wipes periodic jobs & disarms bus!
        let panic_res = engine.cmd_panic_stop_tx();
        assert_eq!(panic_res.stopped_periodic_jobs, 1);
        assert_eq!(panic_res.disarmed_buses, 1);
        assert!(engine.cmd_list_periodic_tx().is_empty());

        let snap = engine.flush_snapshot_now().expect("flush snapshot");
        assert!(snap.tx_panic_latched);
        assert!(!snap.buses[0].tx_armed);
        assert!(snap.total_frames_tx >= 1);

        // TX while panic-latched must be rejected until re-armed
        assert!(engine
            .cmd_transmit_signal_frame(0, 0x101, false, vec![], None, None)
            .is_err());
    }

    #[test]
    fn state_table_64_byte_highlight_mask_cycle_health_and_retained_mux() {
        let engine = PipelineEngine::new();
        let schema = engine
            .cmd_load_preset_databases()
            .expect("load preset databases");
        drop(engine);

        // Load compiled DB directly into StateTable for deterministic microsecond testing
        let scripts_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts");
        let dbc_bytes = std::fs::read(scripts_dir.join("sample_vehicle.dbc")).expect("read dbc");
        let kcd_bytes = std::fs::read(scripts_dir.join("sample_bms.kcd")).expect("read kcd");
        let reg = nexus_netdb::FormatRegistry::new();
        let opts = nexus_netdb::ParseOptions::default();
        let b1 = reg
            .parse_bytes(&dbc_bytes, Some("sample_vehicle.dbc"), &opts)
            .expect("parse dbc");
        let b2 = reg
            .parse_bytes(&kcd_bytes, Some("sample_bms.kcd"), &opts)
            .expect("parse kcd");
        let (merged, _) = nexus_netdb::merge_databases(vec![b1.database, b2.database]);
        let compiled = std::sync::Arc::new(
            nexus_netdb::CompiledDatabase::compile(merged).expect("compile merged"),
        );

        let mut table = StateTable::new();
        table.set_database(Some(compiled));

        // 1. Test 64-byte CAN-FD changed_bytes_lo & changed_bytes_hi 300ms highlight decay
        let payload_a = [0x11u8; 64];
        let mut payload_b = [0x11u8; 64];
        payload_b[3] = 0x99; // lo bit 3
        payload_b[31] = 0xAA; // lo bit 31
        payload_b[32] = 0xBB; // hi bit 0
        payload_b[63] = 0xCC; // hi bit 31

        let f1 = RawCanFrame::new_fd(0, CanIdKey::Standard(0x201), &payload_a, true, 100_000)
            .expect("fd frame 1");
        let f2 = RawCanFrame::new_fd(0, CanIdKey::Standard(0x201), &payload_b, true, 105_000)
            .expect("fd frame 2");

        table.ingest_frame(&f1);
        table.ingest_frame(&f2);

        // Within 300ms window (at t = 250_000 us -> age = 145ms <= 300ms)
        let snap_active = table.build_snapshot(250_000, 0, false, 2_000_000, vec![]);
        let row_201 = snap_active
            .frames
            .iter()
            .find(|r| r.arb_id == 0x201)
            .expect("0x201 row");
        assert_eq!(row_201.changed_bytes_lo, (1u32 << 3) | (1u32 << 31));
        assert_eq!(row_201.changed_bytes_hi, (1u32 << 0) | (1u32 << 31));
        assert_eq!(row_201.cycle_health, "nominal"); // 145ms silence <= 500ms/1500ms watchdog

        // Verify true bus silence (> 1500ms) triggers watchdog "timeout"
        let snap_silent = table.build_snapshot(1_700_000, 0, false, 2_000_000, vec![]);
        let row_201_silent = snap_silent
            .frames
            .iter()
            .find(|r| r.arb_id == 0x201)
            .expect("0x201 silent row");
        assert_eq!(row_201_silent.cycle_health, "timeout");

        // Fresh frames restore nominal health & verify > 300ms byte-change highlight decay
        let f3 = RawCanFrame::new_fd(0, CanIdKey::Standard(0x201), &payload_b, true, 1_805_001)
            .expect("fd frame 3");
        let f4 = RawCanFrame::new_fd(0, CanIdKey::Standard(0x201), &payload_b, true, 1_810_001)
            .expect("fd frame 4");
        table.ingest_frame(&f3);
        table.ingest_frame(&f4);

        let snap_decayed = table.build_snapshot(1_810_500, 0, false, 2_000_000, vec![]);
        let row_201_after = snap_decayed
            .frames
            .iter()
            .find(|r| r.arb_id == 0x201)
            .expect("0x201 row after decay");
        assert_eq!(row_201_after.changed_bytes_lo, 0);
        assert_eq!(row_201_after.changed_bytes_hi, 0);
        assert_eq!(row_201_after.cycle_health, "nominal");

        // 2. Verify PCAN-Explorer style multi-row dynamic mux state across all 4 KCD banks (0x301)
        //    and all 5 cascaded DBC paths (0x105)
        let mut mock_ch = MockCanChannel::new(
            MockCanDriver::mock0_descriptor(),
            ChannelConfigDto {
                bus_id: 0,
                listen_only: true,
                mock_fps_preset: Some(50_000),
                ..ChannelConfigDto::default()
            },
        );
        let mut total_ingested = 0usize;
        let mut last_ts = 0u64;
        let mut batch = [RawCanFrame::zeroed(); 128];
        while total_ingested < 64 {
            thread::sleep(Duration::from_millis(2));
            let n = mock_ch.recv_batch(&mut batch, 5).expect("recv mock0 batch");
            for f in &batch[..n] {
                last_ts = f.timestamp_us;
                table.ingest_frame(f);
            }
            total_ingested += n;
        }
        assert!(
            total_ingested >= 64,
            "expected >= 64 frames from 50kfps mock0 so all 5 cascaded paths of 0x105 arrive, got {total_ingested}"
        );

        let mux_snap = table.build_snapshot(last_ts + 1_000, 0, false, 2_000_000, vec![]);

        // Check 0x301 (KCD CMC_CellVoltagesMux): 4 distinct mux rows (banks 0..=3), each with 8 signals,
        // and union of unique signal_ids == 23!
        let rows_301: Vec<&FrameTelemetryDto> = mux_snap
            .frames
            .iter()
            .filter(|r| r.arb_id == 0x301)
            .collect();
        assert_eq!(rows_301.len(), 4, "0x301 must have 4 dedicated bank rows (0..=3)");
        let mut unique_301_sigs = std::collections::BTreeSet::new();
        for (expected_bank, row) in rows_301.iter().enumerate() {
            assert_eq!(
                row.active_mux_switches.get("CellBankSelector").copied(),
                Some(expected_bank as i64)
            );
            assert_eq!(
                row.signals.len(),
                8,
                "Each 0x301 bank row holds 1 switch + 2 static + 4 cells + 1 NTC == 8 signals"
            );
            assert!(row.signals.iter().all(|s| s.active_in_last_frame && !s.out_of_range));
            for sig in &row.signals {
                unique_301_sigs.insert(sig.signal_id);
            }
        }
        assert_eq!(
            unique_301_sigs.len(),
            23,
            "Union of unique 0x301 signal_ids across all 4 bank rows must equal 23"
        );

        // Check 0x105 (DBC cascaded BMS_MuxDiagnostics): 5 rows in exact lexicographical order
        // (0,0), (0,1), (1,0), (1,1), (2), with union of unique signal_ids == 14!
        let expected_105_sigs = schema
            .messages
            .iter()
            .find(|m| m.arb_id == 0x105)
            .expect("0x105 schema")
            .signal_ids
            .len();
        assert_eq!(expected_105_sigs, 14);

        let rows_105: Vec<&FrameTelemetryDto> = mux_snap
            .frames
            .iter()
            .filter(|r| r.arb_id == 0x105)
            .collect();
        assert_eq!(rows_105.len(), 5, "0x105 must have 5 cascaded mux rows");

        let actual_105_paths: Vec<Vec<(&str, i64)>> = rows_105
            .iter()
            .map(|r| {
                r.active_mux_switches
                    .iter()
                    .map(|(k, &v)| (k.as_str(), v))
                    .collect()
            })
            .collect();
        assert_eq!(
            actual_105_paths,
            vec![
                vec![("MuxDomainSwitch", 0), ("SubBankSwitch", 0)],
                vec![("MuxDomainSwitch", 0), ("SubBankSwitch", 1)],
                vec![("MuxDomainSwitch", 1), ("SubBankSwitch", 0)],
                vec![("MuxDomainSwitch", 1), ("SubBankSwitch", 1)],
                vec![("MuxDomainSwitch", 2)],
            ]
        );

        let mut unique_105_sigs = std::collections::BTreeSet::new();
        for row in &rows_105 {
            assert!(row.signals.iter().all(|s| s.active_in_last_frame && !s.out_of_range));
            for sig in &row.signals {
                unique_105_sigs.insert(sig.signal_id);
            }
        }
        assert_eq!(
            unique_105_sigs.len(),
            expected_105_sigs,
            "Union of unique 0x105 signal_ids across all 5 cascaded mux rows must equal 14"
        );
    }

    #[test]
    fn pipeline_50kfps_burst_zero_drops_and_60hz_pacing() {
        let engine = PipelineEngine::new();
        engine
            .cmd_load_preset_databases()
            .expect("load preset databases");

        let mut sub = engine.subscribe();

        engine
            .cmd_connect_bus(
                MOCK0_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    bitrate: 500_000,
                    data_bitrate: 5_000_000,
                    enable_fd: true,
                    listen_only: true,
                    mock_fps_preset: Some(50_000),
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect 50kfps mock0");

        let start = Instant::now();
        let mut received_snapshots = Vec::new();
        while start.elapsed() < Duration::from_millis(220) {
            if let Ok(snap) = sub.try_recv() {
                received_snapshots.push(snap);
            } else {
                thread::sleep(Duration::from_millis(2));
            }
        }
        // Drain any queued right at boundary
        while let Ok(snap) = sub.try_recv() {
            received_snapshots.push(snap);
        }

        // In ~220ms at 60Hz (16.67ms period) expect ~13 snapshots. The invariants are the upper
        // bound (NOT per-frame: ~11,000 frames arrive in the window) and the pacing (never faster
        // than 60 Hz). The lower bound only proves periodic emission: under CPU starvation (parallel
        // test binaries, 2-core CI runners) the OS may legitimately schedule the ticker less often.
        assert!(
            (2..=18).contains(&received_snapshots.len()),
            "Expected ~13 snapshots at 60Hz over 220ms, got {}",
            received_snapshots.len()
        );
        let first_ts = received_snapshots.first().expect("snapshots").timestamp_us;
        let last_ts = received_snapshots.last().expect("snapshots").timestamp_us;
        let intervals = (received_snapshots.len() - 1) as u64;
        let mean_interval_us = last_ts.saturating_sub(first_ts) / intervals;
        assert!(
            mean_interval_us >= 14_000,
            "60 Hz pacing violated: mean snapshot interval {mean_interval_us} us (< 14 ms)"
        );

        let last = received_snapshots.last().expect("at least one snapshot");
        assert_eq!(
            last.dropped_frames, 0,
            "50,000 fps burst must sustain zero dropped_frames"
        );
        assert!(
            last.total_frames_rx >= 7_500,
            "Expected high-throughput 50kfps RX (~11,000 frames in 220ms), got {}",
            last.total_frames_rx
        );
        assert_eq!(last.active_ids_count, 8);
        assert!(last.decoded_signals_count >= 40);

        let t_stop = Instant::now();
        engine.cmd_disconnect_bus(0).expect("disconnect 50kfps bus");
        assert!(
            t_stop.elapsed() < Duration::from_millis(25),
            "50kfps bus shutdown must complete in < 25ms, took {:?}",
            t_stop.elapsed()
        );
    }

    #[test]
    fn mock0_all_8_waveforms_bit_exact_against_dbc_and_kcd_and_base64_merge() {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;

        let engine = PipelineEngine::new();
        assert!(engine.cmd_get_current_schema().is_none());

        let scripts_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts");
        let dbc_b64 = B64.encode(std::fs::read(scripts_dir.join("sample_vehicle.dbc")).expect("dbc"));
        let kcd_b64 = B64.encode(std::fs::read(scripts_dir.join("sample_bms.kcd")).expect("kcd"));

        let s1 = engine
            .cmd_load_database_content("sample_vehicle.dbc".to_string(), dbc_b64, false)
            .expect("load dbc via base64");
        assert_eq!(s1.messages.len(), 4);

        let schema = engine
            .cmd_load_database_content("sample_bms.kcd".to_string(), kcd_b64, true)
            .expect("append kcd via base64");
        assert_eq!(schema.messages.len(), 8);
        assert!(engine.cmd_get_current_schema().is_some());

        engine
            .cmd_connect_bus(
                MOCK0_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    listen_only: false,
                    mock_fps_preset: Some(10_000),
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect mock0");
        engine.cmd_arm_active_bus(0, true).expect("arm bus 0");

        let rpm_sig = schema
            .signals
            .iter()
            .find(|s| s.name == "MotorSpeedRpm")
            .expect("MotorSpeedRpm");
        let tx = engine
            .cmd_transmit_signal_frame(0, 0x101, false, vec![(rpm_sig.signal_id, 1_500.0)], Some(10), None)
            .expect("schedule job");
        let job_id = tx.job_id.expect("periodic job id");
        engine.cmd_stop_periodic_tx(job_id).expect("stop individual job");
        assert!(engine.cmd_list_periodic_tx().is_empty());

        thread::sleep(Duration::from_millis(25));
        let snap = engine.flush_snapshot_now().expect("flush snapshot");
        assert_eq!(snap.active_ids_count, 8);
        assert_eq!(
            snap.frames.len(),
            15,
            "6 non-mux messages + 5 cascaded mux rows (0x105) + 4 KCD bank rows (0x301) == 15 rows"
        );

        for frame_row in &snap.frames {
            assert!(!frame_row.signals.is_empty());
            assert!(
                frame_row.signals.iter().all(|s| !s.out_of_range),
                "out_of_range signal in {}",
                frame_row.message_key
            );
        }

        // Verify exact CAN-FD TailIntegrityMarker == 0xA5 (165) and J1939 ChargerOutputVoltageV == 802.5 V
        let tail_id = schema
            .signals
            .iter()
            .find(|s| s.name == "TailIntegrityMarker")
            .expect("TailIntegrityMarker")
            .signal_id;
        let dcfc_v_id = schema
            .signals
            .iter()
            .find(|s| s.name == "ChargerOutputVoltageV")
            .expect("ChargerOutputVoltageV")
            .signal_id;

        let fd_row = snap.frames.iter().find(|r| r.arb_id == 0x201).expect("0x201");
        let tail_val = fd_row
            .signals
            .iter()
            .find(|s| s.signal_id == tail_id)
            .expect("tail sig")
            .physical_value;
        assert!((tail_val - 165.0).abs() < 1e-6);

        let dcfc_row = snap
            .frames
            .iter()
            .find(|r| r.arb_id == 0x18FF_50E5)
            .expect("0x18FF50E5");
        let dcfc_v = dcfc_row
            .signals
            .iter()
            .find(|s| s.signal_id == dcfc_v_id)
            .expect("dcfc voltage")
            .physical_value;
        assert!((dcfc_v - 802.5).abs() < 1e-6);
    }

    #[test]
    fn faz2_2_calm_schedule_tx_in_receive_tx_override_hold_and_nominal_475_mode() {
        let engine = PipelineEngine::new();
        let schema = engine
            .cmd_load_preset_databases()
            .expect("load preset databases");

        // 1. Connect with default CalmTrackableSchedule (mock_fps_preset = None, ~15–17 msg/s)
        let calm_cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            ..ChannelConfigDto::default()
        };
        assert_eq!(calm_cfg.mock_fps_preset, None);

        engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), calm_cfg)
            .expect("connect mock0 calm trackable schedule");

        // Raw TX must be blocked until bus is armed
        assert!(engine
            .cmd_transmit_raw_frame(0, 0x7DF, false, false, false, vec![0x02, 0x01, 0x00], None, None)
            .is_err());

        engine.cmd_arm_active_bus(0, true).expect("arm bus 0");

        // Invalid 11-bit standard ID (> 0x7FF) must be rejected cleanly
        assert!(engine
            .cmd_transmit_raw_frame(0, 0x18FF_50E5, false, false, false, vec![0xAA], None, None)
            .is_err());

        // Let initial staggered burst of all 8 synthetic messages arrive first
        thread::sleep(Duration::from_millis(12));

        // Transmit a single-shot symbolic frame on 0x101 (INV_MotorStatus) with MotorSpeedRpm = 4250.0 rpm
        // -> mock0 must suppress synthetic 0x101 frames for 3.0s so user's TX stays visible in Receive!
        let rpm_sig_id = schema
            .signals
            .iter()
            .find(|s| s.name == "MotorSpeedRpm")
            .expect("MotorSpeedRpm signal")
            .signal_id;
        engine
            .cmd_transmit_signal_frame(
                0,
                0x101,
                false,
                vec![(rpm_sig_id, 4_250.0)],
                None,
                None,
            )
            .expect("single-shot symbolic TX on 0x101");

        // Transmit raw Classical CAN on 0x7DF (periodic 25ms) and 10B -> 12B CAN-FD on 0x18DA10F1
        let tx_diag = engine
            .cmd_transmit_raw_frame(
                0,
                0x7DF,
                false,
                false,
                false,
                vec![0x02, 0x3E, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55],
                Some(25),
                Some("OBD_KeepAlive".to_string()),
            )
            .expect("raw classical TX 0x7DF");
        assert!(tx_diag.job_id.is_some());
        assert_eq!(tx_diag.encoded_dlc, 8);

        let tx_fd = engine
            .cmd_transmit_raw_frame(
                0,
                0x18DA_10F1,
                true,
                false,
                true,
                vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                Some(40),
                Some("ISO_TP_FD_Diag".to_string()),
            )
            .expect("raw CAN-FD TX 0x18DA10F1");
        assert_eq!(tx_fd.encoded_dlc, 12);

        // Verify enriched PeriodicTxJobDto fields
        let jobs = engine.cmd_list_periodic_tx();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].arb_id, 0x7DF);
        assert!(!jobs[0].is_extended);
        assert!(!jobs[0].is_fd);
        assert_eq!(jobs[0].dlc, 8);
        assert_eq!(
            jobs[0].raw_bytes,
            vec![0x02, 0x3E, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55]
        );
        assert_eq!(jobs[1].arb_id, 0x18DA_10F1);
        assert!(jobs[1].is_extended);
        assert!(jobs[1].is_fd);
        assert_eq!(jobs[1].dlc, 12);

        let mut sub = engine.subscribe();

        // Sleep 280ms: 0x201 (250ms) emits its 2nd frame, while 0x101 (250ms) synthetic is held off by 3.0s TX override!
        thread::sleep(Duration::from_millis(280));
        let calm_snap = engine.flush_snapshot_now().expect("flush calm snapshot");

        let mut saw_tx_7df_in_chronological = calm_snap
            .recent_chronological
            .iter()
            .any(|c| c.is_tx && c.arb_id == 0x7DF);
        while let Ok(stream_snap) = sub.try_recv() {
            if stream_snap
                .recent_chronological
                .iter()
                .any(|c| c.is_tx && c.arb_id == 0x7DF)
            {
                saw_tx_7df_in_chronological = true;
            }
        }
        assert!(
            saw_tx_7df_in_chronological,
            "TX frames must appear in chronological trace with is_tx = true"
        );
        assert!(calm_snap.total_frames_tx >= 10);
        assert!(calm_snap.total_frames_rx >= 8);

        // Verify raw TX frames (0x7DF & 0x18DA10F1) ARE visible in Receive (`frames`) with `is_tx == true`!
        let row_7df = calm_snap
            .frames
            .iter()
            .find(|r| r.arb_id == 0x7DF)
            .expect("raw TX 0x7DF must appear in Receive state table");
        assert!(row_7df.is_tx);
        assert_eq!(
            row_7df.raw_bytes,
            vec![0x02, 0x3E, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55]
        );

        let row_fd_diag = calm_snap
            .frames
            .iter()
            .find(|r| r.arb_id == 0x18DA_10F1)
            .expect("raw CAN-FD TX 0x18DA10F1 must appear in Receive state table");
        assert!(row_fd_diag.is_tx);
        assert!(row_fd_diag.is_fd);
        assert_eq!(row_fd_diag.dlc, 12);

        // Verify 0x101 in Receive retains user's single-shot TX (MotorSpeedRpm = 4250.0, is_tx = true)
        // without being overwritten by mock0's 250ms synthetic generator!
        let row_101 = calm_snap
            .frames
            .iter()
            .find(|r| r.arb_id == 0x101)
            .expect("0x101 row in Receive");
        assert!(
            row_101.is_tx,
            "0x101 should still reflect user TX due to 3.0s mock0 TX override suppression"
        );
        let decoded_rpm = row_101
            .signals
            .iter()
            .find(|s| s.signal_id == rpm_sig_id)
            .expect("decoded MotorSpeedRpm on TX 0x101")
            .physical_value;
        assert!(
            (decoded_rpm - 4_250.0).abs() < 1e-6,
            "expected TX MotorSpeedRpm 4250.0 rpm, got {decoded_rpm}"
        );

        // Verify 0x201 ran at calm 250ms period AND all configured DB messages report "nominal" (no false timeout!)
        let row_201_calm = calm_snap
            .frames
            .iter()
            .find(|r| r.arb_id == 0x201)
            .expect("0x201 calm row");
        assert!(
            (row_201_calm.cycle_ms - 250.0).abs() < 2.0,
            "expected calm 0x201 period ~250ms, got {}ms",
            row_201_calm.cycle_ms
        );
        for db_arb_id in [0x201u32, 0x101, 0x105, 0x302, 0x301, 0x303, 0x18FF_50E5, 0x18F0_0900] {
            let row = calm_snap
                .frames
                .iter()
                .find(|r| r.arb_id == db_arb_id)
                .unwrap_or_else(|| panic!("missing 0x{db_arb_id:X} in calm snapshot"));
            assert_eq!(
                row.cycle_health, "nominal",
                "0x{db_arb_id:X} should be nominal in CalmTrackableSchedule, got {}",
                row.cycle_health
            );
        }

        let _ = engine.cmd_panic_stop_tx();
        engine.cmd_disconnect_bus(0).expect("disconnect calm bus 0");

        // 2. Verify Some(475) NominalEcuSchedule runs exact real-time .dbc/.kcd ECU periods (5ms..200ms)
        engine
            .cmd_connect_bus(
                MOCK0_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    listen_only: true,
                    mock_fps_preset: Some(475),
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect mock0 nominal 475 schedule");

        thread::sleep(Duration::from_millis(420));
        let nom_snap = engine.flush_snapshot_now().expect("flush nominal 475 snapshot");

        // Multiplexed rows report each branch's true inter-arrival period:
        // - 0x105 transmits every 20ms across 5 cascaded paths -> 100.0ms per mux branch
        // - 0x301 transmits every 25ms across 4 cell banks     -> 100.0ms per mux bank
        let expected_nominal_periods: &[(u32, f64)] = &[
            (0x201, 5.0),
            (0x101, 10.0),
            (0x105, 100.0),
            (0x302, 20.0),
            (0x301, 100.0),
            (0x303, 50.0),
            (0x18FF_50E5, 100.0),
            (0x18F0_0900, 200.0),
        ];
        for &(arb_id, period_ms) in expected_nominal_periods {
            let matching_rows: Vec<&FrameTelemetryDto> = nom_snap
                .frames
                .iter()
                .filter(|r| r.arb_id == arb_id)
                .collect();
            assert!(
                !matching_rows.is_empty(),
                "missing ECU message 0x{arb_id:X}"
            );
            for row in matching_rows {
                assert!(
                    (row.cycle_ms - period_ms).abs() < 0.25,
                    "expected nominal 0x{arb_id:X} period {period_ms}ms, got {}ms",
                    row.cycle_ms
                );
                assert_eq!(row.cycle_health, "nominal");
            }
        }

        engine
            .cmd_disconnect_bus(0)
            .expect("disconnect nominal 475 bus 0");
    }

    #[test]
    fn wave2_chronological_2048_multi_bus_mock1_db_clear_and_project_storage() {
        assert_eq!(CHRONOLOGICAL_RING_CAP, 2_048);

        // 1. Verify StateTable ChronologicalRing holds 1,500 frames intact and wraps cleanly at 2,048
        let mut table = StateTable::new();
        for seq in 0..1_500u64 {
            let payload = (seq as u32).to_le_bytes();
            let frame = RawCanFrame::new_classical(0, CanIdKey::Standard(0x123), &payload, 1_000 + seq * 10)
                .expect("valid frame");
            table.ingest_frame(&frame);
        }
        let snap_1500 = table.build_snapshot(20_000, 0, false, 500_000, Vec::new());
        assert_eq!(
            snap_1500.recent_chronological.len(),
            1_500,
            "ChronologicalRing must deliver all 1,500 frames without truncating at 128"
        );

        for seq in 0..2_500u64 {
            let payload = (seq as u32).to_le_bytes();
            let frame = RawCanFrame::new_classical(0, CanIdKey::Standard(0x123), &payload, 50_000 + seq * 10)
                .expect("valid frame");
            table.ingest_frame(&frame);
        }
        let snap_wrapped = table.build_snapshot(80_000, 0, false, 500_000, Vec::new());
        assert_eq!(snap_wrapped.recent_chronological.len(), 2_048);
        let first_wrapped_seq = u32::from_le_bytes(
            snap_wrapped.recent_chronological[0].raw_bytes[..4]
                .try_into()
                .expect("4 bytes"),
        );
        assert_eq!(first_wrapped_seq, 2_500 - 2_048);

        table.reset_all();
        let snap_reset = table.build_snapshot(90_000, 0, false, 500_000, Vec::new());
        assert!(snap_reset.frames.is_empty());
        assert!(snap_reset.recent_chronological.is_empty());
        assert_eq!(snap_reset.total_frames_rx, 0);
        assert_eq!(snap_reset.total_frames_tx, 0);
        assert_eq!(snap_reset.fps_rx, 0.0);
        assert_eq!(snap_reset.fps_tx, 0.0);

        // 2. Dual-bus simultaneous mock0 (Bus 0) + mock1 (Bus 1), DB clear, and bulk disconnect
        let tmp_projects = std::env::temp_dir().join(format!(
            "nexuscan-hal-wave2-projects-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_projects);

        let engine =
            PipelineEngine::with_projects_dir(DriverRegistry::with_builtin_drivers(), tmp_projects.clone());
        engine
            .cmd_load_preset_databases()
            .expect("load preset databases");
        assert!(engine.cmd_get_current_schema().is_some());

        engine
            .cmd_connect_bus(
                MOCK0_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    listen_only: true,
                    mock_fps_preset: Some(475),
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect mock0 on bus 0");
        engine
            .cmd_connect_bus(
                MOCK1_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 1,
                    listen_only: true,
                    mock_fps_preset: Some(475),
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect mock1 on bus 1");

        thread::sleep(Duration::from_millis(240));
        let dual_snap = engine.flush_snapshot_now().expect("flush dual-bus snapshot");
        assert_eq!(dual_snap.buses.len(), 2);
        assert!(dual_snap.frames.iter().any(|f| f.bus_id == 0));
        assert!(dual_snap.frames.iter().any(|f| f.bus_id == 1));
        assert!(dual_snap.decoded_signals_count > 0);

        // Clear database and verify schema + decoded signals reset
        engine.cmd_clear_database().expect("clear database");
        assert!(engine.cmd_get_current_schema().is_none());
        thread::sleep(Duration::from_millis(30));
        let cleared_snap = engine
            .flush_snapshot_now()
            .expect("flush post-clear snapshot");
        assert_eq!(cleared_snap.decoded_signals_count, 0);

        let disconnected = engine.cmd_disconnect_all_buses();
        assert_eq!(disconnected, 2);

        // 3. Path traversal sanitization & project CRUD
        // WP-8: traversal / empty / dotted stems are errors (no silent rewriting).
        assert!(sanitize_project_stem("../../../etc/passwd").is_err());
        assert!(sanitize_project_stem("...").is_err());
        assert!(sanitize_project_stem("").is_err());
        assert!(sanitize_project_stem(".hidden").is_err());
        assert!(sanitize_project_stem("aux").is_err());
        assert_eq!(
            sanitize_project_stem("BMS Hil Bench.nexusproj.json").unwrap(),
            "BMS_Hil_Bench"
        );
        assert!(engine
            .cmd_save_project("../escape".to_string(), "{}".to_string())
            .is_err());
        assert!(engine.cmd_load_project("../escape".to_string()).is_err());
        assert!(engine.cmd_delete_project("..".to_string()).is_err());

        let p_old = engine
            .cmd_save_project(
                "alpha_bench".to_string(),
                r#"{"name":"Alpha Bench","updatedAt":"2026-11-05T10:00:00Z"}"#.to_string(),
            )
            .expect("save alpha_bench");
        assert_eq!(p_old.file_stem, "alpha_bench");

        let p_new = engine
            .cmd_save_project(
                "beta bench".to_string(),
                r#"{"name":"Beta Bench","updatedAt":"2026-11-06T12:00:00Z"}"#.to_string(),
            )
            .expect("save normalized beta_bench");
        assert_eq!(p_new.file_stem, "beta_bench");
        // Load / delete are strict: the non-canonical spelling is rejected.
        assert!(engine.cmd_load_project("beta bench".to_string()).is_err());

        let listed = engine.cmd_list_projects().expect("list projects");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].file_stem, "beta_bench");
        assert_eq!(listed[1].file_stem, "alpha_bench");

        let raw_beta = engine
            .cmd_load_project("beta_bench".to_string())
            .expect("load beta_bench");
        assert!(raw_beta.contains("Beta Bench"));

        engine
            .cmd_delete_project("alpha_bench".to_string())
            .expect("delete alpha_bench");
        assert_eq!(engine.cmd_list_projects().expect("list after delete").len(), 1);

        let _ = std::fs::remove_dir_all(&tmp_projects);
    }

    #[test]
    fn slcan_lawicel_codec_and_cross_os_driver_probe_report() {
        // 1. Lawicel initialization commands enforce Listen-Only ('L\r') vs Active ('O\r')
        let ro_init = slcan_init_sequence(500_000, 2_000_000, true, true);
        assert_eq!(
            ro_init,
            vec![
                b"C\r".as_slice(),
                b"S6\r".as_slice(),
                b"Y2\r".as_slice(),
                b"L\r".as_slice()
            ]
        );
        let rw_init = slcan_init_sequence(1_000_000, 2_000_000, false, false);
        assert_eq!(
            rw_init,
            vec![b"C\r".as_slice(), b"S8\r".as_slice(), b"O\r".as_slice()]
        );

        // 2. Zero-alloc Lawicel encode + parse round-trips (Classical 11/29-bit, RTR, CAN-FD + BRS)
        let mut wire = [0u8; MAX_SLCAN_ASCII_LEN];

        let std_frame = RawCanFrame::new_classical(
            2,
            CanIdKey::Standard(0x101),
            &[0xDE, 0xAD, 0xBE, 0xEF],
            100,
        )
        .expect("std frame");
        let n_std = encode_slcan_frame(&std_frame, &mut wire).expect("encode std");
        assert_eq!(&wire[..n_std], b"t1014DEADBEEF\r");
        let parsed_std = parse_slcan_line(&wire[..n_std], 2, 100).expect("parse std");
        assert_eq!(parsed_std.arb_id, 0x101);
        assert!(!parsed_std.is_extended());
        assert_eq!(parsed_std.payload(), &[0xDE, 0xAD, 0xBE, 0xEF]);

        // Also accept Lawicel 4-hex hardware millisecond suffix (`ZZZZ`)
        let parsed_with_ts =
            parse_slcan_line(b"t1012ABCD1A2B\r", 0, 200).expect("parse with ZZZZ suffix");
        assert_eq!(parsed_with_ts.payload(), &[0xAB, 0xCD]);

        let ext_frame = RawCanFrame::new_classical(
            1,
            CanIdKey::Extended(0x18FF_50E5),
            &[1, 2, 3, 4, 5, 6, 7, 8],
            300,
        )
        .expect("ext frame");
        let n_ext = encode_slcan_frame(&ext_frame, &mut wire).expect("encode ext");
        assert_eq!(&wire[..n_ext], b"T18FF50E580102030405060708\r");
        let parsed_ext = parse_slcan_line(&wire[..n_ext], 1, 300).expect("parse ext");
        assert!(parsed_ext.is_extended());
        assert_eq!(parsed_ext.arb_id, 0x18FF_50E5);
        assert_eq!(parsed_ext.dlc, 8);

        let rtr_frame =
            RawCanFrame::new_rtr(0, CanIdKey::Standard(0x7DF), 8, 400).expect("rtr frame");
        let n_rtr = encode_slcan_frame(&rtr_frame, &mut wire).expect("encode rtr");
        assert_eq!(&wire[..n_rtr], b"r7DF8\r");
        let parsed_rtr = parse_slcan_line(&wire[..n_rtr], 0, 400).expect("parse rtr");
        assert!(parsed_rtr.is_rtr());
        assert_eq!(parsed_rtr.dlc, 8);

        let fd_payload = [0x5Au8; 12];
        let fd_frame = RawCanFrame::new_fd(
            0,
            CanIdKey::Extended(0x18DA_10F1),
            &fd_payload,
            true,
            500,
        )
        .expect("fd frame");
        let n_fd = encode_slcan_frame(&fd_frame, &mut wire).expect("encode fd");
        assert_eq!(&wire[..11], b"B18DA10F195");
        let parsed_fd = parse_slcan_line(&wire[..n_fd], 0, 500).expect("parse fd");
        assert!(parsed_fd.is_extended());
        assert!(parsed_fd.is_fd());
        assert!(parsed_fd.is_brs());
        assert_eq!(parsed_fd.dlc, 12);
        assert_eq!(parsed_fd.payload(), &fd_payload);

        // 3. Cross-OS Driver Probe Report & helpful missing-driver diagnostics
        let engine = PipelineEngine::new();
        let report = engine.cmd_probe_drivers();
        assert_eq!(report.families.len(), 6);

        let mock_fam = report
            .families
            .iter()
            .find(|f| f.family_id == "mock")
            .expect("mock family");
        assert!(mock_fam.installed);
        assert_eq!(mock_fam.detected_channels, vec!["mock0", "mock1"]);

        let slcan_fam = report
            .families
            .iter()
            .find(|f| f.family_id == "slcan")
            .expect("slcan family");
        assert!(slcan_fam.installed);

        let pcan_fam = report
            .families
            .iter()
            .find(|f| f.family_id == "pcan")
            .expect("pcan family");
        if !pcan_fam.installed {
            let err = engine
                .cmd_connect_bus("pcan:PCAN_USBBUS1".to_string(), ChannelConfigDto::default())
                .expect_err("uninstalled PCAN must return diagnostic error");
            assert!(
                err.to_string().contains("PEAK PCAN-Basic driver is not installed"),
                "unexpected PCAN error: {err}"
            );
        }

        let kvaser_fam = report
            .families
            .iter()
            .find(|f| f.family_id == "kvaser")
            .expect("kvaser family");
        if !kvaser_fam.installed {
            let err = engine
                .cmd_connect_bus("kvaser:0".to_string(), ChannelConfigDto::default())
                .expect_err("uninstalled Kvaser must return diagnostic error");
            assert!(
                err.to_string().contains("Kvaser CANlib driver is not installed"),
                "unexpected Kvaser error: {err}"
            );
        }
    }

    #[test]
    fn set_bus_mode_atomic_device_preservation_rx_retention_and_discovery_priority() {
        let reg = DriverRegistry::with_defaults();
        let devices = reg.discover_all();
        assert!(devices.len() >= 2);

        let mock0_idx = devices
            .iter()
            .position(|d| d.device_id == MOCK0_DEVICE_ID)
            .expect("mock:mock0 present");
        let mock1_idx = devices
            .iter()
            .position(|d| d.device_id == MOCK1_DEVICE_ID)
            .expect("mock:mock1 present");

        // All real / kernel interfaces (such as socketcan:vcan0, slcan:*, pcan:*, kvaser:*, gs_usb:*)
        // must strictly precede virtual mock0 / mock1 simulators!
        assert_eq!(mock0_idx, devices.len() - 2);
        assert_eq!(mock1_idx, devices.len() - 1);
        for (idx, dev) in devices.iter().enumerate() {
            if dev.driver_id != "mock" {
                assert!(
                    idx < mock0_idx,
                    "hardware/kernel device '{}' at idx {idx} must precede mock0 at idx {mock0_idx}",
                    dev.device_id
                );
            }
        }
        if let Some(vcan_idx) = devices.iter().position(|d| d.device_id == "socketcan:vcan0") {
            assert!(vcan_idx < mock0_idx);
        }

        let engine = PipelineEngine::with_registry(reg);

        // 1. Calling cmd_set_bus_mode on an unconnected bus MUST fail with BusNotConnected and never auto-open mock0!
        let not_conn_err = engine
            .cmd_set_bus_mode(0, false, true)
            .expect_err("unconnected bus must return BusNotConnected");
        assert!(
            matches!(not_conn_err, HalError::BusNotConnected(0)),
            "expected BusNotConnected(0), got: {not_conn_err}"
        );
        assert!(engine.flush_snapshot_now().expect("snapshot").buses.is_empty());

        // 2. Connect mock:mock1 (NOT mock0!) in Listen-Only mode on bus 0, capture RX frames,
        //    then atomically switch to Active TX via cmd_set_bus_mode(0, false, true).
        let ro_dto = engine
            .cmd_connect_bus(
                MOCK1_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    listen_only: true,
                    mock_fps_preset: Some(475),
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect mock1 listen-only");
        assert_eq!(ro_dto.device_id, MOCK1_DEVICE_ID);
        assert!(ro_dto.listen_only);
        assert!(!ro_dto.tx_armed);

        thread::sleep(Duration::from_millis(140));
        let snap_before = engine.flush_snapshot_now().expect("snapshot before mode switch");
        assert!(
            !snap_before.frames.is_empty(),
            "expected RX frames on mock1 before mode switch"
        );

        let active_dto = engine
            .cmd_set_bus_mode(0, false, true)
            .expect("atomic Listen-Only -> Active TX switch on mock1");
        assert_eq!(
            active_dto.device_id, MOCK1_DEVICE_ID,
            "cmd_set_bus_mode must strictly preserve exact device_id without leaking to mock0"
        );
        assert_eq!(active_dto.channel_name, "mock1");
        assert!(!active_dto.listen_only);
        assert!(active_dto.tx_armed);
        assert!(active_dto.connected);

        // Verify RX rows in StateTable were NOT wiped during Listen-Only -> Active TX switch
        let snap_after = engine.flush_snapshot_now().expect("snapshot immediately after switch");
        assert!(
            !snap_after.frames.is_empty(),
            "StateTable RX rows must be preserved across cmd_set_bus_mode"
        );

        // Verify raw TX works immediately on the newly armed channel
        let tx_res = engine
            .cmd_transmit_raw_frame(
                0,
                0x7DF,
                false,
                false,
                false,
                vec![0x02, 0x3E, 0x00, 0, 0, 0, 0, 0],
                Some(25),
                Some("DiagKeepAlive".to_string()),
            )
            .expect("transmit raw frame after cmd_set_bus_mode");
        assert_eq!(tx_res.encoded_dlc, 8);
        assert_eq!(engine.cmd_list_periodic_tx().len(), 1);

        // In-place disarm (listen_only unchanged == false, arm_tx == false) cancels periodic TX without reopening
        let disarmed_dto = engine
            .cmd_set_bus_mode(0, false, false)
            .expect("in-place disarm");
        assert_eq!(disarmed_dto.device_id, MOCK1_DEVICE_ID);
        assert!(!disarmed_dto.listen_only);
        assert!(!disarmed_dto.tx_armed);
        assert!(engine.cmd_list_periodic_tx().is_empty());

        // Switching back to Listen-Only forces tx_armed == false even if arm_tx == true
        let back_ro_dto = engine
            .cmd_set_bus_mode(0, true, true)
            .expect("switch back to Listen-Only");
        assert_eq!(back_ro_dto.device_id, MOCK1_DEVICE_ID);
        assert!(back_ro_dto.listen_only);
        assert!(!back_ro_dto.tx_armed);

        engine.cmd_disconnect_bus(0).expect("disconnect bus 0");

        // 3. If socketcan:vcan0 is present and up on this Linux host, verify atomic mode switch on vcan0 directly too!
        if devices.iter().any(|d| d.device_id == "socketcan:vcan0") {
            if let Ok(vcan_ro) = engine.cmd_connect_bus(
                "socketcan:vcan0".to_string(),
                ChannelConfigDto {
                    bus_id: 2,
                    listen_only: true,
                    ..ChannelConfigDto::default()
                },
            ) {
                assert_eq!(vcan_ro.device_id, "socketcan:vcan0");
                assert!(vcan_ro.listen_only);

                let vcan_rw = engine
                    .cmd_set_bus_mode(2, false, true)
                    .expect("atomic vcan0 Listen-Only -> Active TX switch");
                assert_eq!(vcan_rw.device_id, "socketcan:vcan0");
                assert!(!vcan_rw.listen_only);
                assert!(vcan_rw.tx_armed);

                engine.cmd_disconnect_bus(2).expect("disconnect vcan0");
            }
        }
    }
}
