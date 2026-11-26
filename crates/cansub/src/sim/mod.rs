//! CANsub.2 / CANsub.4 device emulator (contract cansub-v1 §5), feature `sim`.
//!
//! One TCP port serves TLS 1.2 (single suite `ECDHE-ECDSA-AES128-GCM-SHA256`, run-time rcgen root CA),
//! HTTP/1.1 REST (`/api/...`, OpenAPI field names) and the per-channel WebSocket `/api/can/{ch}/ws`,
//! thread-per-connection on `std::net`. Test observability: [`SimHandle::log`] and `GET /sim/log`.
//!
//! Independence rule (§4): nothing in this module uses the crate's `proto` or `timing` modules; the wire
//! codec in [`wire`] is a second implementation validated against the official vectors, so both sides
//! check each other.

mod http;
mod source;
mod tls;
pub mod wire;
mod ws;

use std::collections::VecDeque;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub use wire::{Decoder, SimFrame, WireStats};

/// Where received (device → client) CAN traffic comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum SimSource {
    /// Deterministic mixed classical / FD, standard / extended traffic at `fps` frames/s per open channel.
    Mock {
        /// Target frame rate per channel (up to at least 50 000).
        fps: u32,
    },
    /// candump `-L` `.log` file played once with its original timing; interfaces map to channels `1..`
    /// in order of first appearance.
    Replay(PathBuf),
    /// No generated traffic (only TX acknowledgements, injected frames and error frames).
    Silent,
}

/// Fault injection for robustness tests. All randomness comes from `seed` (deterministic xorshift).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SimChaos {
    /// Split / merge HDLC frames at random WebSocket message boundaries.
    pub split_ws: bool,
    /// Probability that an outgoing HDLC frame gets a wrong CRC.
    pub corrupt_crc: f64,
    /// Probability that garbage bytes (never `0x7E`) are inserted before an outgoing HDLC frame.
    pub garbage: f64,
    /// Emit error frames from time to time on channels whose PHY has `error_frames: true`.
    pub inject_errors: bool,
    /// RNG seed.
    pub seed: u64,
    /// Delay the WebSocket close confirmation by this much after a client close (default `None` =
    /// confirm immediately). A `DELETE /api/can/{ch}/ws` arriving during the delay aborts the session
    /// (logged as [`SimCloseKind::Delete`]); exercises the §2.7 "no confirmation in 500 ms" path.
    pub close_ack_delay: Option<std::time::Duration>,
}

/// Emulator configuration.
#[derive(Clone, Debug, PartialEq)]
pub struct SimConfig {
    /// Number of CAN channels: 2 (CANsub.2) or 4 (CANsub.4).
    pub channels: u8,
    /// Device id, 8 hex digits (e.g. `"aabbccdd"`); certificate SANs are `<id>-usb.local`, `<id>-eth.local`.
    pub device_id: String,
    /// Listen address (`127.0.0.1:0` in tests).
    pub bind: SocketAddr,
    /// RX traffic source.
    pub source: SimSource,
    /// Fault injection.
    pub chaos: SimChaos,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            channels: 4,
            device_id: "aabbccdd".into(),
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            source: SimSource::Mock { fps: 1000 },
            chaos: SimChaos::default(),
        }
    }
}

/// One HTTP request received by the emulator (WebSocket upgrades included, `/sim/log` excluded).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimRequest {
    /// HTTP method, e.g. `"PUT"`.
    pub method: String,
    /// Request path without query string, e.g. `"/api/can/1/phy"`.
    pub path: String,
    /// Request body as (lossy) UTF-8.
    pub body: String,
}

/// How a channel WebSocket session ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SimCloseKind {
    /// Client WebSocket close handshake (queue drained, close confirmed).
    WsClose,
    /// `DELETE /api/can/{ch}/ws` aborted the session (queue discarded).
    Delete,
    /// TCP connection dropped without a close handshake.
    TcpDrop,
}

/// Observation log; identical to the `GET /sim/log` JSON body.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimLog {
    /// Received REST / upgrade requests in arrival order.
    pub requests: Vec<SimRequest>,
    /// Client TX frames dropped because the channel was listen-only; index = channel - 1.
    pub dropped_tx: [u64; 4],
    /// Client TX frames accepted for transmission; index = channel - 1.
    pub received_tx: [u64; 4],
    /// Ended WebSocket sessions as `(channel, kind)`.
    pub ws_closes: Vec<(u8, SimCloseKind)>,
}

/// Nominal / data bit timing (OpenAPI `bittiming`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BitTiming {
    pub(crate) brp: u32,
    pub(crate) seg1: u32,
    pub(crate) seg2: u32,
    pub(crate) sjw: u32,
}

/// PHY configuration (OpenAPI `phy`; every field required).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Phy {
    pub(crate) listen_only: bool,
    pub(crate) auto_reset: bool,
    pub(crate) error_frames: bool,
    pub(crate) tx_ack_frames: bool,
    pub(crate) timing: BitTiming,
    pub(crate) timing_data: BitTiming,
}

impl Default for Phy {
    fn default() -> Self {
        Self {
            listen_only: true,
            auto_reset: true,
            error_frames: false,
            tx_ack_frames: false,
            // 500 kbit/s and 2 Mbit/s at 80 MHz, 80 % sample point.
            timing: BitTiming {
                brp: 2,
                seg1: 63,
                seg2: 16,
                sjw: 16,
            },
            timing_data: BitTiming {
                brp: 2,
                seg1: 15,
                seg2: 4,
                sjw: 4,
            },
        }
    }
}

/// Per-channel shared state.
pub(crate) struct ChannelState {
    pub(crate) ws_active: AtomicBool,
    pub(crate) abort: AtomicBool,
    pub(crate) listen_only: AtomicBool,
    pub(crate) tx_ack_frames: AtomicBool,
    pub(crate) error_frames: AtomicBool,
    pub(crate) phy: Mutex<Phy>,
    pub(crate) inject: Mutex<VecDeque<SimFrame>>,
    pub(crate) transmit_ids: Mutex<Vec<u32>>,
    pub(crate) next_transmit_id: AtomicU32,
    pub(crate) dropped_tx: AtomicU64,
    pub(crate) received_tx: AtomicU64,
    pub(crate) frame_count: AtomicU64,
    pub(crate) frame_rate: AtomicU64,
    pub(crate) bus_errors: AtomicU64,
}

impl ChannelState {
    fn new() -> Self {
        let phy = Phy::default();
        Self {
            ws_active: AtomicBool::new(false),
            abort: AtomicBool::new(false),
            listen_only: AtomicBool::new(phy.listen_only),
            tx_ack_frames: AtomicBool::new(phy.tx_ack_frames),
            error_frames: AtomicBool::new(phy.error_frames),
            phy: Mutex::new(phy),
            inject: Mutex::new(VecDeque::new()),
            transmit_ids: Mutex::new(Vec::new()),
            next_transmit_id: AtomicU32::new(0),
            dropped_tx: AtomicU64::new(0),
            received_tx: AtomicU64::new(0),
            frame_count: AtomicU64::new(0),
            frame_rate: AtomicU64::new(0),
            bus_errors: AtomicU64::new(0),
        }
    }

    pub(crate) fn set_phy(&self, phy: Phy) {
        self.listen_only.store(phy.listen_only, Ordering::Release);
        self.tx_ack_frames
            .store(phy.tx_ack_frames, Ordering::Release);
        self.error_frames.store(phy.error_frames, Ordering::Release);
        *lock(&self.phy) = phy;
    }
}

/// Device clock: starts at 0 on "power-up"; `PUT /api/time` re-bases it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Clock {
    pub(crate) base_dev_us: u64,
    pub(crate) base: Instant,
    pub(crate) rate_ppb: i64,
    pub(crate) set_by_rest: bool,
}

impl Clock {
    /// Device time (µs since 2025-01-01) at instant `t`.
    pub(crate) fn device_us_at(&self, t: Instant) -> u64 {
        let dt = t.saturating_duration_since(self.base).as_micros() as i128;
        let adj = dt + dt * i128::from(self.rate_ppb) / 1_000_000_000;
        self.base_dev_us.saturating_add(adj.max(0) as u64)
    }
}

/// State shared by all server threads.
pub(crate) struct Shared {
    pub(crate) channels: Vec<ChannelState>,
    pub(crate) device_id: String,
    pub(crate) source: SimSource,
    pub(crate) chaos: SimChaos,
    pub(crate) replay: Arc<Vec<Vec<source::ReplayRecord>>>,
    pub(crate) stop: AtomicBool,
    pub(crate) requests: Mutex<Vec<SimRequest>>,
    pub(crate) ws_closes: Mutex<Vec<(u8, SimCloseKind)>>,
    pub(crate) clock: Mutex<Clock>,
    pub(crate) tls: Arc<rustls::ServerConfig>,
}

impl Shared {
    pub(crate) fn channel(&self, ch: u8) -> Option<&ChannelState> {
        usize::from(ch)
            .checked_sub(1)
            .and_then(|i| self.channels.get(i))
    }

    pub(crate) fn log(&self) -> SimLog {
        let mut log = SimLog {
            requests: lock(&self.requests).clone(),
            ws_closes: lock(&self.ws_closes).clone(),
            ..SimLog::default()
        };
        for (i, c) in self.channels.iter().enumerate().take(4) {
            log.dropped_tx[i] = c.dropped_tx.load(Ordering::Acquire);
            log.received_tx[i] = c.received_tx.load(Ordering::Acquire);
        }
        log
    }

    pub(crate) fn stopping(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }
}

/// Poison-tolerant lock (a panicking connection thread must not take the emulator down).
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Running emulator. Dropping it (or calling [`SimHandle::stop`]) shuts every thread down.
pub struct SimHandle {
    shared: Arc<Shared>,
    addr: SocketAddr,
    root_der: Vec<u8>,
    root_pem: String,
    accept: Option<JoinHandle<()>>,
    conns: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl std::fmt::Debug for SimHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SimHandle")
            .field("addr", &self.addr)
            .finish_non_exhaustive()
    }
}

fn invalid(msg: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, msg.into())
}

impl SimHandle {
    /// Validates `cfg`, generates the TLS material, binds and starts the accept thread.
    pub fn start(cfg: SimConfig) -> std::io::Result<SimHandle> {
        if cfg.channels != 2 && cfg.channels != 4 {
            return Err(invalid(format!(
                "channels must be 2 or 4, got {}",
                cfg.channels
            )));
        }
        if cfg.device_id.len() != 8 || !cfg.device_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid(format!(
                "device_id must be 8 hex digits, got {:?}",
                cfg.device_id
            )));
        }
        let device_id = cfg.device_id.to_ascii_lowercase();
        for p in [cfg.chaos.corrupt_crc, cfg.chaos.garbage] {
            if !(0.0..=1.0).contains(&p) {
                return Err(invalid(format!(
                    "chaos probability must be in [0, 1], got {p}"
                )));
            }
        }
        let replay = match &cfg.source {
            SimSource::Replay(path) => source::load_candump(path, cfg.channels)?,
            _ => Vec::new(),
        };
        let tls = tls::build(&device_id)?;
        let listener = TcpListener::bind(cfg.bind)?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            channels: (0..cfg.channels).map(|_| ChannelState::new()).collect(),
            device_id,
            source: cfg.source,
            chaos: cfg.chaos,
            replay: Arc::new(replay),
            stop: AtomicBool::new(false),
            requests: Mutex::new(Vec::new()),
            ws_closes: Mutex::new(Vec::new()),
            clock: Mutex::new(Clock {
                base_dev_us: 0,
                base: Instant::now(),
                rate_ppb: 0,
                set_by_rest: false,
            }),
            tls: tls.config,
        });
        let conns: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let accept = {
            let shared = Arc::clone(&shared);
            let conns = Arc::clone(&conns);
            std::thread::Builder::new()
                .name("cansub-sim-accept".into())
                .spawn(move || accept_loop(&listener, &shared, &conns))?
        };
        Ok(SimHandle {
            shared,
            addr,
            root_der: tls.root_der,
            root_pem: tls.root_pem,
            accept: Some(accept),
            conns,
        })
    }

    /// Bound address (resolves port 0).
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// DER of the run-time test root CA (ECDSA P-256) that signed the device certificate.
    pub fn root_ca_der(&self) -> &[u8] {
        &self.root_der
    }

    /// PEM of the run-time test root CA (written by `cansub-sim --ca-out`).
    pub fn root_ca_pem(&self) -> &str {
        &self.root_pem
    }

    /// Snapshot of the observation log (same data as `GET /sim/log`).
    pub fn log(&self) -> SimLog {
        self.shared.log()
    }

    /// Queues frames to be delivered as received traffic on channel `ch` (1-based). Frames with
    /// `timestamp == 0` get the current device time. Ignored when no WebSocket is open on the channel.
    pub fn inject(&self, ch: u8, frames: &[SimFrame]) {
        if let Some(c) = self.shared.channel(ch) {
            if c.ws_active.load(Ordering::Acquire) {
                lock(&c.inject).extend(frames.iter().copied());
            }
        }
    }

    /// Stops the emulator and joins all threads (also done on drop).
    pub fn stop(self) {
        drop(self);
    }

    fn shutdown(&mut self) {
        let Some(accept) = self.accept.take() else {
            return;
        };
        self.shared.stop.store(true, Ordering::Release);
        let mut wake = self.addr;
        if wake.ip().is_unspecified() {
            wake.set_ip(if wake.is_ipv4() {
                [127, 0, 0, 1].into()
            } else {
                std::net::Ipv6Addr::LOCALHOST.into()
            });
        }
        let _ = TcpStream::connect_timeout(&wake, std::time::Duration::from_millis(200));
        let _ = accept.join();
        let handles: Vec<_> = lock(&self.conns).drain(..).collect();
        for h in handles {
            let _ = h.join();
        }
    }
}

impl Drop for SimHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn accept_loop(
    listener: &TcpListener,
    shared: &Arc<Shared>,
    conns: &Arc<Mutex<Vec<JoinHandle<()>>>>,
) {
    for stream in listener.incoming() {
        if shared.stopping() {
            break;
        }
        let Ok(stream) = stream else { continue };
        let sh = Arc::clone(shared);
        let spawned = std::thread::Builder::new()
            .name("cansub-sim-conn".into())
            .spawn(move || http::serve_connection(&sh, stream));
        if let Ok(h) = spawned {
            let mut g = lock(conns);
            g.retain(|h| !h.is_finished());
            g.push(h);
        }
    }
}
