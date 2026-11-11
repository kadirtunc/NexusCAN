//! Scenario runner for the automotive <-> nexus-hal bridge spike. See README.md.

use automotive::can::{AsyncCanAdapter, Identifier};
use automotive::protocols::uds::{UDSClient, UDSConfig};
use automotive::transports::isotp::{IsoTP, IsoTPConfig};
use automotive::StreamExt;
use automotive_hal_bridge::adapter::{LogKind, PassiveCanAdapter};
use automotive_hal_bridge::owner::TapFilter;
use automotive_hal_bridge::{format_log, open_bus, open_diag_session, DiagSession, OpenBus};
use nexus_core::now_monotonic_us;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------------------------
// Allocation counter (only counts on threads that opted in via `track_this_thread`).
// ---------------------------------------------------------------------------------------------
struct CountingAlloc;
static OWNER_ALLOCS: AtomicU64 = AtomicU64::new(0);
thread_local! { static TRACK: Cell<bool> = const { Cell::new(false) }; }

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if TRACK.with(Cell::get) {
            OWNER_ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if TRACK.with(Cell::get) {
            OWNER_ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;
fn track_this_thread() {
    TRACK.with(|t| t.set(true));
}

// ---------------------------------------------------------------------------------------------
type Uds = UDSClient<'static, IsoTP<'static>>;

fn parse_id(s: &str) -> u32 {
    u32::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16).expect("hex id")
}
fn ident(id: u32) -> Identifier {
    if id > 0x7FF { Identifier::extended(id).unwrap() } else { Identifier::standard(id).unwrap() }
}
fn filt(id: u32) -> TapFilter {
    if id > 0x7FF { TapFilter::exact_ext(id) } else { TapFilter::exact_std(id) }
}
fn isotp_cfg(tx: u32, rx: u32, fd: bool, stmin: Option<Duration>) -> IsoTPConfig {
    let mut b = IsoTPConfig::builder(ident(tx)).rx_id(ident(rx)).fd(fd);
    if let Some(s) = stmin {
        b = b.separation_time_min(s);
    }
    b.build().expect("isotp cfg")
}
fn uds_over(adapter: &Arc<AsyncCanAdapter>, cfg: IsoTPConfig) -> Uds {
    let isotp = IsoTP::new_owned(Arc::clone(adapter), cfg);
    UDSClient::with_owned_transport(Arc::new(isotp), UDSConfig::default())
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(" ")
}
fn print_log(sess: &DiagSession, t0: u64, max: usize) -> Vec<automotive_hal_bridge::adapter::LogEntry> {
    let entries = sess.log.take();
    let lines = format_log(&entries, t0);
    for l in lines.iter().take(max) {
        println!("    {l}");
    }
    if lines.len() > max {
        println!("    ... ({} more)", lines.len() - max);
    }
    entries
}
/// Measured P2: first RX after the last confirmed TX of the request.
fn p2_us(entries: &[automotive_hal_bridge::adapter::LogEntry]) -> Option<u64> {
    let last_tx = entries.iter().rposition(|e| e.kind == LogKind::TxConfirmed && e.frame.data[0] >> 4 != 3)?;
    let first_rx = entries[last_tx..].iter().find(|e| e.kind == LogKind::Rx)?;
    Some(first_rx.frame.timestamp_us.saturating_sub(entries[last_tx].frame.timestamp_us))
}
fn check(name: &str, ok: bool, detail: impl std::fmt::Display) -> bool {
    println!("[{}] {name}: {detail}", if ok { "PASS" } else { "FAIL" });
    ok
}
fn stats(bus: &OpenBus) -> String {
    let s = bus.owner.stats.snapshot();
    format!(
        "owner rx={} tel_drop={} tap_deliv={} tap_drop={} tx_sent={} tx_rej={} | StateTable ingested={} (tx echoes={})",
        s[0], s[1], s[2], s[3], s[4], s[5],
        bus.telemetry.ingested.load(Ordering::Relaxed),
        bus.telemetry.tx_echoes.load(Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------------------------
async fn scenario_uds(dev: &str, tx: u32, rx: u32, fd: bool) -> bool {
    println!("== uds: {dev} tx=0x{tx:X} rx=0x{rx:X} fd={fd}");
    let bus = open_bus(dev, 0, false, true, fd, None, None).expect("open");
    let sess = open_diag_session(&bus.owner, &[filt(rx)], Duration::from_micros(500), fd).expect("tap");
    let uds = uds_over(&sess.adapter, isotp_cfg(tx, rx, fd, None));
    let mut ok = true;

    let t0 = now_monotonic_us();
    let r = uds.diagnostic_session_control(3u8).await;
    ok &= check("10 03 DiagnosticSessionControl(extended)", r.is_ok(), format!("{r:?}"));
    print_log(&sess, t0, 4);

    let t0 = now_monotonic_us();
    let r = uds.tester_present().await;
    ok &= check("3E 00 TesterPresent", r.is_ok(), format!("{r:?}"));
    let e = print_log(&sess, t0, 4);
    if let Some(p2) = p2_us(&e) {
        println!("    measured P2 (HAL timestamps) = {:.3} ms", p2 as f64 / 1000.0);
    }

    let t0 = now_monotonic_us();
    let r = uds.read_data_by_identifier(0xF190u16).await;
    let vin = r.as_ref().map(|v| String::from_utf8_lossy(v).to_string());
    ok &= check("22 F1 90 ReadDID VIN", matches!(&vin, Ok(v) if v.len() == 17), format!("{vin:?}"));
    let e = print_log(&sess, t0, 8);
    if let Some(p2) = p2_us(&e) {
        println!("    measured P2 (HAL timestamps) = {:.3} ms", p2 as f64 / 1000.0);
    }

    let t0 = now_monotonic_us();
    let r = uds.read_data_by_identifier(0xF1F1u16).await;
    ok &= check("22 F1 F1 ReadDID 200 B (multi-frame RX)", matches!(&r, Ok(v) if v.len() == 200),
        format!("len={:?}", r.as_ref().map(Vec::len)));
    let e = print_log(&sess, t0, 6);
    let cf = e.iter().filter(|x| x.kind == LogKind::Rx && x.frame.data[0] >> 4 == 2).count();
    println!("    consecutive frames received: {cf}");

    // Multi-frame TX: 2E request longer than one SF (CC: >7 B, FD: >62 B) -> ECU must send FC;
    // we expect NRC 0x13 because the DID is 4 bytes long.
    let t0 = now_monotonic_us();
    let mut payload = vec![0xF1, 0xA0];
    payload.extend((0..if fd { 120u8 } else { 43u8 }).map(|i| i.wrapping_mul(7)));
    let r = uds.request(0x2Eu8, None, Some(&payload)).await;
    let e = print_log(&sess, t0, 10);
    let fc_rx = e.iter().any(|x| x.kind == LogKind::Rx && x.frame.data[0] >> 4 == 3);
    let cf_tx = e.iter().filter(|x| x.kind == LogKind::TxConfirmed && x.frame.data[0] >> 4 == 2).count();
    ok &= check(&format!("2E with {}-byte request (multi-frame TX, FC from ECU)", payload.len() + 1), fc_rx && cf_tx > 0,
        format!("fc_rx={fc_rx} cf_tx={cf_tx} result={r:?}"));

    let t0 = now_monotonic_us();
    let started = Instant::now();
    let r = uds.read_data_by_identifier(0xFA02u16).await;
    ok &= check("22 FA 02 (ECU sends 0x78 twice)", r.is_ok(), format!("{r:?} after {:?}", started.elapsed()));
    print_log(&sess, t0, 6);

    let started = Instant::now();
    let r = uds.read_data_by_identifier(0xFA04u16).await;
    ok &= check("22 FA 04 (ECU silent) -> Timeout", matches!(r, Err(automotive::Error::Timeout)),
        format!("{r:?} after {:?}", started.elapsed()));
    let _ = sess.log.take();

    let r = uds.read_data_by_identifier(0xFA01u16).await;
    ok &= check("22 FA 01 -> NRC 0x22", format!("{r:?}").contains("ConditionsNotCorrect"), format!("{r:?}"));

    println!("    {}", stats(&bus));
    let s = bus.owner.stats.snapshot();
    ok &= check("fan-out: every owner RX/TX also reached StateTable",
        bus.telemetry.ingested.load(Ordering::Relaxed) >= s[0] + s[4] - s[1], stats(&bus));
    drop(uds);
    sess.adapter.close();
    let d = bus.owner.shutdown();
    check("owner shutdown < 25 ms", d < Duration::from_millis(25), format!("{d:?}"));
    ok
}

// ---------------------------------------------------------------------------------------------
async fn scenario_panic(dev: &str, tx: u32, rx: u32) -> bool {
    println!("== panic: 4000-byte ISO-TP request with STmin 5 ms, Panic Stop after 150 ms");
    let bus = open_bus(dev, 0, false, true, false, None, None).expect("open");
    let sess = open_diag_session(&bus.owner, &[filt(rx)], Duration::from_micros(500), false).expect("tap");
    let isotp = IsoTP::new_owned(Arc::clone(&sess.adapter), isotp_cfg(tx, rx, false, Some(Duration::from_millis(5))));
    let mut ok = true;

    let gate = Arc::clone(&bus.owner.gate);
    let stats_ref = Arc::clone(&bus.owner.stats);
    let panic_task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let at = now_monotonic_us();
        let at_i = Instant::now();
        gate.panic_stop();
        (at, at_i, stats_ref.snapshot()[4])
    });

    let mut big = vec![0x2E, 0xF1, 0xA0];
    big.extend((0..3997u32).map(|i| i as u8));
    let started = Instant::now();
    let r = isotp.send(&big).await;
    let elapsed = started.elapsed();
    let (panic_at, panic_instant, sent_at_panic) = panic_task.await.unwrap();
    let abort_latency = (started + elapsed).saturating_duration_since(panic_instant);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let sent_later = bus.owner.stats.snapshot()[4];

    println!("    isotp.send -> {r:?} after {elapsed:?}");
    let entries = sess.log.take();
    let after_panic_tx = entries.iter().filter(|e| e.kind == LogKind::TxConfirmed && e.frame.timestamp_us > panic_at).count();
    let rejected: Vec<_> = entries.iter().filter(|e| matches!(e.kind, LogKind::TxRejected(_))).collect();
    let last_tx = entries.iter().rev().find(|e| e.kind == LogKind::TxConfirmed);
    println!("    frames sent before panic={sent_at_panic}, 300 ms later={sent_later}, confirmed after latch={after_panic_tx}");
    if let Some(l) = last_tx {
        println!("    last confirmed TX at +{:.3} ms rel. to latch (negative = before)",
            (l.frame.timestamp_us as i64 - panic_at as i64) as f64 / 1000.0);
    }
    for l in format_log(&rejected.iter().map(|e| **e).collect::<Vec<_>>(), panic_at) {
        println!("    {l}");
    }
    ok &= check("ISO-TP send aborted with gate error", format!("{r:?}").contains("PanicLatched"), format!("{r:?}"));
    ok &= check("no further frames on bus after latch (<=1 in-flight)", sent_later - sent_at_panic <= 1,
        format!("{} frame(s) after latch", sent_later - sent_at_panic));
    ok &= check("abort was prompt (< 50 ms after latch)", abort_latency < Duration::from_millis(50), format!("send returned {abort_latency:?} after latch"));

    // Same AsyncCanAdapter is now dead (terminal error). New requests fail immediately.
    let r2 = isotp.send(&[0x3E, 0x00]).await;
    ok &= check("dead session returns same terminal error", format!("{r2:?}").contains("PanicLatched"), format!("{r2:?}"));
    drop(isotp);
    sess.adapter.close();

    // New session while latched: early gate refuses before any frame is queued.
    let s2 = open_diag_session(&bus.owner, &[filt(rx)], Duration::from_micros(500), false).unwrap();
    let u2 = uds_over(&s2.adapter, isotp_cfg(tx, rx, false, None));
    let r3 = u2.tester_present().await;
    ok &= check("new session while latched -> refused", format!("{r3:?}").contains("PanicLatched"), format!("{r3:?}"));
    drop(u2);
    s2.adapter.close();
    drop(s2);

    // Explicit re-arm, fresh session works again.
    bus.owner.gate.arm();
    let s3 = open_diag_session(&bus.owner, &[filt(rx)], Duration::from_micros(500), false).unwrap();
    let u3 = uds_over(&s3.adapter, isotp_cfg(tx, rx, false, None));
    tokio::time::sleep(Duration::from_millis(1200)).await; // let ECU N_Cr expire on the partial PDU
    let r4 = u3.tester_present().await;
    ok &= check("after Arm Active Bus, new session 3E 00 OK", r4.is_ok(), format!("{r4:?}"));
    println!("    {}", stats(&bus));
    drop(u3);
    s3.adapter.close();
    ok
}

// ---------------------------------------------------------------------------------------------
async fn scenario_gate(dev: &str, tx: u32, rx: u32) -> bool {
    println!("== gate: Listen-Only and disarmed buses");
    let mut ok = true;
    {
        let bus = open_bus(dev, 0, true, true, false, None, None).expect("open");
        let r = open_diag_session(&bus.owner, &[filt(rx)], Duration::from_micros(500), false);
        ok &= check("Listen-Only: active diag session refused at open", r.is_err(), format!("{:?}", r.err()));
        // Bypass the factory check (simulates a buggy upper layer): gate still holds.
        let tap = bus.owner.open_tap(&[filt(rx)], 64, false).unwrap();
        let log = Arc::new(automotive_hal_bridge::adapter::ConversationLog::default());
        let hal = automotive_hal_bridge::adapter::HalCanAdapter::new(tap, Duration::from_micros(500), false, log);
        let a = Arc::new(AsyncCanAdapter::new(hal));
        let u = uds_over(&a, isotp_cfg(tx, rx, false, None));
        let r = u.tester_present().await;
        ok &= check("Listen-Only: bypassed session TX -> error", format!("{r:?}").contains("ListenOnly"), format!("{r:?}"));
        ok &= check("Listen-Only: zero frames handed to driver", bus.owner.stats.snapshot()[4] == 0, stats(&bus));
        drop(u);
        a.close();
    }
    {
        let bus = open_bus(dev, 0, false, false, false, None, None).expect("open");
        let s = open_diag_session(&bus.owner, &[filt(rx)], Duration::from_micros(500), false).unwrap();
        let u = uds_over(&s.adapter, isotp_cfg(tx, rx, false, None));
        let r = u.tester_present().await;
        ok &= check("Disarmed: 3E 00 -> error", format!("{r:?}").contains("Disarmed"), format!("{r:?}"));
        ok &= check("Disarmed: zero frames handed to driver", bus.owner.stats.snapshot()[4] == 0, stats(&bus));
        drop(u);
        s.adapter.close();

        // Owner-only enforcement: early check disabled, frame reaches the owner queue.
        let tap = bus.owner.open_tap(&[filt(rx)], 64, true).unwrap();
        let log = Arc::new(automotive_hal_bridge::adapter::ConversationLog::default());
        let hal = automotive_hal_bridge::adapter::HalCanAdapter::new(tap, Duration::from_micros(500), false, Arc::clone(&log))
            .without_early_gate();
        let a = Arc::new(AsyncCanAdapter::new(hal));
        let u = uds_over(&a, isotp_cfg(tx, rx, false, None));
        let r = u.tester_present().await;
        let snap = bus.owner.stats.snapshot();
        ok &= check("Owner gate alone: rejection surfaces via recv() as UDS error", format!("{r:?}").contains("Disarmed"), format!("{r:?}"));
        ok &= check("Owner gate alone: owner tx_rej=1, tx_sent=0", snap[5] == 1 && snap[4] == 0, stats(&bus));
        for l in format_log(&log.take(), 0) { println!("    {l}"); }
        drop(u);
        a.close();
    }
    ok
}

// ---------------------------------------------------------------------------------------------
async fn scenario_mock() -> bool {
    println!("== mock: bridge over mock:mock0 (no ECU behind it)");
    let bus = open_bus("mock:mock0", 0, false, true, true, None, None).expect("open mock0");
    let s = open_diag_session(&bus.owner, &[filt(0x7E8)], Duration::from_micros(500), true).unwrap();
    let u = uds_over(&s.adapter, isotp_cfg(0x7E0, 0x7E8, false, None));
    let t0 = now_monotonic_us();
    let r = u.tester_present().await;
    let e = print_log(&s, t0, 4);
    let mut ok = check("mock0: TX confirmed through bridge", e.iter().any(|x| x.kind == LogKind::TxConfirmed), "");
    ok &= check("mock0: no ECU -> UDS Timeout (expected)", matches!(r, Err(automotive::Error::Timeout)), format!("{r:?}"));
    let u_fd = uds_over(&s.adapter, isotp_cfg(0x7E0, 0x7E8, true, None));
    let t0 = now_monotonic_us();
    let _ = u_fd.tester_present().await;
    let e = print_log(&s, t0, 2);
    ok &= check("mock0: FD request leaves as FD frame", e.iter().any(|x| x.kind == LogKind::TxConfirmed && x.frame.is_fd()), "");
    tokio::time::sleep(Duration::from_millis(200)).await;
    println!("    {}", stats(&bus));
    drop((u, u_fd));
    s.adapter.close();
    ok
}

// ---------------------------------------------------------------------------------------------
async fn scenario_alloc() -> bool {
    println!("== alloc: owner-thread heap allocations at mock0 25 kfps, with 2 taps (one accepts ALL frames)");
    let mut ok = true;
    for with_taps in [false, true] {
        let bus = open_bus("mock:mock0", 0, false, true, true, Some(25_000), Some(track_this_thread)).expect("mock0");
        let _taps = if with_taps {
            let t_all = bus.owner.open_tap(&[TapFilter::all()], 65_536, false).unwrap();
            let t_one = bus.owner.open_tap(&[TapFilter::exact_std(0x7E8)], 1_024, false).unwrap();
            // Drain the ALL tap so it never saturates.
            let rx = t_all.rx.clone();
            let drained = Arc::new(AtomicU64::new(0));
            let d2 = Arc::clone(&drained);
            std::thread::spawn(move || while let Ok(_e) = rx.recv() { d2.fetch_add(1, Ordering::Relaxed); });
            Some((t_all, t_one, drained))
        } else {
            None
        };
        tokio::time::sleep(Duration::from_millis(1000)).await; // warm-up
        let a0 = OWNER_ALLOCS.load(Ordering::Relaxed);
        let s0 = bus.owner.stats.snapshot();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let a1 = OWNER_ALLOCS.load(Ordering::Relaxed);
        let s1 = bus.owner.stats.snapshot();
        let frames = s1[0] - s0[0];
        let delivered = s1[2] - s0[2];
        println!("    taps={with_taps}: {frames} frames in 3 s ({:.0} fps), tap deliveries {delivered}, tap drops {}, owner allocs {}",
            frames as f64 / 3.0, s1[3] - s0[3], a1 - a0);
        ok &= check(&format!("zero owner-thread allocations (taps={with_taps})"), a1 == a0, format!("{} allocs", a1 - a0));
        if with_taps {
            // rx and delivered counters are sampled separately: allow < one RX batch of skew.
            ok &= check("ALL-tap received every frame (0 drops, skew < 1 batch)",
                s1[3] == s0[3] && delivered + 256 >= frames, format!("{delivered}/{frames}"));
        }
        OWNER_ALLOCS.store(0, Ordering::Relaxed);
        drop(_taps);
        drop(bus);
    }
    ok
}

// ---------------------------------------------------------------------------------------------
fn proc_cpu_ticks() -> u64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let after = s.rsplit(')').next().unwrap_or("");
    let f: Vec<&str> = after.split_whitespace().collect();
    f.get(11).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) + f.get(12).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
}

async fn scenario_cpu(dev: &str) -> bool {
    println!("== cpu: idle process CPU with one open diag session (automotive worker thread)");
    let bus = open_bus(dev, 0, false, true, false, None, None).expect("open");
    let measure = |label: &'static str| async move {
        let t = proc_cpu_ticks();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let d = proc_cpu_ticks() - t;
        println!("    {label}: {:.1}% of one core", d as f64 / 3.0); // 100 ticks/s
    };
    measure("baseline (owner+aggregator only)").await;
    for (label, wait) in [("idle_wait=0 (spin, sleep 1µs)", Duration::ZERO), ("idle_wait=500µs", Duration::from_micros(500)), ("idle_wait=2ms", Duration::from_millis(2))] {
        let s = open_diag_session(&bus.owner, &[filt(0x7FF)], wait, false).unwrap();
        measure(label).await;
        s.adapter.close();
    }
    true
}

// ---------------------------------------------------------------------------------------------
async fn scenario_passive(dev: &str, tx: u32, rx: u32) -> bool {
    println!("== passive: listen-only owner reassembles a third-party tester session with automotive ISO-TP");
    // "Third-party tester" = an active session on its own socket.
    let tester_bus = open_bus(dev, 0, false, true, false, None, None).expect("open tester");
    let tester = open_diag_session(&tester_bus.owner, &[filt(rx)], Duration::from_micros(500), false).unwrap();
    let uds = uds_over(&tester.adapter, isotp_cfg(tx, rx, false, None));

    // Passive analyser: Listen-Only bus, two ISO-TP instances (request + response direction).
    let sniff_bus = open_bus(dev, 1, true, false, false, None, None).expect("open sniffer");
    let mk = |tx_id: u32, rx_id: u32| {
        let tap = sniff_bus.owner.open_tap(&[filt(rx_id)], 4_096, false).unwrap();
        let p = PassiveCanAdapter::new(tap);
        let swallowed = Arc::clone(&p.swallowed_tx);
        let a = Arc::new(AsyncCanAdapter::new(p));
        let cfg = IsoTPConfig::builder(ident(tx_id)).rx_id(ident(rx_id)).bus(1).timeout(Duration::from_secs(5)).build().unwrap();
        (a, cfg, swallowed)
    };
    let (req_a, req_cfg, req_sw) = mk(rx, tx); // reassembles tester -> ECU
    let (resp_a, resp_cfg, resp_sw) = mk(tx, rx); // reassembles ECU -> tester
    let collect = |a: Arc<AsyncCanAdapter>, cfg: IsoTPConfig| {
        tokio::spawn(async move {
            let isotp = IsoTP::new_owned(a, cfg);
            let mut st = isotp.into_recv();
            let mut out = Vec::new();
            let end = tokio::time::Instant::now() + Duration::from_millis(1500);
            while let Ok(Some(m)) = tokio::time::timeout_at(end, st.next()).await {
                match m {
                    Ok(v) => out.push(v),
                    Err(automotive::Error::IdleTimeout) => {}
                    Err(e) => out.push(format!("ERR {e:?}").into_bytes()),
                }
            }
            out
        })
    };
    let req_task = collect(Arc::clone(&req_a), req_cfg);
    let resp_task = collect(Arc::clone(&resp_a), resp_cfg);
    tokio::time::sleep(Duration::from_millis(50)).await;

    let _ = uds.tester_present().await;
    let vin = uds.read_data_by_identifier(0xF190u16).await;
    let mut long = vec![0xF1, 0xA0];
    long.extend(0..30u8);
    let _ = uds.request(0x2Eu8, None, Some(&long)).await;
    let reqs = req_task.await.unwrap();
    let resps = resp_task.await.unwrap();
    for m in &reqs {
        println!("    passive REQ  [{:>2}] {}", m.len(), hex(&m[..m.len().min(20)]));
    }
    for m in &resps {
        println!("    passive RESP [{:>2}] {}", m.len(), hex(&m[..m.len().min(20)]));
    }
    let got_vin = resps.iter().any(|m| m.len() == 20 && m[0] == 0x62);
    let got_long_req = reqs.iter().any(|m| m.len() == 33 && m[0] == 0x2E);
    let mut ok = check("passive: active tester read VIN", vin.is_ok(), format!("{vin:?}"));
    ok &= check("passive: multi-frame response reassembled (62 F1 90 ...)", got_vin, "");
    ok &= check("passive: multi-frame request reassembled (2E ... 33 B)", got_long_req, "");
    let sw = req_sw.load(Ordering::Relaxed) + resp_sw.load(Ordering::Relaxed);
    println!("    FC frames automotive tried to send from the passive side (swallowed locally): {sw}");
    ok &= check("passive: sniffer bus put zero frames on the wire", sniff_bus.owner.stats.snapshot()[4] == 0, stats(&sniff_bus));
    drop(uds);
    tester.adapter.close();
    req_a.close();
    resp_a.close();
    ok
}

// ---------------------------------------------------------------------------------------------
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |i: usize, d: &str| args.get(i).cloned().unwrap_or_else(|| d.to_string());
    let ok = match args.get(1).map(String::as_str) {
        Some("uds") => scenario_uds(&get(2, "socketcan:vcan0"), parse_id(&get(3, "7E4")), parse_id(&get(4, "7EC")), args.iter().any(|a| a == "--fd")).await,
        Some("panic") => scenario_panic(&get(2, "socketcan:vcan0"), parse_id(&get(3, "7E4")), parse_id(&get(4, "7EC"))).await,
        Some("gate") => scenario_gate(&get(2, "socketcan:vcan0"), parse_id(&get(3, "7E4")), parse_id(&get(4, "7EC"))).await,
        Some("passive") => scenario_passive(&get(2, "socketcan:vcan0"), parse_id(&get(3, "7E4")), parse_id(&get(4, "7EC"))).await,
        Some("cpu") => scenario_cpu(&get(2, "socketcan:vcan0")).await,
        Some("mock") => scenario_mock().await,
        Some("alloc") => scenario_alloc().await,
        _ => {
            eprintln!("usage: automotive-hal-bridge <uds|panic|gate|passive|cpu|mock|alloc> [device] [tx] [rx] [--fd]");
            std::process::exit(2);
        }
    };
    println!("RESULT: {}", if ok { "ALL PASS" } else { "SOME FAILED" });
    std::process::exit(if ok { 0 } else { 1 });
}
