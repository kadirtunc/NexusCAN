//! Layer-1 HIL tests: the real `nexus-ecu-sim` binary on vcan0, driven over
//! a kernel ISO-TP socket by the minimal independent client in `common`.
//!
//! All tests are `#[ignore]` (they need a CAN interface) and additionally skip
//! with a clear message when `vcan0` (or `$NEXUS_HIL_IFACE`) is missing:
//!
//! ```text
//! sudo scripts/hil/vcan_up.sh && cargo test -p nexus-ecu-sim -- --ignored
//! # rootless (user + network namespace):
//! scripts/hil/run_hil_tests.sh
//! ```
//!
//! Every test uses its own CAN ID pair so they run in parallel on one bus.
//! Functional addressing is off in every simulator except the one of
//! `full_oem_reprogramming_sequence` (sim default 0x7DF) and the explicit
//! 0x5DF functional test, so 0x7DF traffic reaches exactly one ECU.
#![cfg(target_os = "linux")]

mod common;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{flash, require_hil, Client, FuncClient, Sim, BASE};
use nexus_ecu_sim::isotp::IsoTpOptions;

/// The acceptance sequence: 10 03 → 10 02 → 27 11/12 → 31 01 FF00 → 34 →
/// 36×293 (counter wraps 0xFF→0x00) → 37 → 31 01 0202 → 11 01, then a
/// byte-for-byte compare of .hex, .s19 and .bin sources with the image.
#[test]
#[ignore = "needs vcan0"]
fn full_flash_sequence_with_counter_wrap_and_byte_compare() {
    require_hil!();
    // 0x7E0 / 0x7E8 belong to full_oem_reprogramming_sequence.
    let (rx, tx) = (0x600, 0x608);
    let sim = Sim::spawn("full", rx, tx, &[]);
    let c = Client::new(rx, tx);
    let data = common::firmware(300_000, 0xC0FFEE);

    // Pre-flash reads.
    let vin = c.expect_pos(&[0x22, 0xF1, 0x90], &[0x62, 0xF1, 0x90]);
    assert_eq!(&vin[3..], b"NEXUSCANSIM000001");
    c.expect_nrc(&[0x10, 0x02], 0x22); // programming only via extended

    let blocks = flash(&c, &data);
    assert_eq!(
        blocks, 293,
        "0x402 maxNumberOfBlockLength -> 1024 data bytes/block"
    );
    assert!(blocks > 256, "counter must wrap");
    c.expect_pos(&[0x31, 0x01, 0xFF, 0x01], &[0x71, 0x01, 0xFF, 0x01, 0x00]);
    c.expect_pos(&[0x11, 0x01], &[0x51, 0x01]);
    std::thread::sleep(Duration::from_millis(400));
    c.expect_pos(&[0x3E, 0x00], &[0x7E, 0x00]);
    c.expect_nrc(&[0x34, 0x00, 0x44, 8, 0, 0, 0, 0, 0, 0, 1], 0x7F); // reset -> default

    let dir = &sim.dir;
    let hex = dir.join("fw.hex");
    let s19 = dir.join("fw.s19");
    let bin = dir.join("fw.bin");
    std::fs::write(&hex, common::write_intel_hex(BASE, &data)).unwrap();
    std::fs::write(&s19, common::write_srec(BASE, &data)).unwrap();
    std::fs::write(&bin, &data).unwrap();
    for (src, extra) in [
        (&hex, vec![]),
        (&s19, vec![]),
        (&bin, vec!["--base", "0x08000000"]),
    ] {
        let (code, out) = sim.compare(src, &extra);
        println!("{}: {out}", src.display());
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("EQUAL: 300000 bytes"), "{out}");
    }
    // Negative control: one flipped byte is detected at the right address.
    let mut bad = data.clone();
    bad[123_456] ^= 0x01;
    let badhex = dir.join("bad.hex");
    std::fs::write(&badhex, common::write_intel_hex(BASE, &bad)).unwrap();
    let (code, out) = sim.compare(&badhex, &[]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains(&format!("0x{:08X}", BASE + 123_456)), "{out}");
    // Wrong base for the .bin -> mismatch.
    assert_eq!(sim.compare(&bin, &["--base", "0x08000001"]).0, 1);
}

#[test]
#[ignore = "needs vcan0"]
fn session_security_dids_dtcs_and_s3() {
    require_hil!();
    let (rx, tx) = (0x610, 0x618);
    let _sim = Sim::spawn("services", rx, tx, &["--s3", "400", "--lockout-ms", "800"]);
    let c = Client::new(rx, tx);
    for did in [0xF187u16, 0xF188, 0xF18C, 0xF195] {
        let d = did.to_be_bytes();
        c.expect_pos(&[0x22, d[0], d[1]], &[0x62, d[0], d[1]]);
    }
    c.expect_nrc(&[0x22, 0x01, 0x02], 0x31);
    c.expect_nrc(&[0x27, 0x01], 0x7F);
    c.expect_pos(&[0x19, 0x01, 0xFF], &[0x59, 0x01, 0xFF, 0x01, 0x00, 0x03]);
    c.expect_pos(&[0x14, 0xFF, 0xFF, 0xFF], &[0x54]);
    c.expect_pos(&[0x19, 0x02, 0xFF], &[0x59, 0x02, 0xFF]);

    c.expect_pos(&[0x10, 0x03], &[0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]);
    c.expect_pos(&[0x28, 0x03, 0x01], &[0x68, 0x03]);
    c.expect_pos(&[0x85, 0x02], &[0xC5, 0x02]);
    let mut vin = vec![0x2E, 0xF1, 0x90];
    vin.extend_from_slice(b"WBA00000000000042");
    c.expect_nrc(&vin, 0x33);
    // Invalid key x3 -> 0x35, 0x35, 0x36, then 0x37 while locked out.
    for code in [0x35, 0x35, 0x36] {
        let s = c.expect_pos(&[0x27, 0x01], &[0x67, 0x01]);
        let mut k = vec![0x27, 0x02];
        k.extend(s[2..].iter().map(|b| b ^ 0x5A)); // wrong algorithm
        c.expect_nrc(&k, code);
    }
    c.expect_nrc(&[0x27, 0x01], 0x37);
    std::thread::sleep(Duration::from_millis(850));
    c.expect_pos(&[0x10, 0x03], &[0x50, 0x03]);
    c.unlock(0x01);
    c.expect_pos(&[0x27, 0x01], &[0x67, 0x01, 0, 0, 0, 0]); // zero seed when unlocked
    c.expect_pos(&vin, &[0x6E, 0xF1, 0x90]);
    assert_eq!(&c.request(&[0x22, 0xF1, 0x90])[3..], b"WBA00000000000042");
    c.expect_nrc(&[0x27, 0x11], 0x7E);

    // S3: tester present (suppressed) keeps the session, silence ends it.
    for _ in 0..4 {
        std::thread::sleep(Duration::from_millis(200));
        c.expect_silence(&[0x3E, 0x80], Duration::from_millis(50));
    }
    c.expect_pos(&[0x22, 0xF1, 0x86], &[0x62, 0xF1, 0x86, 0x03]);
    std::thread::sleep(Duration::from_millis(600));
    c.expect_pos(&[0x22, 0xF1, 0x86], &[0x62, 0xF1, 0x86, 0x01]);
    c.expect_nrc(&[0x27, 0x01], 0x7F);
}

#[test]
#[ignore = "needs vcan0"]
fn functional_addressing_padding_flow_control_and_extended_ids() {
    require_hil!();
    // Functional 0x5DF + padding 0xAA.
    let (rx, tx, fid) = (0x620, 0x628, 0x5DF);
    let sim = Sim::spawn(
        "functional",
        rx,
        tx,
        &[
            "--functional",
            "0x5DF",
            "--padding",
            "0xAA",
            "--stmin",
            "1000",
            "--bs",
            "4",
        ],
    );
    let c = Client::new(rx, tx);
    let raw = RawCan::open(tx);
    let func = nexus_ecu_sim::isotp::IsoTpSocket::open(
        &common::iface(),
        0x5DE, // unused rx id: responses are read on the physical client socket
        fid,
        &IsoTpOptions::default(),
    )
    .unwrap();
    func.send(&[0x3E, 0x00]).unwrap();
    assert_eq!(c.recv(Duration::from_secs(1)).unwrap(), vec![0x7E, 0x00]);
    let frame = raw.recv(Duration::from_secs(1)).expect("raw frame");
    assert_eq!(
        frame,
        vec![0x02, 0x7E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA],
        "padded SF"
    );
    // Functional request (single frame only — functional addressing has no
    // FlowControl) to a physical-only service: no response at all.
    func.send(&[0x31, 0x01, 0xFF, 0x00]).unwrap();
    assert!(c.recv(Duration::from_millis(300)).is_none());
    func.send(&[0x3E, 0x80]).unwrap();
    assert!(c.recv(Duration::from_millis(300)).is_none());
    // Multi-frame request: the simulator's FlowControl carries --bs / --stmin
    // (BS=4, STmin 1000 us = 0x01) and is padded too.
    let mut w = vec![0x2E, 0xF1, 0x90];
    w.extend_from_slice(b"ABCDEFGHIJKLMNOPQ");
    assert_eq!(c.request(&w), vec![0x7F, 0x2E, 0x7F]);
    let fc = raw.recv(Duration::from_secs(1)).expect("FlowControl frame");
    assert_eq!(
        fc,
        vec![0x30, 0x04, 0x01, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA],
        "FC"
    );
    let nrc = raw.recv(Duration::from_secs(1)).expect("NRC frame");
    assert_eq!(nrc, vec![0x03, 0x7F, 0x2E, 0x7F, 0xAA, 0xAA, 0xAA, 0xAA]);
    drop(sim);

    // 29-bit identifiers.
    let (rx, tx) = (0x18DA_10F1, 0x18DA_F110);
    let _sim = Sim::spawn("extended", rx, tx, &["--extended"]);
    let c = Client::with_opts(
        rx,
        tx,
        &IsoTpOptions {
            extended: true,
            ..Default::default()
        },
    );
    c.expect_pos(&[0x22, 0xF1, 0x90], &[0x62, 0xF1, 0x90]);
}

// --------------------------------------------------------------- faults

#[test]
#[ignore = "needs vcan0"]
fn fault_pending78() {
    require_hil!();
    let (rx, tx) = (0x630, 0x638);
    let _sim = Sim::spawn("pending78", rx, tx, &["--fault", "pending78:0x22:3"]);
    let c = Client::new(rx, tx);
    let a = c.try_request(&[0x22, 0xF1, 0x90]).unwrap();
    assert_eq!(a.pendings, 3);
    assert!(a.pdu.starts_with(&[0x62, 0xF1, 0x90]));
    assert_eq!(c.try_request(&[0x3E, 0x00]).unwrap().pendings, 0);
}

#[test]
#[ignore = "needs vcan0"]
fn fault_slow() {
    require_hil!();
    let (rx, tx) = (0x640, 0x648);
    let _sim = Sim::spawn("slow", rx, tx, &["--fault", "slow:0x22:400"]);
    let mut c = Client::new(rx, tx);
    c.p2 = Duration::from_millis(150);
    // P2client timeout expires (no 0x78), the late answer still arrives.
    assert!(c.try_request(&[0x22, 0xF1, 0x90]).is_none());
    let late = c.recv(Duration::from_secs(1)).expect("late response");
    assert!(late.starts_with(&[0x62, 0xF1, 0x90]));
    c.p2 = Duration::from_millis(1000);
    let a = c.try_request(&[0x22, 0xF1, 0x95]).unwrap();
    assert!(a.elapsed >= Duration::from_millis(400), "{:?}", a.elapsed);
    assert!(c.try_request(&[0x3E, 0x00]).unwrap().elapsed < Duration::from_millis(400));
}

fn start_download(c: &Client, len: u32) -> usize {
    c.enter_programming();
    c.erase(BASE, len);
    c.request_download(BASE, len)
}

#[test]
#[ignore = "needs vcan0"]
fn fault_silent_after_block() {
    require_hil!();
    let (rx, tx) = (0x650, 0x658);
    let _sim = Sim::spawn("silent", rx, tx, &["--fault", "silent-after-block:3"]);
    let c = Client::new(rx, tx);
    let data = common::firmware(10 * 1024, 1);
    let mbl = start_download(&c, data.len() as u32);
    let mut chunks = data.chunks(mbl - 2);
    for bsc in 1..=3u8 {
        assert_eq!(
            c.transfer_block(bsc, chunks.next().unwrap()),
            Some(vec![0x76, bsc])
        );
    }
    let mut r = vec![0x36, 4];
    r.extend_from_slice(chunks.next().unwrap());
    c.expect_silence(&r, Duration::from_millis(500));
    c.expect_silence(&[0x3E, 0x00], Duration::from_millis(300));
    c.expect_silence(&[0x11, 0x01], Duration::from_millis(300));
}

#[test]
#[ignore = "needs vcan0"]
fn fault_nrc_once_and_always() {
    require_hil!();
    let (rx, tx) = (0x660, 0x668);
    let _sim = Sim::spawn(
        "nrc",
        rx,
        tx,
        &[
            "--fault",
            "nrc:0x34:0x22:once",
            "--fault",
            "nrc:0x19:0x21:always",
        ],
    );
    let c = Client::new(rx, tx);
    c.enter_programming();
    c.erase(BASE, 0x1000);
    let mut r = vec![0x34, 0x00, 0x44];
    r.extend_from_slice(&BASE.to_be_bytes());
    r.extend_from_slice(&0x1000u32.to_be_bytes());
    c.expect_nrc(&r, 0x22);
    c.expect_pos(&r, &[0x74, 0x20, 0x04, 0x02]);
    for _ in 0..3 {
        c.expect_nrc(&[0x19, 0x01, 0xFF], 0x21);
    }
}

#[test]
#[ignore = "needs vcan0"]
fn fault_wrong_seq_once() {
    require_hil!();
    let (rx, tx) = (0x670, 0x678);
    let sim = Sim::spawn("wrongseq", rx, tx, &["--fault", "wrong-seq-once:5"]);
    let c = Client::new(rx, tx);
    let data = common::firmware(8 * 1024, 2);
    let mbl = start_download(&c, data.len() as u32);
    for (i, chunk) in data.chunks(mbl - 2).enumerate() {
        let bsc = (i + 1) as u8;
        let r = c.transfer_block(bsc, chunk).unwrap();
        if bsc == 5 {
            assert_eq!(r, vec![0x7F, 0x36, 0x73]);
            assert_eq!(
                c.transfer_block(bsc, chunk),
                Some(vec![0x76, bsc]),
                "resend accepted"
            );
        } else {
            assert_eq!(r, vec![0x76, bsc]);
        }
    }
    c.expect_pos(&[0x37], &[0x77]);
    sim.assert_image_equals(&data);
}

#[test]
#[ignore = "needs vcan0"]
fn fault_drop_response_once_no_double_write() {
    require_hil!();
    let (rx, tx) = (0x680, 0x688);
    let sim = Sim::spawn("drop", rx, tx, &["--fault", "drop-response-once:5"]);
    let mut c = Client::new(rx, tx);
    c.p2 = Duration::from_millis(400);
    let data = common::firmware(8 * 1024, 3);
    let mbl = start_download(&c, data.len() as u32);
    for (i, chunk) in data.chunks(mbl - 2).enumerate() {
        let bsc = (i + 1) as u8;
        let r = c.transfer_block(bsc, chunk);
        if bsc == 5 {
            assert_eq!(r, None, "response must be dropped");
            // Flasher retry with the SAME counter: acknowledged, not rewritten
            // (a rewrite of programmed flash would answer 0x72).
            assert_eq!(c.transfer_block(bsc, chunk), Some(vec![0x76, bsc]));
        } else {
            assert_eq!(r, Some(vec![0x76, bsc]));
        }
    }
    c.expect_pos(&[0x37], &[0x77]);
    let crc = common::crc32_ref(&data);
    let mut r = vec![0x31, 0x01, 0x02, 0x02];
    r.extend_from_slice(&crc.to_be_bytes());
    c.expect_pos(&r, &[0x71, 0x01, 0x02, 0x02, 0x00]);
    sim.assert_image_equals(&data);
    assert!(sim.log_text().contains("not rewritten"));
}

#[test]
#[ignore = "needs vcan0"]
fn fault_max_block_len() {
    require_hil!();
    let (rx, tx) = (0x690, 0x698);
    let sim = Sim::spawn("maxblock", rx, tx, &["--fault", "max-block-len:0x82"]);
    let c = Client::new(rx, tx);
    let data = common::firmware(40_000, 4);
    let blocks = flash(&c, &data);
    assert_eq!(
        blocks,
        40_000_usize.div_ceil(0x80),
        "128 data bytes per block"
    );
    assert!(blocks > 256);
    sim.assert_image_equals(&data);
}

#[test]
#[ignore = "needs vcan0"]
fn fault_reset_during_transfer_then_reflash() {
    require_hil!();
    let (rx, tx) = (0x6A0, 0x6A8);
    let sim = Sim::spawn("reset", rx, tx, &["--fault", "reset-during-transfer:4"]);
    let mut c = Client::new(rx, tx);
    c.p2 = Duration::from_millis(400);
    let data = common::firmware(16 * 1024, 5);
    let mbl = start_download(&c, data.len() as u32);
    let chunks: Vec<&[u8]> = data.chunks(mbl - 2).collect();
    for bsc in 1..=3u8 {
        assert_eq!(
            c.transfer_block(bsc, chunks[usize::from(bsc) - 1]),
            Some(vec![0x76, bsc])
        );
    }
    assert_eq!(c.transfer_block(4, chunks[3]), None, "ECU resets silently");
    std::thread::sleep(Duration::from_millis(300));
    // After reboot: Default session, security locked, download gone.
    c.expect_pos(&[0x22, 0xF1, 0x86], &[0x62, 0xF1, 0x86, 0x01]);
    let mut r = vec![0x36, 4];
    r.extend_from_slice(chunks[3]);
    c.expect_nrc(&r, 0x7F);
    // Flasher recovery: full re-flash succeeds.
    flash(&c, &data);
    sim.assert_image_equals(&data);
}

#[test]
#[ignore = "needs vcan0"]
fn fault_erase_time() {
    require_hil!();
    let (rx, tx) = (0x6B0, 0x6B8);
    let _sim = Sim::spawn(
        "erasetime",
        rx,
        tx,
        &["--fault", "erase-time:1200", "--p2star", "1000"],
    );
    let c = Client::new(rx, tx);
    c.enter_programming();
    let a = c.erase(BASE, 0x8_0000);
    // 0x78 re-sent every 0.4 x P2* = 400 ms: t = 0, 400, 800.
    assert_eq!(a.pendings, 3, "{a:?}");
    assert!(a.elapsed >= Duration::from_millis(1200), "{a:?}");
}

// --------------------------------------------------------------- OEM flow

/// Downloads one segment (34 / 36… / 37) and returns the block count.
fn download_segment(c: &Client, addr: u32, data: &[u8]) -> usize {
    let mbl = c.request_download(addr, data.len() as u32);
    let mut n = 0;
    for (i, chunk) in data.chunks(mbl - 2).enumerate() {
        let bsc = (i + 1) as u8;
        assert_eq!(c.transfer_block(bsc, chunk), Some(vec![0x76, bsc]));
        n += 1;
    }
    c.expect_pos(&[0x37], &[0x77]);
    n
}

fn check_crc(c: &Client, crc: u32) -> u8 {
    let mut r = vec![0x31, 0x01, 0x02, 0x02];
    r.extend_from_slice(&crc.to_be_bytes());
    c.expect_pos(&r, &[0x71, 0x01, 0x02, 0x02])[4]
}

fn did(c: &Client, id: u16) -> Vec<u8> {
    let d = id.to_be_bytes();
    c.expect_pos(&[0x22, d[0], d[1]], &[0x62, d[0], d[1]])[3..].to_vec()
}

/// Functional request with SPR: the ECU must stay silent.
fn func_spr(f: &FuncClient, c: &Client, req: &[u8]) {
    f.send(req);
    if let Some(r) = c.recv(Duration::from_millis(150)) {
        panic!("functional {req:02X?} (SPR) must not be answered, got {r:02X?}");
    }
}

/// The production-style reprogramming sequence the NexusCAN ECU-flash Flow
/// template sends, on the simulator defaults (0x7E0 / 0x7E8, functional
/// 0x7DF, boot jump 300 ms, reboot 200 ms), two segments with a gap.
#[test]
#[ignore = "needs vcan0"]
fn full_oem_reprogramming_sequence() {
    require_hil!();
    let (rx, tx) = (0x7E0, 0x7E8);
    let sim = Sim::spawn_default_functional("oem", rx, tx, &["--s3", "2000"]);
    let c = Client::new(rx, tx);
    let f = FuncClient::new(0x7DF);
    let seg_a: (u32, Vec<u8>) = (BASE, common::firmware(5_000, 0xA11CE));
    let seg_b: (u32, Vec<u8>) = (BASE + 0x1_0000, common::firmware(7_000, 0xB0B));
    let fingerprint = [0x26, 0x11, 0x17, 0x4E, 0x58, 0x00, 0x00, 0x00, 0x2A];

    // Periodic functional TesterPresent (3E 80) for the whole sequence.
    let stop = Arc::new(AtomicBool::new(false));
    let sent = Arc::new(AtomicU32::new(0));
    let keepalive = {
        let (stop, sent) = (Arc::clone(&stop), Arc::clone(&sent));
        std::thread::spawn(move || {
            let f = FuncClient::new(0x7DF);
            while !stop.load(Ordering::SeqCst) {
                f.send(&[0x3E, 0x80]);
                sent.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(500));
            }
        })
    };

    // ---------------- pre-programming
    c.expect_pos(&[0x10, 0x03], &[0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]);
    func_spr(&f, &c, &[0x3E, 0x80]);
    assert_eq!(did(&c, 0xF190), b"NEXUSCANSIM000001");
    assert_eq!(did(&c, 0xF187), b"NX-ECU-SIM-0001");
    let sw_before = did(&c, 0xF189);
    assert_eq!(sw_before, b"SW 1.0.0");
    assert_eq!(did(&c, 0xF191), b"HW-NX-01");
    c.expect_pos(&[0x31, 0x01, 0x02, 0x03], &[0x71, 0x01, 0x02, 0x03, 0x00]);
    func_spr(&f, &c, &[0x85, 0x82]);
    func_spr(&f, &c, &[0x28, 0x83, 0x01]);
    // A multi-frame request on the functional ID is ignored: no FlowControl.
    let raw = RawCan::open(tx);
    raw.send(0x7DF, &[0x10, 0x14, 0x2E, 0xF1, 0x90, 0x41, 0x42, 0x43]);
    assert_eq!(
        raw.recv(Duration::from_millis(200)),
        None,
        "FC sent for a functional FF"
    );
    drop(raw);

    // ---------------- programming: bootloader jump
    let r = c.request(&[0x10, 0x02]);
    let t_jump = Instant::now();
    assert_eq!(r, vec![0x50, 0x02, 0x00, 0x32, 0x01, 0xF4]);
    c.send(&[0x3E, 0x00]);
    assert_eq!(
        c.recv(Duration::from_millis(120)),
        None,
        "answered during boot jump"
    );
    c.send(&[0x22, 0xF1, 0x86]);
    assert_eq!(
        c.recv(Duration::from_millis(100)),
        None,
        "answered during boot jump"
    );
    let (alive, _) = c.wait_alive(&[0x22, 0xF1, 0x86]);
    let silent_for = t_jump.elapsed();
    assert_eq!(
        alive,
        vec![0x62, 0xF1, 0x86, 0x02],
        "bootloader in Programming"
    );
    assert!(
        silent_for >= Duration::from_millis(280),
        "boot jump only {silent_for:?}"
    );
    c.unlock(0x11);
    let mut w = vec![0x2E, 0xF1, 0x5A];
    w.extend_from_slice(&fingerprint);
    c.expect_pos(&w, &[0x6E, 0xF1, 0x5A]);
    assert_eq!(did(&c, 0xF15A), fingerprint);

    let mut blocks = 0;
    for (i, (addr, data)) in [&seg_a, &seg_b].into_iter().enumerate() {
        if i == 1 {
            // Segment B is not erased yet: download refused.
            let mut r = vec![0x34, 0x00, 0x44];
            r.extend_from_slice(&addr.to_be_bytes());
            r.extend_from_slice(&(data.len() as u32).to_be_bytes());
            c.expect_nrc(&r, 0x70);
        }
        let e = c.erase(*addr, data.len() as u32);
        assert!(e.pendings >= 1, "long erase must send 0x78: {e:?}");
        blocks += download_segment(&c, *addr, data);
        assert_eq!(check_crc(&c, common::crc32_ref(data)), 0x00, "segment {i}");
    }
    assert_eq!(blocks, 5 + 7, "1024 data bytes per block");
    // S3 is 2000 ms: only the functional 3E 80 keeps the session alive here.
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(did(&c, 0xF186), vec![0x02], "S3 expired despite 3E 80");
    c.expect_pos(&[0x31, 0x01, 0xFF, 0x01], &[0x71, 0x01, 0xFF, 0x01, 0x00]);

    // ---------------- post-programming
    c.expect_pos(&[0x11, 0x01], &[0x51, 0x01]);
    let t_reset = Instant::now();
    c.send(&[0x3E, 0x00]);
    assert_eq!(
        c.recv(Duration::from_millis(100)),
        None,
        "answered during reboot"
    );
    let (alive, _) = c.wait_alive(&[0x3E, 0x00]);
    assert_eq!(alive, vec![0x7E, 0x00]);
    assert!(t_reset.elapsed() >= Duration::from_millis(180));
    c.expect_pos(&[0x10, 0x03], &[0x50, 0x03]);
    func_spr(&f, &c, &[0x28, 0x80, 0x01]);
    func_spr(&f, &c, &[0x85, 0x81]);
    c.expect_pos(&[0x14, 0xFF, 0xFF, 0xFF], &[0x54]);
    let sw_after = did(&c, 0xF189);
    assert_eq!(sw_after, b"SW 1.1.0");
    assert_ne!(sw_after, sw_before, "F189 must change after the flash");
    assert_eq!(
        did(&c, 0xF15A),
        fingerprint,
        "fingerprint survives the reset"
    );
    c.expect_pos(&[0x10, 0x01], &[0x50, 0x01]);
    stop.store(true, Ordering::SeqCst);
    keepalive.join().unwrap();

    // ---------------- byte compare + wire log
    let out = sim.assert_image_equals_segments(&[(seg_a.0, &seg_a.1), (seg_b.0, &seg_b.1)]);
    println!("{out}");
    assert!(out.contains("EQUAL: 12000 bytes"), "{out}");

    let ev = sim.events();
    let rx_ev: Vec<&serde_json::Value> = ev.iter().filter(|e| e["event"] == "rx").collect();
    assert!(rx_ev
        .iter()
        .all(|e| e["addr"] == "phys" || e["addr"] == "func"));
    let func_non_tp: Vec<&str> = rx_ev
        .iter()
        .filter(|e| e["addr"] == "func" && e["pdu"] != "3E 80")
        .map(|e| e["pdu"].as_str().unwrap())
        .collect();
    assert_eq!(
        func_non_tp,
        ["85 82", "28 83 01", "28 80 01", "85 81"],
        "functional requests on the wire"
    );
    assert!(rx_ev
        .iter()
        .all(|e| e["addr"] != "func" || e["canId"] == "0x7DF"));
    assert!(rx_ev
        .iter()
        .filter(|e| e["addr"] == "phys")
        .all(|e| e["canId"] == "0x7E0"));
    let tp = rx_ev
        .iter()
        .filter(|e| e["addr"] == "func" && e["pdu"] == "3E 80")
        .count();
    assert!(
        tp >= 6,
        "only {tp} functional 3E 80 processed of {}",
        sent.load(Ordering::SeqCst)
    );
    assert!(ev.iter().any(|e| e["event"] == "rx-ignored"
        && e["addr"] == "func"
        && e["reason"].as_str().unwrap_or("").contains("First Frame")));
    let ignored_in_jump: Vec<&str> = ev
        .iter()
        .filter(|e| e["event"] == "rx-ignored" && e["reason"] == "boot-jump" && e["addr"] == "phys")
        .map(|e| e["pdu"].as_str().unwrap())
        .collect();
    assert!(ignored_in_jump.contains(&"3E 00"), "{ignored_in_jump:?}");
    assert!(ignored_in_jump.contains(&"22 F1 86"), "{ignored_in_jump:?}");
    assert!(ev
        .iter()
        .any(|e| e["event"] == "boot-jump" && e["ms"] == 300));
    assert!(ev.iter().any(|e| e["event"] == "reboot" && e["ms"] == 200));
    // tx only on the physical response ID.
    assert!(ev
        .iter()
        .filter(|e| e["event"] == "tx")
        .all(|e| e["canId"] == "0x7E8" && e["addr"] == "phys"));
    let log = sim.log_text();
    assert!(log.contains("fingerprint (0xF15A) written: 26 11 17 4E 58 00 00 00 2A"));
    assert!(log.contains("new software active"));
}

#[test]
#[ignore = "needs vcan0"]
fn oem_precondition_fail() {
    require_hil!();
    let (rx, tx) = (0x6C0, 0x6C8);
    let _sim = Sim::spawn("precond", rx, tx, &["--fault", "precondition-fail"]);
    let c = Client::new(rx, tx);
    c.expect_nrc(&[0x31, 0x01, 0x02, 0x03], 0x7F); // Default session
    c.expect_pos(&[0x10, 0x03], &[0x50, 0x03]);
    c.expect_pos(&[0x31, 0x01, 0x02, 0x03], &[0x71, 0x01, 0x02, 0x03, 0x01]);
}

#[test]
#[ignore = "needs vcan0"]
fn oem_crc_mismatch_fails_dependencies_and_keeps_sw_version() {
    require_hil!();
    let (rx, tx) = (0x6D0, 0x6D8);
    let _sim = Sim::spawn("crcmismatch", rx, tx, &[]);
    let c = Client::new(rx, tx);
    let (a, b) = (common::firmware(3_000, 21), common::firmware(2_000, 22));
    c.enter_programming();
    c.erase(BASE, a.len() as u32);
    download_segment(&c, BASE, &a);
    assert_eq!(check_crc(&c, common::crc32_ref(&a)), 0x00);
    let base_b = BASE + 0x8000;
    c.erase(base_b, b.len() as u32);
    download_segment(&c, base_b, &b);
    assert_eq!(check_crc(&c, common::crc32_ref(&b) ^ 0x8000_0000), 0x01);
    c.expect_pos(&[0x31, 0x01, 0xFF, 0x01], &[0x71, 0x01, 0xFF, 0x01, 0x01]);
    c.expect_pos(&[0x11, 0x01], &[0x51, 0x01]);
    c.wait_alive(&[0x3E, 0x00]);
    assert_eq!(
        did(&c, 0xF189),
        b"SW 1.0.0",
        "failed flash must not change F189"
    );
}

#[test]
#[ignore = "needs vcan0"]
fn oem_fingerprint_outside_programming_is_rejected() {
    require_hil!();
    let (rx, tx) = (0x6E0, 0x6E8);
    let _sim = Sim::spawn("fingerprint", rx, tx, &[]);
    let c = Client::new(rx, tx);
    let mut w = vec![0x2E, 0xF1, 0x5A];
    w.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9]);
    c.expect_nrc(&w, 0x7F); // Default
    c.expect_pos(&[0x10, 0x03], &[0x50, 0x03]);
    c.unlock(0x01);
    c.expect_nrc(&w, 0x7F); // Extended, unlocked: still wrong session
    c.expect_pos(&[0x10, 0x02], &[0x50, 0x02]);
    c.wait_alive(&[0x3E, 0x00]);
    c.expect_nrc(&w, 0x33); // Programming, locked
    c.unlock(0x11);
    c.expect_pos(&w, &[0x6E, 0xF1, 0x5A]);
    w[2] = 0x84; // alias F184
    w[3] = 0xEE;
    c.expect_pos(&w, &[0x6E, 0xF1, 0x84]);
    assert_eq!(did(&c, 0xF15A), [0xEE, 2, 3, 4, 5, 6, 7, 8, 9]);
}

// --------------------------------------------------------------- raw CAN

/// Tiny CAN_RAW reader used to verify on-wire padding.
struct RawCan {
    fd: std::os::fd::OwnedFd,
}

impl RawCan {
    fn open(id: u32) -> Self {
        use std::os::fd::FromRawFd;
        #[repr(C)]
        struct SockaddrCan {
            family: libc::sa_family_t,
            ifindex: libc::c_int,
            _addr: [u8; 16],
        }
        #[repr(C)]
        struct CanFilter {
            id: u32,
            mask: u32,
        }
        let name = std::ffi::CString::new(common::iface()).unwrap();
        // SAFETY: plain libc socket calls with valid arguments.
        unsafe {
            let fd = libc::socket(libc::PF_CAN, libc::SOCK_RAW | libc::SOCK_CLOEXEC, 1);
            assert!(fd >= 0, "CAN_RAW socket");
            let f = CanFilter {
                id,
                mask: 0x7FF | 0x8000_0000 | 0x4000_0000,
            };
            libc::setsockopt(
                fd,
                101, // SOL_CAN_RAW
                1,   // CAN_RAW_FILTER
                (&f as *const CanFilter).cast(),
                std::mem::size_of::<CanFilter>() as libc::socklen_t,
            );
            let a = SockaddrCan {
                family: libc::AF_CAN as libc::sa_family_t,
                ifindex: libc::if_nametoindex(name.as_ptr()) as libc::c_int,
                _addr: [0; 16],
            };
            let r = libc::bind(
                fd,
                (&a as *const SockaddrCan).cast(),
                std::mem::size_of::<SockaddrCan>() as libc::socklen_t,
            );
            assert_eq!(r, 0, "bind CAN_RAW");
            Self {
                fd: std::os::fd::OwnedFd::from_raw_fd(fd),
            }
        }
    }

    /// Sends one classical data frame (standard ID).
    fn send(&self, id: u32, data: &[u8]) {
        use std::os::fd::AsRawFd;
        let mut frame = [0u8; 16];
        frame[..4].copy_from_slice(&id.to_ne_bytes());
        frame[4] = data.len() as u8;
        frame[8..8 + data.len()].copy_from_slice(data);
        // SAFETY: writing one struct can_frame (16 bytes).
        let n = unsafe { libc::write(self.fd.as_raw_fd(), frame.as_ptr().cast(), 16) };
        assert_eq!(n, 16, "CAN_RAW write");
    }

    /// Data bytes (length = DLC) of the next frame.
    fn recv(&self, timeout: Duration) -> Option<Vec<u8>> {
        use std::os::fd::AsRawFd;
        let ready = nexus_ecu_sim::isotp::wait_readable(&[self.fd.as_raw_fd()], timeout).ok()?;
        if !ready[0] {
            return None;
        }
        let mut frame = [0u8; 16];
        // SAFETY: reading one struct can_frame (16 bytes).
        let n = unsafe { libc::read(self.fd.as_raw_fd(), frame.as_mut_ptr().cast(), 16) };
        if n != 16 {
            return None;
        }
        let dlc = usize::from(frame[4]).min(8);
        Some(frame[8..8 + dlc].to_vec())
    }
}
