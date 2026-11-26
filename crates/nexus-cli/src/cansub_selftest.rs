//! `nexuscan cansub-selftest` — real-device acceptance check for CSS Electronics CANsub.2 /
//! CANsub.4 (contract cansub-v1 §6).
//!
//! Flow: connect → `info` → `set_time_now` → `channel_status` → `configure(listen_only = true,
//! error_frames, tx_ack_frames, timing)` → `open(ch)` → poll for `duration` (frame counters, FD /
//! classical split, error-frame kinds, `DecoderStats`, timestamp monotonicity, host − device clock
//! offset) → `close`. Optional `--tx-loopback <rx_ch>`: `ch` is re-configured ACTIVE
//! (`listen_only = false`), `rx_ch` listens, 100 test frames are sent and TX-ack ↔ RX timestamps
//! compared; `ch` is ALWAYS put back to listen-only afterwards (finally semantics).
//!
//! The report is one pretty JSON document on stdout. Exit codes: `0` pass, `1` test failed
//! (incl. loopback loss or any recorded error), `2` connection / TLS failure.
//!
//! Hot path: the poll sinks only update fixed-size counters (no per-frame heap allocation).

use std::io::Write;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cansub::client::CanState;
use cansub::proto::{CanFrame, DecoderStats, ErrorKind, Event, FrameFlags};
use cansub::timing::BitTiming;
use cansub::{Channel, ConnectOptions, Device, PhyConfig};
use nexus_hal::drivers::cansub_drv::{select_fd_timing, select_nominal_timing};
use serde::Serialize;

/// Exit code: all checks passed.
pub const SELFTEST_EXIT_PASS: i32 = 0;
/// Exit code: a check failed (RX phase error, loopback loss, …).
pub const SELFTEST_EXIT_FAIL: i32 = 1;
/// Exit code: connection / TLS / API-version failure.
pub const SELFTEST_EXIT_CONNECT: i32 = 2;

/// Number of loopback test frames.
pub const LOOPBACK_FRAMES: usize = 100;
/// First loopback identifier; frames cycle through `0x7E0..=0x7FF` (11-bit).
pub const LOOPBACK_BASE_ID: u32 = 0x7E0;
const LOOPBACK_MAGIC: [u8; 2] = [0xA5, 0x5A];
/// Data-phase filler for classical (non-FD) PHY configs: all six PHY fields are always sent.
const CLASSIC_DATA_FILLER_BPS: u32 = 2_000_000;
const POLL_SLICE: Duration = Duration::from_millis(100);
const LOOPBACK_WAIT: Duration = Duration::from_secs(2);

/// Parsed `cansub-selftest` arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CansubSelftestArgs {
    /// `name[:port]`, `ipv4[:port]` or `[ipv6]:port`.
    pub host: String,
    /// Device ID (8 hex digits) for the §2.6 SAN check.
    pub device_id: Option<String>,
    /// Accept any device chaining to the CSS root (no Device ID).
    pub accept_any: bool,
    /// Channel under test (1-based).
    pub channel: u8,
    /// Listen-only RX duration in seconds.
    pub duration_s: u32,
    /// Nominal bitrate (bit/s).
    pub bitrate: u32,
    /// CAN-FD data bitrate (bit/s).
    pub data_bitrate: u32,
    /// Configure CAN-FD timing.
    pub fd: bool,
    /// `--tx-loopback <rx_ch>`: second channel on the same bus.
    pub tx_loopback: Option<u8>,
}

impl Default for CansubSelftestArgs {
    fn default() -> Self {
        Self {
            host: String::new(),
            device_id: None,
            accept_any: false,
            channel: 1,
            duration_s: 30,
            bitrate: 500_000,
            data_bitrate: 2_000_000,
            fd: false,
            tx_loopback: None,
        }
    }
}

/// `version` section.
#[derive(Clone, Debug, Serialize)]
pub struct VersionReport {
    /// `nexuscan` CLI version.
    pub cli: &'static str,
    /// Device REST API version (`/api/version`), once connected.
    pub device_api: Option<String>,
}

/// `info` section (`/api/info`).
#[derive(Clone, Debug, Serialize)]
pub struct InfoReport {
    pub id: String,
    pub variant: String,
    pub hw: String,
    pub fw: String,
    pub api: String,
    pub channels: u8,
}

/// `min` / `avg` / `max` over `samples`.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct StatReport {
    pub min: f64,
    pub avg: f64,
    pub max: f64,
    pub samples: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct StatAcc {
    min: f64,
    max: f64,
    sum: f64,
    n: u64,
}

impl StatAcc {
    fn push(&mut self, v: f64) {
        if self.n == 0 {
            self.min = v;
            self.max = v;
        } else {
            self.min = self.min.min(v);
            self.max = self.max.max(v);
        }
        self.sum += v;
        self.n += 1;
    }

    fn report(&self) -> Option<StatReport> {
        (self.n > 0).then(|| StatReport {
            min: self.min,
            avg: self.sum / self.n as f64,
            max: self.max,
            samples: self.n,
        })
    }
}

/// `time` section.
#[derive(Clone, Debug, Serialize)]
pub struct TimeReport {
    /// `PUT /api/time` succeeded (or was a PTP no-op).
    pub set_time_ok: bool,
    /// Host receive time − device frame timestamp, milliseconds (includes transport latency).
    pub host_offset_ms: Option<StatReport>,
    /// Device timestamps never decreased during the RX phase.
    pub timestamps_monotonic: bool,
    /// Number of timestamp decreases.
    pub timestamp_regressions: u64,
}

/// One phase's bit timing.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct TimingReport {
    pub brp: u16,
    pub seg1: u16,
    pub seg2: u16,
    pub sjw: u16,
}

impl From<BitTiming> for TimingReport {
    fn from(t: BitTiming) -> Self {
        Self {
            brp: t.brp,
            seg1: t.seg1,
            seg2: t.seg2,
            sjw: t.sjw,
        }
    }
}

/// `phy` section (configuration used for the RX phase).
#[derive(Clone, Debug, Serialize)]
pub struct PhyReport {
    pub channel: u8,
    pub listen_only: bool,
    pub auto_reset: bool,
    pub error_frames: bool,
    pub tx_ack_frames: bool,
    pub fd: bool,
    pub bitrate: u32,
    pub data_bitrate: u32,
    pub sample_point_permille: u16,
    pub timing: TimingReport,
    pub timing_data: TimingReport,
}

/// `channel_status` section (`GET /api/can/{ch}` before the RX phase).
#[derive(Clone, Debug, Serialize)]
pub struct ChannelStatusReport {
    pub state: &'static str,
    pub frame_count: u64,
    pub frame_rate: u64,
    pub bus_load: u8,
    pub rx_error_count: u32,
    pub tx_error_count: u32,
    pub bus_error_count: u64,
}

/// Error frames by kind.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct ErrorFrameCounts {
    pub bit: u64,
    pub ack: u64,
    pub form: u64,
    pub stuff: u64,
    pub crc: u64,
    pub other: u64,
    pub total: u64,
}

/// `rx_stats` section.
#[derive(Clone, Debug, Serialize)]
pub struct RxStatsReport {
    pub channel: u8,
    /// Measured RX phase duration, seconds.
    pub duration_s: f64,
    /// CAN frames (TX-acks included).
    pub frames: u64,
    pub classic: u64,
    pub fd: u64,
    pub brs: u64,
    pub esi: u64,
    pub extended: u64,
    pub rtr: u64,
    pub tx_ack: u64,
    pub frames_per_s: f64,
    pub error_frames: ErrorFrameCounts,
}

/// `decoder_stats` section (SDK [`DecoderStats`]).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct DecoderStatsReport {
    pub hdlc_ok: u64,
    pub crc_errors: u64,
    pub overflows: u64,
    pub truncated_frames: u64,
    pub garbage_bytes: u64,
    pub unknown_errors: u64,
}

impl From<DecoderStats> for DecoderStatsReport {
    fn from(s: DecoderStats) -> Self {
        Self {
            hdlc_ok: s.hdlc_ok,
            crc_errors: s.crc_errors,
            overflows: s.overflows,
            truncated_frames: s.truncated_frames,
            garbage_bytes: s.garbage_bytes,
            unknown_errors: s.unknown_errors,
        }
    }
}

/// `loopback` section.
#[derive(Clone, Debug, Serialize)]
pub struct LoopbackReport {
    pub tx_channel: u8,
    pub rx_channel: u8,
    pub sent: u64,
    pub tx_acked: u64,
    pub rx_received: u64,
    pub lost: u64,
    /// RX timestamp − TX-ack timestamp, microseconds.
    pub delta_us: Option<StatReport>,
    /// `tx_channel` was put back to listen-only.
    pub restored_listen_only: bool,
    pub passed: bool,
}

/// Full JSON report (contract cansub-v1 §6).
#[derive(Clone, Debug, Serialize)]
pub struct SelftestReport {
    pub version: VersionReport,
    pub info: Option<InfoReport>,
    pub time: Option<TimeReport>,
    pub phy: Option<PhyReport>,
    pub channel_status: Option<ChannelStatusReport>,
    pub rx_stats: Option<RxStatsReport>,
    pub decoder_stats: Option<DecoderStatsReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loopback: Option<LoopbackReport>,
    pub errors: Vec<String>,
    /// `"pass"`, `"fail"` or `"connect_failed"`.
    pub result: &'static str,
}

/// Report + process exit code.
#[derive(Clone, Debug)]
pub struct SelftestOutcome {
    pub report: SelftestReport,
    pub exit_code: i32,
}

/// Connection factory: production uses [`Device::connect`] (embedded CSS root only); tests pass
/// the SDK's `connect_with_root` with the emulator root.
pub type DeviceConnector<'a> = dyn Fn(ConnectOptions) -> Result<Device, cansub::Error> + 'a;

/// CLI entry: runs the selftest against the real device (embedded CSS root), prints the JSON
/// report to `stdout` and returns the exit code.
pub fn execute_cansub_selftest(
    args: &CansubSelftestArgs,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let outcome = run_cansub_selftest(args, &Device::connect, stderr);
    match serde_json::to_string_pretty(&outcome.report) {
        Ok(json) => {
            let _ = writeln!(stdout, "{json}");
        }
        Err(e) => {
            let _ = writeln!(stderr, "Error: report serialization failed: {e}");
        }
    }
    outcome.exit_code
}

fn unix_us_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
}

fn state_name(s: CanState) -> &'static str {
    match s {
        CanState::ErrorActive => "error_active",
        CanState::ErrorWarning => "error_warning",
        CanState::ErrorPassive => "error_passive",
        CanState::BusOff => "bus_off",
        CanState::Stopped => "stopped",
        CanState::Unknown => "unknown",
    }
}

/// Nominal sample point (‰) chosen by the driver-equivalent search for `args` (0 if none fits).
fn selected_sample_point(args: &CansubSelftestArgs) -> u16 {
    if args.fd {
        select_fd_timing(args.bitrate, args.data_bitrate).map_or(0, |(sp, _, _)| sp)
    } else {
        select_nominal_timing(args.bitrate).map_or(0, |(sp, _)| sp)
    }
}

fn phy_for(args: &CansubSelftestArgs, listen_only: bool) -> Result<PhyConfig, String> {
    // Same sample-point search as the NexusCAN driver (800 ‰ first, then [700, 900] by distance).
    let (timing, timing_data) = if args.fd {
        let (_sp, n, d) = select_fd_timing(args.bitrate, args.data_bitrate).ok_or_else(|| {
            format!(
                "no exact 80 MHz CAN-FD bit timing for {} bit/s nominal / {} bit/s data \
                 (shared BRP, sample point 70..90 %)",
                args.bitrate, args.data_bitrate
            )
        })?;
        (n, d)
    } else {
        let (_sp, n) = select_nominal_timing(args.bitrate).ok_or_else(|| {
            format!(
                "no exact 80 MHz bit timing for {} bit/s (sample point 70..90 %)",
                args.bitrate
            )
        })?;
        let d = select_fd_timing(args.bitrate, CLASSIC_DATA_FILLER_BPS)
            .map_or(PhyConfig::default().timing_data, |(_, _, d)| d);
        (n, d)
    };
    Ok(PhyConfig {
        listen_only,
        auto_reset: true,
        error_frames: true,
        tx_ack_frames: true,
        timing,
        timing_data,
    })
}

/// Fixed-size RX counters fed from the poll sink (no heap per frame).
#[derive(Default)]
struct RxAcc {
    frames: u64,
    classic: u64,
    fd: u64,
    brs: u64,
    esi: u64,
    extended: u64,
    rtr: u64,
    tx_ack: u64,
    errors: ErrorFrameCounts,
    last_ts: Option<u64>,
    regressions: u64,
    offset_ms: StatAcc,
}

impl RxAcc {
    fn track_ts(&mut self, ts: u64) {
        if let Some(last) = self.last_ts {
            if ts < last {
                self.regressions += 1;
            }
        }
        self.last_ts = Some(ts);
    }

    fn on_event(&mut self, ev: Event) {
        match ev {
            Event::Frame(f) => {
                self.frames += 1;
                let fl = f.flags;
                if fl.contains(FrameFlags::FD) {
                    self.fd += 1;
                    if fl.contains(FrameFlags::BRS) {
                        self.brs += 1;
                    }
                    if fl.contains(FrameFlags::ESI) {
                        self.esi += 1;
                    }
                } else {
                    self.classic += 1;
                    if fl.contains(FrameFlags::RTR) {
                        self.rtr += 1;
                    }
                }
                if fl.contains(FrameFlags::EXTENDED) {
                    self.extended += 1;
                }
                if fl.contains(FrameFlags::TX_ACK) {
                    self.tx_ack += 1;
                }
                self.track_ts(f.timestamp_us);
                let host = unix_us_now() as i128;
                let dev = f.unix_us() as i128;
                self.offset_ms.push((host - dev) as f64 / 1000.0);
            }
            Event::Error { timestamp_us, kind } => {
                let e = &mut self.errors;
                match kind {
                    ErrorKind::Bit => e.bit += 1,
                    ErrorKind::Ack => e.ack += 1,
                    ErrorKind::Form => e.form += 1,
                    ErrorKind::Stuff => e.stuff += 1,
                    ErrorKind::Crc => e.crc += 1,
                    ErrorKind::Other(_) => e.other += 1,
                }
                e.total += 1;
                self.track_ts(timestamp_us);
            }
        }
    }
}

/// Runs the selftest with `connect` and returns the report (nothing is printed except the
/// loopback warning on `stderr`).
pub fn run_cansub_selftest(
    args: &CansubSelftestArgs,
    connect: &DeviceConnector<'_>,
    stderr: &mut dyn Write,
) -> SelftestOutcome {
    let mut report = SelftestReport {
        version: VersionReport {
            cli: crate::cli::CLI_VERSION,
            device_api: None,
        },
        info: None,
        time: None,
        phy: None,
        channel_status: None,
        rx_stats: None,
        decoder_stats: None,
        loopback: None,
        errors: Vec::new(),
        result: "fail",
    };

    let phy = match phy_for(args, true) {
        Ok(p) => p,
        Err(e) => {
            report.errors.push(e);
            return SelftestOutcome {
                report,
                exit_code: SELFTEST_EXIT_FAIL,
            };
        }
    };

    let dev = match connect(ConnectOptions {
        host: args.host.clone(),
        device_id: args.device_id.clone(),
        accept_any_device: args.accept_any,
        ..ConnectOptions::default()
    }) {
        Ok(d) => d,
        Err(e) => {
            report.errors.push(format!("connect to {}: {e}", args.host));
            report.result = "connect_failed";
            return SelftestOutcome {
                report,
                exit_code: SELFTEST_EXIT_CONNECT,
            };
        }
    };

    let info = dev.info();
    report.version.device_api = Some(info.api.clone());
    report.info = Some(InfoReport {
        id: info.id.clone(),
        variant: info.variant.clone(),
        hw: info.hw.clone(),
        fw: info.fw.clone(),
        api: info.api.clone(),
        channels: info.channels,
    });

    let set_time_ok = match dev.set_time_now() {
        Ok(()) => true,
        Err(e) => {
            report.errors.push(format!("set_time_now: {e}"));
            false
        }
    };

    let ch = args.channel;
    match dev.channel_status(ch) {
        Ok(s) => {
            report.channel_status = Some(ChannelStatusReport {
                state: state_name(s.state),
                frame_count: s.frame_count,
                frame_rate: s.frame_rate,
                bus_load: s.bus_load,
                rx_error_count: s.rx_error_count,
                tx_error_count: s.tx_error_count,
                bus_error_count: s.bus_error_count,
            });
        }
        Err(e) => report.errors.push(format!("channel_status CH{ch}: {e}")),
    }

    report.phy = Some(PhyReport {
        channel: ch,
        listen_only: phy.listen_only,
        auto_reset: phy.auto_reset,
        error_frames: phy.error_frames,
        tx_ack_frames: phy.tx_ack_frames,
        fd: args.fd,
        bitrate: args.bitrate,
        data_bitrate: if args.fd {
            args.data_bitrate
        } else {
            CLASSIC_DATA_FILLER_BPS
        },
        sample_point_permille: selected_sample_point(args),
        timing: phy.timing.into(),
        timing_data: phy.timing_data.into(),
    });

    let mut acc = RxAcc::default();
    let rx_ok = rx_phase(&dev, args, &phy, &mut acc, &mut report);
    report.time = Some(TimeReport {
        set_time_ok,
        host_offset_ms: acc.offset_ms.report(),
        timestamps_monotonic: acc.regressions == 0,
        timestamp_regressions: acc.regressions,
    });

    if let (true, Some(rx_ch)) = (rx_ok, args.tx_loopback) {
        let lb = loopback_phase(&dev, args, rx_ch, &mut report.errors, stderr);
        report.loopback = Some(lb);
    }

    let loop_ok = !matches!(report.loopback, Some(ref l) if !l.passed);
    let pass = report.errors.is_empty() && loop_ok;
    report.result = if pass { "pass" } else { "fail" };
    SelftestOutcome {
        report,
        exit_code: if pass {
            SELFTEST_EXIT_PASS
        } else {
            SELFTEST_EXIT_FAIL
        },
    }
}

/// Listen-only RX phase. Returns `false` if the channel could not be configured / opened.
fn rx_phase(
    dev: &Device,
    args: &CansubSelftestArgs,
    phy: &PhyConfig,
    acc: &mut RxAcc,
    report: &mut SelftestReport,
) -> bool {
    let ch = args.channel;
    if let Err(e) = dev.configure(ch, phy) {
        report.errors.push(format!("configure CH{ch}: {e}"));
        return false;
    }
    let mut chan = match dev.open(ch) {
        Ok(c) => c,
        Err(e) => {
            report.errors.push(format!("open CH{ch}: {e}"));
            return false;
        }
    };
    let start = Instant::now();
    let deadline = start + Duration::from_secs(u64::from(args.duration_s));
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Err(e) = chan.poll(remaining.min(POLL_SLICE), &mut |ev| acc.on_event(ev)) {
            report.errors.push(format!("poll CH{ch}: {e}"));
            break;
        }
    }
    let elapsed = start.elapsed().as_secs_f64();
    report.decoder_stats = Some(chan.stats().into());
    report.rx_stats = Some(RxStatsReport {
        channel: ch,
        duration_s: elapsed,
        frames: acc.frames,
        classic: acc.classic,
        fd: acc.fd,
        brs: acc.brs,
        esi: acc.esi,
        extended: acc.extended,
        rtr: acc.rtr,
        tx_ack: acc.tx_ack,
        frames_per_s: if elapsed > 0.0 {
            acc.frames as f64 / elapsed
        } else {
            0.0
        },
        error_frames: acc.errors,
    });
    if let Err(e) = chan.close(dev) {
        report.errors.push(format!("close CH{ch}: {e}"));
    }
    true
}

/// Sequence number of a loopback test frame, if `f` is one.
fn loopback_seq(f: &CanFrame) -> Option<usize> {
    if f.flags.contains(FrameFlags::EXTENDED)
        || !(LOOPBACK_BASE_ID..=0x7FF).contains(&f.id)
        || f.len() < 4
        || f.data[..2] != LOOPBACK_MAGIC
    {
        return None;
    }
    let seq = usize::from(u16::from_be_bytes([f.data[2], f.data[3]]));
    (seq < LOOPBACK_FRAMES).then_some(seq)
}

fn loopback_frames(fd: bool) -> [CanFrame; LOOPBACK_FRAMES] {
    let flags = if fd {
        FrameFlags::FD.union(FrameFlags::BRS)
    } else {
        FrameFlags::default()
    };
    let mut out = [CanFrame {
        timestamp_us: 0,
        id: LOOPBACK_BASE_ID,
        flags,
        dlc: 8,
        data: [0; 64],
    }; LOOPBACK_FRAMES];
    for (i, f) in out.iter_mut().enumerate() {
        // i < 100: both casts are lossless.
        f.id = LOOPBACK_BASE_ID + (i as u32 % 32);
        f.data[..2].copy_from_slice(&LOOPBACK_MAGIC);
        f.data[2..4].copy_from_slice(&(i as u16).to_be_bytes());
    }
    out
}

/// Per-sequence device timestamps (fixed arrays, no heap).
struct LoopbackTrack {
    ack: [Option<u64>; LOOPBACK_FRAMES],
    rx: [Option<u64>; LOOPBACK_FRAMES],
    acked: usize,
    received: usize,
}

impl LoopbackTrack {
    fn on_tx_event(&mut self, ev: Event) {
        if let Event::Frame(f) = ev {
            if f.flags.contains(FrameFlags::TX_ACK) {
                if let Some(slot) = loopback_seq(&f).and_then(|s| self.ack.get_mut(s)) {
                    if slot.is_none() {
                        *slot = Some(f.timestamp_us);
                        self.acked += 1;
                    }
                }
            }
        }
    }

    fn on_rx_event(&mut self, ev: Event) {
        if let Event::Frame(f) = ev {
            if !f.flags.contains(FrameFlags::TX_ACK) {
                if let Some(slot) = loopback_seq(&f).and_then(|s| self.rx.get_mut(s)) {
                    if slot.is_none() {
                        *slot = Some(f.timestamp_us);
                        self.received += 1;
                    }
                }
            }
        }
    }

    fn done(&self) -> bool {
        self.acked == LOOPBACK_FRAMES && self.received == LOOPBACK_FRAMES
    }
}

fn loopback_phase(
    dev: &Device,
    args: &CansubSelftestArgs,
    rx_ch: u8,
    errors: &mut Vec<String>,
    stderr: &mut dyn Write,
) -> LoopbackReport {
    let ch = args.channel;
    let _ = writeln!(
        stderr,
        "WARNING: --tx-loopback switches CANsub CH{ch} to ACTIVE mode (ACK + TX) and transmits \
         {LOOPBACK_FRAMES} test frames (ID 0x{LOOPBACK_BASE_ID:03X}..0x7FF) on the bus; CH{rx_ch} \
         listens. Use only on a bench / isolated bus. CH{ch} is returned to listen-only afterwards."
    );
    let mut track = LoopbackTrack {
        ack: [None; LOOPBACK_FRAMES],
        rx: [None; LOOPBACK_FRAMES],
        acked: 0,
        received: 0,
    };
    let mut sent = 0u64;
    let mut tx_slot: Option<Channel> = None;
    let mut rx_slot: Option<Channel> = None;

    let res = loopback_body(
        dev,
        args,
        rx_ch,
        &mut tx_slot,
        &mut rx_slot,
        &mut track,
        &mut sent,
    );
    if let Err(e) = res {
        errors.push(e);
    }

    // Finally: put the TX channel back to listen-only whatever happened above. Try while the
    // WebSocket is still open (like Panic Stop), retry after closing if the device refused.
    let restore = phy_for(args, true);
    let mut restored = match &restore {
        Ok(p) => dev.configure(ch, p).is_ok(),
        Err(_) => false,
    };
    if let Some(c) = tx_slot.take() {
        if let Err(e) = c.close(dev) {
            errors.push(format!("loopback close CH{ch}: {e}"));
        }
    }
    if !restored {
        restored = match &restore {
            Ok(p) => match dev.configure(ch, p) {
                Ok(()) => true,
                Err(e) => {
                    errors.push(format!(
                        "SAFETY: could not restore listen-only on CH{ch}: {e}"
                    ));
                    false
                }
            },
            Err(e) => {
                errors.push(format!(
                    "SAFETY: could not restore listen-only on CH{ch}: {e}"
                ));
                false
            }
        };
    }
    if let Some(c) = rx_slot.take() {
        if let Err(e) = c.close(dev) {
            errors.push(format!("loopback close CH{rx_ch}: {e}"));
        }
    }

    let mut delta = StatAcc::default();
    for (a, r) in track.ack.iter().zip(track.rx.iter()) {
        if let (Some(a), Some(r)) = (a, r) {
            delta.push((i128::from(*r) - i128::from(*a)) as f64);
        }
    }
    let tx_acked = track.acked as u64;
    let rx_received = track.received as u64;
    let passed =
        restored && sent == LOOPBACK_FRAMES as u64 && tx_acked == sent && rx_received == sent;
    LoopbackReport {
        tx_channel: ch,
        rx_channel: rx_ch,
        sent,
        tx_acked,
        rx_received,
        lost: sent.saturating_sub(rx_received),
        delta_us: delta.report(),
        restored_listen_only: restored,
        passed,
    }
}

fn loopback_body(
    dev: &Device,
    args: &CansubSelftestArgs,
    rx_ch: u8,
    tx_slot: &mut Option<Channel>,
    rx_slot: &mut Option<Channel>,
    track: &mut LoopbackTrack,
    sent: &mut u64,
) -> Result<(), String> {
    let ch = args.channel;
    let listen = phy_for(args, true)?;
    let active = phy_for(args, false)?;
    dev.configure(rx_ch, &listen)
        .map_err(|e| format!("loopback configure CH{rx_ch}: {e}"))?;
    let rx = rx_slot.insert(
        dev.open(rx_ch)
            .map_err(|e| format!("loopback open CH{rx_ch}: {e}"))?,
    );
    dev.configure(ch, &active)
        .map_err(|e| format!("loopback configure CH{ch} active: {e}"))?;
    let tx = tx_slot.insert(
        dev.open(ch)
            .map_err(|e| format!("loopback open CH{ch}: {e}"))?,
    );

    let frames = loopback_frames(args.fd);
    let short = Duration::from_millis(2);
    for batch in frames.chunks(10) {
        tx.send(batch)
            .map_err(|e| format!("loopback send CH{ch}: {e}"))?;
        *sent += batch.len() as u64;
        tx.poll(short, &mut |ev| track.on_tx_event(ev))
            .map_err(|e| format!("loopback poll CH{ch}: {e}"))?;
        rx.poll(short, &mut |ev| track.on_rx_event(ev))
            .map_err(|e| format!("loopback poll CH{rx_ch}: {e}"))?;
    }
    let deadline = Instant::now() + LOOPBACK_WAIT;
    while !track.done() && Instant::now() < deadline {
        tx.poll(short, &mut |ev| track.on_tx_event(ev))
            .map_err(|e| format!("loopback poll CH{ch}: {e}"))?;
        rx.poll(short, &mut |ev| track.on_rx_event(ev))
            .map_err(|e| format!("loopback poll CH{rx_ch}: {e}"))?;
    }
    Ok(())
}
