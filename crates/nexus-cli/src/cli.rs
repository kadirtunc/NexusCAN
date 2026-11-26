//! Deterministic, zero-external-crate POSIX/GNU CLI parser and `dbc lint` engine
//! for the standalone `nexuscan` headless telemetry agent binary.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use nexus_netdb::{parse_and_compile, DiagnosticSeverity, ParseDiagnostic, ParseOptions};
use thiserror::Error;

pub use crate::cansub_selftest::CansubSelftestArgs;

/// Exact version string emitted by `nexuscan agent version` and `nexuscan --version`.
pub const CLI_VERSION: &str = "0.1.0-cli";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelpTopic {
    Root,
    Agent,
    AgentRun,
    Dbc,
    DbcLint,
    CansubSelftest,
}

impl HelpTopic {
    pub fn usage_text(self) -> &'static str {
        match self {
            Self::Root => {
                "NexusCAN Headless Field Telemetry Agent & Signal Database CLI (0.1.0-cli)\n\
                 \n\
                 USAGE:\n\
                 \x20 nexuscan <COMMAND> [OPTIONS]\n\
                 \n\
                 COMMANDS:\n\
                 \x20 agent run [FLAGS]       Start Listen-Only CAN/CAN-FD to NexusCANCloud telemetry bridge\n\
                 \x20 agent version           Print exact agent CLI version (0.1.0-cli)\n\
                 \x20 dbc lint <file.dbc|kcd> Parse, compile, and validate a Vector .dbc or Kayak .kcd file\n\
                 \x20 cansub-selftest <host>  CSS Electronics CANsub device acceptance test (JSON report)\n\
                 \n\
                 OPTIONS:\n\
                 \x20 -h, --help              Print help information\n\
                 \x20 -V, --version           Print version information\n"
            }
            Self::Agent => {
                "Manage the NexusCAN Headless Field Telemetry Agent\n\
                 \n\
                 USAGE:\n\
                 \x20 nexuscan agent <SUBCOMMAND> [FLAGS]\n\
                 \n\
                 SUBCOMMANDS:\n\
                 \x20 run       Connect CAN/CAN-FD adapter in strict Listen-Only mode and stream to NexusCANCloud\n\
                 \x20 version   Print exact agent CLI version (0.1.0-cli)\n\
                 \n\
                 OPTIONS:\n\
                 \x20 -h, --help   Print help information\n"
            }
            Self::AgentRun => {
                "Start the Listen-Only CAN/CAN-FD to NexusCANCloud telemetry bridge\n\
                 \n\
                 SAFETY INVARIANT:\n\
                 \x20 Hardware channels ALWAYS open with listen_only = true and tx_armed = false.\n\
                 \x20 Remote CAN TX and bus-arming commands are blocked at compile time and runtime.\n\
                 \n\
                 USAGE:\n\
                 \x20 nexuscan agent run [FLAGS]\n\
                 \x20 nexuscan agent run --config /etc/nexuscan/agent.toml --listen-only\n\
                 \n\
                 FLAGS:\n\
                 \x20 -c, --config <path>          Path to agent.toml configuration file\n\
                 \x20     --cloud <url>            NexusCANCloud HTTP base URL (e.g. http://localhost:3000)\n\
                 \x20     --ws <ws_url>            Optional explicit WebSocket bridge URL\n\
                 \x20     --token <nxc_tok_...>    Paired device API token (must start with nxc_tok_)\n\
                 \x20     --project <uuid>         Target NexusCANCloud project UUID\n\
                 \x20     --project-slug <slug>    Optional project slug metadata\n\
                 \x20     --device <id>            Optional explicit device ID (omit or 'auto' for token identity)\n\
                 \x20     --name <name>            Optional agent display name\n\
                 \x20     --hostname <host>        Optional hostname override\n\
                 \x20     --iface <iface>          CAN interface (mock0, can0, vcan0, /dev/ttyUSB0, ...)\n\
                 \x20     --bitrate <bps>          Nominal arbitration bitrate (default: 500000)\n\
                 \x20     --fd [true|false]        Enable CAN-FD mode (default: true; also accepts --no-fd)\n\
                 \x20     --dbitrate <bps>         CAN-FD data phase bitrate (default: 2000000)\n\
                 \x20     --dbc <path>             Optional local .dbc or .kcd signal database file\n\
                 \x20     --auto-sync-dbc [bool]   Auto-download active project DBC from Cloud (default: true)\n\
                 \x20     --web <ip:port>          Enable local read-only HTTP /api/status server (e.g. 127.0.0.1:8080)\n\
                 \x20     --no-web                 Disable local HTTP status server\n\
                 \x20     --listen-only [bool]     Passive bus observation flag (enforced true unconditionally)\n\
                 \x20     --require-hw-listen-only [bool]\n\
                 \x20                              Fail-closed: refuse to start if the CAN controller cannot be put\n\
                 \x20                              into hardware listen-only mode (no software-only fallback;\n\
                 \x20                              exits with EX_CONFIG 78, no retry). Default: false\n\
                 \x20 -h, --help                   Print help information\n"
            }
            Self::Dbc => {
                "Signal Database (.dbc / .kcd) Utilities\n\
                 \n\
                 USAGE:\n\
                 \x20 nexuscan dbc <SUBCOMMAND>\n\
                 \n\
                 SUBCOMMANDS:\n\
                 \x20 lint <file.dbc|kcd>   Validate syntax, bit spans, mux trees, and diagnostics\n\
                 \n\
                 OPTIONS:\n\
                 \x20 -h, --help            Print help information\n"
            }
            Self::DbcLint => {
                "Validate and compile a Vector CANdb++ (.dbc) or Kayak (.kcd) signal database\n\
                 \n\
                 USAGE:\n\
                 \x20 nexuscan dbc lint <file.dbc_or_kcd>\n\
                 \n\
                 EXIT CODES:\n\
                 \x20 0   Database parsed and compiled cleanly with zero error-severity diagnostics\n\
                 \x20 1   File I/O error, fatal parse/compile error, or any [ERROR] diagnostic\n"
            }
            Self::CansubSelftest => {
                "CSS Electronics CANsub.2 / CANsub.4 device acceptance test (JSON report on stdout)\n\
                 \n\
                 USAGE:\n\
                 \x20 nexuscan cansub-selftest <host> [FLAGS]\n\
                 \x20 nexuscan cansub-selftest 10.123.45.1 --device-id 1a2b3c4d --ch 1 --duration-s 30\n\
                 \n\
                 FLAGS:\n\
                 \x20     --device-id <8 hex>      Device ID; verified against the TLS certificate (host may be an IP)\n\
                 \x20     --accept-any             Without a Device ID: accept any genuine CANsub (CSS root)\n\
                 \x20     --ch <n>                 Channel under test, 1-based (default: 1)\n\
                 \x20     --duration-s <s>         Listen-only RX duration in seconds (default: 30)\n\
                 \x20     --bitrate <bps>          Nominal bitrate (default: 500000)\n\
                 \x20     --data-bitrate <bps>     CAN-FD data bitrate (default: 2000000)\n\
                 \x20     --fd                     Configure CAN-FD timing\n\
                 \x20     --tx-loopback <rx_ch>    ACTIVE TX: switch <ch> out of listen-only, send 100 frames\n\
                 \x20                              (ID 0x7E0..0x7FF) and receive them on <rx_ch> (same bus).\n\
                 \x20                              <ch> is returned to listen-only afterwards.\n\
                 \x20 -h, --help                   Print help information\n\
                 \n\
                 EXIT CODES:\n\
                 \x20 0   All checks passed\n\
                 \x20 1   A check failed (RX error, loopback loss, invalid timing, ...)\n\
                 \x20 2   Connection / TLS / API version failure\n"
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentRunArgs {
    pub config_path: Option<PathBuf>,
    pub cloud_url: Option<String>,
    pub ws_bridge_url: Option<String>,
    pub token: Option<String>,
    pub project_id: Option<String>,
    pub project_slug: Option<String>,
    pub device_id: Option<String>,
    pub agent_name: Option<String>,
    pub hostname: Option<String>,
    pub interface: Option<String>,
    pub bitrate: Option<u32>,
    pub enable_fd: Option<bool>,
    pub data_bitrate: Option<u32>,
    pub dbc_path: Option<PathBuf>,
    pub auto_sync_dbc: Option<bool>,
    pub web_bind: Option<String>,
    pub web_disabled: bool,
    pub listen_only: Option<bool>,
    /// `--require-hw-listen-only [bool]` (fail-closed hardware Listen-Only, WP-5).
    pub require_hw_listen_only: Option<bool>,
}

// One-shot parse result, built once per process: the size gap between variants is irrelevant.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CliCommand {
    Version,
    Help(HelpTopic),
    DbcLint { path: PathBuf },
    AgentRun(AgentRunArgs),
    CansubSelftest(CansubSelftestArgs),
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum CliError {
    #[error("{0}")]
    MissingSubcommand(String),

    #[error("Unknown command or subcommand '{0}'. Run 'nexuscan --help' for usage.")]
    UnknownCommand(String),

    #[error("Unknown flag '{flag}'. Run '{help_cmd}' for supported flags.")]
    UnknownFlag {
        flag: String,
        help_cmd: &'static str,
    },

    #[error("Flag '{0}' requires a value")]
    MissingFlagValue(String),

    #[error("Invalid value '{value}' for flag '{flag}': expected {expected}")]
    InvalidFlagValue {
        flag: String,
        value: String,
        expected: &'static str,
    },

    #[error("{0}")]
    PositionalArgumentError(String),
}

/// Parses process arguments from `std::env::args()` (skipping `argv[0]`).
pub fn parse_env_args() -> Result<CliCommand, CliError> {
    parse_cli_args(std::env::args().skip(1))
}

/// Parses an iterator of CLI tokens (excluding `argv[0]`) into a typed [`CliCommand`].
pub fn parse_cli_args<I, S>(args: I) -> Result<CliCommand, CliError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let tokens: Vec<String> = args.into_iter().map(|s| s.as_ref().to_string()).collect();
    if tokens.is_empty() {
        return Err(CliError::MissingSubcommand(
            "No command provided. Expected 'agent' or 'dbc' (run 'nexuscan --help' for usage)."
                .to_string(),
        ));
    }

    match tokens[0].as_str() {
        "-h" | "--help" | "help" => Ok(CliCommand::Help(HelpTopic::Root)),
        "-V" | "--version" | "version" => Ok(CliCommand::Version),
        "agent" => parse_agent_subcommand(&tokens[1..]),
        "dbc" => parse_dbc_subcommand(&tokens[1..]),
        "cansub-selftest" => parse_cansub_selftest_args(&tokens[1..]),
        other if other.starts_with('-') => Err(CliError::UnknownFlag {
            flag: other.to_string(),
            help_cmd: "nexuscan --help",
        }),
        other => Err(CliError::UnknownCommand(other.to_string())),
    }
}

fn parse_agent_subcommand(tokens: &[String]) -> Result<CliCommand, CliError> {
    if tokens.is_empty() {
        return Err(CliError::MissingSubcommand(
            "Missing subcommand after 'nexuscan agent'. Expected 'run' or 'version'.".to_string(),
        ));
    }

    match tokens[0].as_str() {
        "-h" | "--help" | "help" => Ok(CliCommand::Help(HelpTopic::Agent)),
        "version" | "-V" | "--version" => {
            // Only the first extra token matters: help wins, anything else is an error.
            match tokens.get(1).map(String::as_str) {
                None => Ok(CliCommand::Version),
                Some("-h" | "--help") => Ok(CliCommand::Help(HelpTopic::Agent)),
                Some(other) => Err(CliError::PositionalArgumentError(format!(
                    "Unexpected argument '{other}' after 'nexuscan agent version'"
                ))),
            }
        }
        "run" => parse_agent_run_flags(&tokens[1..]),
        other if other.starts_with('-') => Err(CliError::UnknownFlag {
            flag: other.to_string(),
            help_cmd: "nexuscan agent --help",
        }),
        other => Err(CliError::UnknownCommand(format!("agent {other}"))),
    }
}

fn parse_dbc_subcommand(tokens: &[String]) -> Result<CliCommand, CliError> {
    if tokens.is_empty() {
        return Err(CliError::MissingSubcommand(
            "Missing subcommand after 'nexuscan dbc'. Expected 'lint <file>'.".to_string(),
        ));
    }

    match tokens[0].as_str() {
        "-h" | "--help" | "help" => Ok(CliCommand::Help(HelpTopic::Dbc)),
        "lint" => parse_dbc_lint_args(&tokens[1..]),
        other if other.starts_with('-') => Err(CliError::UnknownFlag {
            flag: other.to_string(),
            help_cmd: "nexuscan dbc --help",
        }),
        other => Err(CliError::UnknownCommand(format!("dbc {other}"))),
    }
}

fn parse_dbc_lint_args(tokens: &[String]) -> Result<CliCommand, CliError> {
    let mut file_path: Option<PathBuf> = None;
    let mut positional_only = false;

    for tok in tokens {
        if !positional_only {
            if tok == "--" {
                positional_only = true;
                continue;
            }
            if tok == "-h" || tok == "--help" {
                return Ok(CliCommand::Help(HelpTopic::DbcLint));
            }
            if tok.starts_with('-') {
                return Err(CliError::UnknownFlag {
                    flag: tok.clone(),
                    help_cmd: "nexuscan dbc lint --help",
                });
            }
        }

        if file_path.is_some() {
            return Err(CliError::PositionalArgumentError(format!(
                "Unexpected extra argument '{tok}'; 'nexuscan dbc lint' accepts exactly one <file.dbc_or_kcd> path"
            )));
        }
        file_path = Some(PathBuf::from(tok));
    }

    match file_path {
        Some(path) => Ok(CliCommand::DbcLint { path }),
        None => Err(CliError::PositionalArgumentError(
            "Missing required <file.dbc_or_kcd> path for 'nexuscan dbc lint'".to_string(),
        )),
    }
}

fn parse_agent_run_flags(tokens: &[String]) -> Result<CliCommand, CliError> {
    let mut out = AgentRunArgs::default();
    let mut idx = 0usize;

    while idx < tokens.len() {
        let raw = &tokens[idx];
        idx += 1;

        if raw == "-h" || raw == "--help" {
            return Ok(CliCommand::Help(HelpTopic::AgentRun));
        }

        if !raw.starts_with('-') || raw == "-" {
            return Err(CliError::PositionalArgumentError(format!(
                "Unexpected positional argument '{raw}' in 'nexuscan agent run'"
            )));
        }

        let (flag_name, inline_val) = match raw.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (raw.as_str(), None),
        };

        match flag_name {
            "-c" | "--config" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.config_path = Some(PathBuf::from(val));
            }
            "--cloud" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.cloud_url = Some(val);
            }
            "--ws" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.ws_bridge_url = Some(val);
            }
            "--token" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.token = Some(val);
            }
            "--project" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.project_id = Some(val);
            }
            "--project-slug" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.project_slug = Some(val);
            }
            "--device" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.device_id = Some(val);
            }
            "--name" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.agent_name = Some(val);
            }
            "--hostname" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.hostname = Some(val);
            }
            "--iface" | "--interface" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.interface = Some(val);
            }
            "--bitrate" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                let parsed = val.parse::<u32>().map_err(|_| CliError::InvalidFlagValue {
                    flag: flag_name.to_string(),
                    value: val,
                    expected: "positive integer bps (e.g. 500000)",
                })?;
                out.bitrate = Some(parsed);
            }
            "--dbitrate" | "--data-bitrate" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                let parsed = val.parse::<u32>().map_err(|_| CliError::InvalidFlagValue {
                    flag: flag_name.to_string(),
                    value: val,
                    expected: "positive integer bps (e.g. 2000000)",
                })?;
                out.data_bitrate = Some(parsed);
            }
            "--fd" => {
                let b = take_dual_form_bool(flag_name, inline_val, tokens, &mut idx)?;
                out.enable_fd = Some(b);
            }
            "--no-fd" => {
                if let Some(v) = inline_val {
                    return Err(CliError::InvalidFlagValue {
                        flag: flag_name.to_string(),
                        value: v.to_string(),
                        expected: "no value (use --fd=true or --fd=false for explicit boolean)",
                    });
                }
                out.enable_fd = Some(false);
            }
            "--listen-only" => {
                let b = take_dual_form_bool(flag_name, inline_val, tokens, &mut idx)?;
                out.listen_only = Some(b);
            }
            "--require-hw-listen-only" => {
                let b = take_dual_form_bool(flag_name, inline_val, tokens, &mut idx)?;
                out.require_hw_listen_only = Some(b);
            }
            "--auto-sync-dbc" => {
                let b = take_dual_form_bool(flag_name, inline_val, tokens, &mut idx)?;
                out.auto_sync_dbc = Some(b);
            }
            "--no-auto-sync-dbc" => {
                if let Some(v) = inline_val {
                    return Err(CliError::InvalidFlagValue {
                        flag: flag_name.to_string(),
                        value: v.to_string(),
                        expected: "no value",
                    });
                }
                out.auto_sync_dbc = Some(false);
            }
            "--dbc" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.dbc_path = Some(PathBuf::from(val));
            }
            "--web" => {
                let val = take_required_value(flag_name, inline_val, tokens, &mut idx)?;
                out.web_bind = Some(val);
                out.web_disabled = false;
            }
            "--no-web" => {
                if let Some(v) = inline_val {
                    return Err(CliError::InvalidFlagValue {
                        flag: flag_name.to_string(),
                        value: v.to_string(),
                        expected: "no value",
                    });
                }
                out.web_disabled = true;
                out.web_bind = None;
            }
            _ => {
                return Err(CliError::UnknownFlag {
                    flag: flag_name.to_string(),
                    help_cmd: "nexuscan agent run --help",
                });
            }
        }
    }

    Ok(CliCommand::AgentRun(out))
}

fn parse_u32_flag(flag: &str, val: &str, expected: &'static str) -> Result<u32, CliError> {
    val.parse::<u32>().map_err(|_| CliError::InvalidFlagValue {
        flag: flag.to_string(),
        value: val.to_string(),
        expected,
    })
}

fn parse_channel_flag(flag: &str, val: &str) -> Result<u8, CliError> {
    val.parse::<u8>()
        .ok()
        .filter(|c| (1..=4).contains(c))
        .ok_or_else(|| CliError::InvalidFlagValue {
            flag: flag.to_string(),
            value: val.to_string(),
            expected: "channel number 1..=4",
        })
}

fn parse_cansub_selftest_args(tokens: &[String]) -> Result<CliCommand, CliError> {
    const HELP: &str = "nexuscan cansub-selftest --help";
    let mut out = CansubSelftestArgs::default();
    let mut host: Option<String> = None;
    let mut idx = 0usize;
    while idx < tokens.len() {
        let raw = &tokens[idx];
        idx += 1;
        if raw == "-h" || raw == "--help" {
            return Ok(CliCommand::Help(HelpTopic::CansubSelftest));
        }
        if !raw.starts_with('-') {
            if host.is_some() {
                return Err(CliError::PositionalArgumentError(format!(
                    "Unexpected extra positional argument '{raw}' in 'nexuscan cansub-selftest'"
                )));
            }
            host = Some(raw.clone());
            continue;
        }
        let (flag, inline_val) = match raw.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (raw.as_str(), None),
        };
        match flag {
            "--device-id" => {
                let v = take_required_value(flag, inline_val, tokens, &mut idx)?;
                let v = v.trim().to_ascii_lowercase();
                if v.len() != 8 || !v.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(CliError::InvalidFlagValue {
                        flag: flag.to_string(),
                        value: v,
                        expected: "8 hex digits (e.g. 1a2b3c4d)",
                    });
                }
                out.device_id = Some(v);
            }
            "--accept-any" => out.accept_any = true,
            "--fd" => out.fd = true,
            "--ch" => {
                let v = take_required_value(flag, inline_val, tokens, &mut idx)?;
                out.channel = parse_channel_flag(flag, &v)?;
            }
            "--tx-loopback" => {
                let v = take_required_value(flag, inline_val, tokens, &mut idx)?;
                out.tx_loopback = Some(parse_channel_flag(flag, &v)?);
            }
            "--duration-s" => {
                let v = take_required_value(flag, inline_val, tokens, &mut idx)?;
                let d = parse_u32_flag(flag, &v, "seconds 1..=86400")?;
                if !(1..=86_400).contains(&d) {
                    return Err(CliError::InvalidFlagValue {
                        flag: flag.to_string(),
                        value: v,
                        expected: "seconds 1..=86400",
                    });
                }
                out.duration_s = d;
            }
            "--bitrate" => {
                let v = take_required_value(flag, inline_val, tokens, &mut idx)?;
                out.bitrate = parse_u32_flag(flag, &v, "bitrate in bit/s (e.g. 500000)")?;
            }
            "--data-bitrate" | "--dbitrate" => {
                let v = take_required_value(flag, inline_val, tokens, &mut idx)?;
                out.data_bitrate = parse_u32_flag(flag, &v, "bitrate in bit/s (e.g. 2000000)")?;
            }
            _ => {
                return Err(CliError::UnknownFlag {
                    flag: flag.to_string(),
                    help_cmd: HELP,
                })
            }
        }
    }
    out.host = host.ok_or_else(|| {
        CliError::PositionalArgumentError(
            "Missing <host> for 'nexuscan cansub-selftest' (e.g. 10.123.45.1 or 1a2b3c4d-usb.local)"
                .to_string(),
        )
    })?;
    if out.tx_loopback == Some(out.channel) {
        return Err(CliError::InvalidFlagValue {
            flag: "--tx-loopback".to_string(),
            value: out.channel.to_string(),
            expected: "an RX channel different from --ch",
        });
    }
    Ok(CliCommand::CansubSelftest(out))
}

fn take_required_value(
    flag_name: &str,
    inline_val: Option<&str>,
    tokens: &[String],
    idx: &mut usize,
) -> Result<String, CliError> {
    if let Some(v) = inline_val {
        return Ok(v.to_string());
    }
    if *idx >= tokens.len() {
        return Err(CliError::MissingFlagValue(flag_name.to_string()));
    }
    let next = &tokens[*idx];
    // Guard against accidentally consuming another long flag when user forgot value (e.g. `--token --iface mock0`)
    if next == "-h" || next == "--help" || next.starts_with("--") {
        return Err(CliError::MissingFlagValue(flag_name.to_string()));
    }
    *idx += 1;
    Ok(next.clone())
}

fn take_dual_form_bool(
    flag_name: &str,
    inline_val: Option<&str>,
    tokens: &[String],
    idx: &mut usize,
) -> Result<bool, CliError> {
    if let Some(v) = inline_val {
        return parse_bool_literal(v).ok_or_else(|| CliError::InvalidFlagValue {
            flag: flag_name.to_string(),
            value: v.to_string(),
            expected: "true|false|1|0|yes|no",
        });
    }

    // Bare flag: peek next token if present
    if let Some(next) = tokens.get(*idx) {
        if next.starts_with('-') {
            // Followed immediately by another flag (e.g. `--fd --dbitrate 2000000`) -> bare true!
            return Ok(true);
        }
        return match parse_bool_literal(next) {
            Some(b) => {
                *idx += 1;
                Ok(b)
            }
            None => Err(CliError::InvalidFlagValue {
                flag: flag_name.to_string(),
                value: next.clone(),
                expected: "true|false|1|0|yes|no (or omit value before next --flag)",
            }),
        };
    }

    // Bare flag at end of argument list -> true
    Ok(true)
}

fn parse_bool_literal(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Some(true),
        "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

/// Structured result of running `nexuscan dbc lint` on raw `.dbc` / `.kcd` bytes.
#[derive(Clone, Debug)]
pub struct DbcLintReport {
    pub exit_code: i32,
    pub database_name: Option<String>,
    pub format: Option<String>,
    pub source_encoding: Option<String>,
    pub ecu_count: usize,
    pub message_count: usize,
    pub signal_count: usize,
    pub error_diagnostics: usize,
    pub warning_diagnostics: usize,
    pub info_diagnostics: usize,
    pub diagnostics: Vec<ParseDiagnostic>,
    pub fatal_error: Option<String>,
}

/// Parses and compiles raw `.dbc` or `.kcd` bytes and builds a deterministic [`DbcLintReport`].
pub fn lint_database_bytes(bytes: &[u8], file_name: &str) -> DbcLintReport {
    match parse_and_compile(bytes, Some(file_name), &ParseOptions::default()) {
        Ok((_compiled, schema)) => {
            let mut diagnostics = schema.info.diagnostics;
            if schema.messages.is_empty()
                && schema.signals.is_empty()
                && schema.ecus.is_empty()
                && schema.info.version.is_none()
            {
                diagnostics.push(ParseDiagnostic::error(
                    "UNRECOGNIZED_OR_EMPTY_SCHEMA",
                    "Input contains no valid DBC/KCD header, ECU nodes, messages, or signals",
                    None,
                    None,
                    None,
                ));
            }

            let mut err_cnt = 0usize;
            let mut warn_cnt = 0usize;
            let mut info_cnt = 0usize;
            for d in &diagnostics {
                match d.severity {
                    DiagnosticSeverity::Error => err_cnt += 1,
                    DiagnosticSeverity::Warning => warn_cnt += 1,
                    DiagnosticSeverity::Info => info_cnt += 1,
                }
            }
            let exit_code = if err_cnt > 0 { 1 } else { 0 };
            DbcLintReport {
                exit_code,
                database_name: Some(schema.info.name),
                format: Some(schema.info.format),
                source_encoding: Some(schema.info.source_encoding),
                ecu_count: schema.ecus.len(),
                message_count: schema.messages.len(),
                signal_count: schema.signals.len(),
                error_diagnostics: err_cnt,
                warning_diagnostics: warn_cnt,
                info_diagnostics: info_cnt,
                diagnostics,
                fatal_error: None,
            }
        }
        Err(err) => DbcLintReport {
            exit_code: 1,
            database_name: None,
            format: None,
            source_encoding: None,
            ecu_count: 0,
            message_count: 0,
            signal_count: 0,
            error_diagnostics: 1,
            warning_diagnostics: 0,
            info_diagnostics: 0,
            diagnostics: Vec::new(),
            fatal_error: Some(err.to_string()),
        },
    }
}

/// Executes `nexuscan dbc lint <path>`, writing human-readable summary & diagnostics,
/// and returning process exit code (`0` clean/warnings-only, `1` on I/O, parse, or `[ERROR]` diagnostic).
pub fn execute_dbc_lint(path: &Path, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            let _ = writeln!(
                stderr,
                "[ERROR] IO_READ_FAILED: Could not read '{}': {e}",
                path.display()
            );
            return 1;
        }
    };

    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("input.dbc");

    let report = lint_database_bytes(&bytes, file_name);
    if let Some(fatal) = &report.fatal_error {
        let _ = writeln!(
            stderr,
            "[ERROR] PARSE_COMPILE_FAILED ({}): {fatal}",
            path.display()
        );
        return 1;
    }

    let _ = writeln!(
        stdout,
        "Database:        {}",
        report.database_name.as_deref().unwrap_or(file_name)
    );
    let _ = writeln!(
        stdout,
        "Format:          {}",
        report.format.as_deref().unwrap_or("Unknown")
    );
    let _ = writeln!(
        stdout,
        "Source Encoding: {}",
        report.source_encoding.as_deref().unwrap_or("UTF-8")
    );
    let _ = writeln!(stdout, "ECU Nodes:       {}", report.ecu_count);
    let _ = writeln!(stdout, "Messages:        {}", report.message_count);
    let _ = writeln!(stdout, "Total Signals:   {}", report.signal_count);
    let _ = writeln!(
        stdout,
        "Diagnostics:     {} error(s), {} warning(s), {} info",
        report.error_diagnostics, report.warning_diagnostics, report.info_diagnostics
    );

    for diag in &report.diagnostics {
        let tag = match diag.severity {
            DiagnosticSeverity::Error => "[ERROR]",
            DiagnosticSeverity::Warning => "[WARN]",
            DiagnosticSeverity::Info => "[INFO]",
        };
        let loc = match (diag.line, diag.column) {
            (Some(l), Some(c)) => format!(" (line {l}, col {c})"),
            (Some(l), None) => format!(" (line {l})"),
            _ => String::new(),
        };
        let ctx = diag
            .context
            .as_deref()
            .map(|c| format!(" [{c}]"))
            .unwrap_or_default();
        let _ = writeln!(stdout, "  {tag} {}{loc}{ctx}: {}", diag.code, diag.message);
    }

    if report.exit_code == 0 {
        let _ = writeln!(stdout, "Result:          OK");
    } else {
        let _ = writeln!(
            stderr,
            "Result:          FAILED ({} error diagnostic(s))",
            report.error_diagnostics
        );
    }

    report.exit_code
}
