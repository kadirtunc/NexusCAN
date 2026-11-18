//! Linux runtime: binds the physical ISO-TP socket and the optional
//! functional `CAN_RAW` receiver, feeds requests into [`Server`] and executes
//! the resulting plans.
//!
//! Functional requests (ISO 15765-4) are Single Frames only: they are read
//! from a raw socket filtered to the functional ID and decoded by
//! [`crate::functional::decode_single_frame`]; First / Consecutive Frames are
//! logged as `rx-ignored` and never get a FlowControl. Every response is sent
//! on the physical response ID.
//!
//! jsonl events: `rx` / `rx-ignored` carry `addr` (`phys` | `func`), `canId`
//! and `pdu` (`functional` is kept for older log readers); `tx` carries
//! `addr` + `canId`; `boot-jump` / `boot-jump-end` and `reboot` / `boot`
//! bracket the silent windows.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::functional::decode_single_frame;
use crate::image;
use crate::isotp::{wait_readable, IsoTpOptions, IsoTpSocket};
use crate::log::{hex_short, Logger};
use crate::rawcan::RawCanSocket;
use crate::server::{Plan, Server, Step};

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub iface: String,
    pub rx_id: u32,
    pub tx_id: u32,
    pub functional_id: Option<u32>,
    pub isotp: IsoTpOptions,
    pub image_out: PathBuf,
}

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

/// Installs SIGINT/SIGTERM handlers that request a clean shutdown.
pub fn install_signal_handlers() {
    // SAFETY: the handler only touches an atomic (async-signal-safe).
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_signal as *const () as libc::sighandler_t;
        libc::sigemptyset(&mut sa.sa_mask);
        sa.sa_flags = 0; // no SA_RESTART: poll() returns EINTR
        libc::sigaction(libc::SIGINT, &sa, std::ptr::null_mut());
        libc::sigaction(libc::SIGTERM, &sa, std::ptr::null_mut());
    }
}

pub fn stop_requested() -> bool {
    STOP.load(Ordering::SeqCst)
}

fn sleep_interruptible(d: Duration) {
    let end = Instant::now() + d;
    while !stop_requested() {
        let now = Instant::now();
        if now >= end {
            break;
        }
        std::thread::sleep((end - now).min(Duration::from_millis(20)));
    }
}

fn notes(log: &mut Logger, notes: Vec<String>) {
    for n in notes {
        log.event("note", json!({ "msg": n }));
    }
}

fn save_image(rt: &RuntimeConfig, server: &Server, log: &mut Logger) {
    match image::write_atomic(&rt.image_out, server.memory()) {
        Ok(()) => log.event(
            "image",
            json!({ "path": rt.image_out.display().to_string() }),
        ),
        Err(e) => log.event(
            "error",
            json!({ "msg": format!("writing {}: {e}", rt.image_out.display()) }),
        ),
    }
}

struct Links<'a> {
    rt: &'a RuntimeConfig,
    phys: IsoTpSocket,
    func: Option<RawCanSocket>,
}

impl Links<'_> {
    fn id(&self, id: u32) -> String {
        format!("0x{id:X}")
    }

    fn log_rx(&self, log: &mut Logger, kind: &str, pdu: &[u8], functional: bool, extra: Value) {
        let id = if functional {
            self.rt.functional_id.unwrap_or(0)
        } else {
            self.rt.rx_id
        };
        let mut v = json!({
            "addr": if functional { "func" } else { "phys" },
            "canId": self.id(id),
            "pdu": hex_short(pdu),
            "functional": functional,
        });
        if let (Some(m), Value::Object(e)) = (v.as_object_mut(), extra) {
            m.extend(e);
        }
        log.event(kind, v);
    }

    /// Discards every queued request (ECU not listening); returns the count.
    fn discard_queued(&self, log: &mut Logger, reason: &str) -> usize {
        let mut n = 0;
        for pdu in self.phys.drain_collect() {
            self.log_rx(log, "rx-ignored", &pdu, false, json!({ "reason": reason }));
            n += 1;
        }
        if let Some(f) = &self.func {
            for frame in f.drain() {
                match decode_single_frame(&frame) {
                    Ok(pdu) => {
                        self.log_rx(log, "rx-ignored", pdu, true, json!({ "reason": reason }))
                    }
                    Err(e) => self.log_rx(
                        log,
                        "rx-ignored",
                        &frame,
                        true,
                        json!({ "reason": format!("{reason}; {e}") }),
                    ),
                }
                n += 1;
            }
        }
        n
    }

    fn execute(&self, plan: Plan, log: &mut Logger) {
        for step in plan.steps {
            match step {
                Step::Send(pdu) => {
                    if let Err(e) = self.phys.send(&pdu) {
                        log.event(
                            "error",
                            json!({ "msg": format!("send failed: {e}"), "pdu": hex_short(&pdu) }),
                        );
                    } else {
                        log.event(
                            "tx",
                            json!({ "addr": "phys", "canId": self.id(self.rt.tx_id), "pdu": hex_short(&pdu) }),
                        );
                    }
                }
                Step::Delay(d) => sleep_interruptible(d),
                Step::Reboot(d) => {
                    log.event("reboot", json!({ "ms": d.as_millis() as u64 }));
                    sleep_interruptible(d);
                    let dropped = self.discard_queued(log, "reboot");
                    log.event("boot", json!({ "droppedRequests": dropped }));
                }
                Step::Silence(d) => {
                    log.event("boot-jump", json!({ "ms": d.as_millis() as u64 }));
                    sleep_interruptible(d);
                    let dropped = self.discard_queued(log, "boot-jump");
                    log.event("boot-jump-end", json!({ "droppedRequests": dropped }));
                }
            }
        }
    }
}

/// Runs the simulator until SIGINT/SIGTERM.
pub fn run(rt: RuntimeConfig, mut server: Server, mut log: Logger) -> std::io::Result<()> {
    let links = Links {
        rt: &rt,
        phys: IsoTpSocket::open(&rt.iface, rt.rx_id, rt.tx_id, &rt.isotp)?,
        func: match rt.functional_id {
            Some(fid) => Some(RawCanSocket::open(
                &rt.iface,
                fid,
                rt.isotp.extended,
                rt.isotp.fd,
            )?),
            None => None,
        },
    };
    let cfg = server.config().clone();
    log.event(
        "ready",
        json!({
            "iface": rt.iface,
            "rx": format!("0x{:X}", rt.rx_id),
            "tx": format!("0x{:X}", rt.tx_id),
            "functional": rt.functional_id.map(|f| format!("0x{f:X}")),
            "extended": rt.isotp.extended,
            "padding": rt.isotp.padding.map(|p| format!("0x{p:02X}")),
            "seedAlgo": cfg.seed_algo.to_string(),
            "maxBlockLen": format!("0x{:X}", server.max_block_len()),
            "regions": cfg.regions.iter().map(|(a, l)| format!("0x{a:08X}:0x{l:X}")).collect::<Vec<_>>(),
            "faults": cfg.faults.iter().map(|f| f.to_string()).collect::<Vec<_>>(),
            "imageOut": rt.image_out.display().to_string(),
        }),
    );

    let mut buf = vec![0u8; 65536];
    let mut fds = vec![std::os::fd::AsRawFd::as_raw_fd(&links.phys)];
    if let Some(f) = &links.func {
        fds.push(std::os::fd::AsRawFd::as_raw_fd(f));
    }
    while !stop_requested() {
        let now = Instant::now();
        notes(&mut log, server.tick(now));
        let mut timeout = Duration::from_millis(100);
        if let Some(d) = server.s3_deadline() {
            timeout = timeout.min(d.saturating_duration_since(now));
        }
        let ready = wait_readable(&fds, timeout)?;
        for (i, r) in ready.iter().enumerate() {
            if !*r {
                continue;
            }
            let functional = i == 1;
            let req: Vec<u8> = if functional {
                let Some(f) = &links.func else { continue };
                let frame = match f.recv() {
                    Ok(fr) => fr,
                    Err(e) => {
                        log.event("error", json!({ "msg": format!("CAN_RAW recv: {e}") }));
                        continue;
                    }
                };
                match decode_single_frame(&frame) {
                    Ok(pdu) => pdu.to_vec(),
                    Err(e) => {
                        links.log_rx(
                            &mut log,
                            "rx-ignored",
                            &frame,
                            true,
                            json!({ "reason": e.to_string() }),
                        );
                        continue;
                    }
                }
            } else {
                match links.phys.recv(&mut buf) {
                    Ok(n) => buf[..n].to_vec(),
                    Err(e) => {
                        // ISO-TP protocol errors (CF timeout, wrong SN, …) surface here.
                        log.event("isotp-error", json!({ "msg": e.to_string() }));
                        continue;
                    }
                }
            };
            links.log_rx(&mut log, "rx", &req, functional, Value::Null);
            let mut plan = server.handle(&req, Instant::now(), functional);
            notes(&mut log, std::mem::take(&mut plan.notes));
            // Persist BEFORE acknowledging (0x77): a client that compares the
            // image right after RequestTransferExit must never see stale data.
            if plan.write_image {
                save_image(&rt, &server, &mut log);
            }
            links.execute(plan, &mut log);
            server.response_completed(Instant::now());
        }
    }
    save_image(&rt, &server, &mut log);
    log.event("exit", json!({ "bootCount": server.boot_count() }));
    Ok(())
}
