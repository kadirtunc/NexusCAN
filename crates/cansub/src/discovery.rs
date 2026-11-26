//! mDNS / DNS-SD discovery of CANsub devices (contract `cansub-v1` §3.4).
//!
//! CANsub devices advertise the `_cansub._tcp` service on their USB (RNDIS/ECM) or Ethernet
//! link. The mDNS host name is `<device-id>-usb.local` or `<device-id>-eth.local`, where the
//! device id is the 8-hex-digit id printed on the enclosure; the service port is 443 (HTTPS).
//! Documented TXT keys: `api` (REST API version, e.g. `02.00`) and `channels` (`1`, `2` or `4`).
//!
//! Discovery is best-effort: a host without network interfaces, or with multicast blocked,
//! yields an empty list rather than an error, so applications start fine offline.

use std::fmt;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};

/// DNS-SD service type advertised by CANsub devices (fully qualified, as `mdns-sd` expects).
pub const SERVICE_TYPE: &str = "_cansub._tcp.local.";

/// Upper bound for waiting on the mDNS daemon thread to acknowledge shutdown.
const SHUTDOWN_WAIT: Duration = Duration::from_millis(250);

/// Physical link a device was discovered on (from the host name suffix).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    /// USB network link (`<id>-usb.local`).
    Usb,
    /// Ethernet link (`<id>-eth.local`).
    Ethernet,
    /// Link could not be derived from the advertised names.
    Unknown,
}

/// One CANsub device reachable over one link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredDevice {
    /// Device id: 8 lowercase hex digits.
    pub device_id: String,
    /// mDNS host name without trailing dot, e.g. `aabbccdd-usb.local`.
    pub host: String,
    /// Resolved IPv4 / IPv6 addresses (sorted, deduplicated).
    pub addrs: Vec<IpAddr>,
    /// Service (HTTPS) port, normally 443.
    pub port: u16,
    /// Link derived from the host name suffix.
    pub link: Link,
    /// Raw TXT key/value pairs in advertised order (documented keys: `api`, `channels`).
    pub txt: Vec<(String, String)>,
}

/// Discovery failure caused by an mDNS protocol / daemon error.
///
/// Missing network interfaces or an unavailable multicast socket are *not* errors;
/// [`discover`] returns `Ok(vec![])` in that case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    /// The mDNS daemon rejected the browse request.
    Mdns(String),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DiscoveryError::Mdns(msg) => write!(f, "mDNS discovery failed: {msg}"),
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// Returns the lowercase id if `s` is exactly 8 ASCII hex digits.
fn parse_device_id(s: &str) -> Option<String> {
    (s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit())).then(|| s.to_ascii_lowercase())
}

/// Extracts `(device_id, link)` from an mDNS host name.
///
/// Accepts `<8 hex>-usb.local` / `<8 hex>-eth.local`, case-insensitive, with or without the
/// trailing dot. `"AABBCCDD-usb.local."` → `Some(("aabbccdd", Link::Usb))`.
pub fn parse_host(host: &str) -> Option<(String, Link)> {
    let host = host.strip_suffix('.').unwrap_or(host);
    let lower = host.to_ascii_lowercase();
    let label = lower.strip_suffix(".local")?;
    let (id, suffix) = label.rsplit_once('-')?;
    let link = match suffix {
        "usb" => Link::Usb,
        "eth" => Link::Ethernet,
        _ => return None,
    };
    Some((parse_device_id(id)?, link))
}

/// Builds a [`DiscoveredDevice`] from a resolved service, or `None` if no device id is found.
fn device_from_resolved(svc: &ResolvedService) -> Option<DiscoveredDevice> {
    let host = svc.host.strip_suffix('.').unwrap_or(&svc.host).to_string();
    let (device_id, link) = parse_host(&host).or_else(|| {
        // Fallback: instance name `<id>-usb` / `<id>` in `<instance>._cansub._tcp.local.`.
        let instance = svc.fullname.split("._cansub.").next()?;
        parse_host(&format!("{instance}.local"))
            .or_else(|| parse_device_id(instance).map(|id| (id, Link::Unknown)))
    })?;
    let mut addrs: Vec<IpAddr> = svc.addresses.iter().map(|a| a.to_ip_addr()).collect();
    addrs.sort();
    addrs.dedup();
    let txt = svc
        .txt_properties
        .iter()
        .map(|p| (p.key().to_string(), p.val_str().to_string()))
        .collect();
    Some(DiscoveredDevice {
        device_id,
        host,
        addrs,
        port: svc.port,
        link,
        txt,
    })
}

/// Inserts or merges `dev` into `out`, unique per `(device_id, link)`.
fn merge(out: &mut Vec<DiscoveredDevice>, dev: DiscoveredDevice) {
    if let Some(existing) = out
        .iter_mut()
        .find(|d| d.device_id == dev.device_id && d.link == dev.link)
    {
        existing.addrs.extend(dev.addrs);
        existing.addrs.sort();
        existing.addrs.dedup();
        if !dev.txt.is_empty() {
            existing.txt = dev.txt;
        }
        existing.port = dev.port;
        existing.host = dev.host;
    } else {
        out.push(dev);
    }
}

/// Browses `_cansub._tcp` for `timeout` (1.5 s recommended) and returns the devices found.
///
/// Results are unique per device × link and sorted by `device_id` (then link). Blocks the
/// calling thread for about `timeout`; the internal mDNS daemon thread is shut down before
/// returning. If no network interface or multicast socket is available, returns `Ok(vec![])`.
///
/// # Errors
///
/// [`DiscoveryError::Mdns`] if the running mDNS daemon rejects the browse request.
pub fn discover(timeout: Duration) -> Result<Vec<DiscoveredDevice>, DiscoveryError> {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        // No usable socket / interface: offline is not an error.
        Err(_) => return Ok(Vec::new()),
    };
    let result = browse(&daemon, timeout);
    shutdown(&daemon);
    let mut devices = result?;
    devices.sort_by(|a, b| {
        a.device_id
            .cmp(&b.device_id)
            .then_with(|| link_rank(&a.link).cmp(&link_rank(&b.link)))
    });
    Ok(devices)
}

fn link_rank(link: &Link) -> u8 {
    match link {
        Link::Usb => 0,
        Link::Ethernet => 1,
        Link::Unknown => 2,
    }
}

fn browse(
    daemon: &ServiceDaemon,
    timeout: Duration,
) -> Result<Vec<DiscoveredDevice>, DiscoveryError> {
    let rx = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| DiscoveryError::Mdns(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(svc)) => {
                if let Some(dev) = device_from_resolved(&svc) {
                    merge(&mut out, dev);
                }
            }
            Ok(_) => {}
            // Timeout or daemon gone: stop with what we have.
            Err(_) => break,
        }
    }
    // Best effort; the daemon is shut down right after anyway.
    let _ = daemon.stop_browse(SERVICE_TYPE);
    Ok(out)
}

/// Requests daemon shutdown and waits a bounded time for the acknowledgement.
fn shutdown(daemon: &ServiceDaemon) {
    if let Ok(status_rx) = daemon.shutdown() {
        let _ = status_rx.recv_timeout(SHUTDOWN_WAIT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_usb_lowercase() {
        assert_eq!(
            parse_host("aabbccdd-usb.local"),
            Some(("aabbccdd".into(), Link::Usb))
        );
    }

    #[test]
    fn parse_host_uppercase_trailing_dot() {
        assert_eq!(
            parse_host("AABBCCDD-usb.local."),
            Some(("aabbccdd".into(), Link::Usb))
        );
        assert_eq!(
            parse_host("0A1B2C3D-USB.LOCAL"),
            Some(("0a1b2c3d".into(), Link::Usb))
        );
    }

    #[test]
    fn parse_host_eth() {
        assert_eq!(
            parse_host("12345678-eth.local."),
            Some(("12345678".into(), Link::Ethernet))
        );
    }

    #[test]
    fn parse_host_invalid() {
        assert_eq!(parse_host("aabbccd-usb.local"), None); // 7 hex
        assert_eq!(parse_host("aabbccdde-usb.local"), None); // 9 hex
        assert_eq!(parse_host("aabbccgg-usb.local"), None); // non-hex
        assert_eq!(parse_host("aabbccdd.local"), None); // no suffix
        assert_eq!(parse_host("aabbccdd-wifi.local"), None); // unknown suffix
        assert_eq!(parse_host("aabbccdd-usb"), None); // no .local
        assert_eq!(parse_host(""), None);
    }

    #[test]
    fn merge_dedups_per_device_and_link() {
        let mk = |link: Link, ip: [u8; 4]| DiscoveredDevice {
            device_id: "aabbccdd".into(),
            host: "aabbccdd-usb.local".into(),
            addrs: vec![IpAddr::from(ip)],
            port: 443,
            link,
            txt: vec![("api".into(), "02.00".into())],
        };
        let mut out = Vec::new();
        merge(&mut out, mk(Link::Usb, [10, 0, 0, 1]));
        merge(&mut out, mk(Link::Usb, [10, 0, 0, 1]));
        merge(&mut out, mk(Link::Usb, [10, 0, 0, 2]));
        merge(&mut out, mk(Link::Ethernet, [192, 168, 1, 5]));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].addrs.len(), 2);
    }

    #[test]
    fn discover_offline_does_not_panic() {
        let t0 = Instant::now();
        let res = discover(Duration::from_millis(300));
        assert!(res.is_ok(), "{res:?}");
        assert!(t0.elapsed() < Duration::from_secs(3));
    }
}
