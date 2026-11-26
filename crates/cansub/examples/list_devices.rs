//! Lists CANsub devices and their channel states.
//!
//! ```text
//! cargo run -p cansub-rs --features blocking,discovery --example list_devices
//! cargo run -p cansub-rs --features blocking --example list_devices -- 10.123.45.1 aabbccdd
//! ```
//! With a host argument only that device is queried (optional second argument: Device ID).
//! Without arguments the `discovery` feature browses mDNS `_cansub._tcp` for 2 s.

use cansub::{ConnectOptions, Device};

fn show(host: &str, device_id: Option<String>) {
    let opts = ConnectOptions {
        host: host.to_string(),
        device_id,
        ..ConnectOptions::default()
    };
    let dev = match Device::connect(opts) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{host}: {e}");
            return;
        }
    };
    let i = dev.info();
    println!(
        "{host}: {} id={} hw={} fw={} api={}",
        i.variant, i.id, i.hw, i.fw, i.api
    );
    for ch in 1..=i.channels {
        match dev.channel_status(ch) {
            Ok(s) => println!(
                "  can{ch}: {:?} {} fps, load {} %, TEC {} REC {}",
                s.state, s.frame_rate, s.bus_load, s.tx_error_count, s.rx_error_count
            ),
            Err(e) => println!("  can{ch}: {e}"),
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    if let Some(host) = args.next() {
        show(&host, args.next());
        return;
    }
    #[cfg(feature = "discovery")]
    {
        match cansub::discovery::discover(std::time::Duration::from_secs(2)) {
            Ok(list) if list.is_empty() => println!("no CANsub found"),
            Ok(list) => {
                for d in list {
                    // Prefer an IPv4 address: `.local` names may not resolve without an mDNS resolver.
                    let host = match d.addrs.iter().find(|a| a.is_ipv4()) {
                        Some(ip) => format!("{ip}:{}", d.port),
                        None => format!("{}:{}", d.host, d.port),
                    };
                    show(&host, Some(d.device_id.clone()));
                }
            }
            Err(e) => eprintln!("discovery: {e}"),
        }
    }
    #[cfg(not(feature = "discovery"))]
    eprintln!(
        "usage: list_devices <host> [device_id]   (enable feature `discovery` to browse mDNS)"
    );
}
