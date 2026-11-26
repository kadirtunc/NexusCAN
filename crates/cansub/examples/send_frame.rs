//! Sends one classical CAN frame and waits for its TX acknowledgement.
//!
//! ```text
//! cargo run -p cansub-rs --features blocking --example send_frame -- <host> <device_id> <channel> 123#DEADBEEF
//! ```
//! This **arms the bus** (listen-only off) for the channel, then restores listen-only.

use std::time::{Duration, Instant};

use cansub::proto::{CanFrame, Event, FrameFlags};
use cansub::{ConnectOptions, Device, Error, PhyConfig};

fn parse(spec: &str) -> Option<CanFrame> {
    let (id, data) = spec.split_once('#')?;
    let mut f = CanFrame {
        timestamp_us: 0,
        id: u32::from_str_radix(id, 16).ok()?,
        flags: FrameFlags::default(),
        dlc: 0,
        data: [0; 64],
    };
    if id.len() > 3 {
        f.flags = FrameFlags::EXTENDED;
    }
    if data.len() % 2 != 0 || data.len() > 16 {
        return None;
    }
    for (i, b) in data.as_bytes().chunks(2).enumerate() {
        f.data[i] = u8::from_str_radix(std::str::from_utf8(b).ok()?, 16).ok()?;
    }
    f.dlc = (data.len() / 2) as u8;
    Some(f)
}

fn main() -> Result<(), Error> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (Some(host), Some(id), Some(ch), Some(frame)) = (
        a.first(),
        a.get(1),
        a.get(2).and_then(|c| c.parse::<u8>().ok()),
        a.get(3).and_then(|s| parse(s)),
    ) else {
        eprintln!("usage: send_frame <host> <device_id> <channel> <ID>#<hex data>");
        std::process::exit(2);
    };
    let dev = Device::connect(ConnectOptions {
        host: host.clone(),
        device_id: Some(id.clone()),
        ..ConnectOptions::default()
    })?;
    let armed = PhyConfig {
        listen_only: false,
        tx_ack_frames: true,
        ..PhyConfig::default()
    };
    dev.configure(ch, &armed)?;
    let mut chan = dev.open(ch)?;
    chan.send(&[frame])?;
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut acked = false;
    while !acked && Instant::now() < deadline {
        chan.poll(Duration::from_millis(50), &mut |ev| {
            if let Event::Frame(f) = ev {
                if f.flags.contains(FrameFlags::TX_ACK) && f.id == frame.id {
                    println!("TX ack at device time {} us", f.timestamp_us);
                    acked = true;
                }
            }
        })?;
    }
    if !acked {
        eprintln!("no TX acknowledgement within 1 s (bus unpowered / no other node to ACK?)");
    }
    chan.close(&dev)?;
    dev.configure(ch, &PhyConfig::default()) // back to listen-only
}
