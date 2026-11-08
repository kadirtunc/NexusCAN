//! Standalone headless field telemetry agent binary (`nexuscan`).

#![forbid(unsafe_code)]

use std::io;
use std::process::ExitCode;

use nexus_cli::{
    dispatch_sync_command, parse_env_args, run_agent_until_signal, CliCommand,
    EffectiveAgentConfig, RunnerError,
};

/// POSIX / `sysexits.h` `EX_CONFIG` (`78`) matching systemd `RestartPreventExitStatus=78`
/// so a revoked or deleted `NexusCANCloud` device token terminates cleanly without restart loops.
pub const EXIT_CODE_EX_CONFIG: u8 = nexus_cli::EXIT_CODE_EX_CONFIG;

fn main() -> ExitCode {
    let cmd = match parse_env_args() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Error: {err}");
            return ExitCode::from(1);
        }
    };

    let mut stdout = io::stdout();
    let mut stderr = io::stderr();
    if let Some(code) = dispatch_sync_command(&cmd, &mut stdout, &mut stderr) {
        return if code == 0 {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(code.clamp(1, 255) as u8)
        };
    }

    let CliCommand::AgentRun(run_args) = cmd else {
        return ExitCode::SUCCESS;
    };

    let effective_cfg = match EffectiveAgentConfig::from_cli_and_optional_file(&run_args) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("Configuration error: {err}");
            return ExitCode::from(1);
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("nexuscan-agent")
        .build()
    {
        Ok(r) => r,
        Err(err) => {
            eprintln!("Failed to initialize Tokio async runtime: {err}");
            return ExitCode::from(1);
        }
    };

    match rt.block_on(run_agent_until_signal(effective_cfg)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(RunnerError::TokenRevoked4003) => {
            eprintln!(
                "Agent terminated with EX_CONFIG ({EXIT_CODE_EX_CONFIG}): device token revoked or forbidden."
            );
            ExitCode::from(EXIT_CODE_EX_CONFIG)
        }
        Err(err) => {
            eprintln!("Agent runtime error: {err}");
            ExitCode::from(1)
        }
    }
}
