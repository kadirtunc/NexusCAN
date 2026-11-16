//! Test-only harness for the UDS client HIL tests (Linux, vcan0).
//!
//! * [`SocketCanPort`] — a [`DiagCanPort`] over two raw SocketCAN sockets. It is NOT the HAL
//!   implementation (that lives in `nexus-hal`); it exists so `nexus-protocols` can be tested
//!   end-to-end without depending on `nexus-hal`. TX confirmations are derived from the RX socket
//!   seeing our own frame (vcan loopback from the TX socket), so `TxConfirmed` / `Rx` ordering is
//!   true bus order.
//! * [`EcuSim`] — starts our own `tests/hil/ecusim` instance on test-only ids and reads its
//!   JSON-lines event log. Only signals the PID it started.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use nexus_core::{now_monotonic_us, CanIdKey, RawCanFrame};
use nexus_protocols::uds::dto::DiagSessionConfigDto;
use nexus_protocols::uds::port::{DiagCanPort, DiagPortEvent, DiagTxReject};
use socketcan::frame::FdFlags;
use socketcan::{
    CanAnyFrame, CanDataFrame, CanFdFrame, CanFdSocket, CanFilter, EmbeddedFrame, Frame, Socket,
    SocketOptions, StandardId,
};

pub const IFACE: &str = "vcan0";

#[derive(Clone, Copy, Debug)]
pub struct Ids {
    pub req: u32,
    pub resp: u32,
    pub func: u32,
}

/// User's manual test ECU (PID 107587) — never used here.
const FORBIDDEN: [u32; 3] = [0x7E0, 0x7E8, 0x7DF];
pub const CLASSIC: Ids = Ids {
    req: 0x7E2,
    resp: 0x7EA,
    func: 0x7DE,
};
pub const FD: Ids = Ids {
    req: 0x7E3,
    resp: 0x7EB,
    func: 0x7D8,
};

/// Serializes HIL tests even if `--test-threads=1` is forgotten (same CAN ids).
static SERIAL: Mutex<()> = Mutex::new(());

pub fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn ecusim_bin() -> PathBuf {
    repo_root().join("tests/hil/ecusim/build/ecusim")
}

/// Environment check. `None` (with a printed reason) means: skip this test.
pub fn hil_env(need_fd: bool) -> Option<()> {
    let net = Path::new("/sys/class/net").join(IFACE);
    if !net.exists() {
        eprintln!("SKIP (HIL): {IFACE} not present — run scripts/setup_vcan.sh");
        return None;
    }
    if need_fd {
        let mtu = std::fs::read_to_string(net.join("mtu")).unwrap_or_default();
        if mtu.trim() != "72" {
            eprintln!(
                "SKIP (HIL): {IFACE} MTU is {} (CAN-FD needs 72)",
                mtu.trim()
            );
            return None;
        }
    }
    if !ecusim_bin().exists() {
        let ok = Command::new("make")
            .arg("-C")
            .arg(repo_root().join("tests/hil/ecusim"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok || !ecusim_bin().exists() {
            eprintln!("SKIP (HIL): ecusim not built and `make -C tests/hil/ecusim` failed");
            return None;
        }
    }
    Some(())
}

pub fn config(ids: Ids, fd: bool, functional: bool) -> DiagSessionConfigDto {
    DiagSessionConfigDto {
        bus_id: 0,
        request_id: ids.req,
        response_id: ids.resp,
        is_extended_id: false,
        protocol: Some("uds".into()),
        functional_id: functional.then_some(ids.func),
        use_fd: fd,
        padding: Some(0xAA),
        p2_margin_ms: 100,
        address_format: Default::default(),
        target_address: None,
        response_address: None,
    }
}

// ─── test DiagCanPort ───────────────────────────────────────────────────────

/// Shared knobs / evidence of a [`SocketCanPort`].
#[derive(Clone, Default)]
pub struct Probe {
    /// Advisory + authoritative gate (both checked in `send`).
    pub gate: Arc<Mutex<Option<DiagTxReject>>>,
    pub closed: Arc<AtomicBool>,
    /// Every frame written to the bus by the port.
    pub sent: Arc<Mutex<Vec<RawCanFrame>>>,
}

impl Probe {
    pub fn set_gate(&self, r: Option<DiagTxReject>) {
        *self.gate.lock().unwrap_or_else(|e| e.into_inner()) = r;
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }
    pub fn sent(&self) -> Vec<RawCanFrame> {
        self.sent.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

pub struct SocketCanPort {
    tx: CanFdSocket,
    events: crossbeam_channel::Receiver<DiagPortEvent>,
    pending: Arc<Mutex<VecDeque<RawCanFrame>>>,
    stop: Arc<AtomicBool>,
    reader: Option<std::thread::JoinHandle<()>>,
    probe: Probe,
    fd: bool,
}

fn std_filter(id: u32) -> CanFilter {
    // Exact 11-bit data frames only (EFF and RTR bits must be 0).
    CanFilter::new(id, 0x7FF | 0x8000_0000 | 0x4000_0000)
}

fn to_raw(f: &CanAnyFrame) -> Option<RawCanFrame> {
    let ts = now_monotonic_us();
    match f {
        CanAnyFrame::Normal(d) => {
            let key = CanIdKey::new_standard(u16::try_from(d.raw_id()).ok()?)?;
            RawCanFrame::new_classical(0, key, d.data(), ts).ok()
        }
        CanAnyFrame::Fd(d) => {
            let key = CanIdKey::new_standard(u16::try_from(d.raw_id()).ok()?)?;
            RawCanFrame::new_fd(0, key, d.data(), d.is_brs(), ts).ok()
        }
        _ => None,
    }
}

impl SocketCanPort {
    pub fn open(ids: Ids, fd: bool) -> (Box<dyn DiagCanPort>, Probe) {
        let rx = CanFdSocket::open(IFACE).expect("open rx socket");
        rx.set_filters(&[
            std_filter(ids.resp),
            std_filter(ids.req),
            std_filter(ids.func),
        ])
        .expect("filters");
        rx.set_read_timeout(Duration::from_millis(20))
            .expect("timeout");
        let tx = CanFdSocket::open(IFACE).expect("open tx socket");
        tx.set_filter_drop_all().expect("drop all");
        let (ev_tx, events) = crossbeam_channel::unbounded();
        let pending: Arc<Mutex<VecDeque<RawCanFrame>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let probe = Probe::default();
        let reader = {
            let (pending, stop, closed) = (pending.clone(), stop.clone(), probe.closed.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let Ok(frame) = rx.read_frame() else { continue };
                    if closed.load(Ordering::Acquire) {
                        continue;
                    }
                    let Some(raw) = to_raw(&frame) else { continue };
                    let ev = if raw.arb_id == ids.req || raw.arb_id == ids.func {
                        let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
                        let mine = p.front().is_some_and(|f| {
                            f.arb_id == raw.arb_id && f.payload() == raw.payload()
                        });
                        if mine {
                            p.pop_front();
                            DiagPortEvent::TxConfirmed(raw)
                        } else {
                            DiagPortEvent::Rx(raw)
                        }
                    } else {
                        DiagPortEvent::Rx(raw)
                    };
                    let _ = ev_tx.send(ev);
                }
            })
        };
        let port = SocketCanPort {
            tx,
            events,
            pending,
            stop,
            reader: Some(reader),
            probe: probe.clone(),
            fd,
        };
        (Box::new(port), probe)
    }
}

impl Drop for SocketCanPort {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
    }
}

impl DiagCanPort for SocketCanPort {
    fn bus_id(&self) -> u8 {
        0
    }
    fn fd_enabled(&self) -> bool {
        self.fd
    }
    fn gate_check(&self) -> Result<(), DiagTxReject> {
        if self.probe.closed.load(Ordering::Acquire) {
            return Err(DiagTxReject::Closed);
        }
        match *self.probe.gate.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(r) => Err(r),
            None => Ok(()),
        }
    }
    fn send(&self, frame: RawCanFrame) -> Result<(), DiagTxReject> {
        self.gate_check()?;
        let id = StandardId::new(frame.arb_id as u16).ok_or(DiagTxReject::DriverError)?;
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(frame);
        let res = if frame.is_fd() {
            let flags = if frame.is_brs() {
                FdFlags::BRS
            } else {
                FdFlags::empty()
            };
            CanFdFrame::with_flags(id, frame.payload(), flags)
                .ok_or(DiagTxReject::DriverError)
                .and_then(|f| {
                    self.tx
                        .write_frame(&f)
                        .map_err(|_| DiagTxReject::DriverError)
                })
        } else {
            CanDataFrame::new(id, frame.payload())
                .ok_or(DiagTxReject::DriverError)
                .and_then(|f| {
                    self.tx
                        .write_frame(&f)
                        .map_err(|_| DiagTxReject::DriverError)
                })
        };
        if res.is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_back();
        } else {
            self.probe
                .sent
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(frame);
        }
        res
    }
    fn recv_timeout(&self, timeout: Duration) -> Option<DiagPortEvent> {
        if self.probe.closed.load(Ordering::Acquire) {
            std::thread::sleep(timeout);
            return None;
        }
        self.events.recv_timeout(timeout).ok()
    }
    fn try_recv(&self) -> Option<DiagPortEvent> {
        if self.probe.closed.load(Ordering::Acquire) {
            return None;
        }
        self.events.try_recv().ok()
    }
    fn is_closed(&self) -> bool {
        self.probe.closed.load(Ordering::Acquire)
    }
}

// ─── ecusim process ─────────────────────────────────────────────────────────

pub struct EcuSim {
    child: Option<Child>,
    pub log: PathBuf,
}

fn logs_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("uds-hil");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

impl EcuSim {
    pub fn start(tag: &str, ids: Ids, fd: bool) -> EcuSim {
        for id in [ids.req, ids.resp, ids.func] {
            assert!(
                !FORBIDDEN.contains(&id),
                "ID {id:#x} belongs to the user's manual session"
            );
        }
        let log = logs_dir().join(format!("{tag}.ecu.jsonl"));
        let _ = std::fs::remove_file(&log);
        let mut cmd = Command::new(ecusim_bin());
        cmd.args(["-i", IFACE, "-c"])
            .arg(repo_root().join("tests/hil/ecusim/config/default.json"))
            .args(["--req", &format!("{:#x}", ids.req)])
            .args(["--resp", &format!("{:#x}", ids.resp)])
            .args(["--func", &format!("{:#x}", ids.func)])
            .arg("-l")
            .arg(&log)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if fd {
            cmd.arg("--fd");
        }
        let child = cmd.spawn().expect("spawn ecusim");
        let ecu = EcuSim {
            child: Some(child),
            log,
        };
        assert!(
            ecu.wait_event("\"ev\":\"ready\"", Duration::from_secs(3)),
            "ecusim not ready, see {:?}",
            ecu.log
        );
        ecu
    }

    pub fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    pub fn count(&self, needle: &str) -> usize {
        self.log_text()
            .lines()
            .filter(|l| l.contains(needle))
            .count()
    }

    pub fn wait_event(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.count(needle) > 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

impl Drop for EcuSim {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = Command::new("kill")
                .args(["-TERM", &child.id().to_string()])
                .status();
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

// ─── process metrics ────────────────────────────────────────────────────────

/// (utime + stime) of this process in clock ticks.
pub fn cpu_ticks() -> u64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let after = stat.rsplit_once(')').map_or("", |(_, r)| r);
    let f: Vec<&str> = after.split_whitespace().collect();
    // fields after ')' start at index 0 = state (field 3); utime = field 14, stime = field 15.
    let get = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    get(11) + get(12)
}

pub fn thread_count() -> usize {
    std::fs::read_dir("/proc/self/task")
        .map(|d| d.count())
        .unwrap_or(0)
}

/// `(thread name + tid, utime + stime ticks)` for every thread of this process.
pub fn thread_ticks() -> Vec<(String, u64)> {
    let Ok(dir) = std::fs::read_dir("/proc/self/task") else {
        return Vec::new();
    };
    dir.filter_map(|e| e.ok())
        .filter_map(|e| {
            let stat = std::fs::read_to_string(e.path().join("stat")).ok()?;
            let (head, rest) = stat.rsplit_once(')')?;
            let name = head.split_once('(').map_or("", |(_, n)| n);
            let f: Vec<&str> = rest.split_whitespace().collect();
            let t = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
            Some((format!("{name}/{}", e.file_name().to_string_lossy()), t))
        })
        .collect()
}

/// `(thread, run ns, timeslices)` from `/proc/self/task/*/schedstat` (ns resolution).
pub fn thread_sched() -> Vec<(String, u64, u64)> {
    let Ok(dir) = std::fs::read_dir("/proc/self/task") else {
        return Vec::new();
    };
    dir.filter_map(|e| e.ok())
        .filter_map(|e| {
            let comm = std::fs::read_to_string(e.path().join("comm")).ok()?;
            let st = std::fs::read_to_string(e.path().join("schedstat")).ok()?;
            let f: Vec<u64> = st
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            Some((
                format!("{}/{}", comm.trim(), e.file_name().to_string_lossy()),
                *f.first()?,
                *f.get(2)?,
            ))
        })
        .collect()
}
