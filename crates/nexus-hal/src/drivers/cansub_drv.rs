//! CSS Electronics CANsub.2 / CANsub.4 network CAN / CAN-FD adapter (contract cansub-v1 §3.4).
//!
//! Transport: TLS 1.2 + REST + WebSocket via the `cansub` SDK (`crates/cansub`, feature
//! `blocking`); discovery via mDNS (`_cansub._tcp`, feature `discovery`) plus manually added hosts
//! ([`CansubDriver::add_known_host`]). Compiled on every platform (pure Rust, no OS driver).
//!
//! ### Guarantees
//! - **Listen-Only default (CLAUDE.md §3.4):** the full `PUT /phy` is sent with
//!   `listen_only = config.listen_only` BEFORE the channel WebSocket is opened, so a passive
//!   channel never ACKs; enforcement is reported as [`ListenOnlyEnforcement::Hardware`].
//! - **Zero-allocation hot path:** `recv_batch` writes decoded frames straight into the caller's
//!   slice; events of one WebSocket message that do not fit are parked in a ring allocated once
//!   at open (no loss). `send_frame` builds the SDK frame on the stack.
//! - **Non-blocking health:** a per-channel thread polls `GET /api/can/{ch}` at 1 Hz into
//!   atomics; [`CanChannel::health`] only loads them.
//! - **Panic Stop:** [`CanChannel::abort_pending_tx`] discards the device TX queue
//!   (`DELETE /ws`), deletes device-resident transmit jobs and re-applies the full PHY config
//!   with `listen_only = true`. RX resumes on a fresh WebSocket (lazily, from `recv_batch`).
//! - **Production TLS trust:** only the embedded CSS root (`cansub::Device::connect`). Tests
//!   inject a connector ([`CansubDriver::with_connector`]) that calls the SDK's test-only
//!   `connect_with_root`, which does not exist in production builds of the SDK.

use crate::dto::AdapterCapabilitiesDto;
use crate::error::AdapterError;
use crate::error_frame::{CAN_ERR_ACK, CAN_ERR_BUSERROR, CAN_ERR_PROT};
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use cansub::client::CanState;
use cansub::proto::{dlc_to_len, len_to_dlc, CanFrame, ErrorKind, Event, FrameFlags};
use cansub::timing::BitTiming;
use cansub::{Channel, ConnectOptions, Device, PhyConfig};
use nexus_core::{
    BusId, RawCanFrame, EXT_CAN_ID_MASK, FLAG_BRS, FLAG_ERROR, FLAG_ESI, FLAG_EXTENDED, FLAG_FD,
    FLAG_HW_TIMESTAMP, FLAG_RTR, FLAG_TX, STD_CAN_ID_MASK,
};
use parking_lot::RwLock;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Driver id / device id prefix (`"cansub:<devid>@<ch>"`).
pub const CANSUB_DRIVER_ID: &str = "cansub";
/// mDNS browse window (contract §3.4: ≤ 1.5 s).
const MDNS_TIMEOUT: Duration = Duration::from_millis(1500);
/// After this age the mDNS cache is refreshed in the background (the caller gets the cache).
const MDNS_STALE_AFTER: Duration = Duration::from_secs(5);
/// Health poll period (contract §3.4: 1 Hz).
const HEALTH_PERIOD: Duration = Duration::from_secs(1);
/// Consecutive failed health polls before the channel reports `Disconnected`.
const HEALTH_FAILS_DISCONNECT: u32 = 2;
/// RX overflow ring capacity (allocated once per open channel, never grows). When full, the
/// newest frame is dropped and counted in [`CanChannel::driver_dropped_frames`].
pub const RX_RING_CAPACITY: usize = 4096;
/// Retry period for re-opening the WebSocket after a Panic Stop abort.
const REOPEN_RETRY: Duration = Duration::from_millis(200);
/// Preferred sample point (‰, same as qt-cansub); the search starts here.
const SAMPLE_POINT_PERMILLE: u16 = cansub::timing::DEFAULT_SAMPLE_POINT_PERMILLE;
/// Sample point search window (‰): tried in order of increasing distance from
/// [`SAMPLE_POINT_PERMILLE`] (the later point first on a tie) until the SDK finds an exact timing.
const SAMPLE_POINT_MIN_PERMILLE: u16 = 700;
const SAMPLE_POINT_MAX_PERMILLE: u16 = 900;
/// Data bitrate used to fill the (mandatory) `timing_data` field on classical channels.
const CLASSIC_DATA_FILLER_BPS: u32 = 2_000_000;

/// Connection factory: `cansub::Device::connect` in production; tests inject a closure using the
/// SDK's test-only root (see module docs).
pub type CansubConnector =
    dyn Fn(ConnectOptions) -> Result<Device, cansub::Error> + Send + Sync + 'static;

/// A manually added CANsub host (VPN / other subnet / no mDNS).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownHost {
    /// Host as entered (`name[:port]`, `ipv4[:port]`, `[ipv6]:port`).
    pub host: String,
    /// Device ID entered by the user (TLS rule 1), if any.
    pub device_id: Option<String>,
    /// TLS rule 2 (accept any device chaining to the CSS root) as chosen by the user.
    pub accept_any: bool,
    /// Device ID reported by `/api/info`.
    pub info_id: String,
    /// Channel count reported by the device.
    pub channels: u8,
}

/// One mDNS result reduced to what descriptors and `open_channel` need.
#[derive(Clone, Debug)]
struct MdnsEntry {
    device_id: String,
    /// mDNS host name (with `:port` when not 443).
    host: String,
    /// First resolved address as `ip[:port]` (preferred for connecting; avoids OS `.local` lookup).
    addr: Option<String>,
    channels: u8,
}

#[derive(Default)]
struct MdnsCache {
    scanned_at: Option<Instant>,
    devices: Vec<MdnsEntry>,
    refreshing: bool,
}

/// Process-wide mDNS cache shared by all driver instances (the hardware watcher polls
/// `discover_all` every few seconds; a blocking 1.5 s browse each time would stall it).
static MDNS_CACHE: Mutex<MdnsCache> = Mutex::new(MdnsCache {
    scanned_at: None,
    devices: Vec::new(),
    refreshing: false,
});

fn mdns_scan() -> Vec<MdnsEntry> {
    let Ok(found) = cansub::discovery::discover(MDNS_TIMEOUT) else {
        return Vec::new();
    };
    let mut out: Vec<MdnsEntry> = Vec::with_capacity(found.len());
    for d in found {
        // One entry per device (results are sorted USB link first).
        if out.iter().any(|e| e.device_id == d.device_id) {
            continue;
        }
        let channels = d
            .txt
            .iter()
            .find(|(k, _)| k == "channels")
            .and_then(|(_, v)| v.trim().parse::<u8>().ok())
            .filter(|n| (1..=4).contains(n))
            .unwrap_or(2);
        let with_port = |h: String| {
            if d.port == 443 {
                h
            } else {
                format!("{h}:{}", d.port)
            }
        };
        let addr = d
            .addrs
            .iter()
            .find(|a| a.is_ipv4())
            .or_else(|| d.addrs.first())
            .map(|a| match a {
                std::net::IpAddr::V4(v4) => with_port(v4.to_string()),
                std::net::IpAddr::V6(v6) => format!("[{v6}]:{}", d.port),
            });
        out.push(MdnsEntry {
            device_id: d.device_id,
            host: with_port(d.host),
            addr,
            channels,
        });
    }
    out
}

/// Returns the cached mDNS view: blocking scan on first use, background refresh when stale.
fn mdns_snapshot() -> Vec<MdnsEntry> {
    let mut guard = MDNS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    match guard.scanned_at {
        None => {
            drop(guard);
            let devices = mdns_scan();
            let mut guard = MDNS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            guard.devices = devices;
            guard.scanned_at = Some(Instant::now());
            guard.devices.clone()
        }
        Some(t) => {
            if t.elapsed() > MDNS_STALE_AFTER && !guard.refreshing {
                guard.refreshing = true;
                let spawned = thread::Builder::new().name("cansub-mdns".into()).spawn(|| {
                    let devices = mdns_scan();
                    let mut g = MDNS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
                    g.devices = devices;
                    g.scanned_at = Some(Instant::now());
                    g.refreshing = false;
                });
                if spawned.is_err() {
                    guard.refreshing = false;
                }
            }
            guard.devices.clone()
        }
    }
}

fn mdns_cached() -> Vec<MdnsEntry> {
    MDNS_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .devices
        .clone()
}

fn is_device_id(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parses `"cansub:<devid>@<ch>"` → `(devid lowercase, ch)`.
pub fn parse_cansub_device_id(device_id: &str) -> Option<(String, u8)> {
    let rest = device_id.trim().strip_prefix("cansub:")?;
    let (id, ch) = rest.split_once('@')?;
    let ch: u8 = ch.trim().parse().ok()?;
    (is_device_id(id.trim()) && (1..=4).contains(&ch)).then(|| (id.trim().to_ascii_lowercase(), ch))
}

fn capabilities() -> AdapterCapabilitiesDto {
    AdapterCapabilitiesDto {
        supports_fd: true,
        supports_listen_only: true,
        supports_hw_timestamps: true,
        max_bitrate: 8_000_000,
        is_virtual: false,
    }
}

/// Builds the descriptor of channel `ch` of device `devid` reached via `host`.
pub fn cansub_descriptor(devid: &str, host: &str, channels: u8, ch: u8) -> DeviceDescriptor {
    DeviceDescriptor {
        device_id: format!("cansub:{devid}@{ch}"),
        driver_id: CANSUB_DRIVER_ID.to_string(),
        channel_name: format!("{host}@{ch}"),
        display_name: format!("CANsub.{channels} {devid} CH{ch}"),
        capabilities: capabilities(),
    }
}

/// Sample points (‰) in search order: 800, 801, 799, 802, 798, … within
/// [`SAMPLE_POINT_MIN_PERMILLE`]..=[`SAMPLE_POINT_MAX_PERMILLE`].
fn sample_point_search_order() -> impl Iterator<Item = u16> {
    let up = SAMPLE_POINT_MAX_PERMILLE - SAMPLE_POINT_PERMILLE;
    let down = SAMPLE_POINT_PERMILLE - SAMPLE_POINT_MIN_PERMILLE;
    (0..=up.max(down)).flat_map(move |d| {
        let hi = (d <= up).then_some(SAMPLE_POINT_PERMILLE + d);
        let lo = (d > 0 && d <= down).then(|| SAMPLE_POINT_PERMILLE - d);
        hi.into_iter().chain(lo)
    })
}

/// CAN-FD timing with a shared BRP and one sample point for both phases (SDK `fd_timing`),
/// choosing the sample point closest to 80 % that the 80 MHz clock reaches exactly.
/// Returns `(sample_point_permille, nominal, data)`.
pub fn select_fd_timing(nominal: u32, data: u32) -> Option<(u16, BitTiming, BitTiming)> {
    sample_point_search_order()
        .find_map(|sp| cansub::timing::fd_timing(nominal, data, sp).map(|(n, d)| (sp, n, d)))
}

/// Classical CAN timing closest to 80 % sample point. Returns `(sample_point_permille, timing)`.
pub fn select_nominal_timing(bitrate: u32) -> Option<(u16, BitTiming)> {
    sample_point_search_order()
        .find_map(|sp| cansub::timing::nominal_timing(bitrate, sp).map(|t| (sp, t)))
}

/// `812` → `"81.2 %"`.
fn sp_percent(sp: u16) -> String {
    format!("{}.{} %", sp / 10, sp % 10)
}

/// Maps an SDK error to a readable [`AdapterError`] (`ctx` = what was being done).
fn map_sdk(err: cansub::Error, ctx: &str) -> AdapterError {
    match err {
        cansub::Error::Tls(m) => AdapterError::Driver(format!("CANsub {ctx}: TLS: {m}")),
        cansub::Error::UnsupportedApi(m) => {
            AdapterError::UnsupportedCapability(format!("{m} (NexusCAN requires CANsub API 05.x)"))
        }
        cansub::Error::Busy => AdapterError::Driver(format!(
            "CANsub {ctx}: channel already in use by another client"
        )),
        other => AdapterError::Driver(format!("CANsub {ctx}: {other}")),
    }
}

/// CSS Electronics CANsub driver (`driver_id = "cansub"`).
pub struct CansubDriver {
    known: RwLock<Vec<KnownHost>>,
    connector: Arc<CansubConnector>,
    mdns: bool,
}

#[cfg(all(feature = "cansub-dev-root", not(debug_assertions)))]
compile_error!(
    "`cansub-dev-root` is a development-only feature and must not be used in release builds"
);

#[cfg(not(feature = "cansub-dev-root"))]
fn default_connector() -> Arc<CansubConnector> {
    Arc::new(Device::connect)
}

/// Development-only connector: trusts the PEM root CA in `NEXUSCAN_CANSUB_DEV_ROOT` (simulator).
#[cfg(feature = "cansub-dev-root")]
fn default_connector() -> Arc<CansubConnector> {
    use base64::Engine as _;
    let Ok(path) = std::env::var("NEXUSCAN_CANSUB_DEV_ROOT") else {
        return Arc::new(Device::connect);
    };
    let der = std::fs::read_to_string(&path).ok().and_then(|pem| {
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .flat_map(|l| l.trim().chars())
            .collect();
        base64::engine::general_purpose::STANDARD.decode(body).ok()
    });
    match der {
        Some(der) => {
            eprintln!(
                "WARNING: CANsub DEV ROOT ACTIVE — trusting {path} instead of the CSS root CA \
                 (development build, simulator testing only)"
            );
            Arc::new(move |opts| Device::connect_with_root(opts, &der))
        }
        None => {
            eprintln!("WARNING: NEXUSCAN_CANSUB_DEV_ROOT={path} unreadable; using the CSS root CA");
            Arc::new(Device::connect)
        }
    }
}

impl Default for CansubDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl CansubDriver {
    /// Production driver: TLS trusts only the embedded CSS root; mDNS discovery enabled.
    ///
    /// With the development-only `cansub-dev-root` feature (debug builds only) and
    /// `NEXUSCAN_CANSUB_DEV_ROOT=<pem file>` set, it trusts that root CA instead (simulator testing).
    pub fn new() -> Self {
        Self {
            known: RwLock::new(Vec::new()),
            connector: default_connector(),
            mdns: true,
        }
    }

    /// Driver with a custom connection factory (tests: SDK `connect_with_root` + sim root CA).
    /// mDNS discovery is disabled (known hosts only), keeping tests hermetic.
    pub fn with_connector(connector: Arc<CansubConnector>) -> Self {
        Self {
            known: RwLock::new(Vec::new()),
            connector,
            mdns: false,
        }
    }

    /// Snapshot of the manually added hosts.
    pub fn known_hosts(&self) -> Vec<KnownHost> {
        self.known.read().clone()
    }

    /// Connects to `host` (TLS rules §2.6 from `device_id` / `accept_any`), reads `/api/info`
    /// and, on success, remembers the host for discovery / open and returns one descriptor per
    /// channel. Backs the Tauri `cmd_cansub_probe_host` command.
    pub fn add_known_host(
        &self,
        host: &str,
        device_id: Option<String>,
        accept_any: bool,
    ) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let host = host.trim();
        if host.is_empty() {
            return Err(AdapterError::Driver(
                "CANsub: host must not be empty".into(),
            ));
        }
        let device_id = device_id
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty());
        if let Some(id) = &device_id {
            if !is_device_id(id) {
                return Err(AdapterError::Driver(format!(
                    "CANsub: Device ID '{id}' must be 8 hex digits"
                )));
            }
        }
        let dev = (self.connector)(ConnectOptions {
            host: host.to_string(),
            device_id: device_id.clone(),
            accept_any_device: accept_any,
            ..ConnectOptions::default()
        })
        .map_err(|e| map_sdk(e, &format!("connect to {host}")))?;
        let info = dev.info().clone();
        drop(dev);
        let entry = KnownHost {
            host: host.to_string(),
            device_id,
            accept_any,
            info_id: info.id.clone(),
            channels: info.channels,
        };
        {
            let mut known = self.known.write();
            known.retain(|k| k.host != entry.host && k.info_id != entry.info_id);
            known.push(entry);
        }
        Ok((1..=info.channels)
            .map(|ch| cansub_descriptor(&info.id, host, info.channels, ch))
            .collect())
    }

    /// Opens `"cansub:<devid>@<ch>"` without running discovery (registry fast path).
    pub fn open_by_device_id(
        &self,
        device_id: &str,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let (devid, ch) = parse_cansub_device_id(device_id).ok_or_else(|| {
            AdapterError::DeviceNotFound(format!(
                "{device_id} (expected cansub:<8-hex device id>@<channel 1..4>)"
            ))
        })?;
        let desc = cansub_descriptor(&devid, &format!("{devid}-usb.local"), 2, ch);
        self.open_channel(&desc, config)
    }

    /// Resolves `(host, device_id, accept_any)` per §3.4: `config.network_host` →
    /// known hosts / last mDNS result (device id match) → `<devid>-usb.local`.
    /// `config.adapter_channel` is never consulted (frontend may put the descriptor id there).
    fn resolve_target(
        &self,
        devid: &str,
        config: &ChannelConfig,
    ) -> (String, Option<String>, bool) {
        let cfg_id = config
            .network_device_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_ascii_lowercase);
        if let Some(host) = config
            .network_host
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            // §2.6 rule 1 with the descriptor id unless the user gave one (contract §3.4).
            let id = cfg_id.unwrap_or_else(|| devid.to_string());
            return (host.to_string(), Some(id), config.network_accept_any_device);
        }
        if let Some(k) = self.known.read().iter().find(|k| k.info_id == devid) {
            if cfg_id.is_none() && k.device_id.is_none() && k.accept_any {
                return (k.host.clone(), None, true);
            }
            return (
                k.host.clone(),
                Some(cfg_id.unwrap_or_else(|| devid.to_string())),
                false,
            );
        }
        let id = Some(cfg_id.unwrap_or_else(|| devid.to_string()));
        if let Some(m) = mdns_cached().into_iter().find(|m| m.device_id == devid) {
            return (m.addr.unwrap_or(m.host), id, false);
        }
        (format!("{devid}-usb.local"), id, false)
    }
}

impl AdapterDriver for CansubDriver {
    fn driver_id(&self) -> &'static str {
        CANSUB_DRIVER_ID
    }

    fn display_name(&self) -> &'static str {
        "CSS Electronics CANsub"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let mut out = Vec::new();
        let known = self.known.read().clone();
        for k in &known {
            for ch in 1..=k.channels {
                out.push(cansub_descriptor(&k.info_id, &k.host, k.channels, ch));
            }
        }
        if self.mdns {
            for m in mdns_snapshot() {
                if known.iter().any(|k| k.info_id == m.device_id) {
                    continue;
                }
                for ch in 1..=m.channels {
                    out.push(cansub_descriptor(&m.device_id, &m.host, m.channels, ch));
                }
            }
        }
        Ok(out)
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let (devid, ch) = parse_cansub_device_id(&device.device_id)
            .ok_or_else(|| AdapterError::DeviceNotFound(device.device_id.clone()))?;

        let (sp, timing, timing_data) = if config.enable_fd {
            select_fd_timing(config.bitrate, config.data_bitrate).ok_or_else(|| {
                AdapterError::UnsupportedCapability(format!(
                    "CANsub: no exact 80 MHz bit timing for {} bit/s nominal / {} bit/s data \
                     (shared BRP, one sample point for both phases, searched {} .. {})",
                    config.bitrate,
                    config.data_bitrate,
                    sp_percent(SAMPLE_POINT_MIN_PERMILLE),
                    sp_percent(SAMPLE_POINT_MAX_PERMILLE)
                ))
            })?
        } else {
            let (sp, n) = select_nominal_timing(config.bitrate).ok_or_else(|| {
                AdapterError::UnsupportedCapability(format!(
                    "CANsub: no exact 80 MHz bit timing for {} bit/s (sample point searched \
                     {} .. {})",
                    config.bitrate,
                    sp_percent(SAMPLE_POINT_MIN_PERMILLE),
                    sp_percent(SAMPLE_POINT_MAX_PERMILLE)
                ))
            })?;
            let d = select_fd_timing(config.bitrate, CLASSIC_DATA_FILLER_BPS)
                .map_or(PhyConfig::default().timing_data, |(_, _, d)| d);
            (sp, n, d)
        };
        let timing_note = if config.enable_fd {
            format!(
                "CANsub sample point {} (nominal brp={} seg1={} seg2={} sjw={}; data brp={} \
                 seg1={} seg2={} sjw={})",
                sp_percent(sp),
                timing.brp,
                timing.seg1,
                timing.seg2,
                timing.sjw,
                timing_data.brp,
                timing_data.seg1,
                timing_data.seg2,
                timing_data.sjw
            )
        } else {
            format!(
                "CANsub sample point {} (brp={} seg1={} seg2={} sjw={})",
                sp_percent(sp),
                timing.brp,
                timing.seg1,
                timing.seg2,
                timing.sjw
            )
        };

        let (host, tls_id, accept_any) = self.resolve_target(&devid, config);
        let dev = (self.connector)(ConnectOptions {
            host: host.clone(),
            device_id: tls_id,
            accept_any_device: accept_any,
            ..ConnectOptions::default()
        })
        .map_err(|e| map_sdk(e, &format!("connect to {host}")))?;
        let info = dev.info().clone();
        if ch > info.channels {
            return Err(AdapterError::DeviceNotFound(format!(
                "{}: device {} has only {} channel(s)",
                device.device_id, info.id, info.channels
            )));
        }
        if let Err(e) = dev.set_time_now() {
            // Non-fatal: frames still carry device timestamps, just not host-aligned.
            eprintln!(
                "nexus-hal: CANsub {}: setting device time failed: {e}",
                info.id
            );
        }
        let phy = PhyConfig {
            listen_only: config.listen_only,
            auto_reset: true,
            error_frames: true,
            tx_ack_frames: true,
            timing,
            timing_data,
        };
        dev.configure(ch, &phy)
            .map_err(|e| map_sdk(e, &format!("configure channel {ch} ({timing_note})")))?;
        let chan = dev
            .open(ch)
            .map_err(|e| map_sdk(e, &format!("open channel {ch}")))?;

        let dev = Arc::new(dev);
        let health = Arc::new(HealthAtomics::new());
        let health_stop = spawn_health_thread(Arc::clone(&dev), ch, Arc::clone(&health));

        Ok(Box::new(CansubChannel {
            descriptor: cansub_descriptor(&info.id, &host, info.channels, ch),
            device: dev,
            ch,
            bus_id: config.bus_id,
            chan: Some(chan),
            phy,
            listen_only: config.listen_only,
            panic_listen_only: false,
            reopen_at: None,
            ring: VecDeque::with_capacity(RX_RING_CAPACITY),
            rx_dropped: 0,
            timing_note,
            health,
            health_stop: Some(health_stop),
            closed: false,
        }))
    }
}

struct HealthAtomics {
    state: AtomicU8,
    tec: AtomicU32,
    rec: AtomicU32,
    disconnected: AtomicBool,
}

impl HealthAtomics {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(BusState::Active.to_u8()),
            tec: AtomicU32::new(0),
            rec: AtomicU32::new(0),
            disconnected: AtomicBool::new(false),
        }
    }
}

/// Starts the 1 Hz status poller; dropping / sending on the returned sender stops it promptly.
fn spawn_health_thread(dev: Arc<Device>, ch: u8, h: Arc<HealthAtomics>) -> mpsc::Sender<()> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let spawned = thread::Builder::new()
        .name(format!("cansub-health-{ch}"))
        .spawn(move || {
            let mut fails = 0u32;
            loop {
                match dev.channel_status(ch) {
                    Ok(st) => {
                        fails = 0;
                        let state = match st.state {
                            CanState::ErrorActive => Some(BusState::Active),
                            CanState::ErrorWarning => Some(BusState::Warning),
                            CanState::ErrorPassive => Some(BusState::Passive),
                            CanState::BusOff => Some(BusState::BusOff),
                            // `stopped` = no WebSocket yet / re-opening after Panic Stop.
                            CanState::Stopped | CanState::Unknown => None,
                        };
                        if let Some(s) = state {
                            h.state.store(s.to_u8(), Ordering::Release);
                        }
                        h.tec.store(st.tx_error_count, Ordering::Relaxed);
                        h.rec.store(st.rx_error_count, Ordering::Relaxed);
                    }
                    Err(_) => {
                        fails += 1;
                        if fails >= HEALTH_FAILS_DISCONNECT {
                            h.disconnected.store(true, Ordering::Release);
                        }
                    }
                }
                match stop_rx.recv_timeout(HEALTH_PERIOD) {
                    Err(RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
            }
        });
    if spawned.is_err() {
        eprintln!("nexus-hal: CANsub: could not start the health thread for channel {ch}");
    }
    stop_tx
}

/// One open CANsub channel (owned by the bus-io thread).
pub struct CansubChannel {
    descriptor: DeviceDescriptor,
    device: Arc<Device>,
    ch: u8,
    bus_id: BusId,
    chan: Option<Channel>,
    /// Last PHY config applied (Panic Stop re-sends it with `listen_only = true`, §2.4 C2).
    phy: PhyConfig,
    listen_only: bool,
    /// Panic Stop forced the controller back to hardware listen-only.
    panic_listen_only: bool,
    /// After a Panic Stop abort: next time to try re-opening the WebSocket.
    reopen_at: Option<Instant>,
    /// Bounded RX overflow ring (≤ [`RX_RING_CAPACITY`], allocated once at open).
    ring: VecDeque<RawCanFrame>,
    /// Frames dropped because `ring` was full (newest dropped). Monotonic.
    rx_dropped: u64,
    /// Programmed timing incl. the searched sample point (logged once on connect).
    timing_note: String,
    health: Arc<HealthAtomics>,
    health_stop: Option<mpsc::Sender<()>>,
    closed: bool,
}

/// SDK event → [`RawCanFrame`] (contract §3.4 mapping).
#[inline]
fn event_to_raw(ev: Event, bus_id: BusId) -> RawCanFrame {
    let mut out = RawCanFrame::zeroed();
    out.bus_id = bus_id;
    match ev {
        Event::Frame(f) => {
            let ext = f.flags.contains(FrameFlags::EXTENDED);
            let fd = f.flags.contains(FrameFlags::FD);
            let rtr = f.flags.contains(FrameFlags::RTR);
            let mut flags = FLAG_HW_TIMESTAMP;
            if ext {
                flags |= FLAG_EXTENDED;
            }
            if rtr && !fd {
                flags |= FLAG_RTR;
            }
            if fd {
                flags |= FLAG_FD;
                if f.flags.contains(FrameFlags::BRS) {
                    flags |= FLAG_BRS;
                }
                if f.flags.contains(FrameFlags::ESI) {
                    flags |= FLAG_ESI;
                }
            }
            if f.flags.contains(FrameFlags::TX_ACK) {
                flags |= FLAG_TX;
            }
            out.timestamp_us = f.unix_us();
            out.arb_id = f.id
                & if ext {
                    EXT_CAN_ID_MASK
                } else {
                    STD_CAN_ID_MASK
                };
            out.flags = flags;
            let len = dlc_to_len(fd, f.dlc).min(64);
            out.dlc = len as u8;
            if !(rtr && !fd) {
                out.data[..len].copy_from_slice(&f.data[..len]);
            }
        }
        Event::Error { timestamp_us, kind } => {
            // SocketCAN-compatible error frame (error_frame.rs) + data[0] = CANsub wire code.
            let (mask, prot_type, prot_loc, code) = match kind {
                ErrorKind::Bit => (CAN_ERR_PROT | CAN_ERR_BUSERROR, 0x01, 0x00, 0u8),
                ErrorKind::Ack => (CAN_ERR_ACK | CAN_ERR_BUSERROR, 0x00, 0x19, 1),
                ErrorKind::Form => (CAN_ERR_PROT | CAN_ERR_BUSERROR, 0x02, 0x00, 2),
                ErrorKind::Stuff => (CAN_ERR_PROT | CAN_ERR_BUSERROR, 0x04, 0x00, 3),
                ErrorKind::Crc => (CAN_ERR_PROT | CAN_ERR_BUSERROR, 0x00, 0x08, 4),
                ErrorKind::Other(c) => (CAN_ERR_BUSERROR, 0x00, 0x00, c),
            };
            out.timestamp_us = timestamp_us.saturating_add(cansub::proto::DEVICE_EPOCH_UNIX_US);
            out.arb_id = mask;
            out.flags = FLAG_ERROR | FLAG_HW_TIMESTAMP;
            out.dlc = 8;
            out.data[0] = code;
            out.data[2] = prot_type;
            out.data[3] = prot_loc;
        }
    }
    out
}

/// Bounded overflow push: keeps at most [`RX_RING_CAPACITY`] frames (the ring was allocated
/// with that capacity, so this never reallocates); when full the newest frame is dropped and
/// counted (surfaced via [`CanChannel::driver_dropped_frames`]).
#[inline]
fn push_overflow(ring: &mut VecDeque<RawCanFrame>, dropped: &mut u64, f: RawCanFrame) {
    if ring.len() < RX_RING_CAPACITY {
        ring.push_back(f);
    } else {
        *dropped += 1;
    }
}

/// [`RawCanFrame`] → SDK frame (stack only).
fn raw_to_sdk(frame: &RawCanFrame) -> Result<CanFrame, AdapterError> {
    let fd = frame.is_fd();
    let mut flags = FrameFlags::default();
    if frame.is_extended() {
        flags = flags.union(FrameFlags::EXTENDED);
    }
    if fd {
        flags = flags.union(FrameFlags::FD);
        if frame.is_brs() {
            flags = flags.union(FrameFlags::BRS);
        }
        if frame.is_esi() {
            flags = flags.union(FrameFlags::ESI);
        }
    } else if frame.is_rtr() {
        flags = flags.union(FrameFlags::RTR);
    }
    let len = usize::from(frame.dlc);
    let dlc = len_to_dlc(fd, len).ok_or_else(|| {
        AdapterError::UnsupportedCapability(format!(
            "CANsub: payload length {len} is not a valid {} length",
            if fd { "CAN-FD" } else { "classical CAN" }
        ))
    })?;
    let mut data = [0u8; 64];
    if !frame.is_rtr() {
        data[..len].copy_from_slice(&frame.data[..len]);
    }
    let mask = if frame.is_extended() {
        EXT_CAN_ID_MASK
    } else {
        STD_CAN_ID_MASK
    };
    Ok(CanFrame {
        timestamp_us: 0,
        id: frame.arb_id & mask,
        flags,
        dlc,
        data,
    })
}

impl CansubChannel {
    fn mark_disconnected(&mut self) {
        self.health.disconnected.store(true, Ordering::Release);
    }

    /// Lazily re-opens the WebSocket after a Panic Stop abort (listen-only RX keeps flowing).
    fn try_reopen(&mut self, timeout_ms: u32) -> Result<(), AdapterError> {
        match self.reopen_at {
            Some(at) if Instant::now() >= at => match self.device.open(self.ch) {
                Ok(c) => {
                    self.chan = Some(c);
                    self.reopen_at = None;
                    Ok(())
                }
                Err(cansub::Error::Busy | cansub::Error::Http { .. }) => {
                    self.reopen_at = Some(Instant::now() + REOPEN_RETRY);
                    thread::sleep(Duration::from_millis(u64::from(timeout_ms.min(20))));
                    Ok(())
                }
                Err(e) => {
                    self.reopen_at = None;
                    self.mark_disconnected();
                    Err(map_sdk(e, "re-open channel after Panic Stop"))
                }
            },
            Some(_) => {
                thread::sleep(Duration::from_millis(u64::from(timeout_ms.min(20))));
                Ok(())
            }
            None => Err(AdapterError::ChannelClosed),
        }
    }
}

impl CanChannel for CansubChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        if let Some(stop) = self.health_stop.take() {
            let _ = stop.send(());
        }
        self.ring.clear();
        match self.chan.take() {
            Some(c) => c.close(&self.device).map_err(|e| map_sdk(e, "close")),
            None => Ok(()),
        }
    }

    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }
        let mut n = 0usize;
        while n < out_batch.len() {
            match self.ring.pop_front() {
                Some(f) => {
                    out_batch[n] = f;
                    n += 1;
                }
                None => break,
            }
        }
        if n == out_batch.len() {
            return Ok(n);
        }
        if self.chan.is_none() {
            if n > 0 {
                return Ok(n);
            }
            self.try_reopen(timeout_ms)?;
            if self.chan.is_none() {
                return Ok(0);
            }
        }
        let wait = if n > 0 {
            Duration::ZERO
        } else {
            Duration::from_millis(u64::from(timeout_ms))
        };
        let bus_id = self.bus_id;
        let ring = &mut self.ring;
        let rx_dropped = &mut self.rx_dropped;
        let Some(chan) = self.chan.as_mut() else {
            return Ok(n);
        };
        let res = chan.poll(wait, &mut |ev| {
            let f = event_to_raw(ev, bus_id);
            if n < out_batch.len() {
                out_batch[n] = f;
                n += 1;
            } else {
                push_overflow(ring, rx_dropped, f);
            }
        });
        match res {
            Ok(_) => Ok(n),
            Err(_) => {
                // Session ended without our Panic Stop (device gone, cable, DELETE by another tool).
                self.chan = None;
                self.mark_disconnected();
                if n > 0 {
                    Ok(n)
                } else {
                    Err(AdapterError::ChannelClosed)
                }
            }
        }
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }
        if self.panic_listen_only {
            return Err(AdapterError::Driver(
                "CANsub channel was returned to hardware listen-only by Panic Stop; reconnect \
                 the bus to transmit again"
                    .into(),
            ));
        }
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        let f = raw_to_sdk(frame)?;
        let chan = self.chan.as_mut().ok_or(AdapterError::ChannelClosed)?;
        chan.send(core::slice::from_ref(&f))
            .map_err(|e| map_sdk(e, "send"))
    }

    fn set_filters(&mut self, _filters: &[CanFilter]) -> Result<(), AdapterError> {
        // CANsub API 05 has no acceptance filter: all frames are delivered (pipeline filters).
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        Ok(())
    }

    fn health(&self) -> BusHealthSnapshot {
        if self.health.disconnected.load(Ordering::Acquire) {
            return BusHealthSnapshot {
                state: BusState::Disconnected,
                tx_error_count: self.health.tec.load(Ordering::Relaxed),
                rx_error_count: self.health.rec.load(Ordering::Relaxed),
            };
        }
        BusHealthSnapshot {
            state: BusState::from_u8(self.health.state.load(Ordering::Acquire)),
            tx_error_count: self.health.tec.load(Ordering::Relaxed),
            rx_error_count: self.health.rec.load(Ordering::Relaxed),
        }
    }

    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        ListenOnlyEnforcement::Hardware
    }

    fn driver_dropped_frames(&self) -> u64 {
        self.rx_dropped
    }

    fn bit_timing_note(&self) -> Option<String> {
        Some(self.timing_note.clone())
    }

    /// `DELETE /ws` (discard device TX queue) → delete transmit jobs → full PHY with
    /// `listen_only = true`. The old WebSocket is torn down on a helper thread so its §2.7
    /// close wait never counts against the ≤ 100 ms budget; RX resumes via `recv_batch`.
    fn abort_pending_tx(&mut self) -> Result<(), AdapterError> {
        if self.closed {
            return Ok(());
        }
        let mut first_err: Option<AdapterError> = None;
        if let Err(e) = self.device.abort_ws(self.ch) {
            first_err.get_or_insert(map_sdk(e, "Panic Stop: DELETE /ws"));
        }
        if let Err(e) = self.device.delete_transmit_jobs(self.ch) {
            first_err.get_or_insert(map_sdk(e, "Panic Stop: delete transmit jobs"));
        }
        let phy = PhyConfig {
            listen_only: true,
            ..self.phy
        };
        match self.device.configure(self.ch, &phy) {
            Ok(()) => {
                self.phy = phy;
                self.panic_listen_only = true;
            }
            Err(e) => {
                first_err.get_or_insert(map_sdk(e, "Panic Stop: PUT /phy listen_only"));
            }
        }
        if let Some(old) = self.chan.take() {
            let spawned = thread::Builder::new()
                .name("cansub-ws-drop".into())
                .spawn(move || drop(old));
            if let Err(e) = spawned {
                eprintln!("nexus-hal: CANsub: ws teardown thread failed: {e}");
            }
            self.reopen_at = Some(Instant::now());
        }
        // Never transmit again on this channel object, even if the PHY call failed.
        self.panic_listen_only = true;
        first_err.map_or(Ok(()), Err)
    }
}

impl Drop for CansubChannel {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Copy of `src/store/connectionStore.ts` `NOMINAL_BITRATES` (keep in sync).
    const UI_NOMINAL_BITRATES: [u32; 9] = [
        10_000, 20_000, 50_000, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000,
    ];
    /// Copy of `src/store/connectionStore.ts` `DATA_BITRATES_FD` (keep in sync).
    const UI_DATA_BITRATES_FD: [u32; 5] = [1_000_000, 2_000_000, 4_000_000, 5_000_000, 8_000_000];

    #[test]
    fn overflow_ring_is_bounded_and_counts_drops() {
        let mut ring = VecDeque::with_capacity(RX_RING_CAPACITY);
        let cap = ring.capacity();
        let mut dropped = 0u64;
        for i in 0..(RX_RING_CAPACITY + 10) {
            let mut f = RawCanFrame::zeroed();
            f.arb_id = i as u32;
            push_overflow(&mut ring, &mut dropped, f);
        }
        assert_eq!(ring.len(), RX_RING_CAPACITY);
        assert_eq!(ring.capacity(), cap, "must not reallocate");
        assert_eq!(dropped, 10);
        // Newest dropped: the oldest frames are kept in order.
        assert_eq!(
            ring.back().map(|f| f.arb_id),
            Some(RX_RING_CAPACITY as u32 - 1)
        );
    }

    #[test]
    fn sample_point_search_order_is_closest_first_within_window() {
        let order: Vec<u16> = sample_point_search_order().collect();
        assert_eq!(&order[..5], &[800, 801, 799, 802, 798]);
        assert_eq!(order.len(), 201);
        assert!(order.iter().all(|sp| (700..=900).contains(sp)));
    }

    /// Measures which UI bitrate combinations the driver can open (C7 matrix).
    #[test]
    fn ui_bitrate_matrix_timing_coverage() {
        let mut classic_fail = Vec::new();
        for &nb in &UI_NOMINAL_BITRATES {
            match select_nominal_timing(nb) {
                Some((sp, _)) => println!("classic {nb:>9} -> sp {}", sp_percent(sp)),
                None => classic_fail.push(nb),
            }
        }
        let mut fd_ok = 0usize;
        let mut fd_fail = Vec::new();
        for &nb in &UI_NOMINAL_BITRATES {
            for &db in &UI_DATA_BITRATES_FD {
                match select_fd_timing(nb, db) {
                    Some((sp, n, d)) => {
                        fd_ok += 1;
                        println!(
                            "fd {nb:>9} / {db:>9} -> sp {} brp {} (n {}+{}, d {}+{})",
                            sp_percent(sp),
                            n.brp,
                            n.seg1,
                            n.seg2,
                            d.seg1,
                            d.seg2
                        );
                    }
                    None => fd_fail.push((nb, db)),
                }
            }
        }
        println!(
            "classic ok {}/9, fail {classic_fail:?}",
            9 - classic_fail.len()
        );
        println!("fd ok {fd_ok}/45, fail {fd_fail:?}");
        assert!(classic_fail.is_empty(), "{classic_fail:?}");
        // With a fixed 80 % only 22/45 opened (no 5 Mbit/s data at all). The 17 below are not
        // reachable within the window: the shared FD BRP (1..=32) cannot give both a nominal
        // bit of ≤ 385 tq and a data bit of ≤ 25 tq (hardware limit, not a search gap).
        let unreachable: Vec<(u32, u32)> = vec![
            (10_000, 1_000_000),
            (10_000, 2_000_000),
            (10_000, 4_000_000),
            (10_000, 5_000_000),
            (10_000, 8_000_000),
            (20_000, 1_000_000),
            (20_000, 2_000_000),
            (20_000, 4_000_000),
            (20_000, 5_000_000),
            (20_000, 8_000_000),
            (50_000, 4_000_000),
            (50_000, 5_000_000),
            (50_000, 8_000_000),
            (100_000, 4_000_000),
            (100_000, 5_000_000),
            (100_000, 8_000_000),
            (125_000, 8_000_000),
        ];
        assert_eq!(fd_fail, unreachable);
        assert_eq!(fd_ok, 28);
        for (nb, db) in unreachable {
            let any: Vec<u16> = (1..1000)
                .filter(|&sp| cansub::timing::fd_timing(nb, db, sp).is_some())
                .collect();
            // Three combos exist only at a 60 % sample point (5-tq data bit), outside the
            // [70 %, 90 %] window on purpose: 60 % in the nominal phase is not field-usable.
            let only_60 = matches!(
                (nb, db),
                (20_000, 1_000_000) | (100_000, 4_000_000) | (125_000, 8_000_000)
            );
            let expect: &[u16] = if only_60 { &[600] } else { &[] };
            assert_eq!(any, expect, "{nb}/{db}");
        }
        // The device table's 500k / 5M row (81.2 %) is found.
        assert_eq!(select_fd_timing(500_000, 5_000_000).map(|t| t.0), Some(812));
    }

    #[test]
    fn parse_ids() {
        assert_eq!(
            parse_cansub_device_id("cansub:AABBCCDD@3"),
            Some(("aabbccdd".into(), 3))
        );
        assert_eq!(parse_cansub_device_id("cansub:aabbccdd@0"), None);
        assert_eq!(parse_cansub_device_id("cansub:aabbccd@1"), None);
        assert_eq!(parse_cansub_device_id("mock:mock0"), None);
    }

    #[test]
    fn tx_ack_maps_to_flag_tx_and_rtr_keeps_dlc() {
        let mut f = CanFrame {
            timestamp_us: 5,
            id: 0x123,
            flags: FrameFlags::TX_ACK,
            dlc: 2,
            data: [0; 64],
        };
        f.data[0] = 0xAA;
        let r = event_to_raw(Event::Frame(f), 7);
        assert_eq!(r.flags, FLAG_TX | FLAG_HW_TIMESTAMP);
        assert_eq!((r.arb_id, r.dlc, r.data[0], r.bus_id), (0x123, 2, 0xAA, 7));
        assert_eq!(r.timestamp_us, 5 + cansub::proto::DEVICE_EPOCH_UNIX_US);
        f.flags = FrameFlags::RTR;
        let r = event_to_raw(Event::Frame(f), 0);
        assert_eq!((r.flags & FLAG_RTR, r.dlc, r.data[0]), (FLAG_RTR, 2, 0));
    }

    #[test]
    fn error_frames_follow_socketcan_contract() {
        let r = event_to_raw(
            Event::Error {
                timestamp_us: 1,
                kind: ErrorKind::Stuff,
            },
            0,
        );
        assert!(r.is_error());
        assert_eq!(r.data[0], 3);
        let s = crate::error_frame::decode_can_error_summary(r.arb_id, r.payload());
        assert!(s.contains("Stuff"), "{s}");
        let r = event_to_raw(
            Event::Error {
                timestamp_us: 1,
                kind: ErrorKind::Other(17),
            },
            0,
        );
        assert_eq!(r.data[0], 17);
    }

    #[test]
    fn raw_to_sdk_roundtrip_fd() {
        let mut r = RawCanFrame::zeroed();
        r.arb_id = 0x1ABC_DEF0;
        r.flags = FLAG_EXTENDED | FLAG_FD | FLAG_BRS;
        r.dlc = 12;
        r.data[11] = 9;
        let s = raw_to_sdk(&r).unwrap();
        assert_eq!((s.dlc, s.data[11]), (9, 9));
        assert!(s.flags.contains(FrameFlags::BRS));
        r.dlc = 13;
        assert!(raw_to_sdk(&r).is_err());
    }
}
