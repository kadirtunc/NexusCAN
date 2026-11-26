//! `cansub-sim` — CANsub.2 / CANsub.4 device emulator (contract cansub-v1 §5).
//!
//! ```text
//! cansub-sim --channels 2|4 --device-id <8 hex> --bind 127.0.0.1:8443
//!            --source mock|silent|replay:<candump.log> --fps N
//!            [--split-ws] [--corrupt-crc P] [--garbage P] [--inject-errors] [--seed N]
//!            [--ca-out <root-ca.pem>] [--duration <seconds>]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use cansub::sim::{SimConfig, SimHandle, SimSource};

const USAGE: &str = "usage: cansub-sim --channels 2|4 --device-id <8 hex> --bind <addr:port> \
--source mock|silent|replay:<file> --fps N [--split-ws] [--corrupt-crc P] [--garbage P] \
[--inject-errors] [--seed N] [--ca-out <path>] [--duration <s>]";

struct Args {
    cfg: SimConfig,
    ca_out: Option<PathBuf>,
    duration: Option<Duration>,
}

fn value<'a>(it: &mut impl Iterator<Item = &'a String>, flag: &str) -> Result<&'a String, String> {
    it.next().ok_or_else(|| format!("{flag} needs a value"))
}

fn num<T: std::str::FromStr>(s: &str, flag: &str) -> Result<T, String> {
    s.parse()
        .map_err(|_| format!("{flag}: invalid value {s:?}"))
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut cfg = SimConfig::default();
    let mut source = String::from("mock");
    let mut fps: u32 = 1000;
    let mut ca_out = None;
    let mut duration = None;
    let mut it = argv.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--channels" => cfg.channels = num(value(&mut it, flag)?, flag)?,
            "--device-id" => cfg.device_id = value(&mut it, flag)?.clone(),
            "--bind" => cfg.bind = num(value(&mut it, flag)?, flag)?,
            "--source" => source = value(&mut it, flag)?.clone(),
            "--fps" => fps = num(value(&mut it, flag)?, flag)?,
            "--split-ws" => cfg.chaos.split_ws = true,
            "--corrupt-crc" => cfg.chaos.corrupt_crc = num(value(&mut it, flag)?, flag)?,
            "--garbage" => cfg.chaos.garbage = num(value(&mut it, flag)?, flag)?,
            "--inject-errors" => cfg.chaos.inject_errors = true,
            "--seed" => cfg.chaos.seed = num(value(&mut it, flag)?, flag)?,
            "--ca-out" => ca_out = Some(PathBuf::from(value(&mut it, flag)?)),
            "--duration" => {
                duration = Some(Duration::from_secs_f64(num(value(&mut it, flag)?, flag)?))
            }
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    cfg.source = match source.as_str() {
        "mock" => SimSource::Mock { fps },
        "silent" => SimSource::Silent,
        s if s.starts_with("replay:") => SimSource::Replay(PathBuf::from(&s["replay:".len()..])),
        s if s.starts_with("vcan") || s.starts_with("can") => {
            return Err(format!(
                "--source {s}: live SocketCAN sources are out of scope for cansub-sim v1; \
                 record with `candump -L {s} > bus.log` and use --source replay:bus.log"
            ))
        }
        s => {
            return Err(format!(
                "--source: unknown source {s:?} (mock|silent|replay:<file>)"
            ))
        }
    };
    Ok(Args {
        cfg,
        ca_out,
        duration,
    })
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse(&argv) {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("cansub-sim: {e}");
            }
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let channels = args.cfg.channels;
    let id = args.cfg.device_id.clone();
    let sim = match SimHandle::start(args.cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cansub-sim: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(path) = &args.ca_out {
        if let Err(e) = std::fs::write(path, sim.root_ca_pem()) {
            eprintln!("cansub-sim: cannot write {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!("cansub-sim: test root CA written to {}", path.display());
    }
    println!(
        "cansub-sim: CANsub.{channels} emulator listening on https://{} (SNI {id}-usb.local / {id}-eth.local)",
        sim.addr()
    );
    match args.duration {
        Some(d) => std::thread::sleep(d),
        None => loop {
            std::thread::park();
        },
    }
    sim.stop();
    ExitCode::SUCCESS
}
