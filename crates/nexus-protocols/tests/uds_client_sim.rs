//! UDS client end-to-end over an in-memory [`DiagCanPort`] (no bus, any OS): exact ISO-TP
//! byte layouts with extended / mixed addressing.
//!
//! [`SimPort`] behaves like the HAL tap: `send` runs the gate check, records the frame, emits
//! `TxConfirmed` and feeds it to a scripted [`IsoTpEcu`] whose frames come back as `Rx`.

#[path = "support/isotp_ecu.rs"]
mod isotp_ecu;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use isotp_ecu::{Handler, IsoTpEcu};
use nexus_core::{CanIdKey, RawCanFrame};
use nexus_protocols::uds::client::UdsSession;
use nexus_protocols::uds::dto::{
    AddressFormatDto, ConversationEventKind, DiagErrorCode, DiagSessionConfigDto,
    UdsRequestOptionsDto,
};
use nexus_protocols::uds::port::{DiagCanPort, DiagPortEvent, DiagTxReject};
use parking_lot::{Condvar, Mutex};

const REQ: u32 = 0x6F1;
const RESP: u32 = 0x6F9;

/// Hook run on every accepted tester frame BEFORE the ECU sees it (e.g. close a gate).
pub type TxHook = Box<dyn FnMut(&[u8], &SimCtl) + Send>;

/// Shared state of a [`SimPort`]: test knobs and evidence.
pub struct SimCtl {
    q: Mutex<VecDeque<DiagPortEvent>>,
    cv: Condvar,
    pub gate: Mutex<Option<DiagTxReject>>,
    pub sent: Mutex<Vec<RawCanFrame>>,
    /// Frames the ECU put on the bus (payloads).
    pub ecu_frames: Mutex<Vec<Vec<u8>>>,
    ecu: Mutex<IsoTpEcu>,
    hook: Mutex<Option<TxHook>>,
    /// Extra frames injected before the ECU's answer to the next tester frame.
    pub inject: Mutex<Vec<Vec<u8>>>,
    /// Tap closed by the "HAL" (panic / disarm / mode change).
    pub closed: AtomicBool,
    fd: bool,
}

impl SimCtl {
    pub fn set_gate(&self, g: Option<DiagTxReject>) {
        *self.gate.lock() = g;
    }
    pub fn sent_payloads(&self) -> Vec<Vec<u8>> {
        self.sent
            .lock()
            .iter()
            .map(|f| f.payload().to_vec())
            .collect()
    }
    fn push(&self, ev: DiagPortEvent) {
        self.q.lock().push_back(ev);
        self.cv.notify_all();
    }
    fn rx(&self, data: &[u8]) {
        let key = CanIdKey::new_standard(RESP as u16).unwrap_or(CanIdKey::Standard(0));
        let f = if self.fd {
            RawCanFrame::new_fd(0, key, data, true, 1)
        } else {
            RawCanFrame::new_classical(0, key, data, 1)
        };
        self.ecu_frames.lock().push(data.to_vec());
        if let Ok(f) = f {
            self.push(DiagPortEvent::Rx(f));
        }
    }
}

pub struct SimPort(Arc<SimCtl>);

impl DiagCanPort for SimPort {
    fn bus_id(&self) -> u8 {
        0
    }
    fn fd_enabled(&self) -> bool {
        self.0.fd
    }
    fn gate_check(&self) -> Result<(), DiagTxReject> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(DiagTxReject::Closed);
        }
        self.0.gate.lock().map_or(Ok(()), Err)
    }
    fn send(&self, frame: RawCanFrame) -> Result<(), DiagTxReject> {
        self.gate_check()?;
        let c = &self.0;
        c.sent.lock().push(frame);
        c.push(DiagPortEvent::TxConfirmed(frame));
        if frame.arb_id != REQ {
            return Ok(()); // functional: no ECU in these tests
        }
        if let Some(h) = c.hook.lock().as_mut() {
            h(frame.payload(), c);
        }
        for f in std::mem::take(&mut *c.inject.lock()) {
            c.rx(&f);
        }
        let out = c.ecu.lock().on_frame(frame.payload());
        for f in out {
            c.rx(&f);
        }
        Ok(())
    }
    fn recv_timeout(&self, timeout: Duration) -> Option<DiagPortEvent> {
        let mut q = self.0.q.lock();
        if q.is_empty() {
            let _ = self.0.cv.wait_for(&mut q, timeout);
        }
        q.pop_front()
    }
    fn try_recv(&self) -> Option<DiagPortEvent> {
        self.0.q.lock().pop_front()
    }
    fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }
}

pub fn sim(ecu: IsoTpEcu, fd: bool) -> (Box<dyn DiagCanPort>, Arc<SimCtl>) {
    let ctl = Arc::new(SimCtl {
        q: Mutex::new(VecDeque::new()),
        cv: Condvar::new(),
        gate: Mutex::new(None),
        sent: Mutex::new(Vec::new()),
        ecu_frames: Mutex::new(Vec::new()),
        ecu: Mutex::new(ecu),
        hook: Mutex::new(None),
        inject: Mutex::new(Vec::new()),
        closed: AtomicBool::new(false),
        fd,
    });
    (Box::new(SimPort(ctl.clone())), ctl)
}

pub fn cfg(fd: bool) -> DiagSessionConfigDto {
    DiagSessionConfigDto {
        bus_id: 0,
        request_id: REQ,
        response_id: RESP,
        is_extended_id: false,
        protocol: Some("uds".into()),
        functional_id: None,
        use_fd: fd,
        padding: Some(0xAA),
        p2_margin_ms: 100,
        address_format: AddressFormatDto::Normal,
        target_address: None,
        response_address: None,
    }
}

fn extended_cfg(fd: bool) -> DiagSessionConfigDto {
    DiagSessionConfigDto {
        address_format: AddressFormatDto::Extended,
        target_address: Some(0x10),
        response_address: Some(0xF1),
        ..cfg(fd)
    }
}

/// `62 F1 90` + `n - 3` counting bytes.
fn rdbi_answer(n: usize) -> Vec<u8> {
    let mut p = vec![0x62, 0xF1, 0x90];
    p.extend((0..n - 3).map(|i| i as u8));
    p
}

fn echo_handler(answer_len: usize) -> Handler {
    Box::new(move |req: &[u8]| match req.first() {
        Some(0x22) => vec![rdbi_answer(answer_len)],
        Some(0x2E) => vec![vec![0x6E, req[1], req[2]]],
        // Positive SID + echo of sub-function / identifier bytes.
        Some(&sid) => vec![std::iter::once(sid + 0x40)
            .chain(req.iter().skip(1).take(3).copied())
            .collect()],
        None => vec![],
    })
}

fn opts() -> UdsRequestOptionsDto {
    UdsRequestOptionsDto {
        timeout_ms: Some(2_000),
        ..Default::default()
    }
}

#[test]
fn extended_addressing_classic_sf_ff_cf_fc_layouts() {
    let ecu = IsoTpEcu::new(Some(0xF1), Some(0x10), false, echo_handler(20));
    let (port, ctl) = sim(ecu, false);
    let s = UdsSession::open(port, extended_cfg(false)).expect("open");

    // Request SF + multi-frame response (tester answers FF with FC).
    let r = s.request(0x22, &[0xF1, 0x90], &opts()).expect("rdbi");
    assert_eq!(r.raw, rdbi_answer(20));
    assert_eq!(
        ctl.sent_payloads(),
        vec![
            vec![0x10, 0x03, 0x22, 0xF1, 0x90, 0xAA, 0xAA, 0xAA],
            vec![0x10, 0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA],
        ]
    );
    // ECU side: FF carries 5 bytes after [RA, 10 14], CFs 6 bytes each.
    let ecu = ctl.ecu_frames.lock().clone();
    assert_eq!(&ecu[0][..3], &[0xF1, 0x10, 0x14]);
    assert_eq!(ecu.len(), 4, "FF + 3 CF for 20 bytes");

    // Multi-frame request: FF [TA 10 14 + 5 bytes], CFs [TA 2n + 6 bytes], last one padded.
    ctl.sent.lock().clear();
    let data: Vec<u8> = [0xF1, 0x90]
        .into_iter()
        .chain((0..17).map(|i| 0x40 + i))
        .collect();
    let r = s.request(0x2E, &data, &opts()).expect("wdbi");
    assert_eq!(r.raw, vec![0x6E, 0xF1, 0x90]);
    assert_eq!(
        ctl.sent_payloads(),
        vec![
            vec![0x10, 0x10, 0x14, 0x2E, 0xF1, 0x90, 0x40, 0x41],
            vec![0x10, 0x21, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47],
            vec![0x10, 0x22, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D],
            vec![0x10, 0x23, 0x4E, 0x4F, 0x50, 0xAA, 0xAA, 0xAA],
        ]
    );
    // 6-byte request is still a single frame; 7 bytes are not (FF).
    ctl.sent.lock().clear();
    s.request(0x31, &[1, 2, 3, 4, 5], &opts())
        .expect("6-byte SF");
    assert_eq!(
        ctl.sent_payloads()[0],
        vec![0x10, 0x06, 0x31, 1, 2, 3, 4, 5]
    );
    s.close();
}

#[test]
fn extended_addressing_fd_escape_sf_and_ff_layouts() {
    let ecu = IsoTpEcu::new(Some(0xF1), Some(0x10), true, echo_handler(100));
    let (port, ctl) = sim(ecu, true);
    let s = UdsSession::open(port, extended_cfg(true)).expect("open");
    // 10-byte request: escape SF [TA, 00, 0A, pdu] padded to the next FD length (16).
    let r = s
        .request(
            0x22,
            &[0xF1, 0x90, 0xF1, 0x8C, 0xF1, 0x87, 0xF1, 0x86, 0xF1],
            &opts(),
        )
        .expect("rdbi fd");
    assert_eq!(r.raw, rdbi_answer(100));
    let sent = ctl.sent_payloads();
    let mut want = vec![
        0x10, 0x00, 0x0A, 0x22, 0xF1, 0x90, 0xF1, 0x8C, 0xF1, 0x87, 0xF1, 0x86, 0xF1,
    ];
    want.resize(16, 0xAA);
    assert_eq!(sent[0], want);
    // FC after the FD FF: short frame with the TA prefix.
    assert_eq!(
        sent[1],
        vec![0x10, 0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA]
    );
    assert!(ctl.sent.lock().iter().all(|f| f.is_fd()));
    // ECU FF = [RA, 10, 64, 61 bytes] = 64; one CF with the remaining 39 bytes.
    let ecu = ctl.ecu_frames.lock().clone();
    assert_eq!((ecu[0].len(), &ecu[0][..3]), (64, &[0xF1, 0x10, 0x64][..]));
    assert_eq!(ecu.len(), 2);
    // 61 bytes = largest escape SF with an address byte; 62 needs a FF.
    ctl.sent.lock().clear();
    s.request(0x31, &[0x55; 60], &opts()).expect("61-byte SF");
    let sent = ctl.sent_payloads();
    assert_eq!((sent[0].len(), &sent[0][..3]), (64, &[0x10, 0x00, 61][..]));
    ctl.sent.lock().clear();
    s.request(0x31, &[0x55; 61], &opts()).expect("62-byte FF");
    assert_eq!(&ctl.sent_payloads()[0][..3], &[0x10, 0x10, 62]);
    s.close();
}

#[test]
fn mixed_addressing_11bit_uses_n_ae_both_ways() {
    let ecu = IsoTpEcu::new(Some(0x55), Some(0x55), false, echo_handler(3));
    let (port, ctl) = sim(ecu, false);
    let c = DiagSessionConfigDto {
        address_format: AddressFormatDto::Mixed,
        target_address: Some(0x55),
        ..cfg(false)
    };
    let s = UdsSession::open(port, c).expect("open mixed");
    let r = s.request(0x3E, &[0x00], &opts()).expect("tp");
    assert_eq!(r.raw, vec![0x7E, 0x00]);
    assert_eq!(
        ctl.sent_payloads(),
        vec![vec![0x55, 0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA]]
    );
    s.close();
}

#[test]
fn frames_with_a_foreign_address_byte_are_ignored() {
    let ecu = IsoTpEcu::new(Some(0xF1), Some(0x10), false, echo_handler(20));
    let (port, ctl) = sim(ecu, false);
    let s = UdsSession::open(port, extended_cfg(false)).expect("open");
    // Before the real answer: an SF and an FF addressed to another tester (0xF2).
    *ctl.inject.lock() = vec![
        vec![0xF2, 0x03, 0x62, 0xF1, 0x90, 0xAA, 0xAA, 0xAA],
        vec![0xF2, 0x10, 0x30, 0x62, 0xF1, 0x90, 0x00, 0x00],
    ];
    let r = s.request(0x22, &[0xF1, 0x90], &opts()).expect("rdbi");
    assert_eq!(r.raw, rdbi_answer(20), "foreign SF not taken as the answer");
    let fcs = ctl
        .sent_payloads()
        .into_iter()
        .filter(|p| p.get(1).is_some_and(|b| b >> 4 == 3))
        .count();
    assert_eq!(fcs, 1, "no FC for the foreign FF, one for ours");
    s.close();
}

#[test]
fn address_format_validation_on_open() {
    let open = |c: DiagSessionConfigDto| {
        let ecu = IsoTpEcu::new(None, None, false, echo_handler(3));
        UdsSession::open(sim(ecu, false).0, c)
            .map(|_| ())
            .map_err(|e| e.code)
    };
    let inv = Err(DiagErrorCode::InvalidInput);
    let ext = extended_cfg(false);
    assert_eq!(
        open(DiagSessionConfigDto {
            target_address: None,
            ..ext.clone()
        }),
        inv
    );
    assert_eq!(
        open(DiagSessionConfigDto {
            response_address: None,
            ..ext.clone()
        }),
        inv
    );
    let mixed = DiagSessionConfigDto {
        address_format: AddressFormatDto::Mixed,
        target_address: None,
        ..cfg(false)
    };
    assert_eq!(open(mixed.clone()), inv, "mixed needs targetAddress");
    let mixed29 = DiagSessionConfigDto {
        is_extended_id: true,
        request_id: 0x18DA_10F1,
        response_id: 0x18DA_F110,
        target_address: Some(0x55),
        ..mixed
    };
    assert_eq!(open(mixed29.clone()), inv, "29-bit mixed needs 0x18CE ids");
    assert_eq!(
        open(DiagSessionConfigDto {
            request_id: 0x18CE_10F1,
            response_id: 0x18CE_F110,
            ..mixed29
        }),
        Ok(())
    );
    let nf = DiagSessionConfigDto {
        address_format: AddressFormatDto::NormalFixed,
        ..cfg(false)
    };
    assert_eq!(open(nf.clone()), inv, "normalFixed needs 29-bit");
    assert_eq!(
        open(DiagSessionConfigDto {
            is_extended_id: true,
            request_id: 0x18DA_10F1,
            response_id: 0x18DA_F110,
            ..nf
        }),
        Ok(())
    );
}

// ─── NRC 0x21 busyRepeatRequest retries ─────────────────────────────────────────────────────

/// ECU answering `7F 22 21` for the first `busy` requests, then `62 F1 90 01`.
fn busy_ecu(busy: usize) -> (IsoTpEcu, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let ecu = IsoTpEcu::new(
        None,
        None,
        false,
        Box::new(move |req: &[u8]| {
            let n = c.fetch_add(1, Ordering::AcqRel);
            if n < busy {
                vec![vec![0x7F, req[0], 0x21]]
            } else {
                vec![vec![0x62, 0xF1, 0x90, 0x01]]
            }
        }),
    );
    (ecu, calls)
}

fn busy_opts(max: Option<u8>, delay_ms: Option<u32>) -> UdsRequestOptionsDto {
    UdsRequestOptionsDto {
        busy_retry_max: max,
        busy_retry_delay_ms: delay_ms,
        ..Default::default()
    }
}

fn request_events(s: &UdsSession) -> Vec<Option<u8>> {
    s.conversation_since(0, 1000)
        .events
        .iter()
        .filter(|e| e.kind == ConversationEventKind::Request)
        .map(|e| e.retry_index)
        .collect()
}

#[test]
fn busy_twice_then_positive_is_retried_and_logged() {
    let (ecu, calls) = busy_ecu(2);
    let (port, ctl) = sim(ecu, false);
    let s = UdsSession::open(port, cfg(false)).expect("open");
    let r = s
        .request(0x22, &[0xF1, 0x90], &busy_opts(Some(3), Some(10)))
        .expect("request");
    assert!(r.positive, "{r:?}");
    assert_eq!(r.raw, vec![0x62, 0xF1, 0x90, 0x01]);
    assert_eq!(r.busy_retry_count, 2);
    assert_eq!(calls.load(Ordering::Acquire), 3);
    assert_eq!(request_events(&s), vec![None, Some(1), Some(2)]);
    // Each retry is a new transmission of the same SF.
    assert_eq!(ctl.sent_payloads().len(), 3);
    assert!(ctl
        .sent_payloads()
        .iter()
        .all(|p| p[..4] == [0x03, 0x22, 0xF1, 0x90]));
    let log = s.conversation_since(0, 1000).events;
    assert_eq!(
        r.transaction_seq,
        log.iter()
            .rev()
            .find(|e| e.kind == ConversationEventKind::Request)
            .map_or(0, |e| e.seq)
    );
    s.close();
}

#[test]
fn busy_retry_limit_returns_the_0x21_result() {
    let (ecu, calls) = busy_ecu(usize::MAX);
    let (port, ctl) = sim(ecu, false);
    let s = UdsSession::open(port, cfg(false)).expect("open");
    let r = s
        .request(0x22, &[0xF1, 0x90], &busy_opts(Some(2), Some(10)))
        .expect("request");
    assert!(!r.positive);
    assert_eq!(r.nrc, Some(0x21));
    assert_eq!(r.nrc_name.as_deref(), Some("busyTryAgain"));
    assert_eq!(r.busy_retry_count, 2);
    assert_eq!(calls.load(Ordering::Acquire), 3);
    assert_eq!(ctl.sent_payloads().len(), 3);
    // Default: no retry at all (today's behaviour).
    let r = s
        .request(0x22, &[0xF1, 0x90], &UdsRequestOptionsDto::default())
        .expect("request");
    assert_eq!((r.nrc, r.busy_retry_count), (Some(0x21), 0));
    assert_eq!(ctl.sent_payloads().len(), 4);
    s.close();
}

#[test]
fn busy_retry_options_are_clamped_and_bounded() {
    let (ecu, _calls) = busy_ecu(usize::MAX);
    let (port, ctl) = sim(ecu, false);
    let s = UdsSession::open(port, cfg(false)).expect("open");
    // busyRetryMax 50 → 10 retries; delay 0 → 10 ms.
    let t0 = Instant::now();
    let r = s
        .request(0x22, &[0xF1, 0x90], &busy_opts(Some(50), Some(0)))
        .expect("request");
    assert_eq!(r.busy_retry_count, 10);
    assert_eq!(ctl.sent_payloads().len(), 11);
    assert!(
        t0.elapsed() >= Duration::from_millis(100),
        "{:?}",
        t0.elapsed()
    );
    // timeoutMs bounds all attempts: 300 ms with a 200 ms delay leaves room for one retry.
    ctl.sent.lock().clear();
    let o = UdsRequestOptionsDto {
        timeout_ms: Some(300),
        ..busy_opts(Some(10), Some(200))
    };
    let r = s.request(0x22, &[0xF1, 0x90], &o).expect("request");
    assert_eq!(r.busy_retry_count, 1);
    assert_eq!(ctl.sent_payloads().len(), 2);
    s.close();
}

#[test]
fn closed_gate_between_retries_stops_them_without_tx() {
    for gate in [
        DiagTxReject::ListenOnly,
        DiagTxReject::Disarmed,
        DiagTxReject::PanicLatched,
    ] {
        let (ecu, calls) = busy_ecu(usize::MAX);
        let (port, ctl) = sim(ecu, false);
        // The gate closes right after the first request reached the bus.
        *ctl.hook.lock() = Some(Box::new(move |_, c: &SimCtl| c.set_gate(Some(gate))));
        let s = UdsSession::open(port, cfg(false)).expect("open");
        let e = s
            .request(0x22, &[0xF1, 0x90], &busy_opts(Some(5), Some(500)))
            .expect_err("retry must be refused");
        let want = match gate {
            DiagTxReject::ListenOnly => DiagErrorCode::ListenOnly,
            DiagTxReject::Disarmed => DiagErrorCode::Disarmed,
            _ => DiagErrorCode::PanicLatched,
        };
        assert_eq!(e.code, want, "{gate:?}");
        assert_eq!(ctl.sent_payloads().len(), 1, "{gate:?}: no further TX");
        assert_eq!(calls.load(Ordering::Acquire), 1);
        let kinds: Vec<ConversationEventKind> = s
            .conversation_since(0, 100)
            .events
            .iter()
            .map(|e| e.kind)
            .collect();
        assert!(
            kinds.contains(&ConversationEventKind::TxBlocked),
            "{kinds:?}"
        );
        s.close();
    }
}

#[test]
fn tap_close_between_retries_stops_them_without_tx() {
    let (ecu, _calls) = busy_ecu(usize::MAX);
    let (port, ctl) = sim(ecu, false);
    *ctl.hook.lock() = Some(Box::new(|_, c: &SimCtl| {
        c.closed.store(true, Ordering::Release)
    }));
    let s = UdsSession::open(port, cfg(false)).expect("open");
    let t0 = Instant::now();
    let e = s
        .request(0x22, &[0xF1, 0x90], &busy_opts(Some(5), Some(5_000)))
        .expect_err("closed");
    assert_eq!(e.code, DiagErrorCode::SessionClosed);
    assert!(
        t0.elapsed() < Duration::from_secs(2),
        "abort is immediate, not after the delay"
    );
    assert_eq!(ctl.sent_payloads().len(), 1);
}
