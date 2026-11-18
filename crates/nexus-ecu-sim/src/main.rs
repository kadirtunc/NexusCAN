//! `nexus-ecu-sim` — independent UDS bootloader ECU simulator (Linux only).

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!(
        "nexus-ecu-sim requires Linux (kernel CAN_ISOTP socket). \
         Run it on Linux / WSL2 (vcan0) or on the BeagleBone Black (can1)."
    );
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
fn main() {
    linux::main();
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::PathBuf;

    use clap::Parser;
    use nexus_ecu_sim::config::{
        check_regions, parse_optional_id, parse_region, parse_u32, parse_u8, OptionalId,
    };
    use nexus_ecu_sim::faults::Fault;
    use nexus_ecu_sim::isotp::IsoTpOptions;
    use nexus_ecu_sim::log::{LogFormat, Logger};
    use nexus_ecu_sim::runtime::{self, RuntimeConfig};
    use nexus_ecu_sim::seed::SeedAlgo;
    use nexus_ecu_sim::server::{Server, ServerConfig};

    /// Independent ISO 14229-1 bootloader ECU simulator over the Linux kernel
    /// ISO-TP socket (HIL target for the NexusCAN flasher).
    #[derive(Parser, Debug)]
    #[command(name = "nexus-ecu-sim", version)]
    struct Cli {
        /// SocketCAN interface (vcan0, can0, can1 on the BeagleBone Black).
        #[arg(long, default_value = "vcan0")]
        iface: String,
        /// Physical request CAN ID (tester -> ECU).
        #[arg(long, value_parser = parse_u32, default_value = "0x7E0")]
        rx: u32,
        /// Response CAN ID (ECU -> tester).
        #[arg(long, value_parser = parse_u32, default_value = "0x7E8")]
        tx: u32,
        /// Use 29-bit CAN identifiers.
        #[arg(long)]
        extended: bool,
        /// Functional request CAN ID (single frames only, answered on --tx);
        /// `off` disables functional addressing.
        #[arg(long, value_parser = parse_optional_id, default_value = "0x7DF")]
        functional: OptionalId,
        /// Pad transmitted CAN frames with this byte (e.g. 0xAA).
        #[arg(long, value_parser = parse_u8)]
        padding: Option<u8>,
        /// STmin requested from the tester in our FlowControl frames (µs).
        #[arg(long, default_value_t = 0)]
        stmin: u32,
        /// BlockSize requested from the tester in our FlowControl frames.
        #[arg(long, default_value_t = 0)]
        bs: u8,
        /// CAN FD link layer (64-byte frames). Not available on BBB DCAN.
        #[arg(long)]
        fd: bool,
        /// Memory image JSON written on RequestTransferExit and on exit.
        #[arg(long, default_value = "flash_image.json")]
        image_out: PathBuf,
        /// Flash region ADDRESS:LENGTH (repeatable). Default 0x08000000:0x80000.
        #[arg(long = "mem-region", value_parser = parse_region)]
        mem_region: Vec<(u32, u32)>,
        /// maxNumberOfBlockLength reported in 0x74 (includes SID + counter).
        #[arg(long, value_parser = parse_u32, default_value = "0x402")]
        max_block_len: u32,
        /// Seed/key algorithm: xor_ff | xor_const[:HEX].
        #[arg(long, default_value = "xor_ff")]
        seed_algo: SeedAlgo,
        /// P2server_max reported in 0x50 (ms).
        #[arg(long, default_value_t = 50)]
        p2: u16,
        /// P2*server_max reported in 0x50 (ms, 10 ms resolution).
        #[arg(long, default_value_t = 5000)]
        p2star: u32,
        /// S3server session timeout (ms).
        #[arg(long, default_value_t = 5000)]
        s3: u64,
        /// Fault injection spec (repeatable), see `faults` module docs.
        #[arg(long = "fault")]
        faults: Vec<Fault>,
        /// Log format: text | jsonl | off (to stderr or --log-file).
        #[arg(long, default_value = "text")]
        log: LogFormat,
        /// Write the log to this file instead of stderr.
        #[arg(long)]
        log_file: Option<PathBuf>,
        /// Allow Default -> Programming session directly.
        #[arg(long)]
        allow_direct_programming: bool,
        /// Simulated reboot time after ECUReset (ms); the ECU is silent meanwhile.
        #[arg(long, alias = "reset-ms", default_value_t = 200)]
        reboot_ms: u64,
        /// Bootloader jump: silence after a 0x10 0x02 that enters the
        /// Programming session (ms, 0 = none).
        #[arg(long, default_value_t = 300)]
        boot_jump_ms: u64,
        /// DID 0xF189 (ECU software version) before a successful flash.
        #[arg(long, default_value = "SW 1.0.0")]
        sw_version: String,
        /// DID 0xF189 after a successful flash (0202 + FF01 OK) and ECUReset.
        #[arg(long, default_value = "SW 1.1.0")]
        new_sw_version: String,
        /// Read the new 0xF189 from the flashed image at this address
        /// (printable ASCII, NUL/0xFF terminated, max 32 bytes); falls back
        /// to --new-sw-version.
        #[arg(long, value_parser = parse_u32)]
        sw_version_addr: Option<u32>,
        /// DID 0xF191 (ECU hardware number).
        #[arg(long, default_value = "HW-NX-01")]
        hw_number: String,
        /// eraseMemory duration (ms); overridden by --fault erase-time:<ms>.
        #[arg(long, default_value_t = 250)]
        erase_ms: u64,
        /// Failed sendKey attempts before NRC 0x36 + lockout.
        #[arg(long, default_value_t = 3)]
        max_attempts: u8,
        /// SecurityAccess lockout delay after exceeded attempts (ms).
        #[arg(long, default_value_t = 10_000)]
        lockout_ms: u64,
        /// Security level (requestSeed sub-function) required for erase/download.
        #[arg(long, value_parser = parse_u8, default_value = "0x11")]
        download_level: u8,
    }

    pub fn main() {
        let cli = Cli::parse();
        let regions = if cli.mem_region.is_empty() {
            vec![(0x0800_0000, 0x8_0000)]
        } else {
            cli.mem_region.clone()
        };
        if let Err(e) = check_regions(&regions) {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
        if cli.max_block_len < 3 {
            eprintln!("error: --max-block-len must be >= 3");
            std::process::exit(2);
        }
        let out: Box<dyn std::io::Write + Send> = match &cli.log_file {
            Some(p) => match std::fs::File::create(p) {
                Ok(f) => Box::new(f),
                Err(e) => {
                    eprintln!("error: {}: {e}", p.display());
                    std::process::exit(2);
                }
            },
            None => Box::new(std::io::stderr()),
        };
        let server = Server::new(ServerConfig {
            regions,
            max_block_len: cli.max_block_len,
            seed_algo: cli.seed_algo,
            p2_ms: cli.p2,
            p2star_ms: cli.p2star,
            s3_ms: cli.s3,
            allow_direct_programming: cli.allow_direct_programming,
            faults: cli.faults.clone(),
            reboot_ms: cli.reboot_ms,
            erase_ms: cli.erase_ms,
            max_attempts: cli.max_attempts.max(1),
            lockout_ms: cli.lockout_ms,
            download_level: cli.download_level,
            boot_jump_ms: cli.boot_jump_ms,
            sw_version: cli.sw_version.clone(),
            new_sw_version: cli.new_sw_version.clone(),
            sw_version_addr: cli.sw_version_addr,
            hw_number: cli.hw_number.clone(),
        });
        let rt = RuntimeConfig {
            iface: cli.iface.clone(),
            rx_id: cli.rx,
            tx_id: cli.tx,
            functional_id: cli.functional.0,
            isotp: IsoTpOptions {
                padding: cli.padding,
                stmin_us: cli.stmin,
                block_size: cli.bs,
                extended: cli.extended,
                fd: cli.fd,
                sf_broadcast: false,
            },
            image_out: cli.image_out.clone(),
        };
        runtime::install_signal_handlers();
        if let Err(e) = runtime::run(rt, server, Logger::new(cli.log, out)) {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
