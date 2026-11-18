//! End-to-end flasher HIL: the REAL NexusCAN stack (`PipelineEngine` → SocketCAN driver →
//! diag tap → `UdsSession` → `nexus-protocols` ISO-TP + flash engine) against the INDEPENDENT
//! `nexus-ecu-sim` bootloader (kernel `CAN_ISOTP`, own UDS server) on vcan0, 0x7E0 / 0x7E8.
//!
//! Every test spawns a fresh simulator process with its own image / jsonl log, drives the
//! pre-sequence through `cmd_diag_send_uds` + `cmd_seedkey_compute_adhoc` (the Flow editor
//! path), loads the firmware through `cmd_flash_load_image` (base64), downloads it with
//! `cmd_flash_download`, and proves the result with `nexus-flash-compare` (byte-for-byte).
//!
//! All tests are `#[ignore]`: they need vcan0 + the simulator binaries. Without vcan0 they print
//! `SKIP` and return; with `NEXUS_HIL_REQUIRE=1` a missing interface / binary is a FAILURE.
//!
//! ```text
//! scripts/hil/run_flash_e2e.sh                       # rootless: user+net+mount namespace
//! scripts/hil/run_flash_e2e.sh fault_nrc -- --nocapture
//! ```
//!
//! NOTE (namespace): the SocketCAN driver discovers interfaces through `/sys/class/net`. Inside a
//! plain `unshare -rn` sysfs still shows the HOST's interfaces, so NexusCAN cannot see the
//! namespace's vcan0; the runner uses `unshare -rnm` and remounts sysfs.
//!
//! Tests share 0x7E0 / 0x7E8 on one bus, so they are serialized by a process-wide mutex.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use nexus_hal::pipeline::diag_flash::{resolve_download_config, FlashLoadFormat};
use nexus_hal::seedkey::SeedKeyPolicy;
use nexus_hal::{ChannelConfigDto, PipelineEngine};
use nexus_protocols::uds::dto::{
    DiagErrorCode, DiagOrigin, DiagSessionConfigDto, UdsRequestOptionsDto, UdsResponseDto,
};
use nexus_protocols::uds::flash::{
    FlashError, FlashErrorKind, FlashPhase, FlashProgressDto, FlashReportDto,
};
use nexus_protocols::uds::security::{BuiltinAlgorithm, KeyProviderSpecDto};
use serde_json::{json, Value};

const REQ_ID: u32 = 0x7E0;
const RESP_ID: u32 = 0x7E8;
const BUS: u8 = 0;

// ───────────────────────────────────────────────────────────────── environment

fn iface() -> String {
    std::env::var("NEXUS_HIL_IFACE").unwrap_or_else(|_| "vcan0".into())
}

fn hil_required() -> bool {
    std::env::var("NEXUS_HIL_REQUIRE").as_deref() == Ok("1")
}

/// Skip (false) or fail (panic under `NEXUS_HIL_REQUIRE=1`) with a reason.
fn skip_or_fail(reason: String) -> bool {
    if hil_required() {
        panic!("NEXUS_HIL_REQUIRE=1 but the flash E2E HIL cannot run: {reason}");
    }
    eprintln!("SKIP (flash e2e HIL): {reason}");
    false
}

/// Directory holding `nexus-ecu-sim` / `nexus-flash-compare`: `$NEXUS_ECU_SIM_DIR`, else the
/// cargo profile dir of this test binary (`<target>/<profile>/deps/<test>` → `<target>/<profile>`).
fn bin_dir() -> PathBuf {
    if let Ok(d) = std::env::var("NEXUS_ECU_SIM_DIR") {
        return PathBuf::from(d);
    }
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .expect("profile dir")
}

fn sim_bin() -> PathBuf {
    bin_dir().join("nexus-ecu-sim")
}

fn compare_bin() -> PathBuf {
    bin_dir().join("nexus-flash-compare")
}

/// vcan0 must be openable (kernel) AND visible in `/sys/class/net` (the NexusCAN SocketCAN
/// driver enumerates there), and the simulator binaries must exist.
fn hil_ready() -> bool {
    let i = iface();
    if <socketcan::CanSocket as socketcan::Socket>::open(&i).is_err() {
        return skip_or_fail(format!(
            "CAN interface '{i}' not present; run scripts/hil/run_flash_e2e.sh"
        ));
    }
    if !Path::new("/sys/class/net").join(&i).exists() {
        return skip_or_fail(format!(
            "'{i}' exists in this network namespace but not in /sys/class/net (sysfs belongs to \
             another netns); NexusCAN's SocketCAN discovery cannot see it. Use `unshare -rnm` \
             and `mount -t sysfs sysfs /sys` (scripts/hil/run_flash_e2e.sh does this)"
        ));
    }
    for b in [sim_bin(), compare_bin()] {
        if !b.exists() {
            return skip_or_fail(format!(
                "{} missing; run `cargo build -p nexus-ecu-sim --bins` or set NEXUS_ECU_SIM_DIR",
                b.display()
            ));
        }
    }
    true
}

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

macro_rules! require_hil {
    () => {
        let _serial_guard = serial();
        if !hil_ready() {
            return;
        }
    };
}

fn work_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join("nexus-flash-e2e")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("work dir");
    d
}

// ───────────────────────────────────────────────────────────────── simulator

struct Sim {
    child: Child,
    image: PathBuf,
    log: PathBuf,
    dir: PathBuf,
}

impl Sim {
    fn spawn(name: &str, extra: &[&str]) -> Self {
        let dir = work_dir(name);
        let image = dir.join("flash_image.json");
        let log = dir.join("sim.jsonl");
        let child = Command::new(sim_bin())
            .args(["--iface", &iface()])
            .args([
                "--rx",
                &format!("0x{REQ_ID:X}"),
                "--tx",
                &format!("0x{RESP_ID:X}"),
            ])
            .args(["--image-out", image.to_str().unwrap()])
            .args(["--log", "jsonl", "--log-file", log.to_str().unwrap()])
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn nexus-ecu-sim");
        let sim = Self {
            child,
            image,
            log,
            dir,
        };
        // "ready" is logged after the kernel ISO-TP socket is bound.
        let t0 = Instant::now();
        while !sim.log_text().contains("\"event\":\"ready\"") {
            assert!(
                t0.elapsed() < Duration::from_secs(10),
                "simulator not ready; log {}",
                sim.log.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
        sim
    }

    fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    fn events(&self) -> Vec<Value> {
        self.log_text()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// Request PDUs received by the sim (hex strings, `0x36` ones truncated by the sim).
    fn rx_pdus(&self) -> Vec<String> {
        self.events()
            .into_iter()
            .filter(|e| e["event"] == "rx")
            .filter_map(|e| e["pdu"].as_str().map(str::to_owned))
            .collect()
    }

    fn rx_count(&self, sid: &str) -> usize {
        self.rx_pdus().iter().filter(|p| p.starts_with(sid)).count()
    }

    fn compare(&self, source: &Path, extra: &[&str]) -> (i32, String) {
        let out = Command::new(compare_bin())
            .args(["--source", source.to_str().unwrap()])
            .args(["--image", self.image.to_str().unwrap()])
            .args(extra)
            .output()
            .expect("run nexus-flash-compare");
        let text = String::from_utf8_lossy(&out.stdout).into_owned()
            + String::from_utf8_lossy(&out.stderr).as_ref();
        (out.status.code().unwrap_or(-1), text)
    }

    fn assert_equal(&self, source: &Path, extra: &[&str]) -> String {
        let (code, out) = self.compare(source, extra);
        assert_eq!(
            code,
            0,
            "nexus-flash-compare {} vs sim image: {out}\nsim log: {}",
            source.display(),
            self.log.display()
        );
        assert!(out.contains("EQUAL"), "{out}");
        out.lines()
            .find(|l| l.starts_with("EQUAL"))
            .unwrap_or_default()
            .to_string()
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        // SAFETY: SIGTERM to our own child.
        unsafe {
            libc_kill(self.child.id() as i32, 15);
        }
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

/// Independent wire capture (`candump -L`) of tester requests (0x7E0).
struct Candump {
    child: Child,
    file: PathBuf,
}

impl Candump {
    fn start(dir: &Path) -> Option<Self> {
        let file = dir.join("candump.log");
        let out = std::fs::File::create(&file).ok()?;
        let child = Command::new("candump")
            .args(["-L", &format!("{},{REQ_ID:03X}:7FF", iface())])
            .stdout(out)
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        thread::sleep(Duration::from_millis(200));
        Some(Self { child, file })
    }

    /// Stops the capture; returns the data bytes of every 0x7E0 frame.
    fn stop(mut self) -> Vec<Vec<u8>> {
        thread::sleep(Duration::from_millis(100));
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::fs::read_to_string(&self.file)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| {
                let frame = l.split_whitespace().nth(2)?;
                let (id, data) = frame.split_once('#')?;
                if u32::from_str_radix(id, 16).ok()? != REQ_ID {
                    return None;
                }
                let data = data.trim_start_matches('#');
                Some(unhex(data))
            })
            .collect()
    }
}

/// True if any captured ISO-TP frame is a Single Frame carrying `sid`.
fn has_single_frame_sid(frames: &[Vec<u8>], sid: u8) -> bool {
    frames
        .iter()
        .any(|f| f.len() >= 2 && f[0] & 0xF0 == 0x00 && f[0] & 0x0F != 0 && f[1] == sid)
}

/// True if any captured ISO-TP frame is a First Frame carrying `sid`.
fn has_first_frame_sid(frames: &[Vec<u8>], sid: u8) -> bool {
    frames
        .iter()
        .any(|f| f.len() >= 3 && f[0] & 0xF0 == 0x10 && f[2] == sid)
}

// ───────────────────────────────────────────────────────────────── engine

/// Engine + bus 0 on vcan0. Disconnects every bus on drop.
struct Eng(Arc<PipelineEngine>);

impl Drop for Eng {
    fn drop(&mut self) {
        self.0.cmd_disconnect_all_buses();
    }
}

impl std::ops::Deref for Eng {
    type Target = PipelineEngine;
    fn deref(&self) -> &PipelineEngine {
        &self.0
    }
}

fn connect(e: &PipelineEngine, listen_only: bool) {
    let cfg = ChannelConfigDto {
        bus_id: BUS,
        listen_only,
        enable_fd: true,
        ..ChannelConfigDto::default()
    };
    let h = e
        .cmd_connect_bus(format!("socketcan:{}", iface()), cfg)
        .expect("connect vcan0");
    assert_eq!(h.listen_only, listen_only);
    if !listen_only {
        let h = e.cmd_arm_active_bus(BUS, true).expect("arm bus");
        assert!(h.tx_armed);
    }
}

fn engine(listen_only: bool) -> Eng {
    let e = Eng(Arc::new(PipelineEngine::new()));
    connect(&e, listen_only);
    e
}

fn dcfg() -> DiagSessionConfigDto {
    serde_json::from_value(json!({
        "busId": BUS, "requestId": REQ_ID, "responseId": RESP_ID,
        "isExtendedId": false, "protocol": "uds"
    }))
    .expect("diag config")
}

fn bus_armed(e: &PipelineEngine) -> bool {
    let snap = e.flush_snapshot_now().expect("snapshot");
    snap.buses
        .iter()
        .find(|b| b.bus_id == BUS)
        .is_some_and(|b| b.tx_armed)
}

fn uds(e: &PipelineEngine, sid: u8, sub: Option<u8>, data: &[u8]) -> UdsResponseDto {
    let opts = UdsRequestOptionsDto {
        origin: Some(DiagOrigin::Flow),
        ..Default::default()
    };
    e.cmd_diag_send_uds(dcfg(), sid, sub, data.to_vec(), Some(opts))
        .unwrap_or_else(|err| panic!("UDS 0x{sid:02X} {sub:02X?}: {}", err.to_ipc_string()))
}

fn expect_pos(
    e: &PipelineEngine,
    sid: u8,
    sub: Option<u8>,
    data: &[u8],
    prefix: &[u8],
) -> UdsResponseDto {
    let r = uds(e, sid, sub, data);
    assert!(
        r.positive && r.raw.starts_with(prefix),
        "UDS 0x{sid:02X} {sub:02X?} {data:02X?}: expected {prefix:02X?}.., got {:02X?}",
        r.raw
    );
    r
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

/// After 10 02 the simulator emulates the jump to the bootloader (`--boot-jump-ms`, default
/// 300 ms) and ignores requests meanwhile. Poll TesterPresent until it answers, like a
/// production tester does, instead of disabling the jump in the simulator.
fn wait_bootloader(e: &PipelineEngine) {
    let t0 = Instant::now();
    loop {
        let opts = UdsRequestOptionsDto {
            origin: Some(DiagOrigin::Flow),
            ..Default::default()
        };
        match e.cmd_diag_send_uds(dcfg(), 0x3E, Some(0x00), vec![], Some(opts)) {
            Ok(r) if r.positive => return,
            _ => assert!(
                t0.elapsed() < Duration::from_secs(10),
                "bootloader did not answer 3E 00 within 10 s after 10 02"
            ),
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// 10 03 → 10 02 → (boot jump: poll 3E 00) → 27 11 → key via `cmd_seedkey_compute_adhoc` (builtin xor_ff) → 27 12 →
/// 31 01 FF00 (ALFID 0x44, address, length) per segment. Returns the 0x78 count of the erases.
fn unlock_and_erase(e: &PipelineEngine, fw: &Fw) -> u32 {
    expect_pos(e, 0x10, Some(0x03), &[], &[0x50, 0x03]);
    expect_pos(e, 0x10, Some(0x02), &[], &[0x50, 0x02]);
    wait_bootloader(e);
    let seed = expect_pos(e, 0x27, Some(0x11), &[], &[0x67, 0x11]).raw[2..].to_vec();
    assert_eq!(seed.len(), 4, "sim seed is 4 bytes");
    assert!(
        seed.iter().any(|&b| b != 0),
        "locked ECU must send a non-zero seed"
    );
    let provider = KeyProviderSpecDto::Builtin {
        algorithm: BuiltinAlgorithm::XorFf,
        constant_hex: None,
    };
    let key = e
        .cmd_seedkey_compute_adhoc(SeedKeyPolicy::portable_only(), &provider, 0x11, &hex(&seed))
        .expect("seedkey compute");
    let key = unhex(&key.key_hex);
    // Independent cross-check of the builtin provider.
    assert_eq!(key, seed.iter().map(|b| !b).collect::<Vec<_>>());
    expect_pos(e, 0x27, Some(0x12), &key, &[0x67, 0x12]);
    let mut pendings = 0;
    for (addr, data) in &fw.segs {
        let mut args = vec![0xFF, 0x00, 0x44];
        args.extend_from_slice(&addr.to_be_bytes());
        args.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let r = expect_pos(e, 0x31, Some(0x01), &args, &[0x71, 0x01, 0xFF, 0x00, 0x00]);
        pendings += r.response_pending_count;
    }
    pendings
}

/// 31 01 0202 <crc32> → status 00; 11 01.
fn check_and_reset(e: &PipelineEngine, crc: u32) {
    let mut args = vec![0x02, 0x02];
    args.extend_from_slice(&crc.to_be_bytes());
    expect_pos(e, 0x31, Some(0x01), &args, &[0x71, 0x01, 0x02, 0x02, 0x00]);
    expect_pos(e, 0x11, Some(0x01), &[], &[0x51, 0x01]);
}

type Events = Vec<(Instant, FlashProgressDto)>;
type Worker = thread::JoinHandle<(Result<FlashReportDto, FlashError>, Events)>;

fn download(
    e: &PipelineEngine,
    image_id: &str,
    dl: Value,
) -> (Result<FlashReportDto, FlashError>, Events) {
    // Same JSON resolution as the Tauri wrapper (src-tauri/src/commands.rs cmd_flash_download).
    let cfg = dcfg();
    let dl = resolve_download_config(dl, cfg.use_fd).expect("download config");
    let mut events = Vec::new();
    let res = e.cmd_flash_download(cfg, image_id, dl, &mut |p| events.push((Instant::now(), p)));
    (res, events)
}

fn load(
    e: &PipelineEngine,
    name: &str,
    format: FlashLoadFormat,
    base: u32,
    bytes: &[u8],
) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    e.cmd_flash_load_image(name.into(), format, base, &b64)
        .unwrap_or_else(|err| panic!("load {name}: {}", err.to_ipc_string()))
        .image_id
}

// ───────────────────────────────────────────────────────────────── firmware

/// Multi-segment firmware generated and serialized here (independent of the parsers under test).
struct Fw {
    segs: Vec<(u32, Vec<u8>)>,
}

fn prng(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 24) as u8
        })
        .collect()
}

impl Fw {
    fn new(segs: &[(u32, usize)], seed: u32) -> Self {
        Self {
            segs: segs
                .iter()
                .enumerate()
                .map(|(i, &(a, n))| (a, prng(n, seed.wrapping_add(i as u32 * 7919))))
                .collect(),
        }
    }

    /// 280 000 B @0x08000000 (274 blocks: counter wraps) + 40 000 B @0x08050000 (gap).
    fn large() -> Self {
        Self::new(&[(0x0800_0000, 280_000), (0x0805_0000, 40_000)], 0xC0FFEE)
    }

    /// 40 000 B + 20 000 B with a gap: fault matrix.
    fn medium() -> Self {
        Self::new(&[(0x0800_0000, 40_000), (0x0801_0000, 20_000)], 0xBADC0DE)
    }

    fn total(&self) -> u64 {
        self.segs.iter().map(|(_, d)| d.len() as u64).sum()
    }

    fn crc32(&self) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for (_, d) in &self.segs {
            for &b in d {
                crc ^= u32::from(b);
                for _ in 0..8 {
                    crc = if crc & 1 != 0 {
                        (crc >> 1) ^ 0xEDB8_8320
                    } else {
                        crc >> 1
                    };
                }
            }
        }
        !crc
    }

    fn intel_hex(&self) -> String {
        fn rec(kind: u8, addr: u16, data: &[u8]) -> String {
            let mut v = vec![data.len() as u8, (addr >> 8) as u8, addr as u8, kind];
            v.extend_from_slice(data);
            let ck = 0u8.wrapping_sub(v.iter().fold(0u8, |a, &b| a.wrapping_add(b)));
            v.push(ck);
            format!(":{}\n", hex(&v))
        }
        let mut s = String::new();
        let mut upper: Option<u16> = None;
        for (base, data) in &self.segs {
            let mut off = 0usize;
            while off < data.len() {
                let addr = base + off as u32;
                let hi = (addr >> 16) as u16;
                if upper != Some(hi) {
                    s += &rec(0x04, 0, &hi.to_be_bytes());
                    upper = Some(hi);
                }
                let room = 0x1_0000 - (addr & 0xFFFF) as usize;
                let n = 32.min(data.len() - off).min(room);
                s += &rec(0x00, addr as u16, &data[off..off + n]);
                off += n;
            }
        }
        s += &rec(0x01, 0, &[]);
        s
    }

    fn srec(&self) -> String {
        let rec = |t: u8, body: &[u8]| {
            let mut v = vec![(body.len() + 1) as u8];
            v.extend_from_slice(body);
            let ck = !v.iter().fold(0u8, |a, &b| a.wrapping_add(b));
            v.push(ck);
            format!("S{t}{}\n", hex(&v))
        };
        let mut s = rec(0, b"\0\0nexus-e2e");
        let mut n = 0u32;
        for (base, data) in &self.segs {
            for (i, chunk) in data.chunks(32).enumerate() {
                let mut body = (base + (i * 32) as u32).to_be_bytes().to_vec();
                body.extend_from_slice(chunk);
                s += &rec(3, &body);
                n += 1;
            }
        }
        if n <= 0xFFFF {
            s += &rec(5, &(n as u16).to_be_bytes());
        } else {
            s += &rec(6, &n.to_be_bytes()[1..]);
        }
        s += &rec(7, &self.segs[0].0.to_be_bytes());
        s
    }

    fn write_sources(&self, dir: &Path) -> (PathBuf, PathBuf) {
        let h = dir.join("fw.hex");
        let s = dir.join("fw.s19");
        std::fs::write(&h, self.intel_hex()).unwrap();
        std::fs::write(&s, self.srec()).unwrap();
        (h, s)
    }
}

// ───────────────────────────────────────────────────────────────── checks

/// Monotonic progress, bytesTotal, final `done`, ≤ 60 Hz throttle, report totals.
fn check_flash(fw: &Fw, report: &FlashReportDto, events: &Events, block_len: u32) -> String {
    let total = fw.total();
    assert!(!events.is_empty(), "no progress events");
    let mut prev: Option<&FlashProgressDto> = None;
    let mut same_phase_gaps = Vec::new();
    let mut prev_t: Option<Instant> = None;
    for (t, p) in events {
        assert_eq!(p.bytes_total, total, "bytesTotal");
        assert_eq!(p.segment_count as usize, fw.segs.len());
        if let Some(q) = prev {
            assert!(
                p.bytes_done >= q.bytes_done,
                "bytesDone regressed: {q:?} -> {p:?}"
            );
            assert!(p.segment_index >= q.segment_index, "segment regressed");
            assert!(p.retries >= q.retries, "retries regressed");
            if p.phase == q.phase && p.phase != FlashPhase::Done {
                same_phase_gaps.push(t.duration_since(prev_t.unwrap()));
            }
        }
        prev = Some(p);
        prev_t = Some(*t);
    }
    let last = &events.last().unwrap().1;
    assert_eq!(last.phase, FlashPhase::Done, "final phase");
    assert_eq!(last.bytes_done, total);
    let span = events.last().unwrap().0.duration_since(events[0].0);
    if let Some(min) = same_phase_gaps.iter().min() {
        assert!(
            *min >= Duration::from_micros(16_000),
            "throttle violated: two same-phase events {min:?} apart"
        );
    }
    let rate_cap = (span.as_secs_f64() * 60.0).ceil() as usize + 1;
    assert!(
        same_phase_gaps.len() <= rate_cap,
        "{} non-phase-change events in {span:?} (cap {rate_cap})",
        same_phase_gaps.len()
    );

    assert_eq!(report.total_bytes, total);
    assert_eq!(report.segments.len(), fw.segs.len());
    let mut blocks = 0;
    for (s, (addr, data)) in report.segments.iter().zip(&fw.segs) {
        assert_eq!(s.address, *addr);
        assert_eq!(s.bytes, data.len() as u64);
        assert_eq!(s.block_len, block_len, "blockLen in report");
        let want = data.len().div_ceil(block_len as usize - 2) as u32;
        assert_eq!(s.blocks, want, "blocks of segment {}", s.index);
        blocks += s.blocks;
    }
    assert_eq!(report.total_blocks, blocks);
    assert_eq!(
        report.total_retries,
        report.segments.iter().map(|s| s.retries).sum::<u32>()
    );
    assert_eq!(last.retries, report.total_retries);
    format!(
        "{} B, {} blocks (blockLen {}), {} retries, {} ms, {:.0} B/s, {} progress events ({} throttled same-phase, min gap {:?})",
        report.total_bytes,
        report.total_blocks,
        block_len,
        report.total_retries,
        report.duration_ms,
        report.throughput_bytes_per_sec,
        events.len(),
        same_phase_gaps.len(),
        same_phase_gaps.iter().min()
    )
}

/// Load (.hex) → download → checks → 0202 + 11 01 → byte compare. Returns the report.
fn flash_and_verify(
    e: &PipelineEngine,
    sim: &Sim,
    fw: &Fw,
    dl: Value,
    block_len: u32,
    tag: &str,
) -> FlashReportDto {
    let (hexf, s19f) = fw.write_sources(&sim.dir);
    let id = load(
        e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        &std::fs::read(&hexf).unwrap(),
    );
    let (res, events) = download(e, &id, dl);
    let report = res.unwrap_or_else(|err| {
        panic!(
            "[{tag}] download failed: {}\nsim log {}",
            serde_json::to_string(&err).unwrap(),
            sim.log.display()
        )
    });
    let ev = check_flash(fw, &report, &events, block_len);
    check_and_reset(e, fw.crc32());
    let c1 = sim.assert_equal(&hexf, &[]);
    let c2 = sim.assert_equal(&s19f, &[]);
    eprintln!("EVIDENCE [{tag}] {ev}; compare: {c1} | {c2}");
    report
}

fn assert_no_transfer_exit(sim: &Sim, tag: &str) {
    let n37 = sim.rx_count("37");
    assert_eq!(
        n37,
        0,
        "[{tag}] 0x37 reached the sim: {:?}",
        sim.rx_pdus()
            .iter()
            .filter(|p| p.starts_with("37"))
            .collect::<Vec<_>>()
    );
}

// ───────────────────────────────────────────────────────────────── main sequence

/// The acceptance run, once per text format: .hex and .s19 of a 320 000-byte two-segment image
/// with a gap (segment 1: 274 blocks → counter wraps 0xFF→0x00).
#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn full_flash_hex_and_s19_byte_compare() {
    require_hil!();
    let fw = Fw::large();
    assert!(fw.total() >= 300 * 1024, "≥ 300 KiB");
    for (fmt, format) in [
        ("hex", FlashLoadFormat::IntelHex),
        ("s19", FlashLoadFormat::Srec),
    ] {
        let sim = Sim::spawn(&format!("full-{fmt}"), &[]);
        let e = engine(false);
        let (hexf, s19f) = fw.write_sources(&sim.dir);
        let src = if fmt == "hex" { &hexf } else { &s19f };
        let t0 = Instant::now();
        unlock_and_erase(&e, &fw);
        let pre = t0.elapsed();
        let b64 = base64::engine::general_purpose::STANDARD.encode(std::fs::read(src).unwrap());
        let h = e
            .cmd_flash_load_image(format!("fw.{fmt}"), format, 0, &b64)
            .expect("load");
        assert_eq!(h.summary.total_bytes, fw.total());
        assert_eq!(h.summary.segments.len(), 2);
        assert_eq!(
            h.summary.crc32,
            fw.crc32(),
            "image CRC32 vs independent CRC"
        );
        let (res, events) = download(&e, &h.image_id, Value::Null);
        let report =
            res.unwrap_or_else(|err| panic!("download: {}", serde_json::to_string(&err).unwrap()));
        let ev = check_flash(&fw, &report, &events, 0x402);
        assert!(report.segments[0].blocks > 256, "counter must wrap");
        check_and_reset(&e, h.summary.crc32);
        let c1 = sim.assert_equal(&hexf, &[]);
        let c2 = sim.assert_equal(&s19f, &[]);
        assert_eq!(sim.rx_count("34"), 2);
        assert_eq!(sim.rx_count("37"), 2);
        eprintln!("EVIDENCE [full {fmt}] pre-sequence {pre:?}; {ev}; compare: {c1} | {c2}");
    }
}

/// Raw binary with an explicit base address (no addresses in the file).
#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn binary_with_explicit_base_byte_compare() {
    require_hil!();
    const BASE: u32 = 0x0802_0000;
    let fw = Fw::new(&[(BASE, 96 * 1024 + 77)], 0x5EED);
    let sim = Sim::spawn("bin", &[]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let bin = sim.dir.join("fw.bin");
    std::fs::write(&bin, &fw.segs[0].1).unwrap();
    let id = load(&e, "fw.bin", FlashLoadFormat::Binary, BASE, &fw.segs[0].1);
    let (res, events) = download(&e, &id, Value::Null);
    let report = res.expect("download");
    let ev = check_flash(&fw, &report, &events, 0x402);
    check_and_reset(&e, fw.crc32());
    let c = sim.assert_equal(&bin, &["--base", "0x08020000"]);
    // Negative control: wrong base must NOT compare equal.
    assert_eq!(sim.compare(&bin, &["--base", "0x08000000"]).0, 1);
    eprintln!("EVIDENCE [bin base 0x{BASE:08X}] {ev}; compare: {c}");
}

/// A Listen-Only bus refuses arming, UDS and flash with a clear listen_only transport error,
/// and nothing reaches the ECU.
#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn listen_only_bus_refuses_flash() {
    require_hil!();
    let sim = Sim::spawn("listen-only", &[]);
    let e = engine(true);
    let err = e.cmd_arm_active_bus(BUS, true).unwrap_err();
    assert!(err.to_string().contains("Listen-Only"), "{err}");
    let fw = Fw::medium();
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let (res, events) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    assert_eq!(err.kind, FlashErrorKind::Transport, "{err:?}");
    assert_eq!(err.diag_code, Some(DiagErrorCode::ListenOnly), "{err:?}");
    let ipc = nexus_hal::pipeline::diag_flash::flash_error_to_ipc(&err);
    assert!(
        ipc.contains(r#""kind":"transport""#) && ipc.contains(r#""diagCode":"listen_only""#),
        "{ipc}"
    );
    assert!(events.is_empty(), "no progress on a refused flash");
    let uerr = e
        .cmd_diag_send_uds(dcfg(), 0x10, Some(0x03), vec![], None)
        .unwrap_err();
    assert_eq!(uerr.code, DiagErrorCode::ListenOnly);
    thread::sleep(Duration::from_millis(200));
    assert!(sim.rx_pdus().is_empty(), "ECU received {:?}", sim.rx_pdus());
    eprintln!("EVIDENCE [listen-only] {ipc}");
}

// ───────────────────────────────────────────────────────────────── fault matrix

fn fault_success(
    name: &str,
    faults: &[&str],
    fw: &Fw,
    dl: Value,
    block_len: u32,
) -> (FlashReportDto, u32, Sim) {
    let mut args = Vec::new();
    for f in faults {
        args.push("--fault");
        args.push(f);
    }
    let sim = Sim::spawn(name, &args);
    let e = engine(false);
    let pend = unlock_and_erase(&e, fw);
    let r = flash_and_verify(&e, &sim, fw, dl, block_len, name);
    drop(e);
    (r, pend, sim)
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_pending78_on_transfer_data() {
    require_hil!();
    let (r, _, sim) = fault_success(
        "pending78-36",
        &["pending78:0x36:2"],
        &Fw::medium(),
        Value::Null,
        0x402,
    );
    assert_eq!(r.total_retries, 0, "0x78 must not cause resends");
    let tx78 = sim
        .events()
        .iter()
        .filter(|e| e["event"] == "tx" && e["pdu"] == "7F 36 78")
        .count();
    assert_eq!(
        tx78 as u32,
        2 * r.total_blocks,
        "sim sent 2x 0x78 per block"
    );
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_pending78_on_erase_routine() {
    require_hil!();
    let (_, pend, _) = fault_success(
        "pending78-31",
        &["pending78:0x31:3"],
        &Fw::medium(),
        Value::Null,
        0x402,
    );
    assert!(pend >= 6, "two erases × ≥3 pendings, got {pend}");
    eprintln!("EVIDENCE [pending78 0x31] erase responsePendingCount total {pend}");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_wrong_seq_once() {
    require_hil!();
    let (r, _, sim) = fault_success(
        "wrong-seq",
        &["wrong-seq-once:5"],
        &Fw::medium(),
        Value::Null,
        0x402,
    );
    assert!(r.total_retries >= 1, "{r:?}");
    assert!(sim.log_text().contains("7F 36 73"), "sim never sent 0x73");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_drop_response_once() {
    require_hil!();
    let (r, _, sim) = fault_success(
        "drop-resp",
        &["drop-response-once:5"],
        &Fw::medium(),
        Value::Null,
        0x402,
    );
    assert!(r.total_retries >= 1, "{r:?}");
    // The same counter (0x05) was sent twice; the byte compare above proves no double write.
    let n05 = sim
        .rx_pdus()
        .iter()
        .filter(|p| p.starts_with("36 05 "))
        .count();
    assert!(n05 >= 2, "block 5 resent: seen {n05}x");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_max_block_len_8_0x102_0xfff() {
    require_hil!();
    let small = Fw::new(&[(0x0800_0000, 1_800), (0x0800_4000, 1_200)], 0x8);
    for (mbl, fw) in [
        (8u32, &small),
        (0x102, &Fw::medium()),
        (0xFFF, &Fw::medium()),
    ] {
        let spec = format!("max-block-len:0x{mbl:X}");
        let (r, _, _) = fault_success(&format!("mbl-{mbl:x}"), &[&spec], fw, Value::Null, mbl);
        for s in &r.segments {
            assert_eq!(s.ecu_max_block_len, mbl);
            assert_eq!(s.block_len, mbl);
        }
    }
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_silent_after_block_then_recovery() {
    require_hil!();
    let fw = Fw::medium();
    let sim = Sim::spawn("silent", &["--fault", "silent-after-block:20"]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let t0 = Instant::now();
    let (res, _) = download(&e, &id, Value::Null);
    let took = t0.elapsed();
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [silent-after-block:20] {took:?}: {}",
        serde_json::to_string(&err).unwrap()
    );
    assert_eq!(err.kind, FlashErrorKind::Timeout, "{err:?}");
    assert_eq!(err.phase, FlashPhase::Transfer);
    assert_eq!(err.segment_index, Some(0));
    assert_eq!(err.address, Some(0x0800_0000));
    assert_eq!(err.offset, Some(20 * 1024));
    assert_eq!(err.bytes_done, 20 * 1024);
    assert_eq!(err.block_counter, Some(21));
    assert_no_transfer_exit(&sim, "silent");
    drop(sim);

    // Engine stays healthy: restart the ECU, reconnect the bus, flash again.
    let sim = Sim::spawn("silent-recover", &[]);
    e.cmd_disconnect_bus(BUS).expect("disconnect");
    connect(&e, false);
    unlock_and_erase(&e, &fw);
    flash_and_verify(&e, &sim, &fw, Value::Null, 0x402, "silent-recover");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_nrc_0x72_always_no_transfer_exit() {
    require_hil!();
    let fw = Fw::medium();
    let sim = Sim::spawn("nrc72", &["--fault", "nrc:0x36:0x72:always"]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let cap = Candump::start(&sim.dir);
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let (res, _) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [nrc 0x36 0x72] {}",
        serde_json::to_string(&err).unwrap()
    );
    assert_eq!(err.kind, FlashErrorKind::NegativeResponse);
    assert_eq!(err.last_nrc, Some(0x72));
    assert_eq!(err.block_counter, Some(1));
    assert_eq!(err.offset, Some(0));
    assert_eq!(sim.rx_count("36"), 1, "0x72 is not retried");
    assert_no_transfer_exit(&sim, "nrc72");
    match cap {
        Some(c) => {
            let frames = c.stop();
            assert!(
                has_first_frame_sid(&frames, 0x34),
                "capture saw no 0x34 (capture broken?)"
            );
            assert!(!has_single_frame_sid(&frames, 0x37), "0x37 on the wire");
            eprintln!(
                "EVIDENCE [nrc 0x36 0x72] candump: {} tester frames, no 0x37",
                frames.len()
            );
        }
        None => eprintln!("NOTE: candump unavailable; relying on the sim jsonl log"),
    }
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn fault_reset_during_transfer_then_reflash() {
    require_hil!();
    let fw = Fw::medium();
    let sim = Sim::spawn("reset", &["--fault", "reset-during-transfer:10"]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let (res, _) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [reset-during-transfer:10] {}",
        serde_json::to_string(&err).unwrap()
    );
    assert!(
        matches!(
            err.kind,
            FlashErrorKind::Timeout | FlashErrorKind::NegativeResponse
        ),
        "{err:?}"
    );
    assert_eq!(err.phase, FlashPhase::Transfer);
    assert_eq!(err.offset, Some(9 * 1024));
    assert!(
        sim.log_text().contains("\"event\":\"reboot\""),
        "sim did not reset"
    );
    assert_no_transfer_exit(&sim, "reset");
    thread::sleep(Duration::from_millis(300));
    unlock_and_erase(&e, &fw);
    flash_and_verify(&e, &sim, &fw, Value::Null, 0x402, "reset-reflash");
}

/// Starts a large download on a worker; returns it once ≥ `min_bytes` are acknowledged.
fn start_worker(e: &Eng, id: &str) -> (Worker, Arc<AtomicU64>) {
    let done = Arc::new(AtomicU64::new(0));
    let (e2, id2, d2) = (Arc::clone(&e.0), id.to_string(), Arc::clone(&done));
    let h = thread::spawn(move || {
        let cfg = dcfg();
        let dl = resolve_download_config(Value::Null, false).unwrap();
        let mut ev = Vec::new();
        let r = e2.cmd_flash_download(cfg, &id2, dl, &mut |p| {
            d2.store(p.bytes_done.max(1), Ordering::SeqCst);
            ev.push((Instant::now(), p));
        });
        (r, ev)
    });
    (h, done)
}

fn wait_bytes(done: &AtomicU64, min: u64) {
    let t0 = Instant::now();
    while done.load(Ordering::SeqCst) < min {
        assert!(
            t0.elapsed() < Duration::from_secs(20),
            "download never progressed"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn cancel_mid_transfer_from_another_thread() {
    require_hil!();
    let fw = Fw::large();
    let sim = Sim::spawn("cancel", &[]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let (h, done) = start_worker(&e, &id);
    wait_bytes(&done, 50_000);
    let t_cancel = Instant::now();
    e.cmd_flash_cancel(&dcfg());
    let (res, _) = h.join().unwrap();
    let latency = t_cancel.elapsed();
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [cancel] latency {latency:?}: {}",
        serde_json::to_string(&err).unwrap()
    );
    assert_eq!(err.kind, FlashErrorKind::Cancelled, "{err:?}");
    assert!(err.bytes_done >= 50_000 && err.bytes_done < fw.total());
    thread::sleep(Duration::from_millis(200));
    assert_no_transfer_exit(&sim, "cancel");
    assert!(bus_armed(&e), "cancel must not disarm the bus");
    // A new run on the same session is accepted afterwards (run entry released).
    unlock_and_erase(&e, &fw);
    flash_and_verify(&e, &sim, &fw, Value::Null, 0x402, "cancel-reflash");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn panic_stop_mid_transfer() {
    require_hil!();
    let fw = Fw::large();
    let sim = Sim::spawn("panic", &[]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let (h, done) = start_worker(&e, &id);
    wait_bytes(&done, 50_000);
    let p = e.cmd_panic_stop_tx();
    let (res, _) = h.join().unwrap();
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [panic] disarmed={} : {}",
        p.disarmed_buses,
        serde_json::to_string(&err).unwrap()
    );
    let mut failures = Vec::new();
    if err.kind != FlashErrorKind::Cancelled {
        failures.push(format!(
            "Panic Stop mid-transfer ended as {:?} (diagCode {:?}), expected Cancelled: {}",
            err.kind, err.diag_code, err.message
        ));
    }
    thread::sleep(Duration::from_millis(200));
    assert_no_transfer_exit(&sim, "panic");
    assert!(!bus_armed(&e), "bus still armed after Panic Stop");
    assert_eq!(p.disarmed_buses, 1);

    // Refused while latched / disarmed, nothing transmitted.
    let n34 = sim.rx_count("34");
    let (res, _) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [panic] flash while latched: {}",
        serde_json::to_string(&err).unwrap()
    );
    // Already latched = gate refusal (nothing was running to cancel), like any other gate.
    assert_eq!(err.kind, FlashErrorKind::Transport, "{err:?}");
    assert_eq!(err.diag_code, Some(DiagErrorCode::PanicLatched), "{err:?}");
    assert!(
        e.cmd_arm_active_bus(BUS, true).is_err(),
        "arming must fail while latched"
    );
    e.cmd_clear_panic_latch();
    assert!(!bus_armed(&e), "clearing the latch must not re-arm");
    let (res, _) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [panic] flash after latch clear, not re-armed: {}",
        serde_json::to_string(&err).unwrap()
    );
    assert_eq!(err.kind, FlashErrorKind::Transport);
    assert_eq!(err.diag_code, Some(DiagErrorCode::Disarmed));
    assert_eq!(sim.rx_count("34"), n34, "refused flash reached the ECU");

    e.cmd_arm_active_bus(BUS, true).expect("re-arm");
    unlock_and_erase(&e, &fw);
    flash_and_verify(&e, &sim, &fw, Value::Null, 0x402, "panic-reflash");
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn second_concurrent_download_is_rejected() {
    require_hil!();
    let fw = Fw::large();
    let sim = Sim::spawn("concurrent", &[]);
    let e = engine(false);
    unlock_and_erase(&e, &fw);
    let id = load(
        &e,
        "fw.hex",
        FlashLoadFormat::IntelHex,
        0,
        fw.intel_hex().as_bytes(),
    );
    let (h, done) = start_worker(&e, &id);
    wait_bytes(&done, 10_000);
    let (res, ev) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [concurrent] {}",
        serde_json::to_string(&err).unwrap()
    );
    assert_eq!(err.kind, FlashErrorKind::InvalidConfig);
    assert!(err.message.contains("already running"), "{}", err.message);
    assert!(ev.is_empty());
    let (res, events) = h.join().unwrap();
    let report = res.expect("first download unaffected");
    check_flash(&fw, &report, &events, 0x402);
    check_and_reset(&e, fw.crc32());
    let (hexf, _) = fw.write_sources(&sim.dir);
    sim.assert_equal(&hexf, &[]);
    assert_eq!(sim.rx_count("34"), 2, "the rejected run must not send 0x34");
}

#[test]
#[ignore = "needs vcan0 + nexus-ecu-sim: scripts/hil/run_flash_e2e.sh"]
fn released_or_evicted_image_is_invalid() {
    require_hil!();
    let sim = Sim::spawn("image-id", &[]);
    let e = engine(false);
    let fw = Fw::new(&[(0x0800_0000, 512)], 1);
    let hexs = fw.intel_hex();
    let id = load(&e, "a.hex", FlashLoadFormat::IntelHex, 0, hexs.as_bytes());
    e.cmd_flash_release_image(&id);
    let (res, _) = download(&e, &id, Value::Null);
    let err = res.unwrap_err();
    assert_eq!(err.kind, FlashErrorKind::InvalidImage, "{err:?}");
    let first = load(&e, "b.hex", FlashLoadFormat::IntelHex, 0, hexs.as_bytes());
    for i in 0..nexus_hal::pipeline::diag_flash::MAX_CACHED_IMAGES {
        load(
            &e,
            &format!("c{i}.hex"),
            FlashLoadFormat::IntelHex,
            0,
            hexs.as_bytes(),
        );
    }
    let (res, _) = download(&e, &first, Value::Null);
    let err = res.unwrap_err();
    eprintln!(
        "EVIDENCE [evicted] {}",
        serde_json::to_string(&err).unwrap()
    );
    assert_eq!(err.kind, FlashErrorKind::InvalidImage);
    assert!(err.message.contains("released or evicted"));
    thread::sleep(Duration::from_millis(100));
    assert!(sim.rx_pdus().is_empty(), "ECU received {:?}", sim.rx_pdus());
}
