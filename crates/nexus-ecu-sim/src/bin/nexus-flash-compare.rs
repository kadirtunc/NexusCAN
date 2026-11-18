//! `nexus-flash-compare` — byte-for-byte comparison of a firmware source file
//! (Intel HEX / S-record / raw binary) with the simulator's memory image JSON.
//!
//! Exit codes: 0 = identical, 1 = mismatch (first mismatch address printed),
//! 2 = usage / parse error.

use std::path::PathBuf;

use clap::Parser;
use nexus_ecu_sim::config::parse_num;
use nexus_ecu_sim::firmware::{self, Format, SparseImage};
use nexus_ecu_sim::image;

#[derive(Parser, Debug)]
#[command(name = "nexus-flash-compare", version)]
struct Cli {
    /// Reference firmware file (.hex / .s19 / .s28 / .s37 / .srec / .bin).
    #[arg(long)]
    source: PathBuf,
    /// Memory image JSON written by nexus-ecu-sim.
    #[arg(long)]
    image: PathBuf,
    /// Force the source format (hex | srec | bin); default: detect.
    #[arg(long)]
    format: Option<Format>,
    /// Load address for raw binary sources.
    #[arg(long, value_parser = parse_num, default_value = "0")]
    base: u64,
}

fn main() {
    let cli = Cli::parse();
    let src = match firmware::load(&cli.source, cli.format, cli.base) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    let img = match image::load(&cli.image) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    let describe = |s: &SparseImage| {
        s.segments()
            .iter()
            .map(|g| format!("0x{:08X}+0x{:X}", g.address, g.data.len()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    println!("source: {} bytes [{}]", src.len(), describe(&src));
    println!("image : {} bytes [{}]", img.len(), describe(&img));
    match SparseImage::compare(&src, &img) {
        None => {
            println!("EQUAL: {} bytes match byte-for-byte", src.len());
        }
        Some(m) => {
            println!("MISMATCH: {m}");
            std::process::exit(1);
        }
    }
}
