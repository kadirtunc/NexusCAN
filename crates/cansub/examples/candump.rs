//! Prints received frames like `candump -L` (listen-only, no TX).
//!
//! ```text
//! cargo run -p cansub-rs --features blocking --example candump -- <host> <device_id> [channel]
//! ```

use std::time::Duration;

use cansub::proto::{Event, FrameFlags};
use cansub::{ConnectOptions, Device, PhyConfig};

fn main() -> Result<(), cansub::Error> {
    let mut args = std::env::args().skip(1);
    let (Some(host), Some(id)) = (args.next(), args.next()) else {
        eprintln!("usage: candump <host> <device_id> [channel]");
        std::process::exit(2);
    };
    let ch: u8 = args.next().and_then(|c| c.parse().ok()).unwrap_or(1);
    let dev = Device::connect(ConnectOptions {
        host,
        device_id: Some(id),
        ..ConnectOptions::default()
    })?;
    dev.set_time_now()?;
    dev.configure(ch, &PhyConfig::default())?; // listen-only, 500 kbit/s / 2 Mbit/s
    let mut chan = dev.open(ch)?;
    let iface = format!("can{ch}");
    loop {
        chan.poll(Duration::from_millis(100), &mut |ev| match ev {
            Event::Frame(f) => {
                let t = f.unix_us();
                let id = if f.flags.contains(FrameFlags::EXTENDED) {
                    format!("{:08X}", f.id)
                } else {
                    format!("{:03X}", f.id)
                };
                let data: String = f.payload().iter().map(|b| format!("{b:02X}")).collect();
                let sep = if f.flags.contains(FrameFlags::FD) {
                    "##"
                } else {
                    "#"
                };
                let rtr = if f.flags.contains(FrameFlags::RTR) {
                    "R"
                } else {
                    ""
                };
                println!(
                    "({}.{:06}) {iface} {id}{sep}{rtr}{data}",
                    t / 1_000_000,
                    t % 1_000_000
                );
            }
            Event::Error { timestamp_us, kind } => {
                println!("({timestamp_us}) {iface} error {kind:?}");
            }
        })?;
    }
}
