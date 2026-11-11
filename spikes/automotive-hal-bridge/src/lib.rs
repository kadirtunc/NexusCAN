//! Spike: run `automotive` 0.6.0 ISO-TP + UDSClient over the NexusCAN HAL.
//! See README.md for scenarios, evidence and conclusions.

pub mod adapter;
pub mod convert;
pub mod owner;

use adapter::{ConversationLog, HalCanAdapter, LogKind};
use automotive::can::AsyncCanAdapter;
use crossbeam_channel::{bounded, Receiver};
use nexus_core::RawCanFrame;
use nexus_hal::{ChannelConfigDto, DriverRegistry, StateTable};
use owner::{BusOwner, TapFilter, TapOpenError};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Capacity of the owner -> StateTable queue (product: `FRAME_RING_CAPACITY`).
pub const TELEMETRY_RING: usize = 65_536;

/// Stand-in for the product aggregator thread: drains the bounded queue into the **real**
/// `nexus_hal::StateTable` so fan-out is exercised against the actual ingest path.
pub struct Telemetry {
    pub ingested: Arc<AtomicU64>,
    pub tx_echoes: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Telemetry {
    pub fn spawn(rx: Receiver<RawCanFrame>) -> Self {
        let ingested = Arc::new(AtomicU64::new(0));
        let tx_echoes = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (i, t, s) = (Arc::clone(&ingested), Arc::clone(&tx_echoes), Arc::clone(&stop));
        let join = std::thread::Builder::new()
            .name("aggregator".into())
            .spawn(move || {
                let mut table = StateTable::new();
                while !s.load(Ordering::Acquire) {
                    if let Ok(f) = rx.recv_timeout(Duration::from_millis(2)) {
                        table.ingest_frame(&f);
                        i.fetch_add(1, Ordering::Relaxed);
                        if f.is_tx() {
                            t.fetch_add(1, Ordering::Relaxed);
                        }
                        while let Ok(f) = rx.try_recv() {
                            table.ingest_frame(&f);
                            i.fetch_add(1, Ordering::Relaxed);
                            if f.is_tx() {
                                t.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
            })
            .expect("spawn aggregator");
        Self { ingested, tx_echoes, stop, join: Some(join) }
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

pub struct OpenBus {
    pub owner: BusOwner,
    pub telemetry: Telemetry,
}

/// Opens a device through the product `DriverRegistry` (same path as `cmd_connect_bus`).
pub fn open_bus(
    device_id: &str,
    bus_id: u8,
    listen_only: bool,
    armed: bool,
    enable_fd: bool,
    mock_fps: Option<u32>,
    thread_init: Option<fn()>,
) -> Result<OpenBus, String> {
    let registry = DriverRegistry::with_defaults();
    let cfg = ChannelConfigDto {
        bus_id,
        bitrate: 500_000,
        data_bitrate: if enable_fd { 2_000_000 } else { 500_000 },
        enable_fd,
        listen_only,
        mock_fps_preset: mock_fps,
        driver_family: None,
        serial_port: None,
        serial_baud_rate: None,
        serial_dtr_rts: None,
        adapter_channel: None,
    };
    let (_desc, channel) = registry
        .open_by_device_id(device_id, &cfg)
        .map_err(|e| format!("open {device_id}: {e}"))?;
    let (ttx, trx) = bounded::<RawCanFrame>(TELEMETRY_RING);
    let telemetry = Telemetry::spawn(trx);
    let owner = BusOwner::spawn(bus_id, channel, listen_only, armed, enable_fd, ttx, thread_init);
    Ok(OpenBus { owner, telemetry })
}

/// One active diagnostic session = one tap + one `AsyncCanAdapter` (one worker thread).
pub struct DiagSession {
    pub adapter: Arc<AsyncCanAdapter>,
    pub log: Arc<ConversationLog>,
}

pub fn open_diag_session(
    owner: &BusOwner,
    rx_filters: &[TapFilter],
    idle_wait: Duration,
    default_brs: bool,
) -> Result<DiagSession, TapOpenError> {
    let tap = owner.open_tap(rx_filters, 4_096, true)?;
    let log = Arc::new(ConversationLog::default());
    let hal = HalCanAdapter::new(tap, idle_wait, default_brs, Arc::clone(&log));
    Ok(DiagSession { adapter: Arc::new(AsyncCanAdapter::new(hal)), log })
}

/// Formats a log as candump-like lines with HAL timestamps relative to `t0_us`.
pub fn format_log(entries: &[adapter::LogEntry], t0_us: u64) -> Vec<String> {
    entries
        .iter()
        .map(|e| {
            let f = &e.frame;
            let id = if f.is_extended() { format!("{:08X}", f.arb_id) } else { format!("{:03X}", f.arb_id) };
            let kind = match e.kind {
                LogKind::Rx => "RX ".to_string(),
                LogKind::TxConfirmed => "TX ".to_string(),
                LogKind::TxRejected(r) => format!("TX-REJECTED({r:?})"),
            };
            let fd = if f.is_fd() { if f.is_brs() { "FD+BRS" } else { "FD" } } else { "CC" };
            let data: String = f.payload().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ");
            format!(
                "{:>10.3} ms  {kind} {id} {fd:<6} [{:>2}] {data}",
                (f.timestamp_us.saturating_sub(t0_us)) as f64 / 1000.0,
                f.dlc
            )
        })
        .collect()
}
