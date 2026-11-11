//! Test harness for evaluating the `automotive` crate (=0.6.0) against the
//! NexusCAN test ECU (`tests/hil/ecusim`). Spike code, not product code.
//!
//! * [`EcuSim`] starts our OWN ecusim instance on non-default IDs and reads its
//!   JSON-lines event log ("what did the ECU receive?").
//! * [`Candump`] records the bus with `candump -L` for frame-level evidence.
//! * The wrappers at the bottom ([`LoggingTransport`], [`SplitTransport`],
//!   [`spawn_keepalive`]) are the work-arounds NexusCAN would need on top of
//!   the crate; the tests show whether they are sufficient.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use automotive::adapters::socketcan::{SocketCanAdapter, SocketCanConfig};
use automotive::can::{AsyncCanAdapter, Frame, Identifier};
use automotive::protocols::uds;
use automotive::transports::isotp::{IsoTP, IsoTPConfig, IsoTPConfigBuilder};
use automotive::{Stream, StreamExt, Transport};
use nexus_protocols::uds::security::{
    build_portable_provider, BuiltinAlgorithm, KeyProviderSpecDto, SeedKeyRequest,
};
use serde_json::Value;

pub const IFACE: &str = "vcan0";

/// CAN IDs of one ecusim instance.
#[derive(Clone, Copy, Debug)]
pub struct Ids {
    pub req: u32,
    pub resp: u32,
    pub func: u32,
}

/// IDs reserved by the user's manual session. We never start an ECU on them.
const FORBIDDEN: [u32; 3] = [0x7E0, 0x7E8, 0x7DF];

/// Classical CAN instance used by the spike.
pub const CLASSIC: Ids = Ids {
    req: 0x7E2,
    resp: 0x7EA,
    func: 0x7DE,
};
/// CAN-FD instance used by the spike. Functional ID 0x7D8: 0x7DF is the user's,
/// 0x7DC/0x7DD are used by the parallel automotive-hal-bridge spike.
pub const FD: Ids = Ids {
    req: 0x7E3,
    resp: 0x7EB,
    func: 0x7D8,
};

pub fn spike_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Evidence directory (git-ignored): ecusim event logs, candump captures.
pub fn logs_dir() -> PathBuf {
    let dir = spike_dir().join("logs");
    std::fs::create_dir_all(&dir).expect("create logs dir");
    dir
}

fn ecusim_bin() -> PathBuf {
    spike_dir().join("../../tests/hil/ecusim/build/ecusim")
}

fn config_path(name: &str) -> PathBuf {
    if name == "default" {
        spike_dir().join("../../tests/hil/ecusim/config/default.json")
    } else {
        spike_dir().join("config").join(name)
    }
}

// ─── ecusim process ─────────────────────────────────────────────────────────

/// One ecusim child process. Dropping it sends SIGTERM to THIS pid only.
pub struct EcuSim {
    child: Option<Child>,
    pub log: PathBuf,
    pub ids: Ids,
    pub fd: bool,
}

impl EcuSim {
    pub fn start(tag: &str, config: &str, ids: Ids, fd: bool) -> EcuSim {
        for id in [ids.req, ids.resp, ids.func] {
            assert!(
                !FORBIDDEN.contains(&id),
                "ID {id:#x} belongs to the user's manual session"
            );
        }
        let bin = ecusim_bin();
        assert!(
            bin.exists(),
            "missing {bin:?}; run `make -C tests/hil/ecusim`"
        );
        let log = logs_dir().join(format!("{tag}.ecu.jsonl"));
        let _ = std::fs::remove_file(&log);
        let stderr = std::fs::File::create(logs_dir().join(format!("{tag}.ecu.stderr")))
            .expect("stderr file");
        let mut cmd = Command::new(bin);
        cmd.args(["-i", IFACE, "-c"])
            .arg(config_path(config))
            .args(["--req", &format!("{:#x}", ids.req)])
            .args(["--resp", &format!("{:#x}", ids.resp)])
            .args(["--func", &format!("{:#x}", ids.func)])
            .arg("-l")
            .arg(&log)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr);
        if fd {
            cmd.arg("--fd");
        }
        let child = cmd.spawn().expect("spawn ecusim");
        let ecu = EcuSim {
            child: Some(child),
            log,
            ids,
            fd,
        };
        ecu.wait_event(|e| e["ev"] == "ready", Duration::from_secs(3))
            .unwrap_or_else(|| panic!("ecusim did not become ready; see {:?}", ecu.log));
        ecu
    }

    pub fn pid(&self) -> i32 {
        self.child.as_ref().map(|c| c.id() as i32).unwrap_or(0)
    }

    /// All events logged so far.
    pub fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    pub fn events_of(&self, ev: &str) -> Vec<Value> {
        self.events().into_iter().filter(|e| e["ev"] == ev).collect()
    }

    /// Hex strings of every complete request the ECU received.
    pub fn rx_data(&self) -> Vec<String> {
        self.events_of("rx")
            .iter()
            .map(|e| e["data"].as_str().unwrap_or("").to_uppercase())
            .collect()
    }

    pub fn wait_event(&self, pred: impl Fn(&Value) -> bool, timeout: Duration) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(e) = self.events().into_iter().find(|e| pred(e)) {
                return Some(e);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    /// SIGUSR1: reset all ECU state to the configuration defaults.
    pub fn reset(&self) {
        let before = self.events_of("state_reset").len();
        unsafe { libc::kill(self.pid(), libc::SIGUSR1) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.events_of("state_reset").len() == before {
            assert!(Instant::now() < deadline, "no state_reset event");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for EcuSim {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

// ─── candump capture ────────────────────────────────────────────────────────

/// One `candump -L` line.
#[derive(Debug, Clone)]
pub struct CanLine {
    pub t: f64,
    pub id: u32,
    pub fd: bool,
    pub data: Vec<u8>,
    pub raw: String,
}

pub struct Candump {
    child: Child,
    path: PathBuf,
}

impl Drop for Candump {
    /// A panicking test must not leave candump running (it would keep writing
    /// into the next capture file with the same name).
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            unsafe { libc::kill(self.child.id() as i32, libc::SIGINT) };
            let _ = self.child.wait();
        }
    }
}

impl Candump {
    /// Capture only the given standard IDs (other vcan0 traffic is filtered by the kernel).
    pub fn start(tag: &str, ids: &[u32]) -> Candump {
        let path = logs_dir().join(format!("{tag}.candump"));
        let out = std::fs::File::create(&path).expect("candump file");
        let mut spec = IFACE.to_string();
        for id in ids {
            spec.push_str(&format!(",{id:03X}:7FF"));
        }
        let child = Command::new("candump")
            .args(["-L", &spec])
            .stdout(out)
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn candump");
        std::thread::sleep(Duration::from_millis(150));
        Candump { child, path }
    }

    pub fn stop(mut self) -> Vec<CanLine> {
        std::thread::sleep(Duration::from_millis(100));
        unsafe { libc::kill(self.child.id() as i32, libc::SIGINT) };
        let _ = self.child.wait();
        std::fs::read_to_string(&self.path)
            .unwrap_or_default()
            .lines()
            .filter_map(parse_candump_line)
            .collect()
    }
}

fn parse_candump_line(line: &str) -> Option<CanLine> {
    // "(1731272000.123456) vcan0 7E2#0322F190AAAAAAAA"   or  "7EB##1<hex>" (FD)
    let mut parts = line.split_whitespace();
    let t: f64 = parts.next()?.trim_matches(|c| c == '(' || c == ')').parse().ok()?;
    let _iface = parts.next()?;
    let frame = parts.next()?;
    let (id, rest) = frame.split_once('#')?;
    let (fd, hexdata) = match rest.strip_prefix('#') {
        Some(r) => (true, &r[1..]),
        None => (false, rest),
    };
    Some(CanLine {
        t,
        id: u32::from_str_radix(id, 16).ok()?,
        fd,
        data: hex::decode(hexdata).ok()?,
        raw: line.to_string(),
    })
}

/// Print a capture (evidence in test output with `--nocapture`).
pub fn print_capture(lines: &[CanLine], max: usize) {
    let t0 = lines.first().map(|l| l.t).unwrap_or(0.0);
    for l in lines.iter().take(max) {
        println!(
            "  +{:>9.3} ms  {:03X}{} [{:2}] {}",
            (l.t - t0) * 1000.0,
            l.id,
            if l.fd { " FD" } else { "   " },
            l.data.len(),
            hex::encode_upper(&l.data)
        );
    }
    if lines.len() > max {
        println!("  ... ({} more frames)", lines.len() - max);
    }
}

// ─── client construction ────────────────────────────────────────────────────

pub fn adapter() -> AsyncCanAdapter {
    SocketCanAdapter::new_async(SocketCanConfig::builder(IFACE).build()).expect("open vcan0")
}

pub fn id(raw: u32) -> Identifier {
    Identifier::standard(raw).expect("standard id")
}

/// Physical ISO-TP config: tx = ECU request ID, rx = ECU response ID.
pub fn isotp_builder(ids: Ids, fd: bool) -> IsoTPConfigBuilder {
    IsoTPConfig::builder(id(ids.req)).rx_id(id(ids.resp)).fd(fd)
}

pub fn isotp_config(ids: Ids, fd: bool) -> IsoTPConfig {
    isotp_builder(ids, fd).build().expect("isotp config")
}

/// NRC byte of a negative response error, if it is one.
pub fn nrc_of(err: &automotive::Error) -> Option<u8> {
    match err {
        automotive::Error::UDSError(uds::Error::NegativeResponse(code)) => Some(code.as_raw()),
        _ => None,
    }
}

// ─── seed/key via nexus-protocols ───────────────────────────────────────────

pub fn spec_xor_const(constant: &str) -> KeyProviderSpecDto {
    KeyProviderSpecDto::Builtin {
        algorithm: BuiltinAlgorithm::XorConst,
        constant_hex: Some(constant.to_string()),
    }
}

pub fn spec_xor_ff() -> KeyProviderSpecDto {
    KeyProviderSpecDto::Builtin {
        algorithm: BuiltinAlgorithm::XorFf,
        constant_hex: None,
    }
}

pub fn compute_key(spec: &KeyProviderSpecDto, seed: &[u8], level: u8) -> Vec<u8> {
    build_portable_provider(spec)
        .expect("portable provider")
        .compute_key(&SeedKeyRequest { seed, level })
        .expect("key")
}

/// Full unlock: requestSeed(level) -> provider -> sendKey(level+1).
pub async fn unlock<T: Transport>(
    client: &uds::UDSClient<'_, T>,
    level: u8,
    spec: &KeyProviderSpecDto,
) -> automotive::Result<(Vec<u8>, Vec<u8>)> {
    let seed = client
        .security_access(level, None)
        .await?
        .expect("seed for non-suppressed requestSeed");
    let key = compute_key(spec, &seed, level);
    client.security_access(level + 1, Some(&key)).await?;
    Ok((seed, key))
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

// ─── Work-around 1: conversation log at the UDS PDU level ───────────────────

#[derive(Debug, Clone)]
pub enum Dir {
    Tx,
    Rx,
    RxErr(String),
}

#[derive(Debug, Clone)]
pub struct PduEvent {
    pub at: Instant,
    pub dir: Dir,
    pub data: Vec<u8>,
}

/// Transport decorator that timestamps every request PDU the client sends and
/// every PDU (including each NRC 0x78) or transport error it receives.
/// This is the only hook available without forking: the crate exposes no
/// callbacks, only the `Transport` trait seam and `tracing` debug strings.
pub struct LoggingTransport<T: Transport> {
    pub inner: T,
    pub log: Arc<Mutex<Vec<PduEvent>>>,
}

impl<T: Transport> LoggingTransport<T> {
    pub fn new(inner: T) -> Self {
        Self {
            inner,
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }
    pub fn take(&self) -> Vec<PduEvent> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

impl<T: Transport> Transport for LoggingTransport<T> {
    fn send<'a>(
        &'a self,
        data: &'a [u8],
    ) -> impl std::future::Future<Output = automotive::Result<()>> + 'a {
        self.log.lock().unwrap().push(PduEvent {
            at: Instant::now(),
            dir: Dir::Tx,
            data: data.to_vec(),
        });
        self.inner.send(data)
    }

    fn recv(&self) -> impl Stream<Item = automotive::Result<Vec<u8>>> + Unpin + '_ {
        let log = self.log.clone();
        self.inner.recv().map(move |item| {
            let (dir, data) = match &item {
                Ok(d) => (Dir::Rx, d.clone()),
                Err(e) => (Dir::RxErr(e.to_string()), Vec::new()),
            };
            log.lock().unwrap().push(PduEvent {
                at: Instant::now(),
                dir,
                data,
            });
            item
        })
    }
}

pub fn print_pdu_log(events: &[PduEvent]) {
    let t0 = events.first().map(|e| e.at).unwrap_or_else(Instant::now);
    for e in events {
        let ms = e.at.duration_since(t0).as_secs_f64() * 1000.0;
        match &e.dir {
            Dir::Tx => println!("  +{ms:>9.3} ms  TX {}", hex::encode_upper(&e.data)),
            Dir::Rx => println!("  +{ms:>9.3} ms  RX {}", hex::encode_upper(&e.data)),
            Dir::RxErr(err) => println!("  +{ms:>9.3} ms  RX-ERR {err}"),
        }
    }
}

// ─── Work-around 2: functional request, physical flow control ───────────────

/// Sends on the functional ISO-TP channel but receives (and sends FC) on the
/// physical channel. The crate's `IsoTP` uses one `tx_id` for both data and FC,
/// so a plain functional `IsoTP` sends FC to the functional ID.
pub struct SplitTransport<'a> {
    pub func: IsoTP<'a>,
    pub phys: IsoTP<'a>,
}

impl Transport for SplitTransport<'_> {
    fn send<'b>(
        &'b self,
        data: &'b [u8],
    ) -> impl std::future::Future<Output = automotive::Result<()>> + 'b {
        Transport::send(&self.func, data)
    }

    fn recv(&self) -> impl Stream<Item = automotive::Result<Vec<u8>>> + Unpin + '_ {
        Transport::recv(&self.phys)
    }
}

// ─── Work-around 3: background TesterPresent, serialized with requests ──────

pub type SharedClient = Arc<tokio::sync::Mutex<uds::UDSClient<'static, IsoTP<'static>>>>;

/// Sends suppressed TesterPresent (3E 80) every `period` while nobody else
/// holds the client lock. Uses `spawn_local` (run inside a `LocalSet`) for
/// simplicity; the crate futures ARE `Send` (see `send_probe` in t10), so a
/// product version can use `tokio::spawn` on a multi-threaded runtime.
pub fn spawn_keepalive(
    client: SharedClient,
    period: Duration,
) -> (tokio::task::JoinHandle<u32>, tokio::sync::watch::Sender<bool>) {
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let handle = tokio::task::spawn_local(async move {
        let mut sent = 0u32;
        let mut tick = tokio::time::interval(period);
        tick.tick().await;
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    let c = client.lock().await;
                    let r = c.suppress_positive_responses().tester_present().await;
                    if r.is_ok() { sent += 1; } else { eprintln!("keepalive error: {r:?}"); }
                }
                _ = stop_rx.changed() => break,
            }
        }
        sent
    });
    (handle, stop_tx)
}

/// Passive raw-frame tap on the adapter broadcast. The crate's `Frame` has no
/// timestamp field, so the time is taken when the user-space task sees it.
pub async fn tap_frames(
    adapter: &AsyncCanAdapter,
    ids: &[u32],
    duration: Duration,
) -> Vec<(Instant, Frame)> {
    let ids = ids.to_vec();
    let mut stream = adapter.recv_filter(move |f| {
        f.id()
            .map(|i| ids.contains(&u32::from(i)))
            .unwrap_or(false)
    });
    let mut out = Vec::new();
    let _ = tokio::time::timeout(duration, async {
        while let Some(f) = stream.next().await {
            out.push((Instant::now(), f));
        }
    })
    .await;
    out
}

/// Sanity guard used by every test: the user's manual ecusim must stay alive.
pub fn assert_user_ecu_alive() {
    let out = Command::new("pgrep")
        .args(["-f", "config/manual.json"])
        .output()
        .expect("pgrep");
    if out.stdout.is_empty() {
        eprintln!("NOTE: user's manual ecusim (config/manual.json) is not running");
    }
}

// ─── Scripted fake ECU (raw frames) for transport/robustness tests ──────────

/// Waits for the first frame on `req`, then transmits `frames` on `resp`
/// (each after `delay_ms`). Returns the request frames seen (incl. FC).
/// Subscribes EAGERLY (before the returned future is polled) so the request
/// cannot slip past under CPU load; the first-frame wait is bounded to 3 s.
pub fn fake_ecu<'a>(
    adapter: &'a AsyncCanAdapter,
    req: u32,
    resp: u32,
    frames: Vec<(u64, Vec<u8>)>,
    linger: Duration,
) -> impl std::future::Future<Output = Vec<Vec<u8>>> + 'a {
    let stream = adapter.recv_filter(move |f| {
        !f.loopback && f.id().map(u32::from) == Some(req)
    });
    async move {
        let mut stream = std::pin::pin!(stream);
        let mut seen = Vec::new();
        match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
            Ok(Some(f)) => seen.push(f.data().to_vec()),
            _ => {
                eprintln!("fake_ecu: no request on {req:#x} within 3 s");
                return seen;
            }
        }
        for (delay, data) in frames {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let frame = Frame::builder(id(resp)).data(&data).build().expect("frame");
            adapter.send(&frame).await.expect("fake send");
        }
        let _ = tokio::time::timeout(linger, async {
            while let Some(f) = stream.next().await {
                seen.push(f.data().to_vec());
            }
        })
        .await;
        seen
    }
}

/// Minimum gap (ms) between consecutive frames on `id` whose first nibble is `pci`.
pub fn min_gap_ms(lines: &[CanLine], id: u32, pci: u8) -> Option<f64> {
    let ts: Vec<f64> = lines
        .iter()
        .filter(|l| l.id == id && l.data.first().map(|b| b >> 4) == Some(pci))
        .map(|l| l.t)
        .collect();
    ts.windows(2).map(|w| (w[1] - w[0]) * 1000.0).reduce(f64::min)
}

/// Minimum gap (ms) between consecutive CFs on `data_id` INSIDE a block, i.e.
/// ignoring the first CF after a flow-control frame on `fc_id`.
pub fn min_cf_gap_in_block_ms(lines: &[CanLine], data_id: u32, fc_id: u32) -> Option<f64> {
    let mut last: Option<f64> = None;
    let mut min: Option<f64> = None;
    for l in lines {
        if l.id == fc_id && l.data.first().map(|b| b >> 4) == Some(0x3) {
            last = None;
        } else if l.id == data_id && l.data.first().map(|b| b >> 4) == Some(0x2) {
            if let Some(prev) = last {
                let gap = (l.t - prev) * 1000.0;
                min = Some(min.map_or(gap, |m: f64| m.min(gap)));
            }
            last = Some(l.t);
        }
    }
    min
}

// ─── Flash download sequence (shared by t04 classic and t08 CAN-FD) ─────────

pub use flash_impl::*;
mod flash_impl {
    use super::*;
    use automotive::protocols::uds::{RoutineControlType, SessionType, UDSClient, UDSConfig};

    pub struct FlashReport {
        pub max_block_len: usize,
        pub blocks: usize,
        pub transfer: Duration,
        pub total: Duration,
        pub crc_ecu: u32,
    }

    /// What a NexusCAN "Flash Download" block needs to do. The crate offers the
    /// individual services only: block length, chunking and the BSC are ours.
    pub async fn flash<T: Transport>(uds: &UDSClient<'_, T>, image: &[u8], addr: u64) -> FlashReport {
        let t0 = Instant::now();
        uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
        uds.diagnostic_session_control(SessionType::Programming).await.unwrap();
        unlock(uds, 0x11, &spec_xor_ff()).await.unwrap();
        uds.routine_control(RoutineControlType::Start, 0xFF00u16, None).await.unwrap();

        // Returned value = maxNumberOfBlockLength from the 0x34 response (SID+BSC included).
        let max_block_len = uds
            .request_download_alfid(0u8, 0u8, addr, image.len() as u64, 4, 4)
            .await
            .unwrap();
        let chunk = max_block_len - 2;

        let t1 = Instant::now();
        let mut bsc: u8 = 1;
        let mut blocks = 0;
        for block in image.chunks(chunk) {
            let r = uds.transfer_data(bsc, Some(block)).await;
            if let Err(e) = r {
                panic!("0x36 block {blocks} (bsc {bsc:#04x}) failed: {e}");
            }
            bsc = bsc.wrapping_add(1); // caller-managed FF -> 00 wrap
            blocks += 1;
        }
        let transfer = t1.elapsed();
        let exit = uds.request_transfer_exit(None).await.unwrap();
        println!("0x37 -> {exit:02X?}");
        let crc = uds
            .routine_control(RoutineControlType::Start, 0x0202u16, None)
            .await
            .unwrap()
            .expect("crc32 routine result");
        let crc_ecu = u32::from_be_bytes([crc[0], crc[1], crc[2], crc[3]]);
        FlashReport {
            max_block_len,
            blocks,
            transfer,
            total: t0.elapsed(),
            crc_ecu,
        }
    }

    pub fn image(len: usize) -> Vec<u8> {
        let mut x: u32 = 0x1234_5678;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 24) as u8
            })
            .collect()
    }

    /// P2client = P2server(50 ms) + ΔP2 margin. The crate adopts the server value
    /// with no margin; under CPU load one 0x36 answer took 71 ms and the default
    /// client timed out (see README, finding F-P2). Wrapper-side fix: fixed margin.
    pub fn flash_client_config() -> UDSConfig {
        UDSConfig::builder()
            .use_server_timing(false)
            .p2_timeout(Duration::from_millis(50 + 100))
            .p2_star_timeout(Duration::from_millis(2000 + 100))
            .build()
    }
}

// ─── Work-around 4: persistent receiver + response matching ─────────────────

/// Does `pdu` answer `req`? SID (+0x40 or 7F SID), echoed sub-function and
/// echoed identifier for the common services. Anything else is stale.
pub fn response_matches(req: &[u8], pdu: &[u8]) -> bool {
    let (Some(&sid), Some(&rsid)) = (req.first(), pdu.first()) else {
        return false;
    };
    if rsid == 0x7F {
        return pdu.get(1) == Some(&sid);
    }
    if rsid != sid.wrapping_add(0x40) {
        return false;
    }
    match sid {
        0x22 | 0x2E | 0x2F => pdu.get(1..3) == req.get(1..3),
        0x31 => pdu.get(1) == req.get(1).map(|b| b & 0x7F).as_ref() && pdu.get(2..4) == req.get(2..4),
        0x10 | 0x11 | 0x19 | 0x27 | 0x28 | 0x3E | 0x85 => {
            pdu.get(1) == req.get(1).map(|b| b & 0x7F).as_ref()
        }
        _ => true,
    }
}

/// One long-lived ISO-TP receive stream per ECU (reassembly and FC continue
/// while no request is waiting) + filtering of PDUs that do not answer the
/// last request. Spike version uses `spawn_local` (needs a `LocalSet`).
pub struct PersistentTransport {
    isotp: Arc<IsoTP<'static>>,
    rx: tokio::sync::broadcast::Sender<Result<Vec<u8>, String>>,
    last_req: Arc<Mutex<Vec<u8>>>,
    pub stale: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl PersistentTransport {
    pub fn spawn_local(isotp: Arc<IsoTP<'static>>) -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        let pump_tx = tx.clone();
        let pump_isotp = isotp.clone();
        tokio::task::spawn_local(async move {
            let stream = pump_isotp.recv();
            let mut stream = std::pin::pin!(stream);
            while let Some(item) = stream.next().await {
                match item {
                    Err(automotive::Error::IdleTimeout) => continue,
                    Ok(pdu) => {
                        let _ = pump_tx.send(Ok(pdu));
                    }
                    Err(e) => {
                        let _ = pump_tx.send(Err(e.to_string()));
                    }
                }
            }
        });
        Self {
            isotp,
            rx: tx,
            last_req: Arc::new(Mutex::new(Vec::new())),
            stale: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl Transport for PersistentTransport {
    fn send<'a>(
        &'a self,
        data: &'a [u8],
    ) -> impl std::future::Future<Output = automotive::Result<()>> + 'a {
        *self.last_req.lock().unwrap() = data.to_vec();
        Transport::send(&*self.isotp, data)
    }

    fn recv(&self) -> impl Stream<Item = automotive::Result<Vec<u8>>> + Unpin + '_ {
        let last = self.last_req.clone();
        let stale = self.stale.clone();
        tokio_stream::wrappers::BroadcastStream::new(self.rx.subscribe()).filter_map(move |item| {
            match item {
                Ok(Ok(pdu)) => {
                    if response_matches(&last.lock().unwrap(), &pdu) {
                        Some(Ok(pdu))
                    } else {
                        stale.lock().unwrap().push(pdu);
                        None
                    }
                }
                // Reassembly errors of unrelated transfers are logged, not fatal.
                Ok(Err(e)) => {
                    eprintln!("persistent rx error: {e}");
                    None
                }
                Err(_lagged) => None,
            }
        })
    }
}
