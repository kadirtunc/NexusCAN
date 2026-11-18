//! Shared HIL test harness: a minimal, independent UDS *client* on a kernel
//! ISO-TP socket, a guard that spawns/kills the `nexus-ecu-sim` binary, and
//! Intel HEX / S-record writers (independent of the parsers under test).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nexus_ecu_sim::isotp::{IsoTpOptions, IsoTpSocket};

pub const BASE: u32 = 0x0800_0000;

pub fn iface() -> String {
    std::env::var("NEXUS_HIL_IFACE").unwrap_or_else(|_| "vcan0".into())
}

/// Returns false (and prints why) when the HIL interface is unavailable.
///
/// Uses `if_nametoindex(3)` rather than `/sys/class/net`: inside a network
/// namespace sysfs still shows the host's interfaces. With
/// `NEXUS_HIL_REQUIRE=1` (set by `run_hil_tests.sh`) a missing interface is a
/// hard failure instead of a skip, so a CI run can never pass vacuously.
pub fn hil_available() -> bool {
    let i = iface();
    let name = std::ffi::CString::new(i.clone()).unwrap();
    // SAFETY: valid NUL-terminated string.
    let present = unsafe { libc::if_nametoindex(name.as_ptr()) } != 0;
    if !present {
        if std::env::var("NEXUS_HIL_REQUIRE").as_deref() == Ok("1") {
            panic!("NEXUS_HIL_REQUIRE=1 but CAN interface '{i}' is not present");
        }
        eprintln!(
            "SKIP: CAN interface '{i}' not present. Bring it up with \
             `sudo scripts/hil/vcan_up.sh`, or run rootless via \
             `scripts/hil/run_hil_tests.sh` (user+net namespace)."
        );
        return false;
    }
    true
}

macro_rules! require_hil {
    () => {
        if !common::hil_available() {
            return;
        }
    };
}
pub(crate) use require_hil;

pub fn work_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join("nexus-ecu-sim-hil")
        .join(format!("{name}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

// --------------------------------------------------------------- client

pub struct Client {
    sock: IsoTpSocket,
    /// P2client: generous, the simulator runs as a debug build in parallel tests.
    pub p2: Duration,
    pub p2star: Duration,
}

#[derive(Debug)]
pub struct Answer {
    pub pdu: Vec<u8>,
    pub pendings: u32,
    pub elapsed: Duration,
}

impl Client {
    /// `sim_rx` = the simulator's request ID, `sim_tx` = its response ID.
    pub fn new(sim_rx: u32, sim_tx: u32) -> Self {
        Self::with_opts(sim_rx, sim_tx, &IsoTpOptions::default())
    }

    pub fn with_opts(sim_rx: u32, sim_tx: u32, o: &IsoTpOptions) -> Self {
        let sock =
            IsoTpSocket::open(&iface(), sim_tx, sim_rx, o).expect("open client ISO-TP socket");
        Self {
            sock,
            p2: Duration::from_millis(1000),
            p2star: Duration::from_millis(6000),
        }
    }

    pub fn send(&self, req: &[u8]) {
        self.sock.send(req).expect("ISO-TP send");
    }

    pub fn recv(&self, timeout: Duration) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; 8192];
        self.sock
            .recv_timeout(&mut buf, timeout)
            .expect("ISO-TP recv")
            .map(|n| buf[..n].to_vec())
    }

    /// Sends `req` and waits for the final response, following 0x78 pending.
    pub fn try_request(&self, req: &[u8]) -> Option<Answer> {
        let t0 = Instant::now();
        self.send(req);
        let mut pendings = 0;
        let mut timeout = self.p2;
        loop {
            let pdu = self.recv(timeout)?;
            if pdu.len() == 3 && pdu[0] == 0x7F && pdu[1] == req[0] && pdu[2] == 0x78 {
                pendings += 1;
                timeout = self.p2star;
                continue;
            }
            return Some(Answer {
                pdu,
                pendings,
                elapsed: t0.elapsed(),
            });
        }
    }

    pub fn request(&self, req: &[u8]) -> Vec<u8> {
        self.try_request(req)
            .unwrap_or_else(|| panic!("no response to {req:02X?}"))
            .pdu
    }

    /// Asserts a positive response with the given prefix.
    pub fn expect_pos(&self, req: &[u8], prefix: &[u8]) -> Vec<u8> {
        let r = self.request(req);
        assert!(
            r.starts_with(prefix),
            "req {req:02X?}: expected {prefix:02X?}.., got {r:02X?}"
        );
        r
    }

    pub fn expect_nrc(&self, req: &[u8], code: u8) {
        let r = self.request(req);
        assert_eq!(r, vec![0x7F, req[0], code], "req {req:02X?}");
    }

    pub fn expect_silence(&self, req: &[u8], wait: Duration) {
        self.send(req);
        if let Some(r) = self.recv(wait) {
            panic!("expected no response to {req:02X?}, got {r:02X?}");
        }
    }

    pub fn unlock(&self, level: u8) {
        let r = self.expect_pos(&[0x27, level], &[0x67, level]);
        // xor_ff, computed independently of the simulator's seed module.
        let mut k = vec![0x27, level + 1];
        k.extend(r[2..].iter().map(|b| !b));
        self.expect_pos(&k, &[0x67, level + 1]);
    }

    pub fn enter_programming(&self) {
        self.expect_pos(&[0x10, 0x03], &[0x50, 0x03]);
        self.expect_pos(&[0x10, 0x02], &[0x50, 0x02]);
        self.wait_alive(&[0x3E, 0x00]);
        self.unlock(0x11);
    }

    /// Discards responses still queued on the client socket.
    pub fn drain(&self) -> usize {
        self.sock.drain()
    }

    /// Polls `req` every 100 ms until the ECU answers (after a bootloader
    /// jump or reboot); returns the answer and the time spent polling.
    pub fn wait_alive(&self, req: &[u8]) -> (Vec<u8>, Duration) {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(10) {
            self.send(req);
            if let Some(r) = self.recv(Duration::from_millis(100)) {
                // A late answer to an earlier poll must not leak into the next request.
                std::thread::sleep(Duration::from_millis(20));
                self.drain();
                return (r, t0.elapsed());
            }
        }
        panic!("ECU did not come back within 10 s (polling {req:02X?})");
    }

    pub fn erase(&self, addr: u32, len: u32) -> Answer {
        let mut r = vec![0x31, 0x01, 0xFF, 0x00, 0x44];
        r.extend_from_slice(&addr.to_be_bytes());
        r.extend_from_slice(&len.to_be_bytes());
        let a = self.try_request(&r).expect("erase response");
        assert_eq!(a.pdu, vec![0x71, 0x01, 0xFF, 0x00, 0x00]);
        a
    }

    /// RequestDownload; returns maxNumberOfBlockLength.
    pub fn request_download(&self, addr: u32, len: u32) -> usize {
        let mut r = vec![0x34, 0x00, 0x44];
        r.extend_from_slice(&addr.to_be_bytes());
        r.extend_from_slice(&len.to_be_bytes());
        let resp = self.expect_pos(&r, &[0x74]);
        let n = usize::from(resp[1] >> 4);
        assert_eq!(resp.len(), 2 + n);
        resp[2..]
            .iter()
            .fold(0usize, |a, &b| (a << 8) | usize::from(b))
    }

    pub fn transfer_block(&self, bsc: u8, chunk: &[u8]) -> Option<Vec<u8>> {
        let mut r = Vec::with_capacity(chunk.len() + 2);
        r.push(0x36);
        r.push(bsc);
        r.extend_from_slice(chunk);
        self.try_request(&r).map(|a| a.pdu)
    }
}

/// Functional (1-to-N) tester: kernel ISO-TP socket with
/// `CAN_ISOTP_SF_BROADCAST`, so every request is a Single Frame on `fid`
/// (the kernel refuses anything longer). Responses arrive on the physical
/// client socket.
pub struct FuncClient {
    sock: IsoTpSocket,
}

impl FuncClient {
    pub fn new(fid: u32) -> Self {
        let sock = IsoTpSocket::open(
            &iface(),
            0x5FE, // never used: a functional sender receives nothing itself
            fid,
            &IsoTpOptions {
                sf_broadcast: true,
                ..Default::default()
            },
        )
        .expect("open functional ISO-TP socket");
        Self { sock }
    }

    pub fn send(&self, req: &[u8]) {
        self.sock.send(req).expect("functional SF send");
    }

    pub fn try_send(&self, req: &[u8]) -> std::io::Result<()> {
        self.sock.send(req)
    }
}

/// Full reference flash sequence. Returns the number of TransferData blocks.
pub fn flash(c: &Client, data: &[u8]) -> usize {
    c.enter_programming();
    c.erase(BASE, data.len() as u32);
    let mbl = c.request_download(BASE, data.len() as u32);
    let mut bsc: u8 = 1;
    let mut blocks = 0;
    for chunk in data.chunks(mbl - 2) {
        let r = c.transfer_block(bsc, chunk).expect("TransferData response");
        assert_eq!(r, vec![0x76, bsc], "block {blocks}");
        bsc = bsc.wrapping_add(1);
        blocks += 1;
    }
    c.expect_pos(&[0x37], &[0x77]);
    let crc = crc32_ref(data);
    let mut r = vec![0x31, 0x01, 0x02, 0x02];
    r.extend_from_slice(&crc.to_be_bytes());
    c.expect_pos(&r, &[0x71, 0x01, 0x02, 0x02, 0x00]);
    blocks
}

/// Bitwise CRC-32/ISO-HDLC (independent of the simulator's table version).
pub fn crc32_ref(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

pub fn firmware(len: usize, seed: u32) -> Vec<u8> {
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

// --------------------------------------------------------------- simulator

pub struct Sim {
    child: Child,
    pub image: PathBuf,
    pub log: PathBuf,
    pub dir: PathBuf,
}

impl Sim {
    /// Spawns the simulator. Functional addressing is switched off unless
    /// `extra` sets `--functional`: parallel tests share one bus and must not
    /// all react to 0x7DF (see [`Sim::spawn_default_functional`]).
    pub fn spawn(name: &str, rx: u32, tx: u32, extra: &[&str]) -> Self {
        let mut args: Vec<&str> = extra.to_vec();
        if !extra.contains(&"--functional") {
            args.extend(["--functional", "off"]);
        }
        Self::spawn_exact(name, rx, tx, &args)
    }

    /// Spawns with the simulator's own defaults (functional 0x7DF ON).
    pub fn spawn_default_functional(name: &str, rx: u32, tx: u32, extra: &[&str]) -> Self {
        Self::spawn_exact(name, rx, tx, extra)
    }

    fn spawn_exact(name: &str, rx: u32, tx: u32, extra: &[&str]) -> Self {
        let dir = work_dir(name);
        let image = dir.join("flash_image.json");
        let log = dir.join("sim.jsonl");
        let _ = std::fs::remove_file(&image);
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_nexus-ecu-sim"));
        cmd.args(["--iface", &iface()])
            .args(["--rx", &format!("0x{rx:X}"), "--tx", &format!("0x{tx:X}")])
            .args(["--image-out", image.to_str().unwrap()])
            .args(["--log", "jsonl", "--log-file", log.to_str().unwrap()])
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        let child = cmd.spawn().expect("spawn nexus-ecu-sim");
        let sim = Self {
            child,
            image,
            log,
            dir,
        };
        sim.wait_ready(rx, tx, extra.contains(&"--extended"));
        sim
    }

    fn wait_ready(&self, rx: u32, tx: u32, extended: bool) {
        let mut c = Client::with_opts(
            rx,
            tx,
            &IsoTpOptions {
                extended,
                ..Default::default()
            },
        );
        c.p2 = Duration::from_millis(100);
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(10) {
            if c.try_request(&[0x3E, 0x00]).is_some() {
                return;
            }
        }
        panic!(
            "simulator did not become ready; log: {}",
            self.log.display()
        );
    }

    pub fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    /// Parsed jsonl events.
    pub fn events(&self) -> Vec<serde_json::Value> {
        self.log_text()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    pub fn assert_image_equals_segments(&self, segs: &[(u32, &[u8])]) -> String {
        let hex = self.dir.join("source_segments.hex");
        std::fs::write(&hex, write_intel_hex_segments(segs)).unwrap();
        let (code, text) = self.compare(&hex, &[]);
        assert_eq!(
            code,
            0,
            "flash compare failed:\n{text}\nlog: {}",
            self.log.display()
        );
        text
    }

    /// Runs `nexus-flash-compare`; returns (exit code, stdout).
    pub fn compare(&self, source: &Path, extra: &[&str]) -> (i32, String) {
        let out = Command::new(env!("CARGO_BIN_EXE_nexus-flash-compare"))
            .args(["--source", source.to_str().unwrap()])
            .args(["--image", self.image.to_str().unwrap()])
            .args(extra)
            .output()
            .expect("run nexus-flash-compare");
        let text = String::from_utf8_lossy(&out.stdout).into_owned()
            + &String::from_utf8_lossy(&out.stderr);
        (out.status.code().unwrap_or(-1), text)
    }

    pub fn assert_image_equals(&self, data: &[u8]) {
        let hex = self.dir.join("source.hex");
        std::fs::write(&hex, write_intel_hex(BASE, data)).unwrap();
        let (code, text) = self.compare(&hex, &[]);
        assert_eq!(
            code,
            0,
            "flash compare failed:\n{text}\nlog: {}",
            self.log.display()
        );
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        // SAFETY: sending SIGTERM to our own child process.
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// --------------------------------------------------------------- writers

fn ihex_record(kind: u8, addr: u16, data: &[u8]) -> String {
    let mut v = vec![data.len() as u8, (addr >> 8) as u8, addr as u8, kind];
    v.extend_from_slice(data);
    let ck = 0u8.wrapping_sub(v.iter().fold(0u8, |a, &b| a.wrapping_add(b)));
    v.push(ck);
    format!(
        ":{}\n",
        v.iter().map(|b| format!("{b:02X}")).collect::<String>()
    )
}

pub fn write_intel_hex(base: u32, data: &[u8]) -> String {
    let mut s = String::new();
    let mut upper: Option<u16> = None;
    let mut off = 0usize;
    while off < data.len() {
        let addr = base + off as u32;
        let hi = (addr >> 16) as u16;
        if upper != Some(hi) {
            s += &ihex_record(0x04, 0, &hi.to_be_bytes());
            upper = Some(hi);
        }
        // Do not cross a 64 KiB boundary inside a record.
        let room = 0x1_0000 - (addr & 0xFFFF) as usize;
        let n = 32.min(data.len() - off).min(room);
        s += &ihex_record(0x00, addr as u16, &data[off..off + n]);
        off += n;
    }
    s += &ihex_record(0x01, 0, &[]);
    s
}

/// Intel HEX with several (possibly non-contiguous) segments.
pub fn write_intel_hex_segments(segs: &[(u32, &[u8])]) -> String {
    let eof = ihex_record(0x01, 0, &[]);
    let mut s = String::new();
    for (base, data) in segs {
        s += write_intel_hex(*base, data).trim_end_matches(eof.as_str());
    }
    s + &eof
}

pub fn write_srec(base: u32, data: &[u8]) -> String {
    let rec = |t: u8, body: &[u8]| {
        let mut v = vec![(body.len() + 1) as u8];
        v.extend_from_slice(body);
        let ck = !v.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        v.push(ck);
        format!(
            "S{t}{}\n",
            v.iter().map(|b| format!("{b:02X}")).collect::<String>()
        )
    };
    let mut s = rec(0, b"\0\0nexus");
    let mut n = 0u32;
    for (i, chunk) in data.chunks(32).enumerate() {
        let mut body = (base + (i * 32) as u32).to_be_bytes().to_vec();
        body.extend_from_slice(chunk);
        s += &rec(3, &body);
        n += 1;
    }
    if n <= 0xFFFF {
        s += &rec(5, &(n as u16).to_be_bytes());
    } else {
        s += &rec(6, &n.to_be_bytes()[1..]);
    }
    s += &rec(7, &base.to_be_bytes());
    s
}
