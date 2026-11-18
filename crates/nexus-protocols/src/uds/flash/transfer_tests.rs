use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use super::*;
use crate::uds::flash::firmware::{parse_intel_hex, FirmwareSegment};

// ─── Mock ECU ───────────────────────────────────────────────────────────────

/// Scripted fault for the n-th (0-based, global) 0x36 request.
#[derive(Clone)]
enum Fault {
    /// Answer with a negative response, block NOT written.
    Nrc(u8),
    /// No answer, block NOT written.
    Timeout,
    /// Block written, response lost (the retry is a repeated block).
    TimeoutAfterAccept,
    /// Positive response with this counter (block written).
    Echo(u8),
    /// Replace the response with these bytes (block NOT written).
    Raw(Vec<u8>),
    /// Set the cancel flag, then process normally.
    Cancel,
}

struct Download {
    address: u32,
    size: usize,
    data: Vec<u8>,
    expected: u8,
    last_accepted: Option<u8>,
}

#[derive(Default)]
struct EcuState {
    log: Vec<(u8, Vec<u8>)>,
    memory: Vec<FirmwareSegment>,
    active: Option<Download>,
    transfer_count: usize,
    timeouts_seen: Vec<Option<u32>>,
}

struct MockEcu<'a> {
    /// Full 0x74 response tail: `[lfid, maxNumberOfBlockLength…]`.
    rd_response: Vec<u8>,
    faults: HashMap<usize, Fault>,
    persistent_nrc: Option<u8>,
    raw_override: HashMap<u8, Vec<u8>>,
    exit_record: Vec<u8>,
    cancel: Option<&'a AtomicBool>,
    st: RefCell<EcuState>,
}

impl<'a> MockEcu<'a> {
    fn new(max_block_len: u32, len_bytes: usize) -> Self {
        let mut rd = vec![(len_bytes as u8) << 4];
        rd.extend_from_slice(&max_block_len.to_be_bytes()[4 - len_bytes..]);
        Self {
            rd_response: rd,
            faults: HashMap::new(),
            persistent_nrc: None,
            raw_override: HashMap::new(),
            exit_record: Vec::new(),
            cancel: None,
            st: RefCell::new(EcuState::default()),
        }
    }

    fn fault(mut self, n: usize, f: Fault) -> Self {
        self.faults.insert(n, f);
        self
    }

    fn sids(&self) -> Vec<u8> {
        self.st.borrow().log.iter().map(|(s, _)| *s).collect()
    }

    fn counters(&self) -> Vec<u8> {
        self.st
            .borrow()
            .log
            .iter()
            .filter(|(s, _)| *s == 0x36)
            .map(|(_, d)| d[0])
            .collect()
    }

    fn block_lens(&self) -> Vec<usize> {
        self.st
            .borrow()
            .log
            .iter()
            .filter(|(s, _)| *s == 0x36)
            .map(|(_, d)| d.len() + 1)
            .collect()
    }

    fn memory(&self) -> Vec<FirmwareSegment> {
        self.st.borrow().memory.clone()
    }
}

fn timeout() -> RequesterError {
    RequesterError::Diag(DiagError::new(
        DiagErrorCode::TimeoutP2,
        "no response within P2",
    ))
}

fn neg(nrc: u8) -> RequesterError {
    RequesterError::Negative { nrc }
}

impl UdsRequester for MockEcu<'_> {
    fn request(
        &self,
        sid: u8,
        data: &[u8],
        timeout_ms: Option<u32>,
    ) -> Result<Vec<u8>, RequesterError> {
        let mut st = self.st.borrow_mut();
        st.log.push((sid, data.to_vec()));
        st.timeouts_seen.push(timeout_ms);
        if let Some(raw) = self.raw_override.get(&sid) {
            return Ok(raw.clone());
        }
        match sid {
            0x34 => {
                if st.active.is_some() {
                    return Err(neg(0x22));
                }
                let alfid = data[1];
                let (a, s) = (usize::from(alfid & 0xF), usize::from(alfid >> 4));
                let be = |b: &[u8]| b.iter().fold(0u64, |x, &y| (x << 8) | u64::from(y));
                let address = be(&data[2..2 + a]) as u32;
                let size = be(&data[2 + a..2 + a + s]) as usize;
                assert_eq!(data.len(), 2 + a + s);
                st.active = Some(Download {
                    address,
                    size,
                    data: Vec::new(),
                    expected: 1,
                    last_accepted: None,
                });
                let mut r = vec![0x74];
                r.extend_from_slice(&self.rd_response);
                Ok(r)
            }
            0x36 => {
                let n = st.transfer_count;
                st.transfer_count += 1;
                if st.active.is_none() {
                    return Err(neg(0x24));
                }
                if let Some(nrc) = self.persistent_nrc {
                    return Err(neg(nrc));
                }
                let fault = self.faults.get(&n).cloned();
                match &fault {
                    Some(Fault::Nrc(nrc)) => return Err(neg(*nrc)),
                    Some(Fault::Timeout) => return Err(timeout()),
                    Some(Fault::Raw(r)) => return Ok(r.clone()),
                    Some(Fault::Cancel) => {
                        if let Some(c) = self.cancel {
                            c.store(true, Ordering::Release);
                        }
                    }
                    _ => {}
                }
                let bsc = data[0];
                let dl = st.active.as_mut().unwrap();
                if Some(bsc) == dl.last_accepted {
                    // Repeated block: positive, not written again.
                } else if bsc == dl.expected {
                    if dl.data.len() + data.len() - 1 > dl.size {
                        return Err(neg(0x71));
                    }
                    dl.data.extend_from_slice(&data[1..]);
                    dl.last_accepted = Some(bsc);
                    dl.expected = bsc.wrapping_add(1);
                } else {
                    return Err(neg(0x73));
                }
                match fault {
                    Some(Fault::TimeoutAfterAccept) => Err(timeout()),
                    Some(Fault::Echo(e)) => Ok(vec![0x76, e]),
                    _ => Ok(vec![0x76, bsc]),
                }
            }
            0x37 => {
                let Some(dl) = st.active.take() else {
                    return Err(neg(0x24));
                };
                if dl.data.len() != dl.size {
                    return Err(neg(0x24));
                }
                st.memory.push(FirmwareSegment {
                    address: dl.address,
                    data: dl.data,
                });
                let mut r = vec![0x77];
                r.extend_from_slice(&self.exit_record);
                Ok(r)
            }
            _ => Err(neg(0x11)),
        }
    }
}

fn image(segs: &[(u32, usize)]) -> FirmwareImage {
    FirmwareImage::from_segments(
        segs.iter()
            .map(|&(address, len)| FirmwareSegment {
                address,
                data: (0..len)
                    .map(|i| (i as u32 ^ address).wrapping_mul(31) as u8)
                    .collect(),
            })
            .collect(),
    )
    .unwrap()
}

fn run(
    ecu: &MockEcu<'_>,
    img: &FirmwareImage,
    cfg: &DownloadConfig,
) -> (Result<FlashReportDto, FlashError>, Vec<FlashProgressDto>) {
    let cancel = AtomicBool::new(false);
    run_with_cancel(ecu, img, cfg, &cancel)
}

fn run_with_cancel(
    ecu: &MockEcu<'_>,
    img: &FirmwareImage,
    cfg: &DownloadConfig,
    cancel: &AtomicBool,
) -> (Result<FlashReportDto, FlashError>, Vec<FlashProgressDto>) {
    let mut events = Vec::new();
    let r = download_image(ecu, img, cfg, cancel, &mut |p| events.push(p));
    (r, events)
}

// ─── Happy paths ────────────────────────────────────────────────────────────

#[test]
fn multi_segment_hex_with_gap_reassembles_byte_for_byte() {
    use crate::uds::flash::firmware::tests::ihex;
    let mut lines = vec![ihex(4, 0, &[0x08, 0x00])];
    let src_a: Vec<u8> = (0..200u32).map(|i| (i * 7) as u8).collect();
    let src_b: Vec<u8> = (0..50u32).map(|i| (i * 13 + 1) as u8).collect();
    for (k, c) in src_a.chunks(16).enumerate() {
        lines.push(ihex(0, (k * 16) as u16, c));
    }
    for (k, c) in src_b.chunks(16).enumerate() {
        lines.push(ihex(0, 0x4000 + (k * 16) as u16, c));
    }
    lines.push(ihex(1, 0, &[]));
    let img = parse_intel_hex(&lines.join("\n")).unwrap();
    assert_eq!(img.segments.len(), 2);

    let ecu = MockEcu::new(0x22, 1);
    let (r, events) = run(&ecu, &img, &DownloadConfig::default());
    let rep = r.unwrap();
    assert_eq!(ecu.memory(), img.segments, "byte-for-byte equal");
    assert_eq!(
        ecu.sids()
            .iter()
            .filter(|&&s| s != 0x36)
            .collect::<Vec<_>>(),
        vec![&0x34, &0x37, &0x34, &0x37]
    );
    // 0x34 wire format with ALFID 0x44.
    let st = ecu.st.borrow();
    assert_eq!(
        st.log[0].1,
        vec![0x00, 0x44, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 200]
    );
    drop(st);
    assert_eq!(rep.total_bytes, 250);
    assert_eq!(rep.segments.len(), 2);
    assert_eq!(rep.segments[0].block_len, 0x22);
    assert_eq!(rep.segments[0].blocks, 200usize.div_ceil(0x20) as u32);
    assert_eq!(rep.segments[1].address, 0x0800_4000);
    assert_eq!(rep.total_retries, 0);

    // Progress: monotonic bytes, phase sequence per segment, ends with Done.
    assert!(events
        .windows(2)
        .all(|w| w[0].bytes_done <= w[1].bytes_done));
    assert_eq!(events.first().unwrap().phase, FlashPhase::RequestDownload);
    let last = events.last().unwrap();
    assert_eq!(last.phase, FlashPhase::Done);
    assert_eq!((last.bytes_done, last.bytes_total), (250, 250));
    assert_eq!(
        events
            .iter()
            .filter(|e| e.phase == FlashPhase::Exit)
            .count(),
        2
    );
}

#[test]
fn block_counter_wraps_ff_to_00() {
    // 8-byte blocks → 6 data bytes; 300 blocks.
    let img = image(&[(0x1000, 6 * 300)]);
    let ecu = MockEcu::new(8, 1);
    let (r, _) = run(&ecu, &img, &DownloadConfig::default());
    let rep = r.unwrap();
    assert_eq!(rep.segments[0].blocks, 300);
    let c = ecu.counters();
    assert_eq!(c[0], 0x01);
    assert_eq!(c[254], 0xFF);
    assert_eq!(c[255], 0x00, "wraps to 0x00, not 0x01");
    assert_eq!(c[256], 0x01);
    assert_eq!(c[299], 0x2C);
    assert_eq!(ecu.memory(), img.segments);
}

#[test]
fn counter_restarts_at_01_for_each_segment() {
    let img = image(&[(0x0, 30), (0x100, 30)]);
    let ecu = MockEcu::new(12, 1);
    run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
    assert_eq!(ecu.counters(), vec![1, 2, 3, 1, 2, 3]);
}

#[test]
fn max_block_len_length_formats_1_2_4_bytes() {
    for (max, n, expect_block) in [
        (0x20u32, 1usize, 0x20usize),
        (0x0102, 2, 0x0102),
        (0x0000_0FFF, 4, 0x0FFF),
        (0x0001_0000, 4, 4095), // capped to the classical limit
        (0xFFFF, 2, 4095),
    ] {
        let img = image(&[(0x2000, 10_000)]);
        let ecu = MockEcu::new(max, n);
        let rep = run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
        assert_eq!(rep.segments[0].ecu_max_block_len, max);
        assert_eq!(rep.segments[0].block_len as usize, expect_block);
        let lens = ecu.block_lens();
        assert!(lens[..lens.len() - 1].iter().all(|&l| l == expect_block));
        assert!(*lens.last().unwrap() <= expect_block);
        assert_eq!(ecu.memory(), img.segments);
    }
}

#[test]
fn tiny_and_large_blocks() {
    // Tiny: 8-byte PDU.
    let img = image(&[(0, 1000)]);
    let ecu = MockEcu::new(8, 1);
    let rep = run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
    assert_eq!(rep.segments[0].blocks, 1000usize.div_ceil(6) as u32);
    assert_eq!(ecu.memory(), img.segments);

    // Large: 4095-byte PDU → 4093 data bytes per block.
    let img = image(&[(0x0800_0000, 3 * 4093 + 5)]);
    let ecu = MockEcu::new(4095, 2);
    let rep = run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
    assert_eq!(rep.segments[0].blocks, 4);
    assert_eq!(ecu.block_lens(), vec![4095, 4095, 4095, 7]);
    assert_eq!(ecu.memory(), img.segments);

    // FD cap lets a larger ECU block through.
    let ecu = MockEcu::new(8192, 2);
    let cfg = DownloadConfig {
        max_block_len_cap: FD_MAX_BLOCK_LEN,
        ..Default::default()
    };
    let rep = run(&ecu, &img, &cfg).0.unwrap();
    assert_eq!(rep.segments[0].block_len, 8192);
    assert_eq!(ecu.memory(), img.segments);
}

#[test]
fn override_replaces_ecu_value_but_cap_wins() {
    let img = image(&[(0, 100)]);
    let ecu = MockEcu::new(0x400, 2);
    let cfg = DownloadConfig {
        max_block_len_override: Some(10),
        ..Default::default()
    };
    let rep = run(&ecu, &img, &cfg).0.unwrap();
    assert_eq!(rep.segments[0].block_len, 10);
    let ecu = MockEcu::new(0x10, 1);
    let cfg = DownloadConfig {
        max_block_len_override: Some(100_000),
        max_block_len_cap: 64,
        ..Default::default()
    };
    let rep = run(&ecu, &img, &cfg).0.unwrap();
    assert_eq!(rep.segments[0].block_len, 64);
    assert_eq!(ecu.memory(), img.segments);
}

#[test]
fn alfid_variants_and_exit_record() {
    let img = image(&[(0x12_3456, 300)]);
    let mut ecu = MockEcu::new(0x40, 1);
    ecu.exit_record = vec![0xCA, 0xFE];
    let cfg = DownloadConfig {
        data_format_identifier: 0x11,
        address_and_length_format_identifier: 0x23,
        transfer_exit_parameter: vec![0x01],
        transfer_timeout_ms: Some(500),
        request_timeout_ms: Some(5000),
        ..Default::default()
    };
    let rep = run(&ecu, &img, &cfg).0.unwrap();
    let st = ecu.st.borrow();
    assert_eq!(st.log[0].1, vec![0x11, 0x23, 0x12, 0x34, 0x56, 0x01, 0x2C]);
    let exit = st.log.iter().find(|(s, _)| *s == 0x37).unwrap();
    assert_eq!(exit.1, vec![0x01]);
    assert_eq!(st.timeouts_seen[0], Some(5000));
    assert_eq!(st.timeouts_seen[1], Some(500));
    assert_eq!(*st.timeouts_seen.last().unwrap(), Some(5000));
    drop(st);
    assert_eq!(rep.segments[0].exit_response, vec![0xCA, 0xFE]);
    assert_eq!(ecu.memory(), img.segments);
}

// ─── Retry policy ───────────────────────────────────────────────────────────

#[test]
fn nrc_73_once_then_success_resends_same_counter() {
    let img = image(&[(0, 60)]);
    let ecu = MockEcu::new(12, 1).fault(3, Fault::Nrc(0x73));
    let rep = run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
    assert_eq!(ecu.counters(), vec![1, 2, 3, 4, 4, 5, 6]);
    assert_eq!(rep.total_retries, 1);
    assert_eq!(rep.segments[0].retries, 1);
    assert_eq!(rep.segments[0].blocks, 6);
    assert_eq!(ecu.memory(), img.segments);
}

#[test]
fn timeout_once_then_success() {
    // Lost request (block not written) and lost response (block written → repeated block).
    for fault in [Fault::Timeout, Fault::TimeoutAfterAccept] {
        let img = image(&[(0, 60)]);
        let ecu = MockEcu::new(12, 1).fault(2, fault);
        let rep = run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
        assert_eq!(ecu.counters(), vec![1, 2, 3, 3, 4, 5, 6]);
        assert_eq!(rep.total_retries, 1);
        assert_eq!(ecu.memory(), img.segments, "no duplicated data");
    }
}

#[test]
fn busy_nrc_21_is_retried() {
    let img = image(&[(0, 20)]);
    let ecu = MockEcu::new(12, 1).fault(0, Fault::Nrc(0x21));
    let rep = run(&ecu, &img, &DownloadConfig::default()).0.unwrap();
    assert_eq!(rep.total_retries, 1);
    assert_eq!(ecu.memory(), img.segments);
}

#[test]
fn retries_exhausted_on_timeouts() {
    let img = image(&[(0x100, 60)]);
    let ecu = MockEcu::new(12, 1)
        .fault(1, Fault::Timeout)
        .fault(2, Fault::Timeout)
        .fault(3, Fault::Timeout);
    let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::Timeout);
    assert_eq!(e.phase, FlashPhase::Transfer);
    assert_eq!(e.block_counter, Some(2));
    assert_eq!(e.offset, Some(10));
    assert_eq!(e.diag_code, Some(DiagErrorCode::TimeoutP2));
    assert!(e.message.contains("after 2 retries"), "{}", e.message);
    assert_eq!(ecu.counters(), vec![1, 2, 2, 2]);
    assert!(!ecu.sids().contains(&0x37));

    let cfg = DownloadConfig {
        retries_per_block: 0,
        ..Default::default()
    };
    let ecu = MockEcu::new(12, 1).fault(0, Fault::Timeout);
    let e = run(&ecu, &img, &cfg).0.unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::Timeout);
    assert_eq!(ecu.counters(), vec![1]);
}

#[test]
fn persistent_nrc_72_aborts_without_exit() {
    let img = image(&[(0x0, 10), (0x8000, 100)]);
    let mut ecu = MockEcu::new(12, 1);
    // First segment fine, then fail all 0x36 of segment 2 by switching persistent NRC on.
    ecu.faults.insert(2, Fault::Nrc(0x72));
    let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::NegativeResponse);
    assert_eq!(e.last_nrc, Some(0x72));
    assert_eq!(e.last_nrc_name.as_deref(), Some("programmingFailure"));
    assert_eq!(e.segment_index, Some(1));
    assert_eq!(e.address, Some(0x8000));
    assert_eq!(e.offset, Some(10));
    assert_eq!(e.segments_completed, 1);
    assert_eq!(e.bytes_done, 20);
    assert_eq!(ecu.sids(), vec![0x34, 0x36, 0x37, 0x34, 0x36, 0x36]);
    assert!(e.to_ipc_string().starts_with("[flash:negative_response] "));

    let mut ecu = MockEcu::new(12, 1);
    ecu.persistent_nrc = Some(0x72);
    let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
    assert_eq!(e.last_nrc, Some(0x72));
    assert_eq!(ecu.counters(), vec![1], "0x72 is never retried");
}

#[test]
fn other_nrcs_abort_immediately() {
    for nrc in [0x71, 0x24, 0x31, 0x92, 0x93] {
        let img = image(&[(0, 30)]);
        let ecu = MockEcu::new(12, 1).fault(1, Fault::Nrc(nrc));
        let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
        assert_eq!(e.last_nrc, Some(nrc));
        assert_eq!(ecu.counters(), vec![1, 2]);
    }
    // Persistent 0x73 exhausts the retries and reports the NRC.
    let img = image(&[(0, 30)]);
    let mut ecu = MockEcu::new(12, 1);
    ecu.persistent_nrc = Some(0x73);
    let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::NegativeResponse);
    assert_eq!(e.last_nrc, Some(0x73));
    assert_eq!(ecu.counters(), vec![1, 1, 1]);
}

#[test]
fn transport_errors_abort_without_retry() {
    struct Gate;
    impl UdsRequester for Gate {
        fn request(&self, sid: u8, _: &[u8], _: Option<u32>) -> Result<Vec<u8>, RequesterError> {
            match sid {
                0x34 => Ok(vec![0x74, 0x10, 0x20]),
                _ => Err(DiagError::new(DiagErrorCode::PanicLatched, "panic stop").into()),
            }
        }
    }
    let e = download_image(
        &Gate,
        &image(&[(0, 10)]),
        &DownloadConfig::default(),
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::Transport);
    assert_eq!(e.diag_code, Some(DiagErrorCode::PanicLatched));
    assert_eq!(e.last_nrc, None);
}

#[test]
fn counter_echo_mismatch_is_error() {
    let img = image(&[(0, 60)]);
    let ecu = MockEcu::new(12, 1).fault(2, Fault::Echo(0x07));
    let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::CounterMismatch);
    assert_eq!(e.block_counter, Some(3));
    assert!(e.message.contains("0x07"), "{}", e.message);
    assert_eq!(ecu.counters(), vec![1, 2, 3]);
    assert!(!ecu.sids().contains(&0x37));
}

#[test]
fn cancellation_mid_segment() {
    let cancel = AtomicBool::new(false);
    let img = image(&[(0x4000, 100), (0x9000, 10)]);
    let mut ecu = MockEcu::new(12, 1).fault(4, Fault::Cancel);
    ecu.cancel = Some(&cancel);
    let (r, events) = run_with_cancel(&ecu, &img, &DownloadConfig::default(), &cancel);
    let e = r.unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::Cancelled);
    assert_eq!(e.phase, FlashPhase::Transfer);
    assert_eq!(e.segment_index, Some(0));
    assert_eq!(e.offset, Some(50), "5 blocks of 10 bytes acknowledged");
    assert_eq!(e.bytes_done, 50);
    assert_eq!(e.block_counter, Some(6));
    assert_eq!(ecu.counters(), vec![1, 2, 3, 4, 5]);
    assert!(
        !ecu.sids().contains(&0x37),
        "no RequestTransferExit after cancel"
    );
    assert_eq!(events.last().unwrap().bytes_done, 50);

    // Already-cancelled → nothing is sent.
    let ecu = MockEcu::new(12, 1);
    let (r, _) = run_with_cancel(&ecu, &img, &DownloadConfig::default(), &cancel);
    assert_eq!(r.unwrap_err().kind, FlashErrorKind::Cancelled);
    assert!(ecu.sids().is_empty());
}

// ─── Validation / malformed responses ───────────────────────────────────────

#[test]
fn config_validation_is_preflight() {
    let img = image(&[(0x0001_0000, 10)]);
    for cfg in [
        DownloadConfig {
            address_and_length_format_identifier: 0x40,
            ..Default::default()
        },
        DownloadConfig {
            address_and_length_format_identifier: 0x54,
            ..Default::default()
        },
        DownloadConfig {
            address_and_length_format_identifier: 0x12, // 2-byte address, 0x10000 does not fit
            ..Default::default()
        },
        DownloadConfig {
            max_block_len_cap: 2,
            ..Default::default()
        },
        DownloadConfig {
            max_block_len_cap: 70_000,
            ..Default::default()
        },
        DownloadConfig {
            max_block_len_override: Some(2),
            ..Default::default()
        },
        DownloadConfig {
            retries_per_block: 11,
            ..Default::default()
        },
        DownloadConfig {
            transfer_timeout_ms: Some(0),
            ..Default::default()
        },
        DownloadConfig {
            mode: TransferMode::Upload,
            ..Default::default()
        },
    ] {
        let ecu = MockEcu::new(12, 1);
        let e = run(&ecu, &img, &cfg).0.unwrap_err();
        assert_eq!(e.kind, FlashErrorKind::InvalidConfig, "{cfg:?}");
        assert!(ecu.sids().is_empty(), "nothing sent for {cfg:?}");
    }
    // Length does not fit a 1-byte memorySize.
    let cfg = DownloadConfig {
        address_and_length_format_identifier: 0x14,
        ..Default::default()
    };
    let e = run(&MockEcu::new(12, 1), &image(&[(0, 256)]), &cfg)
        .0
        .unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::InvalidConfig);
    assert_eq!(e.segment_index, Some(0));
    // 255 fits.
    assert!(run(&MockEcu::new(12, 1), &image(&[(0, 255)]), &cfg)
        .0
        .is_ok());

    let e = run(
        &MockEcu::new(12, 1),
        &FirmwareImage::default(),
        &DownloadConfig::default(),
    )
    .0
    .unwrap_err();
    assert_eq!(e.kind, FlashErrorKind::InvalidImage);
}

#[test]
fn config_json_shape() {
    let cfg: DownloadConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(cfg, DownloadConfig::default());
    let cfg: DownloadConfig = serde_json::from_str(
        r#"{"addressAndLengthFormatIdentifier":51,"maxBlockLenCap":65535,"mode":"download",
            "retriesPerBlock":3,"maxBlockLenOverride":258,"transferTimeoutMs":1000}"#,
    )
    .unwrap();
    assert_eq!(cfg.address_and_length_format_identifier, 0x33);
    assert_eq!(cfg.max_block_len_override, Some(258));
    assert!(cfg.validate().is_ok());
}

#[test]
fn request_download_response_parsing() {
    assert_eq!(
        parse_request_download_response(&[0x74, 0x10, 0x20]),
        Ok(0x20)
    );
    assert_eq!(
        parse_request_download_response(&[0x74, 0x20, 0x0F, 0xFF]),
        Ok(0xFFF)
    );
    assert_eq!(
        parse_request_download_response(&[0x74, 0x40, 0x00, 0x01, 0x00, 0x02]),
        Ok(0x0001_0002)
    );
    for bad in [
        &[][..],
        &[0x74],
        &[0x75, 0x10, 0x20],
        &[0x74, 0x00],
        &[0x74, 0x00, 0x20],
        &[0x74, 0x50, 1, 2, 3, 4, 5],
        &[0x74, 0x20, 0x0F],
        &[0x74, 0x10, 0x20, 0x00],
    ] {
        assert!(parse_request_download_response(bad).is_err(), "{bad:02X?}");
    }
}

#[test]
fn malformed_ecu_responses_are_errors_not_panics() {
    let img = image(&[(0, 30)]);
    // Bad 0x74.
    for rd in [
        vec![0x74],
        vec![0x74, 0x00],
        vec![0x74, 0x10],
        vec![0x74, 0x10, 0x02],
    ] {
        let mut ecu = MockEcu::new(12, 1);
        ecu.raw_override.insert(0x34, rd.clone());
        let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
        assert_eq!(e.kind, FlashErrorKind::MalformedResponse, "{rd:02X?}");
        assert_eq!(e.phase, FlashPhase::RequestDownload);
        assert_eq!(ecu.sids(), vec![0x34]);
    }
    // Bad 0x76.
    for r in [vec![], vec![0x76], vec![0x77, 0x01], vec![0x00]] {
        let ecu = MockEcu::new(12, 1).fault(0, Fault::Raw(r.clone()));
        let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
        assert_eq!(e.kind, FlashErrorKind::MalformedResponse, "{r:02X?}");
    }
    // A 0x7F smuggled through Ok is treated as the NRC it carries.
    let ecu = MockEcu::new(12, 1).fault(0, Fault::Raw(vec![0x7F, 0x36, 0x72]));
    let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
    assert_eq!(e.last_nrc, Some(0x72));
    // Bad 0x77.
    for r in [vec![], vec![0x76]] {
        let mut ecu = MockEcu::new(12, 1);
        ecu.raw_override.insert(0x37, r);
        let e = run(&ecu, &img, &DownloadConfig::default()).0.unwrap_err();
        assert_eq!(e.kind, FlashErrorKind::MalformedResponse);
        assert_eq!(e.phase, FlashPhase::Exit);
    }
}

#[test]
fn random_responses_never_panic() {
    struct Chaos(RefCell<u64>);
    impl UdsRequester for Chaos {
        fn request(&self, sid: u8, _: &[u8], _: Option<u32>) -> Result<Vec<u8>, RequesterError> {
            let mut x = self.0.borrow_mut();
            let mut next = || {
                *x = x
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (*x >> 33) as u8
            };
            let len = usize::from(next() % 8);
            let mut v: Vec<u8> = (0..len).map(|_| next()).collect();
            // Bias towards plausible SIDs so deeper paths are reached.
            if !v.is_empty() && next() % 2 == 0 {
                v[0] = sid + 0x40;
            }
            match next() % 6 {
                0 => Err(timeout()),
                1 => Err(neg(next())),
                _ => Ok(v),
            }
        }
    }
    for seed in 0..3000u64 {
        let chaos = Chaos(RefCell::new(seed));
        let _ = download_image(
            &chaos,
            &image(&[(0, 40), (0x100, 5)]),
            &DownloadConfig::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        );
    }
}

// ─── Requester contract helpers ─────────────────────────────────────────────

#[test]
fn nrc_error_round_trip_and_response_mapping() {
    for nrc in [0x00, 0x22, 0x72, 0x73, 0xFF] {
        let e = neg(nrc);
        assert_eq!((e.nrc(), e.diag_code()), (Some(nrc), None));
    }
    let t = timeout();
    assert_eq!(
        (t.nrc(), t.diag_code()),
        (None, Some(DiagErrorCode::TimeoutP2))
    );
    // A DiagError coded NegativeResponse whose text looks like an NRC is still NOT an NRC:
    // nothing parses message text.
    let fake: RequesterError = DiagError::new(
        DiagErrorCode::NegativeResponse,
        "nrc=0x72 programmingFailure",
    )
    .into();
    assert_eq!(fake.nrc(), None);
    assert_eq!(
        neg(0x72).to_string(),
        "negative response nrc=0x72 programmingFailure"
    );

    let base = UdsResponseDto {
        raw: vec![0x7F, 0x36, 0x73],
        positive: false,
        suppressed: false,
        nrc: Some(0x73),
        nrc_name: Some("wrongBlockCounter".into()),
        response_pending_count: 0,
        elapsed_us: 0,
        transaction_seq: 1,
        busy_retry_count: 0,
    };
    // NRC taken from the DTO field, not from `raw` or any text.
    let e = response_to_result(UdsResponseDto {
        raw: vec![],
        ..base.clone()
    })
    .unwrap_err();
    assert_eq!(e, RequesterError::Negative { nrc: 0x73 });
    let ok = UdsResponseDto {
        raw: vec![0x76, 0x01],
        positive: true,
        nrc: None,
        nrc_name: None,
        ..base.clone()
    };
    assert_eq!(response_to_result(ok).unwrap(), vec![0x76, 0x01]);
    let empty = UdsResponseDto {
        raw: vec![],
        positive: true,
        suppressed: true,
        nrc: None,
        nrc_name: None,
        ..base
    };
    assert_eq!(
        response_to_result(empty).unwrap_err().diag_code(),
        Some(DiagErrorCode::UnexpectedResponse)
    );
}

#[test]
fn dto_json_shapes() {
    let p = FlashProgressDto {
        segment_index: 0,
        segment_count: 2,
        segment_address: 0x100,
        bytes_done: 10,
        bytes_total: 20,
        block_counter: 1,
        retries: 0,
        phase: FlashPhase::RequestDownload,
    };
    assert_eq!(
        serde_json::to_value(p).unwrap(),
        serde_json::json!({"segmentIndex":0,"segmentCount":2,"segmentAddress":256,
            "bytesDone":10,"bytesTotal":20,"blockCounter":1,"retries":0,
            "phase":"requestDownload"})
    );
    let err = FlashError::preflight(FlashErrorKind::InvalidConfig, "x".into());
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "invalidConfig");
    assert_eq!(v["phase"], "requestDownload");
    assert!(v["lastNrc"].is_null());
    assert_eq!(v["segmentsCompleted"], 0);
}
