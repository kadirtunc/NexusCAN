//! # nexus-cli
//!
//! Standalone, zero-Tauri/GUI headless field telemetry agent (`nexuscan`) and
//! signal database linter (`nexuscan dbc lint`) for NexusCAN.
//!
//! ### Core Safety Invariants
//! 1. `#![forbid(unsafe_code)]` across the entire crate.
//! 2. **Unconditional `listen_only = true`:** Every CAN / CAN-FD channel opened by
//!    `nexuscan agent run` is locked to passive `Listen-Only` observation (`tx_armed = false`),
//!    even if `agent.toml` or CLI flags attempt to pass `listen_only = false`.
//!    Opt-in fail-closed mode (`--require-hw-listen-only` / `require_hw_listen_only = true`)
//!    refuses to start when the controller cannot be put into hardware listen-only mode
//!    (exit `EX_CONFIG` 78, no retry) instead of accepting the software-only TX lock.
//! 3. **Read-Only Cloud Bridge:** Inbound actuation frames (`TX`, `CAN_TX`, `ARM_ACTIVE_BUS`, etc.)
//!    are rejected and counted as security violations without ever touching `nexus-hal`.

#![forbid(unsafe_code)]

use std::io::Write;

pub mod cli;
pub mod config;
pub mod http_client;
pub mod runner;
pub mod web_status;
pub mod ws_bridge;

pub use cli::{
    execute_dbc_lint, lint_database_bytes, parse_cli_args, parse_env_args, AgentRunArgs,
    CliCommand, CliError, DbcLintReport, HelpTopic, CLI_VERSION,
};
pub use config::{
    append_token_query_param, derive_ws_bridge_url, detect_host_os_label, detect_system_hostname,
    parse_agent_toml_str, resolve_hal_device_id, AgentSectionToml, AgentTomlFile, CanSectionToml,
    CloudSectionToml, ConfigError, EffectiveAgentConfig, WebSectionToml,
};
pub use http_client::{
    http_get_authenticated, http_get_plain, http_get_plain_with_content_type,
    sync_project_database_from_cloud, HttpClientError, SyncedCloudDatabase,
};
pub use runner::{run_agent_until_signal, spawn_agent_runtime, RunnerError, RunningAgentHandle};
pub use web_status::{
    build_status_router, spawn_web_status_server, AgentLiveSnapshotDto, AgentStatusDto,
    SharedAgentState, SignalMetaBriefDto, EDGE_HMI_INDEX_HTML,
};
pub use ws_bridge::{
    coalesce_and_convert_snapshot, run_ws_bridge_supervisor, LoadedEdgeDatabase, WsBridgeError,
    WsSupervisorOutcome,
};

/// POSIX `sysexits.h` `EX_CONFIG` (`78`) returned on permanent `4003` / `401` token revocation
/// so `systemd` (`RestartPreventExitStatus=78`) stops restarting a revoked edge agent.
pub const EXIT_CODE_EX_CONFIG: u8 = 78;

/// Synchronous CLI dispatcher for `version`, `help`, and `dbc lint` commands, returning
/// `Some(exit_code)` when handled synchronously or `None` when `agent run` needs the async Tokio runtime.
pub fn dispatch_sync_command(
    cmd: &CliCommand,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> Option<i32> {
    match cmd {
        CliCommand::Version => {
            let _ = writeln!(stdout, "{CLI_VERSION}");
            Some(0)
        }
        CliCommand::Help(topic) => {
            let _ = write!(stdout, "{}", topic.usage_text());
            Some(0)
        }
        CliCommand::DbcLint { path } => Some(execute_dbc_lint(path, stdout, stderr)),
        CliCommand::AgentRun(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
    use axum::extract::{Query, State as AxumState};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use base64::engine::general_purpose::STANDARD as BASE64_STD;
    use base64::Engine as _;
    use nexus_hal::{
        BusHealthDto, ChronologicalFrameDto, FrameTelemetryDto, LiveSignalDto, TelemetrySnapshotDto,
    };
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    use super::*;

    #[test]
    fn full_and_minimal_agent_toml_parsing_and_defaults() {
        let full_toml = r#"
[agent]
name = "Headless Agent (rpi-dyno-01)"
hostname = "rpi-dyno-01"
device_id = "dev-rpi-01"
listen_only = true
auto_sync_dbc = true
dbc_path = "/etc/nexuscan/vehicle.dbc"

[cloud]
url = "http://localhost:3000/"
ws_bridge_url = "ws://localhost:3000/api/bridge/ws"
project_id = "proj-uuid-1234"
project_slug = "ev-dyno"
token = "nxc_tok_abcdef0123456789abcdef"

[can]
interface = "vcan0"
bitrate = 250000
enable_fd = false
data_bitrate = 1000000
listen_only = true

[web]
enabled = true
bind = "127.0.0.1:9090"
"#;

        let parsed = parse_agent_toml_str(full_toml).expect("parse full agent.toml");
        let eff = EffectiveAgentConfig::resolve(Some(parsed), &AgentRunArgs::default())
            .expect("resolve effective config");

        assert_eq!(eff.agent_name, "Headless Agent (rpi-dyno-01)");
        assert_eq!(eff.hostname, "rpi-dyno-01");
        assert_eq!(eff.explicit_device_id(), Some("dev-rpi-01"));
        assert!(eff.listen_only);
        assert!(!eff.forced_listen_only_override);
        assert!(eff.auto_sync_dbc);
        assert_eq!(
            eff.dbc_path.as_deref(),
            Some(Path::new("/etc/nexuscan/vehicle.dbc"))
        );
        assert_eq!(eff.cloud_url, "http://localhost:3000");
        assert_eq!(eff.ws_bridge_url, "ws://localhost:3000/api/bridge/ws");
        assert_eq!(
            eff.authenticated_ws_url(),
            "ws://localhost:3000/api/bridge/ws?token=nxc_tok_abcdef0123456789abcdef"
        );
        assert_eq!(eff.project_id, "proj-uuid-1234");
        assert_eq!(eff.project_slug.as_deref(), Some("ev-dyno"));
        assert_eq!(eff.interface, "vcan0");
        assert_eq!(eff.resolved_device_id, "socketcan:vcan0");
        assert_eq!(eff.bitrate, 250_000);
        assert!(!eff.enable_fd);
        assert_eq!(eff.data_bitrate, 1_000_000);
        assert!(eff.web_enabled);
        assert_eq!(eff.web_bind, "127.0.0.1:9090");

        // Minimal TOML with missing optional sections/fields defaults cleanly
        let minimal_toml = r#"
[cloud]
url = "https://cloud.nexuscan.io/"
project_id = "proj-minimal-99"
token = "nxc_tok_minimal_valid_token_99"
"#;
        let parsed_min = parse_agent_toml_str(minimal_toml).expect("parse minimal TOML");
        let eff_min = EffectiveAgentConfig::resolve(Some(parsed_min), &AgentRunArgs::default())
            .expect("resolve minimal TOML");

        assert_eq!(eff_min.cloud_url, "https://cloud.nexuscan.io");
        assert_eq!(
            eff_min.ws_bridge_url,
            "wss://cloud.nexuscan.io/api/bridge/ws"
        );
        assert_eq!(eff_min.interface, "can0");
        assert_eq!(eff_min.resolved_device_id, "socketcan:can0");
        assert_eq!(eff_min.bitrate, 500_000);
        assert!(eff_min.enable_fd);
        assert_eq!(eff_min.data_bitrate, 2_000_000);
        assert!(eff_min.auto_sync_dbc);
        assert!(!eff_min.web_enabled);
        assert_eq!(eff_min.web_bind, "127.0.0.1:8080");
        assert!(eff_min.listen_only);
        assert_eq!(eff_min.explicit_device_id(), None);
    }

    #[test]
    fn cli_version_help_and_dual_form_boolean_flags() {
        // 1. Version subcommand and flags -> exact "0.1.0-cli"
        for argv in [
            vec!["agent", "version"],
            vec!["--version"],
            vec!["-V"],
            vec!["version"],
        ] {
            let cmd = parse_cli_args(&argv).expect("parse version");
            assert_eq!(cmd, CliCommand::Version);
            let mut out = Vec::new();
            let mut err = Vec::new();
            let code = dispatch_sync_command(&cmd, &mut out, &mut err).expect("sync handled");
            assert_eq!(code, 0);
            assert_eq!(String::from_utf8(out).unwrap(), "0.1.0-cli\n");
            assert!(err.is_empty());
        }

        // 2. Help topics at root, agent, agent run, dbc, dbc lint -> exit 0
        for (argv, expected_topic) in [
            (vec!["--help"], HelpTopic::Root),
            (vec!["-h"], HelpTopic::Root),
            (vec!["agent", "--help"], HelpTopic::Agent),
            (vec!["agent", "run", "--help"], HelpTopic::AgentRun),
            (vec!["dbc", "-h"], HelpTopic::Dbc),
            (vec!["dbc", "lint", "--help"], HelpTopic::DbcLint),
        ] {
            let cmd = parse_cli_args(&argv).expect("parse help");
            assert_eq!(cmd, CliCommand::Help(expected_topic));
            let mut out = Vec::new();
            let mut err = Vec::new();
            assert_eq!(dispatch_sync_command(&cmd, &mut out, &mut err), Some(0));
            assert!(!out.is_empty());
        }

        // 3. Dual-form `--fd` & `--listen-only`
        // Case A: bare `--fd` immediately followed by `--dbitrate 2000000` and bare `--listen-only` at end
        let cmd_bare = parse_cli_args([
            "agent",
            "run",
            "--cloud",
            "http://localhost:3000",
            "--ws",
            "ws://localhost:3000/api/bridge/ws",
            "--token",
            "nxc_tok_1234567890abcdef",
            "--project",
            "proj-1",
            "--device",
            "auto",
            "--iface",
            "mock0",
            "--bitrate",
            "500000",
            "--fd",
            "--dbitrate",
            "2000000",
            "--web",
            "127.0.0.1:8080",
            "--listen-only",
        ])
        .expect("parse bare --fd before --dbitrate");
        let CliCommand::AgentRun(run_bare) = cmd_bare else {
            panic!("expected AgentRun");
        };
        assert_eq!(run_bare.enable_fd, Some(true));
        assert_eq!(run_bare.data_bitrate, Some(2_000_000));
        assert_eq!(run_bare.listen_only, Some(true));
        assert_eq!(run_bare.web_bind.as_deref(), Some("127.0.0.1:8080"));

        // Case B: `--fd true`, `--fd false`, `--fd=true`, `--fd=false`, `--no-fd`
        for (args, expected_fd) in [
            (
                vec!["agent", "run", "--fd", "true", "--iface", "can0"],
                Some(true),
            ),
            (
                vec!["agent", "run", "--fd", "false", "--iface", "can0"],
                Some(false),
            ),
            (vec!["agent", "run", "--fd", "1"], Some(true)),
            (vec!["agent", "run", "--fd", "0"], Some(false)),
            (vec!["agent", "run", "--fd=true"], Some(true)),
            (vec!["agent", "run", "--fd=false"], Some(false)),
            (vec!["agent", "run", "--no-fd"], Some(false)),
        ] {
            let CliCommand::AgentRun(parsed) = parse_cli_args(&args).unwrap() else {
                panic!("expected AgentRun");
            };
            assert_eq!(parsed.enable_fd, expected_fd, "failed for {args:?}");
        }

        // Case C: invalid non-flag token after `--fd` must fail cleanly
        let bad_fd = parse_cli_args(["agent", "run", "--fd", "not_a_boolean"]);
        assert!(bad_fd.is_err(), "invalid token after --fd must error");

        // Case D: CLI flags override agent.toml values
        let base_toml = parse_agent_toml_str(
            r#"
[cloud]
url = "http://toml-host:3000"
project_id = "toml-proj"
token = "nxc_tok_toml_token_123456789"
[can]
interface = "can0"
bitrate = 250000
enable_fd = true
"#,
        )
        .unwrap();
        let CliCommand::AgentRun(override_cli) = parse_cli_args([
            "agent",
            "run",
            "--iface=mock0",
            "--bitrate=1000000",
            "--fd=false",
            "--web=127.0.0.1:8181",
        ])
        .unwrap() else {
            panic!("expected AgentRun");
        };
        let merged = EffectiveAgentConfig::resolve(Some(base_toml), &override_cli).unwrap();
        assert_eq!(merged.interface, "mock0");
        assert_eq!(merged.resolved_device_id, "mock:mock0");
        assert_eq!(merged.bitrate, 1_000_000);
        assert!(!merged.enable_fd);
        assert!(merged.web_enabled);
        assert_eq!(merged.web_bind, "127.0.0.1:8181");
    }

    #[test]
    fn dbc_lint_valid_sample_vehicle_dbc_and_malformed_dbc() {
        let sample_dbc_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/sample_vehicle.dbc");
        assert!(
            sample_dbc_path.is_file(),
            "scripts/sample_vehicle.dbc must exist"
        );

        let cmd = parse_cli_args(["dbc", "lint", sample_dbc_path.to_str().unwrap()])
            .expect("parse dbc lint");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let exit_code = dispatch_sync_command(&cmd, &mut stdout, &mut stderr).unwrap();
        let out_str = String::from_utf8(stdout).unwrap();

        assert_eq!(
            exit_code,
            0,
            "valid sample_vehicle.dbc must exit 0; stderr={}",
            String::from_utf8_lossy(&stderr)
        );
        assert!(out_str.contains("Format:"));
        assert!(out_str.contains("Messages:"));
        assert!(out_str.contains("Total Signals:"));
        assert!(out_str.contains("Result:          OK"));

        // Malformed / empty / error-diagnostic bytes must exit 1
        let empty_report = lint_database_bytes(b"", "broken.dbc");
        assert_eq!(empty_report.exit_code, 1);

        // Malformed DBC statement (`BO_ NOT_AN_ID ...`) emits DiagnosticSeverity::Error -> exit 1
        let malformed_dbc = br#"VERSION "1.0"
BU_: ECU1
BO_ NOT_AN_ID BrokenMsg: 8 ECU1
 SG_ : 0|8@1+ (1,0) [0|255] "" Vector__XXX
"#;
        let malformed_report = lint_database_bytes(malformed_dbc, "malformed.dbc");
        assert_eq!(malformed_report.exit_code, 1);
        assert!(malformed_report.error_diagnostics >= 1);

        // Random garbage bytes with zero DBC/KCD constructs -> exit 1 with error diagnostic
        let garbage_report = lint_database_bytes(b"\x00\xFF\xFEnot_a_db", "corrupt.dbc");
        assert_eq!(garbage_report.exit_code, 1);
        assert!(garbage_report.error_diagnostics >= 1);

        // Also verify execute_dbc_lint on a malformed .dbc file on disk exits 1 and prints [ERROR]
        let tmp_bad_dbc =
            std::env::temp_dir().join(format!("nexuscan_lint_bad_{}.dbc", std::process::id()));
        std::fs::write(&tmp_bad_dbc, malformed_dbc).expect("write temp bad dbc");
        let mut bad_out = Vec::new();
        let mut bad_err = Vec::new();
        let bad_exit = execute_dbc_lint(&tmp_bad_dbc, &mut bad_out, &mut bad_err);
        let _ = std::fs::remove_file(&tmp_bad_dbc);
        assert_eq!(bad_exit, 1);
        assert!(String::from_utf8_lossy(&bad_out).contains("[ERROR]"));

        // Non-existent file path -> exit 1
        let mut out2 = Vec::new();
        let mut err2 = Vec::new();
        let missing_code = execute_dbc_lint(
            Path::new("/nonexistent/path/does_not_exist.dbc"),
            &mut out2,
            &mut err2,
        );
        assert_eq!(missing_code, 1);
        assert!(!err2.is_empty());
    }

    #[test]
    fn hard_listen_only_safety_enforcement_cannot_be_overridden() {
        let unsafe_toml = parse_agent_toml_str(
            r#"
[agent]
listen_only = false

[cloud]
url = "http://localhost:3000"
project_id = "proj-safety"
token = "nxc_tok_safety_test_1234567890"

[can]
interface = "mock0"
listen_only = false
"#,
        )
        .expect("parse TOML with listen_only = false");

        let CliCommand::AgentRun(unsafe_cli) =
            parse_cli_args(["agent", "run", "--listen-only=false"])
                .expect("parse --listen-only=false")
        else {
            panic!("expected AgentRun");
        };
        assert_eq!(unsafe_cli.listen_only, Some(false));

        let eff = EffectiveAgentConfig::resolve(Some(unsafe_toml), &unsafe_cli)
            .expect("resolve config enforcing listen_only");
        assert!(
            eff.listen_only,
            "EffectiveAgentConfig.listen_only MUST always be forced to true"
        );
        assert!(
            eff.forced_listen_only_override,
            "forced_listen_only_override must record attempted active TX configuration"
        );

        let ch_dto = eff.to_channel_config_dto();
        assert_eq!(ch_dto.bus_id, 0);
        assert!(
            ch_dto.listen_only,
            "ChannelConfigDto.listen_only MUST always be true"
        );
        assert_eq!(ch_dto.mock_fps_preset, Some(500));
    }

    const MIN_TOML: &str = r#"
[cloud]
url = "http://localhost:3000"
project_id = "proj-hwlo"
token = "nxc_tok_hwlo_test_1234567890"
"#;

    fn run_args(argv: &[&str]) -> AgentRunArgs {
        match parse_cli_args(argv.iter().copied()).expect("parse") {
            CliCommand::AgentRun(a) => a,
            other => panic!("expected AgentRun, got {other:?}"),
        }
    }

    #[test]
    fn require_hw_listen_only_flag_parses_in_all_forms() {
        for (argv, expected) in [
            (vec!["agent", "run"], None),
            (vec!["agent", "run", "--require-hw-listen-only"], Some(true)),
            (
                vec![
                    "agent",
                    "run",
                    "--require-hw-listen-only",
                    "--iface",
                    "can0",
                ],
                Some(true),
            ),
            (
                vec!["agent", "run", "--require-hw-listen-only", "false"],
                Some(false),
            ),
            (
                vec!["agent", "run", "--require-hw-listen-only=yes"],
                Some(true),
            ),
            (
                vec!["agent", "run", "--require-hw-listen-only=0"],
                Some(false),
            ),
        ] {
            assert_eq!(run_args(&argv).require_hw_listen_only, expected, "{argv:?}");
        }
        assert!(parse_cli_args(["agent", "run", "--require-hw-listen-only=maybe"]).is_err());
        assert!(HelpTopic::AgentRun
            .usage_text()
            .contains("--require-hw-listen-only"));
    }

    #[test]
    fn require_hw_listen_only_merges_cli_over_can_over_agent_and_reaches_dto() {
        let resolve = |toml_extra: &str, argv: &[&str]| {
            let t = parse_agent_toml_str(&format!("{MIN_TOML}\n{toml_extra}")).expect("toml");
            EffectiveAgentConfig::resolve(Some(t), &run_args(argv)).expect("resolve")
        };

        // Default: off, existing behaviour.
        let eff = resolve("", &["agent", "run"]);
        assert!(!eff.require_hw_listen_only);
        assert!(!eff.to_channel_config_dto().require_hardware_listen_only);

        // Config-file key in [can] and in [agent].
        let eff = resolve("[can]\nrequire_hw_listen_only = true\n", &["agent", "run"]);
        assert!(eff.require_hw_listen_only);
        let dto = eff.to_channel_config_dto();
        assert!(dto.listen_only && dto.require_hardware_listen_only);
        assert!(dto.requires_hardware_listen_only());
        let eff = resolve(
            "[agent]\nrequire_hw_listen_only = true\n",
            &["agent", "run"],
        );
        assert!(eff.require_hw_listen_only);

        // [can] takes precedence over [agent].
        let eff = resolve(
            "[agent]\nrequire_hw_listen_only = true\n[can]\nrequire_hw_listen_only = false\n",
            &["agent", "run"],
        );
        assert!(!eff.require_hw_listen_only);

        // CLI overrides the file in both directions.
        let eff = resolve("", &["agent", "run", "--require-hw-listen-only"]);
        assert!(eff.require_hw_listen_only);
        let eff = resolve(
            "[can]\nrequire_hw_listen_only = true\n",
            &["agent", "run", "--require-hw-listen-only=false"],
        );
        assert!(!eff.require_hw_listen_only);

        // Listen-Only itself stays forced on regardless.
        assert!(eff.to_channel_config_dto().listen_only);
    }

    #[test]
    fn require_hw_listen_only_on_virtual_mock_still_starts_channel_config() {
        // mock0 is virtual: the DTO carries the flag and the HAL accepts it (no refusal).
        let t = parse_agent_toml_str(&format!(
            "{MIN_TOML}\n[can]\ninterface = \"mock0\"\nrequire_hw_listen_only = true\n"
        ))
        .expect("toml");
        let eff =
            EffectiveAgentConfig::resolve(Some(t), &AgentRunArgs::default()).expect("resolve");
        let engine = nexus_hal::PipelineEngine::new();
        let dto = engine
            .cmd_connect_bus(eff.resolved_device_id.clone(), eff.to_channel_config_dto())
            .expect("virtual mock0 is allowed fail-closed");
        assert_eq!(dto.listen_only_enforcement.as_deref(), Some("virtual"));
        engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn runner_error_for_hw_listen_only_is_distinct() {
        let hal = nexus_hal::HalError::from_channel_open(
            nexus_hal::AdapterError::hw_listen_only_unavailable("test"),
        );
        assert!(hal.is_hw_listen_only_unavailable());
        assert!(hal
            .to_string()
            .starts_with(nexus_hal::HW_LISTEN_ONLY_UNAVAILABLE_PREFIX));
        let e = RunnerError::HardwareListenOnlyUnavailable(hal.to_string());
        assert!(
            e.to_string().contains("HW_LISTEN_ONLY_UNAVAILABLE: test"),
            "{e}"
        );
    }

    #[test]
    fn resolve_hal_device_id_maps_all_interface_families() {
        assert_eq!(resolve_hal_device_id("mock0"), "mock:mock0");
        assert_eq!(resolve_hal_device_id("mock:mock0"), "mock:mock0");
        assert_eq!(resolve_hal_device_id("mock1"), "mock:mock1");
        assert_eq!(resolve_hal_device_id("mock:mock1"), "mock:mock1");
        assert_eq!(resolve_hal_device_id("can0"), "socketcan:can0");
        assert_eq!(resolve_hal_device_id("vcan0"), "socketcan:vcan0");
        assert_eq!(resolve_hal_device_id("slcan0"), "socketcan:slcan0");
        assert_eq!(resolve_hal_device_id("socketcan:vcan0"), "socketcan:vcan0");
        assert_eq!(resolve_hal_device_id("/dev/ttyUSB0"), "slcan:/dev/ttyUSB0");
        assert_eq!(resolve_hal_device_id("/dev/ttyACM0"), "slcan:/dev/ttyACM0");
        assert_eq!(resolve_hal_device_id("COM3"), "slcan:COM3");
        assert_eq!(resolve_hal_device_id("com12"), "slcan:com12");
        assert_eq!(resolve_hal_device_id("gs_usb:0"), "gs_usb:0");
        assert_eq!(
            resolve_hal_device_id("pcan:PCAN_USBBUS1"),
            "pcan:PCAN_USBBUS1"
        );
        assert_eq!(resolve_hal_device_id("kvaser:0"), "kvaser:0");
    }

    #[test]
    fn multiplexed_frames_coalesce_oldest_to_newest_by_bus_and_message_key() {
        let sw0 = serde_json::from_value(json!({ "BankMux": 0 })).unwrap();
        let sw1 = serde_json::from_value(json!({ "BankMux": 1 })).unwrap();

        let snap = TelemetrySnapshotDto {
            seq: 7,
            timestamp_us: 250_000,
            fps_rx: 500.0,
            fps_tx: 0.0,
            estimated_bus_load_pct: 12.5,
            total_frames_rx: 100,
            total_frames_tx: 0,
            total_frames_err: 0,
            dropped_frames: 0,
            active_ids_count: 1,
            decoded_signals_count: 3,
            tx_panic_latched: false,
            buses: vec![BusHealthDto {
                bus_id: 0,
                device_id: "mock:mock0".to_string(),
                channel_name: "mock0".to_string(),
                connected: true,
                listen_only: true,
                tx_armed: false,
                bus_state: "active".to_string(),
                tx_error_count: 0,
                rx_error_count: 0,
                listen_only_enforcement: Some("virtual".to_string()),
            }],
            frames: vec![
                // Newer branch listed first in input to verify timestamp sorting!
                FrameTelemetryDto {
                    bus_id: 0,
                    message_key: "ext:0x18FF50E5".to_string(),
                    arb_id: 0x18FF50E5,
                    is_extended: true,
                    is_fd: false,
                    is_brs: false,
                    is_tx: false,
                    is_error: false,
                    error_summary: None,
                    has_hw_timestamp: true,
                    dlc: 8,
                    raw_bytes: vec![1, 0xAA, 0xBB, 0, 0, 0, 0, 0],
                    changed_bytes_lo: 0b0010,
                    changed_bytes_hi: 0,
                    last_timestamp_us: 240_000,
                    cycle_ms: 10.0,
                    frequency_hz: 100.0,
                    cycle_health: "nominal".to_string(),
                    rx_count: 50,
                    active_mux_switches: sw1,
                    signals: vec![
                        LiveSignalDto {
                            signal_id: 0, // Mux switch
                            raw_int: 1,
                            physical_value: 1.0,
                            active_in_last_frame: true,
                            out_of_range: false,
                            age_ms: 10,
                        },
                        LiveSignalDto {
                            signal_id: 2, // Bank 1 voltage
                            raw_int: 3710,
                            physical_value: 3.71,
                            active_in_last_frame: true,
                            out_of_range: false,
                            age_ms: 10,
                        },
                    ],
                },
                FrameTelemetryDto {
                    bus_id: 0,
                    message_key: "ext:0x18FF50E5".to_string(),
                    arb_id: 0x18FF50E5,
                    is_extended: true,
                    is_fd: false,
                    is_brs: false,
                    is_tx: false,
                    is_error: false,
                    error_summary: None,
                    has_hw_timestamp: true,
                    dlc: 8,
                    raw_bytes: vec![0, 0xCC, 0xDD, 0, 0, 0, 0, 0],
                    changed_bytes_lo: 0b0100,
                    changed_bytes_hi: 0,
                    last_timestamp_us: 200_000,
                    cycle_ms: 10.0,
                    frequency_hz: 100.0,
                    cycle_health: "nominal".to_string(),
                    rx_count: 45,
                    active_mux_switches: sw0,
                    signals: vec![
                        LiveSignalDto {
                            signal_id: 0, // Mux switch (older value = 0)
                            raw_int: 0,
                            physical_value: 0.0,
                            active_in_last_frame: true,
                            out_of_range: false,
                            age_ms: 50,
                        },
                        LiveSignalDto {
                            signal_id: 1, // Bank 0 voltage (retained!)
                            raw_int: 3680,
                            physical_value: 3.68,
                            active_in_last_frame: true,
                            out_of_range: false,
                            age_ms: 50,
                        },
                    ],
                },
            ],
            recent_chronological: Vec::<ChronologicalFrameDto>::new(),
            replay: Default::default(),
        };

        let wire = coalesce_and_convert_snapshot(&snap, Vec::new());
        assert_eq!(
            wire.frames.len(),
            1,
            "must coalesce into 1 authoritative frame"
        );
        let f = &wire.frames[0];
        assert_eq!(f.rx_count, 95);
        assert_eq!(f.last_timestamp_us, 240_000);
        assert_eq!(f.changed_bytes_lo, 0b0110);
        assert_eq!(f.active_mux_switches.get("BankMux"), Some(&1));
        assert_eq!(f.signals.len(), 3);
        // Signal 0 (mux switch) must reflect newest branch (1.0, active=true)
        assert_eq!(f.signals[0].signal_id, 0);
        assert_eq!(f.signals[0].raw_int, 1);
        assert!(f.signals[0].active_in_last_frame);
        // Signal 1 (older branch) retained with active_in_last_frame = false
        assert_eq!(f.signals[1].signal_id, 1);
        assert!(!f.signals[1].active_in_last_frame);
        // Signal 2 (newest branch) active_in_last_frame = true
        assert_eq!(f.signals[2].signal_id, 2);
        assert!(f.signals[2].active_in_last_frame);
    }

    #[derive(Clone)]
    struct MockCloudServerState {
        expected_bearer: String,
        expected_raw_token: String,
        dbc_b64: String,
        http_auth_headers: Arc<Mutex<Vec<String>>>,
        ws_auth_headers: Arc<Mutex<Vec<String>>>,
        ws_query_tokens: Arc<Mutex<Vec<String>>>,
        inbound_ws_tx: mpsc::UnboundedSender<Value>,
    }

    async fn mock_list_databases(
        headers: HeaderMap,
        AxumState(st): AxumState<MockCloudServerState>,
    ) -> impl IntoResponse {
        if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
            st.http_auth_headers.lock().push(auth.to_string());
        }
        Json(json!({
            "databases": [
                { "id": "db-uuid-001", "name": "sample_vehicle.dbc" }
            ],
            "activeSchema": null
        }))
    }

    async fn mock_download_database(
        headers: HeaderMap,
        AxumState(st): AxumState<MockCloudServerState>,
    ) -> impl IntoResponse {
        if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
            st.http_auth_headers.lock().push(auth.to_string());
        }
        Json(json!({
            "databaseId": "db-uuid-001",
            "fileName": "sample_vehicle.dbc",
            "contentBase64": st.dbc_b64
        }))
    }

    async fn mock_bridge_ws_upgrade(
        ws: WebSocketUpgrade,
        headers: HeaderMap,
        Query(params): Query<std::collections::HashMap<String, String>>,
        AxumState(st): AxumState<MockCloudServerState>,
    ) -> impl IntoResponse {
        let auth_hdr = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        st.ws_auth_headers.lock().push(auth_hdr.clone());

        if let Some(qtok) = params.get("token") {
            st.ws_query_tokens.lock().push(qtok.clone());
        }

        if auth_hdr != st.expected_bearer {
            return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
        }

        let _ = &st.expected_raw_token;
        ws.on_upgrade(move |socket| handle_mock_cloud_ws(socket, st))
    }

    async fn handle_mock_cloud_ws(mut socket: WebSocket, st: MockCloudServerState) {
        // Immediately send RATE_CONTROL (2 Hz), a PING, and a malicious forbidden CAN_TX command!
        let _ = socket
            .send(AxumWsMessage::Text(
                r#"{"type":"RATE_CONTROL","targetHz":2,"reason":"e2e_test"}"#.into(),
            ))
            .await;
        let _ = socket
            .send(AxumWsMessage::Text(
                r#"{"type":"CAPTURE_STATUS","streamId":"dev-1","state":"CAPTURING","capturing":true,"activeSessionId":"sess-77","activeSessionName":"DynoRun","startedAtIso":null,"startedByName":"QA","capturedFramesCount":42,"capturedBytesEstimate":4096}"#.into(),
            ))
            .await;
        let _ = socket
            .send(AxumWsMessage::Text(
                r#"{"type":"CAN_TX","arbId":257,"data":[1,2,3,4]}"#.into(),
            ))
            .await;
        let _ = socket
            .send(AxumWsMessage::Text(
                r#"{"type":"PING","timestampMs":1700000000123}"#.into(),
            ))
            .await;

        while let Some(Ok(msg)) = socket.recv().await {
            if let AxumWsMessage::Text(txt) = msg {
                if let Ok(parsed) = serde_json::from_str::<Value>(&txt) {
                    let _ = st.inbound_ws_tx.send(parsed);
                }
            } else if matches!(msg, AxumWsMessage::Close(_)) {
                break;
            }
        }
    }

    #[tokio::test]
    async fn end_to_end_mock0_loopback_ws_bridge_rate_control_security_and_web_status() {
        let sample_dbc_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/sample_vehicle.dbc");
        let dbc_bytes = std::fs::read(&sample_dbc_path).expect("read sample_vehicle.dbc");
        let dbc_b64 = BASE64_STD.encode(&dbc_bytes);

        let raw_token = "nxc_tok_e2e_loopback_secret_987654";
        let expected_bearer = format!("Bearer {raw_token}");
        let (inbound_ws_tx, mut inbound_ws_rx) = mpsc::unbounded_channel::<Value>();

        let mock_state = MockCloudServerState {
            expected_bearer: expected_bearer.clone(),
            expected_raw_token: raw_token.to_string(),
            dbc_b64,
            http_auth_headers: Arc::new(Mutex::new(Vec::new())),
            ws_auth_headers: Arc::new(Mutex::new(Vec::new())),
            ws_query_tokens: Arc::new(Mutex::new(Vec::new())),
            inbound_ws_tx,
        };

        let cloud_router = Router::new()
            .route(
                "/api/projects/{project_id}/databases",
                get(mock_list_databases),
            )
            .route(
                "/api/projects/{project_id}/databases/{db_id}/download",
                get(mock_download_database),
            )
            .route("/api/bridge/ws", get(mock_bridge_ws_upgrade))
            .with_state(mock_state.clone());

        let cloud_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock cloud server");
        let cloud_addr = cloud_listener.local_addr().unwrap();
        let cloud_server_task = tokio::spawn(async move {
            let _ = axum::serve(cloud_listener, cloud_router).await;
        });

        let cloud_http_url = format!("http://{cloud_addr}");
        let CliCommand::AgentRun(cli_args) = parse_cli_args([
            "agent",
            "run",
            "--cloud",
            &cloud_http_url,
            "--token",
            raw_token,
            "--project",
            "proj-e2e-001",
            "--iface",
            "mock0",
            "--bitrate",
            "500000",
            "--fd",
            "--dbitrate",
            "2000000",
            "--web",
            "127.0.0.1:0",
            "--listen-only",
        ])
        .expect("parse E2E CLI args") else {
            panic!("expected AgentRun");
        };

        let eff_cfg =
            EffectiveAgentConfig::from_cli_and_optional_file(&cli_args).expect("resolve E2E cfg");
        assert!(eff_cfg.listen_only);

        let agent_handle = spawn_agent_runtime(eff_cfg)
            .await
            .expect("spawn agent runtime");
        let status_addr = agent_handle
            .web_local_addr()
            .expect("web status server must be bound");

        // Collect frames from agent over ~350ms
        let mut received_schema_update = false;
        let mut received_pong = false;
        let mut received_bridge_hello = false;
        let mut telemetry_snapshots: Vec<Value> = Vec::new();

        let deadline = Instant::now() + Duration::from_millis(650);
        while Instant::now() < deadline {
            if let Ok(Some(frame)) =
                tokio::time::timeout(Duration::from_millis(60), inbound_ws_rx.recv()).await
            {
                {
                    match frame.get("type").and_then(Value::as_str) {
                        Some("BRIDGE_HELLO") => {
                            received_bridge_hello = true;
                        }
                        Some("BRIDGE_SCHEMA_UPDATE") => {
                            received_schema_update = true;
                            assert_eq!(
                                frame.get("activeDbName").and_then(Value::as_str),
                                Some("sample_vehicle.dbc")
                            );
                        }
                        Some("PONG") => {
                            if frame.get("timestampMs").and_then(Value::as_u64)
                                == Some(1_700_000_000_123)
                            {
                                received_pong = true;
                            }
                        }
                        Some("TELEMETRY_SNAPSHOT") => {
                            telemetry_snapshots.push(frame);
                        }
                        _ => {}
                    }
                    if received_schema_update && received_pong && !telemetry_snapshots.is_empty() {
                        // Give mock0 a tiny bit more time to accumulate frames for /api/status check
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        break;
                    }
                }
            }
        }

        // 1. Verify Authorization: Bearer header & ?token=... query fallback
        assert_eq!(mock_state.http_auth_headers.lock().len(), 2);
        assert!(mock_state
            .http_auth_headers
            .lock()
            .iter()
            .all(|h| h == &expected_bearer));
        assert_eq!(
            mock_state.ws_auth_headers.lock().as_slice(),
            &[expected_bearer]
        );
        assert_eq!(
            mock_state.ws_query_tokens.lock().as_slice(),
            &[raw_token.to_string()]
        );

        // 2. Verify omitted device_id did NOT send BRIDGE_HELLO, while BRIDGE_SCHEMA_UPDATE & PONG arrived
        assert!(
            !received_bridge_hello,
            "BRIDGE_HELLO must not be sent when device_id is None/'auto'"
        );
        assert!(
            received_schema_update,
            "BRIDGE_SCHEMA_UPDATE must be pushed after auto_sync_dbc"
        );
        assert!(received_pong, "Agent must reply PONG to cloud PING");
        assert!(
            !telemetry_snapshots.is_empty(),
            "At least one TELEMETRY_SNAPSHOT must arrive"
        );

        // 3. Verify TELEMETRY_SNAPSHOT structure, listenOnly == true, txArmed == false, and coalesced frames
        let first_snap = telemetry_snapshots[0]
            .get("snapshot")
            .expect("snapshot object inside TELEMETRY_SNAPSHOT");
        assert!(
            first_snap.get("replay").is_none(),
            "Desktop-only replay field must not appear on BridgeTelemetryFrame"
        );
        let buses = first_snap
            .get("buses")
            .and_then(Value::as_array)
            .expect("buses array");
        assert_eq!(buses.len(), 1);
        assert_eq!(
            buses[0].get("listenOnly").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            buses[0].get("txArmed").and_then(Value::as_bool),
            Some(false)
        );

        if let Some(frames_arr) = first_snap.get("frames").and_then(Value::as_array) {
            let mut seen_keys = HashSet::new();
            for row in frames_arr {
                let bus_id = row.get("busId").and_then(Value::as_u64).unwrap_or(0);
                let msg_key = row.get("messageKey").and_then(Value::as_str).unwrap_or("");
                assert!(
                    seen_keys.insert((bus_id, msg_key.to_string())),
                    "Duplicate (busId, messageKey) ({bus_id}, {msg_key}) in TELEMETRY_SNAPSHOT"
                );
            }
        }

        // 4. Verify local Read-Only HTTP `/`, `/index.html`, `/api/live`, `/api/status`, `/api/health`
        let root_url = format!("http://{status_addr}/");
        let (root_code, root_ct, root_bytes) = http_get_plain_with_content_type(&root_url)
            .await
            .expect("GET / must succeed");
        assert_eq!(root_code, 200);
        assert!(
            root_ct.to_ascii_lowercase().contains("text/html"),
            "Expected text/html content-type on GET /, got: {root_ct}"
        );
        let root_html = String::from_utf8(root_bytes).expect("valid UTF-8 HTML");
        assert!(root_html.contains("NexusCAN"));
        assert!(root_html.contains("LISTEN-ONLY"));
        assert!(
            !root_html.contains("backdrop-blur"),
            "Industrial HMI must never use backdrop-blur"
        );

        let index_url = format!("http://{status_addr}/index.html");
        let (idx_code, idx_ct, _) = http_get_plain_with_content_type(&index_url)
            .await
            .expect("GET /index.html must succeed");
        assert_eq!(idx_code, 200);
        assert!(idx_ct.to_ascii_lowercase().contains("text/html"));

        let live_url = format!("http://{status_addr}/api/live");
        let (live_code, live_bytes) = http_get_plain(&live_url)
            .await
            .expect("GET /api/live must succeed");
        assert_eq!(live_code, 200);
        let live_dto: AgentLiveSnapshotDto =
            serde_json::from_slice(&live_bytes).expect("parse AgentLiveSnapshotDto JSON");
        assert!(live_dto.status.listen_only);
        assert!(!live_dto.status.tx_armed);
        assert_eq!(live_dto.buses.len(), 1);
        assert!(live_dto.buses[0].listen_only);
        assert!(!live_dto.buses[0].tx_armed);
        assert!(
            !live_dto.frames.is_empty(),
            "GET /api/live must expose live coalesced mock0 frames"
        );
        assert!(
            !live_dto.signal_catalog.is_empty(),
            "GET /api/live must expose compiled DBC signal metadata"
        );

        let status_url = format!("http://{status_addr}/api/status");
        let (http_code, body_bytes) = http_get_plain(&status_url)
            .await
            .expect("GET /api/status must succeed");
        assert_eq!(http_code, 200);

        let status_dto: AgentStatusDto =
            serde_json::from_slice(&body_bytes).expect("parse AgentStatusDto JSON");
        assert_eq!(status_dto.version, "0.1.0-cli");
        assert!(status_dto.listen_only);
        assert!(!status_dto.tx_armed);
        assert!(!status_dto.token_revoked);
        assert!(status_dto.cloud_connected);
        assert_eq!(status_dto.target_hz, 2);
        assert!(status_dto.capturing);
        assert_eq!(status_dto.active_session_id.as_deref(), Some("sess-77"));
        assert_eq!(status_dto.captured_frames_count, 42);
        assert_eq!(
            status_dto.security_violations_rejected, 1,
            "Forbidden CAN_TX command from server must be rejected and counted"
        );
        assert!(status_dto.snapshots_forwarded >= 1);
        assert!(status_dto.total_frames_rx > 0);
        assert_eq!(
            status_dto.active_db_name.as_deref(),
            Some("sample_vehicle.dbc")
        );

        let health_url = format!("http://{status_addr}/api/health");
        let (health_code, _) = http_get_plain(&health_url)
            .await
            .expect("GET /api/health must succeed");
        assert_eq!(health_code, 200);

        // 4b. WP-1: DNS-rebinding Host header is refused with 403.
        {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut stream = tokio::net::TcpStream::connect(status_addr)
                .await
                .expect("connect web status");
            stream
                .write_all(
                    b"GET /api/status HTTP/1.1\r\nHost: evil.example:8080\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write");
            let mut resp = Vec::new();
            stream.read_to_end(&mut resp).await.expect("read");
            let text = String::from_utf8_lossy(&resp);
            assert!(
                text.starts_with("HTTP/1.1 403"),
                "rebinding Host must be 403: {text}"
            );
        }

        // 5. Trigger clean shutdown and verify rapid termination
        let t_stop = Instant::now();
        let final_snap = agent_handle.shutdown().await;
        assert!(
            t_stop.elapsed() < Duration::from_secs(1),
            "Agent shutdown must complete promptly"
        );
        assert_eq!(final_snap.security_violations_rejected, 1);

        cloud_server_task.abort();
    }

    #[tokio::test]
    async fn explicit_device_id_sends_bridge_hello_and_4003_terminates_run_agent_with_ex_config() {
        use axum::extract::ws::CloseFrame;

        assert_eq!(EXIT_CODE_EX_CONFIG, 78);

        let raw_token = "nxc_tok_explicit_dev_4003_test_1234";
        let (hello_tx, mut hello_rx) = mpsc::unbounded_channel::<Value>();
        let connect_counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter_clone = Arc::clone(&connect_counter);

        let router = Router::new().route(
            "/api/bridge/ws",
            get(move |ws: WebSocketUpgrade| {
                let tx = hello_tx.clone();
                let cnt = Arc::clone(&counter_clone);
                async move {
                    cnt.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    ws.on_upgrade(move |mut socket| async move {
                        if let Some(Ok(AxumWsMessage::Text(txt))) = socket.recv().await {
                            if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                                let _ = tx.send(val);
                            }
                        }
                        // Close with 4003 (revoked token) -> agent must NOT reconnect or stay zombie!
                        let _ = socket
                            .send(AxumWsMessage::Close(Some(CloseFrame {
                                code: 4003,
                                reason: "DEVICE_TOKEN_REVOKED".into(),
                            })))
                            .await;
                    })
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv_task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        let cloud_url = format!("http://{addr}");
        let CliCommand::AgentRun(cli_args) = parse_cli_args([
            "agent",
            "run",
            "--cloud",
            &cloud_url,
            "--token",
            raw_token,
            "--project",
            "proj-explicit-4003",
            "--device",
            "dev-explicit-01",
            "--iface",
            "mock0",
            "--no-auto-sync-dbc",
        ])
        .unwrap() else {
            panic!("expected AgentRun");
        };

        let eff_cfg = EffectiveAgentConfig::from_cli_and_optional_file(&cli_args).unwrap();

        // `run_agent_until_signal` MUST exit cleanly with `Err(RunnerError::TokenRevoked4003)`
        // instead of leaving CAN & web tasks running as a zombie process!
        let run_res = tokio::time::timeout(Duration::from_secs(3), run_agent_until_signal(eff_cfg))
            .await
            .expect("run_agent_until_signal must not hang after 4003 WS close");
        assert!(
            matches!(run_res, Err(RunnerError::TokenRevoked4003)),
            "Expected Err(RunnerError::TokenRevoked4003), got: {run_res:?}"
        );

        let first_msg = tokio::time::timeout(Duration::from_secs(1), hello_rx.recv())
            .await
            .expect("BRIDGE_HELLO timeout")
            .expect("BRIDGE_HELLO payload");
        assert_eq!(
            first_msg.get("type").and_then(Value::as_str),
            Some("BRIDGE_HELLO")
        );
        assert_eq!(
            first_msg.get("deviceId").and_then(Value::as_str),
            Some("dev-explicit-01")
        );
        assert_eq!(
            first_msg.get("appVersion").and_then(Value::as_str),
            Some("0.1.0-cli")
        );
        assert_eq!(
            connect_counter.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "Agent must make exactly 1 connection attempt and never reconnect after 4003"
        );

        srv_task.abort();
    }

    #[tokio::test]
    async fn http_401_and_403_upgrade_rejection_terminate_agent_immediately_without_zombie() {
        for status_code in [StatusCode::FORBIDDEN, StatusCode::UNAUTHORIZED] {
            let hit_counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let hit_clone = Arc::clone(&hit_counter);

            let router = Router::new().route(
                "/api/bridge/ws",
                get(move || {
                    let cnt = Arc::clone(&hit_clone);
                    async move {
                        cnt.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        (status_code, "Token revoked or deleted")
                    }
                }),
            );

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let srv_task = tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });

            let cloud_url = format!("http://{addr}");
            let CliCommand::AgentRun(cli_args) = parse_cli_args([
                "agent",
                "run",
                "--cloud",
                &cloud_url,
                "--token",
                "nxc_tok_deleted_before_connect",
                "--project",
                "proj-http-reject",
                "--iface",
                "mock0",
                "--web",
                "127.0.0.1:0",
                "--no-auto-sync-dbc",
            ])
            .unwrap() else {
                panic!("expected AgentRun");
            };

            let eff_cfg = EffectiveAgentConfig::from_cli_and_optional_file(&cli_args).unwrap();
            let run_res =
                tokio::time::timeout(Duration::from_secs(3), run_agent_until_signal(eff_cfg))
                    .await
                    .expect(
                        "run_agent_until_signal must not hang on HTTP 401/403 upgrade rejection",
                    );

            assert!(
                matches!(run_res, Err(RunnerError::TokenRevoked4003)),
                "HTTP {status_code} must return Err(RunnerError::TokenRevoked4003), got: {run_res:?}"
            );
            assert_eq!(
                hit_counter.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "Agent must not retry after HTTP {status_code} upgrade rejection"
            );

            srv_task.abort();
        }
    }

    #[tokio::test]
    async fn offline_web_hmi_serves_live_mock0_frames_when_cloud_is_unreachable() {
        // Offline WAN simulation: privileged port 1 on loopback has no listener, so the Cloud WS
        // connect is refused. Do NOT bind-and-drop an ephemeral port here: the OS may hand that
        // port to a parallel test's server, and this agent's reconnect loop would then connect to
        // it (seen as a spurious second connection in the 4003 no-reconnect test).
        let offline_cloud_url = "http://127.0.0.1:1".to_string();

        let CliCommand::AgentRun(cli_args) = parse_cli_args([
            "agent",
            "run",
            "--cloud",
            &offline_cloud_url,
            "--token",
            "nxc_tok_offline_field_test",
            "--project",
            "proj-offline-field",
            "--iface",
            "mock0",
            "--web",
            "127.0.0.1:0",
            "--no-auto-sync-dbc",
        ])
        .unwrap() else {
            panic!("expected AgentRun");
        };

        let eff_cfg = EffectiveAgentConfig::from_cli_and_optional_file(&cli_args).unwrap();
        let handle = spawn_agent_runtime(eff_cfg).await.unwrap();
        let web_addr = handle.web_local_addr().expect("web addr bound");

        // Wait ~150ms for mock0 frames to populate SharedAgentState via local ingestor
        tokio::time::sleep(Duration::from_millis(160)).await;

        let live_url = format!("http://{web_addr}/api/live");
        let (code, body) = http_get_plain(&live_url).await.expect("GET /api/live");
        assert_eq!(code, 200);
        let live: AgentLiveSnapshotDto = serde_json::from_slice(&body).unwrap();
        assert!(!live.status.cloud_connected);
        assert!(live.status.listen_only);
        assert!(!live.status.tx_armed);
        assert!(
            !live.frames.is_empty(),
            "Local Edge Web HMI must show live mock0 CAN frames even when Cloud WS is offline"
        );

        let _ = handle.shutdown().await;
    }
}
