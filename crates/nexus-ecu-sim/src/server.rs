//! Platform-independent UDS (ISO 14229-1) bootloader server state machine.
//!
//! [`Server::handle`] turns one request PDU into a [`Plan`]: an ordered list
//! of transport steps (send a PDU, wait, simulate a reboot). The runtime
//! executes the plan on the ISO-TP socket; unit tests inspect it directly.
//!
//! ## Session / service matrix
//! | SID | Default | Extended | Programming | functional |
//! | :-- | :-: | :-: | :-: | :-: |
//! | 0x10 0x11 0x3E 0x22 0x19 0x14 | yes | yes | yes | yes |
//! | 0x28 0x85 | 0x7F | yes | yes | yes |
//! | 0x27 0x2E 0x31 | 0x7F | yes | yes | no |
//! | 0x34 0x36 0x37 | 0x7F | 0x7F | yes | no |
//!
//! NRC evaluation order per service follows ISO 14229-1 §7.5 (SID → session →
//! length → sub-function → sub-function-in-session → service specific).
//! For functionally addressed requests NRCs 0x11, 0x12, 0x31, 0x7E and 0x7F
//! are suppressed (ISO 14229-1 §7.5.3).
//!
//! ## Production-style reprogramming (OEM flow)
//! * **Bootloader jump:** a 0x10 0x02 that actually enters the Programming
//!   session is answered, then the ECU is silent for `boot_jump_ms`
//!   ([`Step::Silence`]); requests received meanwhile are discarded.
//! * **RID 0x0203** checkProgrammingPreconditions (Extended + Programming, no
//!   security): status 00, or 01 with `--fault precondition-fail`.
//! * **RID 0x0202** checkProgrammingIntegrity with a 4-byte CRC-32 argument is
//!   matched, in this order, against (1) the most recently downloaded segment,
//!   (2) any other single segment downloaded since its last erase, (3) all
//!   segments concatenated in download order (legacy whole-image check).
//!   Status 00 marks the matched segment(s) verified; a mismatch marks the
//!   most recent segment failed (sticky until that range is erased again).
//!   Without an argument the routine returns status 00 + the whole-image CRC
//!   and marks every segment verified (the tester does the comparison).
//! * **RID 0xFF01** checkProgrammingDependencies: status 00 only if no
//!   download is active, at least one segment exists and every segment is
//!   verified and not failed; this arms the software-version update that the
//!   next ECUReset applies to DID 0xF189.
//! * **DID 0xF15A** (fingerprint, alias 0xF184): writable only in the
//!   Programming session (else 0x7F) with security unlocked (else 0x33);
//!   readable in every session; survives resets (NVM).

use std::time::{Duration, Instant};

use crate::crc::Crc32;
use crate::faults::Fault;
use crate::memory::{MemError, Memory};
use crate::seed::SeedAlgo;

/// Negative response codes used by the simulator.
pub mod nrc {
    pub const SERVICE_NOT_SUPPORTED: u8 = 0x11;
    pub const SUB_FUNCTION_NOT_SUPPORTED: u8 = 0x12;
    pub const INCORRECT_MESSAGE_LENGTH: u8 = 0x13;
    pub const CONDITIONS_NOT_CORRECT: u8 = 0x22;
    pub const REQUEST_SEQUENCE_ERROR: u8 = 0x24;
    pub const REQUEST_OUT_OF_RANGE: u8 = 0x31;
    pub const SECURITY_ACCESS_DENIED: u8 = 0x33;
    pub const INVALID_KEY: u8 = 0x35;
    pub const EXCEEDED_NUMBER_OF_ATTEMPTS: u8 = 0x36;
    pub const REQUIRED_TIME_DELAY_NOT_EXPIRED: u8 = 0x37;
    pub const UPLOAD_DOWNLOAD_NOT_ACCEPTED: u8 = 0x70;
    pub const TRANSFER_DATA_SUSPENDED: u8 = 0x71;
    pub const GENERAL_PROGRAMMING_FAILURE: u8 = 0x72;
    pub const WRONG_BLOCK_SEQUENCE_COUNTER: u8 = 0x73;
    pub const RESPONSE_PENDING: u8 = 0x78;
    pub const SUB_FUNCTION_NOT_SUPPORTED_IN_SESSION: u8 = 0x7E;
    pub const SERVICE_NOT_SUPPORTED_IN_SESSION: u8 = 0x7F;
}

/// NRCs that are never sent for functionally addressed requests.
const FUNCTIONAL_SUPPRESSED_NRCS: [u8; 5] = [0x11, 0x12, 0x31, 0x7E, 0x7F];
/// Services the server accepts on the functional address.
const FUNCTIONAL_SERVICES: [u8; 8] = [0x10, 0x11, 0x3E, 0x22, 0x19, 0x14, 0x28, 0x85];

pub const RID_ERASE_MEMORY: u16 = 0xFF00;
pub const RID_CHECK_DEPENDENCIES: u16 = 0xFF01;
pub const RID_CHECK_INTEGRITY: u16 = 0x0202;
pub const RID_CHECK_PRECONDITIONS: u16 = 0x0203;

pub const DID_ACTIVE_SESSION: u16 = 0xF186;
pub const DID_SPARE_PART: u16 = 0xF187;
pub const DID_SW_VERSION: u16 = 0xF189;
pub const DID_VIN: u16 = 0xF190;
pub const DID_HW_NUMBER: u16 = 0xF191;
pub const DID_FINGERPRINT: u16 = 0xF15A;
pub const DID_FINGERPRINT_ALIAS: u16 = 0xF184;
/// Maximum fingerprint record length accepted by 0x2E F15A / F184.
pub const MAX_FINGERPRINT_LEN: usize = 64;
/// Maximum length of a software-version string read from the image.
const MAX_IMAGE_SW_VERSION_LEN: usize = 32;

/// Status availability mask reported by 0x19.
const DTC_AVAILABILITY_MASK: u8 = 0xFF;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Session {
    Default = 0x01,
    Programming = 0x02,
    Extended = 0x03,
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub regions: Vec<(u32, u32)>,
    /// maxNumberOfBlockLength (includes SID + blockSequenceCounter).
    pub max_block_len: u32,
    pub seed_algo: SeedAlgo,
    pub p2_ms: u16,
    pub p2star_ms: u32,
    pub s3_ms: u64,
    pub allow_direct_programming: bool,
    pub faults: Vec<Fault>,
    pub reboot_ms: u64,
    pub erase_ms: u64,
    pub max_attempts: u8,
    pub lockout_ms: u64,
    /// Security level (requestSeed sub-function) required for erase/download.
    pub download_level: u8,
    /// Silence after a 0x10 0x02 that enters Programming (bootloader jump, ms).
    pub boot_jump_ms: u64,
    /// DID 0xF189 before a successful flash.
    pub sw_version: String,
    /// DID 0xF189 after a successful flash + ECUReset.
    pub new_sw_version: String,
    /// If set, a printable ASCII string (NUL/0xFF terminated, max 32 bytes) at
    /// this address of the flashed image overrides `new_sw_version`.
    pub sw_version_addr: Option<u32>,
    /// DID 0xF191 (ECU hardware number).
    pub hw_number: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            regions: vec![(0x0800_0000, 0x8_0000)],
            max_block_len: 0x402,
            seed_algo: SeedAlgo::XorFf,
            p2_ms: 50,
            p2star_ms: 5000,
            s3_ms: 5000,
            allow_direct_programming: false,
            faults: Vec::new(),
            reboot_ms: 200,
            erase_ms: 250,
            max_attempts: 3,
            lockout_ms: 10_000,
            download_level: 0x11,
            boot_jump_ms: 300,
            sw_version: "SW 1.0.0".into(),
            new_sw_version: "SW 1.1.0".into(),
            sw_version_addr: None,
            hw_number: "HW-NX-01".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Send one response PDU.
    Send(Vec<u8>),
    /// Wait (server busy).
    Delay(Duration),
    /// Simulated ECU reboot: wait, then discard every request queued meanwhile.
    Reboot(Duration),
    /// Bootloader jump after entering the Programming session: same transport
    /// behaviour as [`Step::Reboot`] (silent, queued requests discarded).
    Silence(Duration),
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// Persist the memory image after executing the plan.
    pub write_image: bool,
    /// Human-readable events (session changes, fired faults, …) for logging.
    pub notes: Vec<String>,
}

impl Plan {
    /// All PDUs this plan sends, in order.
    pub fn sent(&self) -> Vec<&[u8]> {
        self.steps
            .iter()
            .filter_map(|s| match s {
                Step::Send(v) => Some(v.as_slice()),
                _ => None,
            })
            .collect()
    }

    /// The last PDU sent (the final response), if any.
    pub fn last_sent(&self) -> Option<&[u8]> {
        self.sent().last().copied()
    }
}

#[derive(Debug)]
enum Resp {
    Pos(Vec<u8>),
    Neg(u8),
    None,
}

#[derive(Debug)]
struct Reply {
    resp: Resp,
    suppress: bool,
    work: Duration,
    reboot: bool,
    silence: Duration,
    write_image: bool,
}

impl Reply {
    fn pos(v: Vec<u8>) -> Self {
        Self {
            resp: Resp::Pos(v),
            suppress: false,
            work: Duration::ZERO,
            reboot: false,
            silence: Duration::ZERO,
            write_image: false,
        }
    }
    fn neg(code: u8) -> Self {
        Self {
            resp: Resp::Neg(code),
            ..Self::pos(Vec::new())
        }
    }
    fn none() -> Self {
        Self {
            resp: Resp::None,
            ..Self::pos(Vec::new())
        }
    }
    fn suppressed(mut self, s: bool) -> Self {
        self.suppress = s;
        self
    }
}

type R = Result<Reply, u8>;

#[derive(Debug, Clone)]
struct Download {
    address: u64,
    total: u64,
    written: u64,
    next_bsc: u8,
    last_bsc: Option<u8>,
    /// Number of new blocks accepted in this download.
    blocks: u32,
}

/// A range completed by 0x37 since its last erase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub address: u64,
    pub len: u64,
    /// Passed a 0x0202 check.
    pub verified: bool,
    /// Failed a 0x0202 check (sticky until the range is erased).
    pub failed: bool,
}

pub struct Server {
    cfg: ServerConfig,
    session: Session,
    s3_deadline: Option<Instant>,
    unlocked: Option<u8>,
    pending_seed: Option<(u8, [u8; 4])>,
    failed_attempts: u8,
    lockout_until: Option<Instant>,
    comm_control: u8,
    dtc_setting_on: bool,
    dtcs: Vec<(u32, u8)>,
    vin: Vec<u8>,
    download: Option<Download>,
    /// Ranges completed by 0x37 since their last erase, in download order.
    segments: Vec<Segment>,
    routine_results: Vec<(u16, Vec<u8>)>,
    fingerprint: Vec<u8>,
    sw_version: Vec<u8>,
    /// Software version armed by a successful 0xFF01, applied on ECUReset.
    pending_sw_version: Option<Vec<u8>>,
    memory: Memory,
    fault_fired: Vec<bool>,
    silent: bool,
    max_block_len: u32,
    erase_time: Duration,
    boot_count: u32,
    notes: Vec<String>,
}

fn be_uint(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, &x| (a << 8) | u64::from(x))
}

fn random_seed() -> [u8; 4] {
    let mut s = [0u8; 4];
    loop {
        if getrandom::fill(&mut s).is_err() {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() ^ (d.as_secs() as u32))
                .unwrap_or(0x1234_5678);
            s = t.to_be_bytes();
        }
        if s != [0; 4] {
            return s;
        }
    }
}

const DEFAULT_DTCS: [(u32, u8); 3] = [(0x01_2345, 0x2F), (0xC0_7300, 0x08), (0x9A_0B01, 0x01)];

impl Server {
    pub fn new(cfg: ServerConfig) -> Self {
        let mut max_block_len = cfg.max_block_len;
        let mut erase_time = Duration::from_millis(cfg.erase_ms);
        for f in &cfg.faults {
            match *f {
                Fault::MaxBlockLen(n) => max_block_len = n,
                Fault::EraseTime(ms) => erase_time = Duration::from_millis(ms),
                _ => {}
            }
        }
        Self {
            memory: Memory::new(&cfg.regions),
            fault_fired: vec![false; cfg.faults.len()],
            session: Session::Default,
            s3_deadline: None,
            unlocked: None,
            pending_seed: None,
            failed_attempts: 0,
            lockout_until: None,
            comm_control: 0,
            dtc_setting_on: true,
            dtcs: DEFAULT_DTCS.to_vec(),
            vin: b"NEXUSCANSIM000001".to_vec(),
            download: None,
            segments: Vec::new(),
            routine_results: Vec::new(),
            fingerprint: vec![0u8; 9],
            sw_version: cfg.sw_version.as_bytes().to_vec(),
            pending_sw_version: None,
            silent: false,
            max_block_len,
            erase_time,
            boot_count: 0,
            notes: Vec::new(),
            cfg,
        }
    }

    pub fn config(&self) -> &ServerConfig {
        &self.cfg
    }
    pub fn session(&self) -> Session {
        self.session
    }
    pub fn unlocked_level(&self) -> Option<u8> {
        self.unlocked
    }
    pub fn memory(&self) -> &Memory {
        &self.memory
    }
    pub fn is_silent(&self) -> bool {
        self.silent
    }
    pub fn boot_count(&self) -> u32 {
        self.boot_count
    }
    pub fn max_block_len(&self) -> u32 {
        self.max_block_len
    }
    pub fn s3_deadline(&self) -> Option<Instant> {
        self.s3_deadline
    }
    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }
    pub fn fingerprint(&self) -> &[u8] {
        &self.fingerprint
    }
    pub fn sw_version(&self) -> &[u8] {
        &self.sw_version
    }

    /// Checks S3; returns notes if the session timed out.
    pub fn tick(&mut self, now: Instant) -> Vec<String> {
        if let Some(d) = self.s3_deadline {
            if now >= d && self.session != Session::Default {
                self.enter_session(Session::Default);
                self.notes
                    .push("S3 timeout: back to Default session, security relocked".into());
            }
        }
        std::mem::take(&mut self.notes)
    }

    /// Restarts S3 after the final response of a request has been sent.
    pub fn response_completed(&mut self, now: Instant) {
        self.s3_deadline = if self.session == Session::Default {
            None
        } else {
            Some(now + Duration::from_millis(self.cfg.s3_ms))
        };
    }

    /// Processes one request PDU.
    pub fn handle(&mut self, req: &[u8], now: Instant, functional: bool) -> Plan {
        let mut plan = Plan::default();
        if self.silent {
            plan.notes
                .push("silent fault active: request ignored".into());
            return plan;
        }
        let Some(&sid) = req.first() else {
            return plan;
        };
        plan.notes.extend(self.tick(now));

        let reply = if let Some(code) = self.take_nrc_fault(sid) {
            Reply::neg(code)
        } else if functional && !FUNCTIONAL_SERVICES.contains(&sid) {
            Reply::neg(nrc::SERVICE_NOT_SUPPORTED)
        } else {
            self.dispatch(req, now).unwrap_or_else(Reply::neg)
        };

        let mut pending_sent = false;
        let pending = vec![0x7F, sid, nrc::RESPONSE_PENDING];
        for f in &self.cfg.faults {
            if let Fault::Slow { sid: s, ms } = *f {
                if s == sid {
                    plan.steps.push(Step::Delay(Duration::from_millis(ms)));
                    plan.notes.push(format!("fault slow: +{ms} ms"));
                }
            }
        }
        let gap = Duration::from_millis(u64::from((self.cfg.p2_ms / 2).clamp(1, 50)));
        for f in &self.cfg.faults {
            if let Fault::Pending78 { sid: s, count } = *f {
                if s == sid && count > 0 {
                    for _ in 0..count {
                        plan.steps.push(Step::Send(pending.clone()));
                        plan.steps.push(Step::Delay(gap));
                    }
                    pending_sent = true;
                    plan.notes.push(format!("fault pending78: {count}x 0x78"));
                }
            }
        }
        if !reply.work.is_zero() {
            // Re-send 0x78 well within P2*server while busy.
            let interval = Duration::from_millis((u64::from(self.cfg.p2star_ms) * 2 / 5).max(10));
            let mut remaining = reply.work;
            plan.steps.push(Step::Send(pending.clone()));
            pending_sent = true;
            while !remaining.is_zero() {
                let d = remaining.min(interval);
                plan.steps.push(Step::Delay(d));
                remaining -= d;
                if !remaining.is_zero() {
                    plan.steps.push(Step::Send(pending.clone()));
                }
            }
        }
        match reply.resp {
            Resp::Pos(v) => {
                // A final response after 0x78 is mandatory even with SPRMIB.
                if !reply.suppress || pending_sent {
                    plan.steps.push(Step::Send(v));
                }
            }
            Resp::Neg(code) => {
                if !(functional && FUNCTIONAL_SUPPRESSED_NRCS.contains(&code)) {
                    plan.steps.push(Step::Send(vec![0x7F, sid, code]));
                }
            }
            Resp::None => {}
        }
        if !reply.silence.is_zero() {
            plan.steps.push(Step::Silence(reply.silence));
        }
        if reply.reboot {
            plan.steps
                .push(Step::Reboot(Duration::from_millis(self.cfg.reboot_ms)));
        }
        plan.write_image = reply.write_image;
        self.response_completed(now);
        plan.notes.append(&mut self.notes);
        plan
    }

    fn take_nrc_fault(&mut self, sid: u8) -> Option<u8> {
        for (i, f) in self.cfg.faults.iter().enumerate() {
            if let Fault::Nrc { sid: s, nrc, once } = *f {
                if s == sid && !(once && self.fault_fired[i]) {
                    self.fault_fired[i] = true;
                    self.notes
                        .push(format!("fault {f}: answering NRC 0x{nrc:02X}"));
                    return Some(nrc);
                }
            }
        }
        None
    }

    /// Fires a one-shot block fault matching `pred` for block `idx`.
    fn take_block_fault(&mut self, idx: u32, pred: impl Fn(&Fault) -> Option<u32>) -> bool {
        for (i, f) in self.cfg.faults.iter().enumerate() {
            if pred(f) == Some(idx) && !self.fault_fired[i] {
                self.fault_fired[i] = true;
                self.notes.push(format!("fault {f} fired at block {idx}"));
                return true;
            }
        }
        false
    }

    fn dispatch(&mut self, req: &[u8], now: Instant) -> R {
        match req[0] {
            0x10 => self.svc_session_control(req),
            0x11 => self.svc_ecu_reset(req),
            0x3E => self.svc_tester_present(req),
            0x27 => self.svc_security_access(req, now),
            0x22 => self.svc_read_did(req),
            0x2E => self.svc_write_did(req),
            0x19 => self.svc_read_dtc(req),
            0x14 => self.svc_clear_dtc(req),
            0x28 => self.svc_communication_control(req),
            0x85 => self.svc_control_dtc_setting(req),
            0x31 => self.svc_routine_control(req),
            0x34 => self.svc_request_download(req),
            0x36 => self.svc_transfer_data(req),
            0x37 => self.svc_transfer_exit(req),
            _ => Err(nrc::SERVICE_NOT_SUPPORTED),
        }
    }

    fn require_session(&self, allowed: &[Session]) -> Result<(), u8> {
        if allowed.contains(&self.session) {
            Ok(())
        } else {
            Err(nrc::SERVICE_NOT_SUPPORTED_IN_SESSION)
        }
    }

    fn relock(&mut self) {
        self.unlocked = None;
        self.pending_seed = None;
    }

    fn enter_session(&mut self, target: Session) {
        if target != self.session {
            self.notes
                .push(format!("session {:?} -> {:?}", self.session, target));
        }
        self.relock();
        if self.download.take().is_some() {
            self.notes
                .push("active download aborted by session change".into());
        }
        if target == Session::Default {
            self.comm_control = 0;
            self.dtc_setting_on = true;
            self.s3_deadline = None;
        }
        self.session = target;
    }

    fn reset_state(&mut self) {
        self.enter_session(Session::Default);
        self.routine_results.clear();
        self.boot_count += 1;
        if let Some(v) = self.pending_sw_version.take() {
            self.notes.push(format!(
                "new software active: F189 {:?} -> {:?}",
                String::from_utf8_lossy(&self.sw_version),
                String::from_utf8_lossy(&v)
            ));
            self.sw_version = v;
        }
        // Attempt counter / lockout survive a reset (anti brute-force).
    }

    // ---------------------------------------------------------------- 0x10
    fn svc_session_control(&mut self, req: &[u8]) -> R {
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        let target = match sub {
            0x01 => Session::Default,
            0x02 => Session::Programming,
            0x03 => Session::Extended,
            _ => return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED),
        };
        if req.len() != 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        if target == Session::Programming
            && self.session == Session::Default
            && !self.cfg.allow_direct_programming
        {
            return Err(nrc::CONDITIONS_NOT_CORRECT);
        }
        let jump = target == Session::Programming && self.session != Session::Programming;
        self.enter_session(target);
        let p2 = self.cfg.p2_ms.to_be_bytes();
        // P2*server_max is encoded in 10 ms units.
        let p2s = u16::try_from(self.cfg.p2star_ms / 10)
            .unwrap_or(u16::MAX)
            .to_be_bytes();
        let mut r = Reply::pos(vec![0x50, sub, p2[0], p2[1], p2s[0], p2s[1]])
            .suppressed(req[1] & 0x80 != 0);
        if jump && self.cfg.boot_jump_ms > 0 {
            r.silence = Duration::from_millis(self.cfg.boot_jump_ms);
            self.notes.push(format!(
                "jump to bootloader: silent for {} ms",
                self.cfg.boot_jump_ms
            ));
        }
        Ok(r)
    }

    // ---------------------------------------------------------------- 0x11
    fn svc_ecu_reset(&mut self, req: &[u8]) -> R {
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        if !matches!(sub, 0x01..=0x03) {
            return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED);
        }
        if req.len() != 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        self.reset_state();
        self.notes.push(format!("ECU reset type 0x{sub:02X}"));
        let mut r = Reply::pos(vec![0x51, sub]).suppressed(req[1] & 0x80 != 0);
        r.reboot = true;
        Ok(r)
    }

    // ---------------------------------------------------------------- 0x3E
    fn svc_tester_present(&mut self, req: &[u8]) -> R {
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        if req[1] & 0x7F != 0 {
            return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED);
        }
        if req.len() != 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        Ok(Reply::pos(vec![0x7E, 0x00]).suppressed(req[1] & 0x80 != 0))
    }

    // ---------------------------------------------------------------- 0x27
    fn svc_security_access(&mut self, req: &[u8], now: Instant) -> R {
        self.require_session(&[Session::Extended, Session::Programming])?;
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        let suppress = req[1] & 0x80 != 0;
        match sub {
            0x01 | 0x02 => {}
            0x11 | 0x12 => {
                if self.session != Session::Programming {
                    return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED_IN_SESSION);
                }
            }
            _ => return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED),
        }
        if let Some(until) = self.lockout_until {
            if now >= until {
                self.lockout_until = None;
            }
        }
        if sub % 2 == 1 {
            // requestSeed
            if req.len() != 2 {
                return Err(nrc::INCORRECT_MESSAGE_LENGTH);
            }
            if self.lockout_until.is_some() {
                return Err(nrc::REQUIRED_TIME_DELAY_NOT_EXPIRED);
            }
            let seed = if self.unlocked == Some(sub) {
                self.pending_seed = None;
                [0u8; 4]
            } else {
                let s = random_seed();
                self.pending_seed = Some((sub, s));
                s
            };
            let mut v = vec![0x67, sub];
            v.extend_from_slice(&seed);
            Ok(Reply::pos(v).suppressed(suppress))
        } else {
            // sendKey
            if req.len() != 2 + 4 {
                return Err(nrc::INCORRECT_MESSAGE_LENGTH);
            }
            if self.lockout_until.is_some() {
                return Err(nrc::REQUIRED_TIME_DELAY_NOT_EXPIRED);
            }
            let level = sub - 1;
            let seed = match self.pending_seed {
                Some((l, s)) if l == level => s,
                _ => return Err(nrc::REQUEST_SEQUENCE_ERROR),
            };
            self.pending_seed = None;
            if req[2..] == self.cfg.seed_algo.key(&seed)[..] {
                self.unlocked = Some(level);
                self.failed_attempts = 0;
                self.notes
                    .push(format!("security level 0x{level:02X} unlocked"));
                Ok(Reply::pos(vec![0x67, sub]).suppressed(suppress))
            } else {
                self.failed_attempts = self.failed_attempts.saturating_add(1);
                if self.failed_attempts >= self.cfg.max_attempts {
                    self.failed_attempts = 0;
                    self.lockout_until = Some(now + Duration::from_millis(self.cfg.lockout_ms));
                    self.notes.push(format!(
                        "invalid key: attempts exceeded, locked out for {} ms",
                        self.cfg.lockout_ms
                    ));
                    Err(nrc::EXCEEDED_NUMBER_OF_ATTEMPTS)
                } else {
                    Err(nrc::INVALID_KEY)
                }
            }
        }
    }

    // ---------------------------------------------------------- 0x22 / 0x2E
    fn did_value(&self, did: u16) -> Option<Vec<u8>> {
        Some(match did {
            DID_ACTIVE_SESSION => vec![self.session as u8],
            DID_SPARE_PART => b"NX-ECU-SIM-0001".to_vec(),
            0xF188 => b"SW-BOOT-1.0.0".to_vec(),
            DID_SW_VERSION => self.sw_version.clone(),
            0xF18C => b"SN0123456789".to_vec(),
            DID_VIN => self.vin.clone(),
            DID_HW_NUMBER => self.cfg.hw_number.as_bytes().to_vec(),
            0xF195 => b"1.0.0".to_vec(),
            DID_FINGERPRINT | DID_FINGERPRINT_ALIAS => self.fingerprint.clone(),
            _ => return None,
        })
    }

    fn svc_read_did(&mut self, req: &[u8]) -> R {
        if req.len() < 3 || !(req.len() - 1).is_multiple_of(2) {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let mut v = vec![0x62];
        let mut any = false;
        for c in req[1..].as_chunks::<2>().0 {
            let did = u16::from_be_bytes(*c);
            if let Some(d) = self.did_value(did) {
                v.extend_from_slice(c);
                v.extend_from_slice(&d);
                any = true;
            }
        }
        if !any {
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        Ok(Reply::pos(v))
    }

    fn svc_write_did(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Extended, Session::Programming])?;
        if req.len() < 4 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let did = u16::from_be_bytes([req[1], req[2]]);
        if matches!(did, DID_FINGERPRINT | DID_FINGERPRINT_ALIAS) {
            return self.write_fingerprint(req);
        }
        if did != DID_VIN {
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        if req.len() != 3 + 17 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        if self.unlocked.is_none() {
            return Err(nrc::SECURITY_ACCESS_DENIED);
        }
        self.vin = req[3..].to_vec();
        self.notes.push("VIN (F190) written".into());
        Ok(Reply::pos(vec![0x6E, req[1], req[2]]))
    }

    /// 0x2E F15A / F184: Programming session only (0x7F), 1..=64 bytes (0x13),
    /// any unlocked level (0x33).
    fn write_fingerprint(&mut self, req: &[u8]) -> R {
        if self.session != Session::Programming {
            return Err(nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        }
        let rec = &req[3..];
        if rec.is_empty() || rec.len() > MAX_FINGERPRINT_LEN {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        if self.unlocked.is_none() {
            return Err(nrc::SECURITY_ACCESS_DENIED);
        }
        self.fingerprint = rec.to_vec();
        let hex: Vec<String> = rec.iter().map(|b| format!("{b:02X}")).collect();
        self.notes.push(format!(
            "fingerprint (0x{:02X}{:02X}) written: {}",
            req[1],
            req[2],
            hex.join(" ")
        ));
        Ok(Reply::pos(vec![0x6E, req[1], req[2]]))
    }

    // ---------------------------------------------------------- 0x19 / 0x14
    fn svc_read_dtc(&mut self, req: &[u8]) -> R {
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        if !matches!(sub, 0x01 | 0x02) {
            return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED);
        }
        if req.len() != 3 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let mask = req[2] & DTC_AVAILABILITY_MASK;
        let matching = self.dtcs.iter().filter(|(_, st)| st & mask != 0);
        if sub == 0x01 {
            let n = u16::try_from(matching.count())
                .unwrap_or(u16::MAX)
                .to_be_bytes();
            // DTCFormatIdentifier 0x01 = ISO 14229-1 DTC format.
            Ok(Reply::pos(vec![
                0x59,
                0x01,
                DTC_AVAILABILITY_MASK,
                0x01,
                n[0],
                n[1],
            ]))
        } else {
            let mut v = vec![0x59, 0x02, DTC_AVAILABILITY_MASK];
            for &(dtc, st) in matching {
                v.extend_from_slice(&dtc.to_be_bytes()[1..]);
                v.push(st);
            }
            Ok(Reply::pos(v))
        }
    }

    fn svc_clear_dtc(&mut self, req: &[u8]) -> R {
        if req.len() != 4 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let group = be_uint(&req[1..4]) as u32;
        if group == 0xFF_FFFF {
            self.dtcs.clear();
        } else if let Some(p) = self.dtcs.iter().position(|(d, _)| *d == group) {
            self.dtcs.remove(p);
        } else {
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        self.notes
            .push(format!("DTCs cleared (group 0x{group:06X})"));
        Ok(Reply::pos(vec![0x54]))
    }

    // ---------------------------------------------------------- 0x28 / 0x85
    fn svc_communication_control(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Extended, Session::Programming])?;
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        if sub > 0x03 {
            return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED);
        }
        if req.len() != 3 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        if !matches!(req[2] & 0x0F, 0x01..=0x03) {
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        self.comm_control = sub;
        Ok(Reply::pos(vec![0x68, sub]).suppressed(req[1] & 0x80 != 0))
    }

    fn svc_control_dtc_setting(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Extended, Session::Programming])?;
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        if !matches!(sub, 0x01 | 0x02) {
            return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED);
        }
        self.dtc_setting_on = sub == 0x01;
        Ok(Reply::pos(vec![0xC5, sub]).suppressed(req[1] & 0x80 != 0))
    }

    // ---------------------------------------------------------------- 0x31
    fn svc_routine_control(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Extended, Session::Programming])?;
        if req.len() < 4 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let sub = req[1] & 0x7F;
        let suppress = req[1] & 0x80 != 0;
        if !matches!(sub, 0x01..=0x03) {
            return Err(nrc::SUB_FUNCTION_NOT_SUPPORTED);
        }
        let rid = u16::from_be_bytes([req[2], req[3]]);
        let supported = match rid {
            // Pre-programming check: application (Extended) and bootloader.
            RID_CHECK_PRECONDITIONS => true,
            RID_ERASE_MEMORY | RID_CHECK_INTEGRITY | RID_CHECK_DEPENDENCIES => {
                self.session == Session::Programming
            }
            _ => false,
        };
        if !supported {
            // Unknown RID, or RID not supported in the active session.
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        let args = &req[4..];
        let head = |r: &[u8]| {
            let mut v = vec![0x71, sub, req[2], req[3]];
            v.extend_from_slice(r);
            v
        };
        match sub {
            0x02 => Err(nrc::SUB_FUNCTION_NOT_SUPPORTED),
            0x03 => {
                if !args.is_empty() {
                    return Err(nrc::INCORRECT_MESSAGE_LENGTH);
                }
                let rec = self
                    .routine_results
                    .iter()
                    .find(|(r, _)| *r == rid)
                    .map(|(_, v)| v.clone())
                    .ok_or(nrc::REQUEST_SEQUENCE_ERROR)?;
                Ok(Reply::pos(head(&rec)).suppressed(suppress))
            }
            _ => {
                let (rec, work) = match rid {
                    RID_ERASE_MEMORY => (self.routine_erase(args)?, self.erase_time),
                    RID_CHECK_INTEGRITY => (self.routine_integrity(args)?, Duration::ZERO),
                    RID_CHECK_PRECONDITIONS => (self.routine_preconditions(args)?, Duration::ZERO),
                    _ => (self.routine_dependencies(args)?, Duration::ZERO),
                };
                self.routine_results.retain(|(r, _)| *r != rid);
                self.routine_results.push((rid, rec.clone()));
                let mut r = Reply::pos(head(&rec)).suppressed(suppress);
                r.work = work;
                Ok(r)
            }
        }
    }

    fn security_ok_for_download(&self) -> bool {
        self.unlocked == Some(self.cfg.download_level)
    }

    /// Parses `ALFID + address + size`; returns (address, size).
    fn parse_alfid_range(args: &[u8]) -> Result<(u64, u64), u8> {
        if args.is_empty() {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let a = usize::from(args[0] & 0x0F);
        let s = usize::from(args[0] >> 4);
        if !(1..=4).contains(&a) || !(1..=4).contains(&s) {
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        if args.len() != 1 + a + s {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        Ok((be_uint(&args[1..1 + a]), be_uint(&args[1 + a..])))
    }

    fn routine_erase(&mut self, args: &[u8]) -> Result<Vec<u8>, u8> {
        let range = if args.is_empty() {
            None
        } else {
            let (addr, len) = Self::parse_alfid_range(args)?;
            if len == 0 || self.memory.locate(addr, len).is_none() {
                return Err(nrc::REQUEST_OUT_OF_RANGE);
            }
            Some((addr, len))
        };
        if !self.security_ok_for_download() {
            return Err(nrc::SECURITY_ACCESS_DENIED);
        }
        if self.download.is_some() {
            return Err(nrc::CONDITIONS_NOT_CORRECT);
        }
        match range {
            Some((addr, len)) => {
                self.memory
                    .erase(addr, len)
                    .map_err(|_| nrc::REQUEST_OUT_OF_RANGE)?;
                let end = addr + len;
                self.segments
                    .retain(|s| s.address + s.len <= addr || s.address >= end);
                self.notes.push(format!(
                    "erase 0x{addr:08X}+0x{len:X} ({:?})",
                    self.erase_time
                ));
            }
            None => {
                self.memory.erase_all();
                self.segments.clear();
                self.notes.push("erase all regions".into());
            }
        }
        self.pending_sw_version = None;
        Ok(vec![0x00])
    }

    /// CRC-32 over all ranges downloaded since their last erase, in download order.
    pub fn programmed_crc(&self) -> u32 {
        let mut c = Crc32::new();
        for s in &self.segments {
            if let Some(d) = self.memory.read(s.address, s.len) {
                c.update(d);
            }
        }
        c.finish()
    }

    /// CRC-32 of one downloaded segment.
    fn segment_crc(&self, s: &Segment) -> u32 {
        let mut c = Crc32::new();
        if let Some(d) = self.memory.read(s.address, s.len) {
            c.update(d);
        }
        c.finish()
    }

    fn routine_preconditions(&mut self, args: &[u8]) -> Result<Vec<u8>, u8> {
        if !args.is_empty() {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let fail = self
            .cfg
            .faults
            .iter()
            .any(|f| matches!(f, Fault::PreconditionFail));
        self.notes.push(format!(
            "checkProgrammingPreconditions -> {}",
            if fail {
                "FAIL (fault precondition-fail)"
            } else {
                "OK"
            }
        ));
        Ok(vec![if fail { 0x01 } else { 0x00 }])
    }

    fn routine_integrity(&mut self, args: &[u8]) -> Result<Vec<u8>, u8> {
        if !(args.is_empty() || args.len() == 4) {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        if self.download.is_some() {
            return Err(nrc::REQUEST_SEQUENCE_ERROR);
        }
        let crc = self.programmed_crc();
        if args.is_empty() {
            for s in &mut self.segments {
                s.verified = true;
            }
            let mut v = vec![0x00];
            v.extend_from_slice(&crc.to_be_bytes());
            return Ok(v);
        }
        let expected = be_uint(args) as u32;
        let crcs: Vec<u32> = self.segments.iter().map(|s| self.segment_crc(s)).collect();
        // 1) most recent segment, 2) any other single segment, 3) whole image.
        let single = crcs.iter().rposition(|&c| c == expected);
        let whole = !crcs.is_empty() && crc == expected;
        let ok = single.is_some() || whole;
        let verdict = match single {
            Some(i) => {
                self.segments[i].verified = true;
                format!("OK (segment #{} of {})", i + 1, crcs.len())
            }
            None if whole => {
                for s in &mut self.segments {
                    s.verified = true;
                }
                "OK (all segments, download order)".to_string()
            }
            None => {
                if let Some(last) = self.segments.last_mut() {
                    last.failed = true;
                }
                "FAIL (most recent segment marked failed)".to_string()
            }
        };
        let last = crcs.last().copied().unwrap_or(0);
        self.notes.push(format!(
            "checkProgrammingIntegrity: expected 0x{expected:08X}, last segment 0x{last:08X}, \
             all 0x{crc:08X} -> {verdict}"
        ));
        Ok(vec![if ok { 0x00 } else { 0x01 }])
    }

    fn routine_dependencies(&mut self, args: &[u8]) -> Result<Vec<u8>, u8> {
        if !args.is_empty() {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let ok = self.download.is_none()
            && !self.segments.is_empty()
            && self.segments.iter().all(|s| s.verified && !s.failed);
        if ok {
            let v = self
                .image_sw_version()
                .unwrap_or_else(|| self.cfg.new_sw_version.as_bytes().to_vec());
            self.notes.push(format!(
                "checkProgrammingDependencies OK: F189 becomes {:?} after ECUReset",
                String::from_utf8_lossy(&v)
            ));
            self.pending_sw_version = Some(v);
        } else {
            let unverified = self
                .segments
                .iter()
                .filter(|s| !s.verified || s.failed)
                .count();
            self.notes.push(format!(
                "checkProgrammingDependencies FAIL: {} segment(s), {unverified} not verified/failed, download active: {}",
                self.segments.len(),
                self.download.is_some()
            ));
            self.pending_sw_version = None;
        }
        Ok(vec![if ok { 0x00 } else { 0x01 }])
    }

    /// Printable ASCII version string at `sw_version_addr` in a programmed range.
    fn image_sw_version(&self) -> Option<Vec<u8>> {
        let addr = u64::from(self.cfg.sw_version_addr?);
        let (ri, off) = self.memory.locate(addr, 1)?;
        let room =
            (self.memory.regions()[ri].len() - off as u64).min(MAX_IMAGE_SW_VERSION_LEN as u64);
        let bytes = self.memory.read(addr, room)?;
        let end = bytes
            .iter()
            .position(|&b| b == 0x00 || b == 0xFF)
            .unwrap_or(bytes.len());
        let v = &bytes[..end];
        (!v.is_empty() && v.iter().all(|b| (0x20..=0x7E).contains(b))).then(|| v.to_vec())
    }

    // ---------------------------------------------------------------- 0x34
    fn svc_request_download(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Programming])?;
        if req.len() < 3 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let dfi = req[1];
        let (addr, len) = Self::parse_alfid_range(&req[2..])?;
        if self.download.is_some() {
            return Err(nrc::CONDITIONS_NOT_CORRECT);
        }
        if dfi != 0x00 {
            // No compression / encryption supported.
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        if len == 0 || self.memory.locate(addr, len).is_none() {
            return Err(nrc::REQUEST_OUT_OF_RANGE);
        }
        if !self.security_ok_for_download() {
            return Err(nrc::SECURITY_ACCESS_DENIED);
        }
        if !self.memory.is_erased(addr, len).unwrap_or(false) {
            return Err(nrc::UPLOAD_DOWNLOAD_NOT_ACCEPTED);
        }
        self.download = Some(Download {
            address: addr,
            total: len,
            written: 0,
            next_bsc: 0x01,
            last_bsc: None,
            blocks: 0,
        });
        self.notes.push(format!(
            "download started 0x{addr:08X}+0x{len:X}, maxNumberOfBlockLength 0x{:X}",
            self.max_block_len
        ));
        let mbl = self.max_block_len;
        let mut v = vec![0x74];
        if mbl <= 0xFFFF {
            v.push(0x20);
            v.extend_from_slice(&(mbl as u16).to_be_bytes());
        } else {
            v.push(0x40);
            v.extend_from_slice(&mbl.to_be_bytes());
        }
        Ok(Reply::pos(v))
    }

    // ---------------------------------------------------------------- 0x36
    fn svc_transfer_data(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Programming])?;
        if req.len() < 2 {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let Some(dl) = self.download.clone() else {
            return Err(nrc::REQUEST_SEQUENCE_ERROR);
        };
        if req.len() as u64 > u64::from(self.max_block_len) {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let bsc = req[1];
        let data = &req[2..];
        if bsc != dl.next_bsc {
            if dl.last_bsc == Some(bsc) {
                self.notes.push(format!(
                    "repeated block counter 0x{bsc:02X}: acknowledged, not rewritten"
                ));
                return Ok(Reply::pos(vec![0x76, bsc]));
            }
            return Err(nrc::WRONG_BLOCK_SEQUENCE_COUNTER);
        }
        if data.is_empty() {
            return Err(nrc::INCORRECT_MESSAGE_LENGTH);
        }
        let idx = dl.blocks + 1;
        if self.take_block_fault(idx, |f| match f {
            Fault::WrongSeqOnce(n) => Some(*n),
            _ => None,
        }) {
            return Err(nrc::WRONG_BLOCK_SEQUENCE_COUNTER);
        }
        if self.take_block_fault(idx, |f| match f {
            Fault::ResetDuringTransfer(n) => Some(*n),
            _ => None,
        }) {
            self.reset_state();
            let mut r = Reply::none();
            r.reboot = true;
            return Ok(r);
        }
        if dl.written + data.len() as u64 > dl.total {
            return Err(nrc::TRANSFER_DATA_SUSPENDED);
        }
        match self.memory.program(dl.address + dl.written, data) {
            Ok(()) => {}
            Err(MemError::NotErased { address }) => {
                self.notes
                    .push(format!("program failure: 0x{address:08X} not erased"));
                return Err(nrc::GENERAL_PROGRAMMING_FAILURE);
            }
            Err(MemError::OutOfRange) => return Err(nrc::GENERAL_PROGRAMMING_FAILURE),
        }
        if let Some(d) = self.download.as_mut() {
            d.written += data.len() as u64;
            d.last_bsc = Some(bsc);
            d.next_bsc = bsc.wrapping_add(1);
            d.blocks = idx;
        }
        if self.take_block_fault(idx, |f| match f {
            Fault::DropResponseOnce(n) => Some(*n),
            _ => None,
        }) {
            return Ok(Reply::none());
        }
        if self
            .cfg
            .faults
            .iter()
            .any(|f| matches!(f, Fault::SilentAfterBlock(n) if *n == idx))
        {
            self.silent = true;
            self.notes
                .push(format!("fault silent-after-block:{idx}: going silent"));
        }
        Ok(Reply::pos(vec![0x76, bsc]))
    }

    // ---------------------------------------------------------------- 0x37
    fn svc_transfer_exit(&mut self, req: &[u8]) -> R {
        self.require_session(&[Session::Programming])?;
        let Some(dl) = self.download.clone() else {
            return Err(nrc::REQUEST_SEQUENCE_ERROR);
        };
        let _ = req; // transferRequestParameterRecord is accepted and ignored
        if dl.written != dl.total {
            // Programming not completed: keep the download active so the
            // client can continue with the outstanding blocks.
            self.notes.push(format!(
                "transfer exit rejected: {} of {} bytes received",
                dl.written, dl.total
            ));
            return Err(nrc::REQUEST_SEQUENCE_ERROR);
        }
        self.download = None;
        self.segments.push(Segment {
            address: dl.address,
            len: dl.total,
            verified: false,
            failed: false,
        });
        self.notes.push(format!(
            "download complete 0x{:08X}+0x{:X} in {} blocks",
            dl.address, dl.total, dl.blocks
        ));
        let mut r = Reply::pos(vec![0x77]);
        r.write_image = true;
        Ok(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGION: (u32, u32) = (0x0800_0000, 0x8_0000);

    fn srv(faults: &[&str]) -> Server {
        Server::new(ServerConfig {
            regions: vec![REGION],
            erase_ms: 0,
            reboot_ms: 0,
            faults: faults.iter().map(|f| f.parse().unwrap()).collect(),
            ..ServerConfig::default()
        })
    }

    struct T {
        s: Server,
        now: Instant,
    }

    impl T {
        fn new(faults: &[&str]) -> Self {
            Self {
                s: srv(faults),
                now: Instant::now(),
            }
        }
        fn plan(&mut self, req: &[u8]) -> Plan {
            self.s.handle(req, self.now, false)
        }
        /// Final response (panics if none).
        fn rq(&mut self, req: &[u8]) -> Vec<u8> {
            let p = self.plan(req);
            p.last_sent()
                .unwrap_or_else(|| panic!("no response to {req:02X?}"))
                .to_vec()
        }
        fn nrc(&mut self, req: &[u8]) -> u8 {
            let r = self.rq(req);
            assert_eq!(r.len(), 3, "expected NRC for {req:02X?}, got {r:02X?}");
            assert_eq!(&r[..2], &[0x7F, req[0]]);
            r[2]
        }
        fn unlock(&mut self, level: u8) {
            let r = self.rq(&[0x27, level]);
            assert_eq!(&r[..2], &[0x67, level]);
            let key = SeedAlgo::XorFf.key(&r[2..]);
            let mut k = vec![0x27, level + 1];
            k.extend_from_slice(&key);
            assert_eq!(self.rq(&k), vec![0x67, level + 1]);
        }
        fn enter_programming_unlocked(&mut self) {
            assert_eq!(self.rq(&[0x10, 0x03])[..2], [0x50, 0x03]);
            assert_eq!(self.rq(&[0x10, 0x02])[..2], [0x50, 0x02]);
            self.unlock(0x11);
        }
        fn erase(&mut self, addr: u32, len: u32) -> Vec<u8> {
            let mut r = vec![0x31, 0x01, 0xFF, 0x00, 0x44];
            r.extend_from_slice(&addr.to_be_bytes());
            r.extend_from_slice(&len.to_be_bytes());
            self.rq(&r)
        }
        fn req_download(&mut self, addr: u32, len: u32) -> Vec<u8> {
            let mut r = vec![0x34, 0x00, 0x44];
            r.extend_from_slice(&addr.to_be_bytes());
            r.extend_from_slice(&len.to_be_bytes());
            self.rq(&r)
        }
        fn block(&mut self, bsc: u8, data: &[u8]) -> Plan {
            let mut r = vec![0x36, bsc];
            r.extend_from_slice(data);
            self.plan(&r)
        }
        /// Functionally addressed request.
        fn fplan(&mut self, req: &[u8]) -> Plan {
            self.s.handle(req, self.now, true)
        }
        /// RequestDownload + TransferData (16-byte blocks) + TransferExit.
        fn download(&mut self, addr: u32, data: &[u8]) {
            assert_eq!(self.req_download(addr, data.len() as u32)[0], 0x74);
            for (i, c) in data.chunks(16).enumerate() {
                let bsc = (i + 1) as u8;
                assert_eq!(self.block(bsc, c).last_sent().unwrap(), &[0x76, bsc]);
            }
            assert_eq!(self.rq(&[0x37]), vec![0x77]);
        }
        fn check_crc(&mut self, crc: u32) -> u8 {
            let mut r = vec![0x31, 0x01, 0x02, 0x02];
            r.extend_from_slice(&crc.to_be_bytes());
            let a = self.rq(&r);
            assert_eq!(&a[..4], &[0x71, 0x01, 0x02, 0x02], "{a:02X?}");
            a[4]
        }
        fn dependencies(&mut self) -> u8 {
            let a = self.rq(&[0x31, 0x01, 0xFF, 0x01]);
            assert_eq!(&a[..4], &[0x71, 0x01, 0xFF, 0x01], "{a:02X?}");
            a[4]
        }
        fn read_did(&mut self, did: u16) -> Vec<u8> {
            let d = did.to_be_bytes();
            let r = self.rq(&[0x22, d[0], d[1]]);
            assert_eq!(&r[..3], &[0x62, d[0], d[1]], "{r:02X?}");
            r[3..].to_vec()
        }
    }

    fn pattern(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 13 + (i >> 8) * 7) as u8).collect()
    }

    // ------------------------------------------------------------ sessions
    #[test]
    fn session_control_and_timing_encoding() {
        let mut t = T::new(&[]);
        // P2 = 50 ms -> 0x0032; P2* = 5000 ms -> 500 x 10 ms = 0x01F4
        assert_eq!(
            t.rq(&[0x10, 0x03]),
            vec![0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]
        );
        assert_eq!(t.s.session(), Session::Extended);
        assert_eq!(t.nrc(&[0x10, 0x04]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
        assert_eq!(t.nrc(&[0x10]), nrc::INCORRECT_MESSAGE_LENGTH);
        assert_eq!(t.nrc(&[0x10, 0x03, 0x00]), nrc::INCORRECT_MESSAGE_LENGTH);
        // suppressPosRsp
        assert!(t.plan(&[0x10, 0x83]).last_sent().is_none());
    }

    #[test]
    fn programming_only_from_extended() {
        let mut t = T::new(&[]);
        assert_eq!(t.nrc(&[0x10, 0x02]), nrc::CONDITIONS_NOT_CORRECT);
        t.rq(&[0x10, 0x03]);
        assert_eq!(t.rq(&[0x10, 0x02])[1], 0x02);
        let mut d = Server::new(ServerConfig {
            allow_direct_programming: true,
            ..ServerConfig::default()
        });
        let p = d.handle(&[0x10, 0x02], Instant::now(), false);
        assert_eq!(p.last_sent().unwrap()[0], 0x50);
    }

    #[test]
    fn s3_timeout_returns_to_default_and_relocks() {
        let mut t = T::new(&[]);
        t.enter_programming_unlocked();
        assert_eq!(t.s.unlocked_level(), Some(0x11));
        // Tester present keeps the session alive.
        t.now += Duration::from_millis(4000);
        t.rq(&[0x3E, 0x00]);
        t.now += Duration::from_millis(4000);
        t.s.tick(t.now);
        assert_eq!(t.s.session(), Session::Programming);
        t.now += Duration::from_millis(1001);
        let notes = t.s.tick(t.now);
        assert!(notes.iter().any(|n| n.contains("S3")));
        assert_eq!(t.s.session(), Session::Default);
        assert_eq!(t.s.unlocked_level(), None);
    }

    #[test]
    fn tester_present() {
        let mut t = T::new(&[]);
        assert_eq!(t.rq(&[0x3E, 0x00]), vec![0x7E, 0x00]);
        assert!(t.plan(&[0x3E, 0x80]).steps.is_empty());
        assert_eq!(t.nrc(&[0x3E, 0x01]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
        assert_eq!(t.nrc(&[0x3E, 0x00, 0x00]), nrc::INCORRECT_MESSAGE_LENGTH);
        assert_eq!(t.nrc(&[0xBA]), nrc::SERVICE_NOT_SUPPORTED);
    }

    #[test]
    fn ecu_reset_reboots_and_resets_state() {
        let mut t = T::new(&[]);
        t.enter_programming_unlocked();
        let p = t.plan(&[0x11, 0x01]);
        assert_eq!(p.steps[0], Step::Send(vec![0x51, 0x01]));
        assert!(matches!(p.steps[1], Step::Reboot(_)));
        assert_eq!(t.s.session(), Session::Default);
        assert_eq!(t.s.unlocked_level(), None);
        assert_eq!(t.s.boot_count(), 1);
        let p = t.plan(&[0x11, 0x83]);
        assert_eq!(p.steps.len(), 1, "suppressed soft reset still reboots");
        assert_eq!(t.nrc(&[0x11, 0x05]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
    }

    // ------------------------------------------------------------ security
    #[test]
    fn security_access_flow() {
        let mut t = T::new(&[]);
        assert_eq!(t.nrc(&[0x27, 0x01]), nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        t.rq(&[0x10, 0x03]);
        assert_eq!(
            t.nrc(&[0x27, 0x11]),
            nrc::SUB_FUNCTION_NOT_SUPPORTED_IN_SESSION
        );
        assert_eq!(t.nrc(&[0x27, 0x05]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
        assert_eq!(
            t.nrc(&[0x27, 0x02, 1, 2, 3, 4]),
            nrc::REQUEST_SEQUENCE_ERROR
        );
        t.unlock(0x01);
        // Zero seed when already unlocked.
        assert_eq!(t.rq(&[0x27, 0x01]), vec![0x67, 0x01, 0, 0, 0, 0]);
        assert_eq!(
            t.nrc(&[0x27, 0x02, 0, 0, 0, 0]),
            nrc::REQUEST_SEQUENCE_ERROR
        );
        // Session change relocks.
        t.rq(&[0x10, 0x02]);
        assert_eq!(t.s.unlocked_level(), None);
        t.unlock(0x11);
        assert_eq!(t.s.unlocked_level(), Some(0x11));
    }

    #[test]
    fn xor_const_seed_algo_unlocks() {
        let mut s = Server::new(ServerConfig {
            seed_algo: "xor_const:5A3C1E8F".parse().unwrap(),
            ..ServerConfig::default()
        });
        let now = Instant::now();
        s.handle(&[0x10, 0x03], now, false);
        let p = s.handle(&[0x27, 0x01], now, false);
        let seed = p.last_sent().unwrap()[2..].to_vec();
        let c = 0x5A3C_1E8Fu32.to_be_bytes();
        let mut req = vec![0x27, 0x02];
        req.extend(seed.iter().enumerate().map(|(i, b)| b ^ c[i % 4]));
        assert_eq!(
            s.handle(&req, now, false).last_sent().unwrap(),
            &[0x67, 0x02]
        );
    }

    #[test]
    fn invalid_key_attempts_and_lockout() {
        let mut t = T::new(&[]);
        t.rq(&[0x10, 0x03]);
        for expected in [
            nrc::INVALID_KEY,
            nrc::INVALID_KEY,
            nrc::EXCEEDED_NUMBER_OF_ATTEMPTS,
        ] {
            let r = t.rq(&[0x27, 0x01]);
            let mut bad = SeedAlgo::XorFf.key(&r[2..]);
            bad[0] ^= 0x01;
            let mut k = vec![0x27, 0x02];
            k.extend_from_slice(&bad);
            assert_eq!(t.nrc(&k), expected);
        }
        assert_eq!(t.nrc(&[0x27, 0x01]), nrc::REQUIRED_TIME_DELAY_NOT_EXPIRED);
        // The lockout outlives S3 (session drops to Default) and session changes.
        t.now += Duration::from_millis(9_999);
        t.rq(&[0x10, 0x03]);
        assert_eq!(t.nrc(&[0x27, 0x01]), nrc::REQUIRED_TIME_DELAY_NOT_EXPIRED);
        t.now += Duration::from_millis(2);
        t.unlock(0x01);
        // Wrong key length.
        t.rq(&[0x10, 0x03]);
        t.rq(&[0x27, 0x01]);
        assert_eq!(t.nrc(&[0x27, 0x02, 1, 2, 3]), nrc::INCORRECT_MESSAGE_LENGTH);
    }

    // ------------------------------------------------------------ DIDs / DTCs
    #[test]
    fn read_and_write_dids() {
        let mut t = T::new(&[]);
        let r = t.rq(&[0x22, 0xF1, 0x90]);
        assert_eq!(&r[..3], &[0x62, 0xF1, 0x90]);
        assert_eq!(&r[3..], b"NEXUSCANSIM000001");
        let r = t.rq(&[0x22, 0xF1, 0x95, 0x12, 0x34, 0xF1, 0x87]);
        assert_eq!(
            r,
            [
                &[0x62, 0xF1, 0x95][..],
                b"1.0.0",
                &[0xF1, 0x87],
                b"NX-ECU-SIM-0001"
            ]
            .concat()
        );
        for did in [[0xF1, 0x88], [0xF1, 0x8C]] {
            assert_eq!(&t.rq(&[0x22, did[0], did[1]])[..3], &[0x62, did[0], did[1]]);
        }
        assert_eq!(t.nrc(&[0x22, 0x12, 0x34]), nrc::REQUEST_OUT_OF_RANGE);
        assert_eq!(t.nrc(&[0x22, 0xF1]), nrc::INCORRECT_MESSAGE_LENGTH);

        let mut w = vec![0x2E, 0xF1, 0x90];
        w.extend_from_slice(b"WVWZZZ1JZXW000001");
        assert_eq!(t.nrc(&w), nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        t.rq(&[0x10, 0x03]);
        assert_eq!(t.nrc(&w), nrc::SECURITY_ACCESS_DENIED);
        assert_eq!(t.nrc(&w[..10]), nrc::INCORRECT_MESSAGE_LENGTH);
        assert_eq!(t.nrc(&[0x2E, 0xF1, 0x87, 0x00]), nrc::REQUEST_OUT_OF_RANGE);
        t.unlock(0x01);
        assert_eq!(t.rq(&w), vec![0x6E, 0xF1, 0x90]);
        assert_eq!(&t.rq(&[0x22, 0xF1, 0x90])[3..], b"WVWZZZ1JZXW000001");
    }

    #[test]
    fn dtc_read_and_clear() {
        let mut t = T::new(&[]);
        assert_eq!(
            t.rq(&[0x19, 0x01, 0xFF]),
            vec![0x59, 0x01, 0xFF, 0x01, 0x00, 0x03]
        );
        assert_eq!(
            t.rq(&[0x19, 0x01, 0x08]),
            vec![0x59, 0x01, 0xFF, 0x01, 0x00, 0x02]
        );
        assert_eq!(
            t.rq(&[0x19, 0x02, 0x01]),
            vec![0x59, 0x02, 0xFF, 0x01, 0x23, 0x45, 0x2F, 0x9A, 0x0B, 0x01, 0x01]
        );
        assert_eq!(t.nrc(&[0x19, 0x0A, 0xFF]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
        assert_eq!(t.nrc(&[0x19, 0x02]), nrc::INCORRECT_MESSAGE_LENGTH);
        assert_eq!(t.nrc(&[0x14, 0x12, 0x34, 0x56]), nrc::REQUEST_OUT_OF_RANGE);
        assert_eq!(t.rq(&[0x14, 0xC0, 0x73, 0x00]), vec![0x54]);
        assert_eq!(t.rq(&[0x14, 0xFF, 0xFF, 0xFF]), vec![0x54]);
        assert_eq!(t.rq(&[0x19, 0x02, 0xFF]), vec![0x59, 0x02, 0xFF]);
        assert_eq!(t.nrc(&[0x14, 0xFF, 0xFF]), nrc::INCORRECT_MESSAGE_LENGTH);
    }

    #[test]
    fn comm_control_and_dtc_setting_need_extended() {
        let mut t = T::new(&[]);
        assert_eq!(
            t.nrc(&[0x28, 0x03, 0x01]),
            nrc::SERVICE_NOT_SUPPORTED_IN_SESSION
        );
        assert_eq!(t.nrc(&[0x85, 0x02]), nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        t.rq(&[0x10, 0x03]);
        assert_eq!(t.rq(&[0x28, 0x03, 0x01]), vec![0x68, 0x03]);
        assert!(t.plan(&[0x28, 0x80, 0x01]).steps.is_empty());
        assert_eq!(t.nrc(&[0x28, 0x03, 0x00]), nrc::REQUEST_OUT_OF_RANGE);
        assert_eq!(t.nrc(&[0x28, 0x05, 0x01]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
        assert_eq!(t.rq(&[0x85, 0x02]), vec![0xC5, 0x02]);
        assert_eq!(t.nrc(&[0x85, 0x03]), nrc::SUB_FUNCTION_NOT_SUPPORTED);
    }

    #[test]
    fn functional_addressing_suppresses_nrcs() {
        let mut t = T::new(&[]);
        let now = t.now;
        let p = t.s.handle(&[0x3E, 0x00], now, true);
        assert_eq!(p.last_sent(), Some(&[0x7E, 0x00][..]));
        assert!(t.s.handle(&[0x3E, 0x80], now, true).steps.is_empty());
        // 0x7F / 0x11 / 0x31 suppressed for functional requests.
        assert!(t.s.handle(&[0x28, 0x03, 0x01], now, true).steps.is_empty());
        assert!(t.s.handle(&[0x34, 0x00, 0x44], now, true).steps.is_empty());
        assert!(t.s.handle(&[0x22, 0x12, 0x34], now, true).steps.is_empty());
        // 0x13 is not suppressed.
        assert_eq!(
            t.s.handle(&[0x3E], now, true).last_sent(),
            Some(&[0x7F, 0x3E, 0x13][..])
        );
        assert_eq!(
            t.s.handle(&[0x10, 0x03], now, true).last_sent().unwrap()[0],
            0x50
        );
    }

    // ------------------------------------------------------------ programming
    #[test]
    fn erase_requires_programming_and_security_and_sends_pending() {
        let mut t = T::new(&["erase-time:300"]);
        assert_eq!(
            t.nrc(&[0x31, 0x01, 0xFF, 0x00]),
            nrc::SERVICE_NOT_SUPPORTED_IN_SESSION
        );
        t.rq(&[0x10, 0x03]);
        assert_eq!(t.nrc(&[0x31, 0x01, 0xFF, 0x00]), nrc::REQUEST_OUT_OF_RANGE);
        t.rq(&[0x10, 0x02]);
        assert_eq!(
            t.erase(REGION.0, 0x1000),
            vec![0x7F, 0x31, nrc::SECURITY_ACCESS_DENIED]
        );
        t.unlock(0x11);
        assert_eq!(t.nrc(&[0x31, 0x01, 0x12, 0x34]), nrc::REQUEST_OUT_OF_RANGE);
        assert_eq!(
            t.nrc(&[0x31, 0x04, 0xFF, 0x00]),
            nrc::SUB_FUNCTION_NOT_SUPPORTED
        );
        assert_eq!(
            t.nrc(&[0x31, 0x03, 0xFF, 0x00]),
            nrc::REQUEST_SEQUENCE_ERROR
        );
        assert_eq!(
            t.nrc(&[0x31, 0x01, 0xFF, 0x00, 0x05, 0, 0]),
            nrc::REQUEST_OUT_OF_RANGE
        );
        assert_eq!(
            t.nrc(&[0x31, 0x01, 0xFF, 0x00, 0x44, 0, 0]),
            nrc::INCORRECT_MESSAGE_LENGTH
        );
        assert_eq!(
            t.erase(0x0700_0000, 0x10),
            vec![0x7F, 0x31, nrc::REQUEST_OUT_OF_RANGE]
        );
        assert_eq!(
            t.erase(REGION.0, REGION.1 + 1),
            vec![0x7F, 0x31, nrc::REQUEST_OUT_OF_RANGE]
        );

        let mut r = vec![0x31, 0x01, 0xFF, 0x00, 0x44];
        r.extend_from_slice(&REGION.0.to_be_bytes());
        r.extend_from_slice(&0x1000u32.to_be_bytes());
        let p = t.plan(&r);
        assert_eq!(
            p.steps,
            vec![
                Step::Send(vec![0x7F, 0x31, 0x78]),
                Step::Delay(Duration::from_millis(300)),
                Step::Send(vec![0x71, 0x01, 0xFF, 0x00, 0x00]),
            ]
        );
        assert!(t.s.memory().is_erased(u64::from(REGION.0), 0x1000).unwrap());
        assert_eq!(
            t.rq(&[0x31, 0x03, 0xFF, 0x00]),
            vec![0x71, 0x03, 0xFF, 0x00, 0x00]
        );
        // Even with suppressPosRsp the final response follows a 0x78.
        r[1] = 0x81;
        assert_eq!(
            t.plan(&r).last_sent().unwrap(),
            &[0x71, 0x01, 0xFF, 0x00, 0x00]
        );
    }

    #[test]
    fn long_erase_repeats_pending_within_p2star() {
        let mut t = T::new(&["erase-time:5000"]);
        t.enter_programming_unlocked();
        let p = t.plan(&[0x31, 0x01, 0xFF, 0x00]);
        let pendings = p
            .sent()
            .iter()
            .filter(|s| **s == [0x7F, 0x31, 0x78])
            .count();
        // interval = 2000 ms -> 0x78 at t=0, 2000, 4000
        assert_eq!(pendings, 3);
        let total: Duration = p
            .steps
            .iter()
            .filter_map(|s| match s {
                Step::Delay(d) => Some(*d),
                _ => None,
            })
            .sum();
        assert_eq!(total, Duration::from_millis(5000));
    }

    #[test]
    fn request_download_validation() {
        let mut t = T::new(&[]);
        assert_eq!(t.req_download(REGION.0, 0x100), vec![0x7F, 0x34, 0x7F]);
        t.rq(&[0x10, 0x03]);
        t.rq(&[0x10, 0x02]);
        assert_eq!(
            t.req_download(REGION.0, 0x100),
            vec![0x7F, 0x34, nrc::SECURITY_ACCESS_DENIED]
        );
        t.unlock(0x11);
        assert_eq!(
            t.req_download(REGION.0, 0x100),
            vec![0x7F, 0x34, nrc::UPLOAD_DOWNLOAD_NOT_ACCEPTED]
        );
        t.erase(REGION.0, 0x1000);
        assert_eq!(t.nrc(&[0x34, 0x00, 0x05, 1, 2]), nrc::REQUEST_OUT_OF_RANGE);
        assert_eq!(
            t.nrc(&[0x34, 0x00, 0x44, 1, 2]),
            nrc::INCORRECT_MESSAGE_LENGTH
        );
        assert_eq!(t.nrc(&[0x34, 0x00]), nrc::INCORRECT_MESSAGE_LENGTH);
        assert_eq!(
            t.nrc(&[0x34, 0x11, 0x44, 8, 0, 0, 0, 0, 0, 1, 0]),
            nrc::REQUEST_OUT_OF_RANGE
        );
        assert_eq!(
            t.req_download(REGION.0, 0),
            vec![0x7F, 0x34, nrc::REQUEST_OUT_OF_RANGE]
        );
        assert_eq!(
            t.req_download(REGION.0 + REGION.1 - 4, 8),
            vec![0x7F, 0x34, nrc::REQUEST_OUT_OF_RANGE]
        );
        assert_eq!(
            t.req_download(REGION.0, 0x1001),
            vec![0x7F, 0x34, nrc::UPLOAD_DOWNLOAD_NOT_ACCEPTED]
        );
        assert_eq!(
            t.req_download(REGION.0, 0x1000),
            vec![0x74, 0x20, 0x04, 0x02]
        );
        assert_eq!(
            t.req_download(REGION.0, 0x1000),
            vec![0x7F, 0x34, nrc::CONDITIONS_NOT_CORRECT]
        );
        // 4-byte address / 2-byte size: ALFID 0x24
        let mut t2 = T::new(&[]);
        t2.enter_programming_unlocked();
        t2.rq(&[0x31, 0x01, 0xFF, 0x00]);
        assert_eq!(
            t2.rq(&[0x34, 0x00, 0x24, 0x08, 0x00, 0x00, 0x10, 0x01, 0x00])[0],
            0x74
        );
    }

    /// Full download with > 256 blocks: counter wrap 0xFF -> 0x00, repeated
    /// block acknowledgement, error NRCs, transfer exit and CRC check.
    #[test]
    fn full_download_with_counter_wrap() {
        let mut t = T::new(&[]);
        t.enter_programming_unlocked();
        let data = pattern(300 * 16);
        let base = REGION.0;
        assert_eq!(t.erase(base, 0x2000)[0], 0x71);
        assert_eq!(t.nrc(&[0x36, 0x01, 0xAA]), nrc::REQUEST_SEQUENCE_ERROR);
        assert_eq!(t.nrc(&[0x37]), nrc::REQUEST_SEQUENCE_ERROR);
        assert_eq!(t.req_download(base, data.len() as u32)[0], 0x74);
        assert_eq!(
            t.nrc(&[0x36, 0x02, 0xAA]),
            nrc::WRONG_BLOCK_SEQUENCE_COUNTER
        );
        assert_eq!(t.nrc(&[0x36, 0x01]), nrc::INCORRECT_MESSAGE_LENGTH);
        let too_long = vec![0u8; 0x402 - 1];
        assert_eq!(
            t.block(0x01, &too_long).last_sent().unwrap(),
            &[0x7F, 0x36, 0x13]
        );
        let mut bsc: u8 = 1;
        let mut wrapped = false;
        for (i, chunk) in data.chunks(16).enumerate() {
            assert_eq!(
                t.block(bsc, chunk).last_sent().unwrap(),
                &[0x76, bsc],
                "block {i}"
            );
            if i == 10 {
                // Repeat: acknowledged, memory unchanged.
                let mut evil = chunk.to_vec();
                evil[0] ^= 0xFF;
                assert_eq!(t.block(bsc, &evil).last_sent().unwrap(), &[0x76, bsc]);
                assert_eq!(t.nrc(&[0x37]), nrc::REQUEST_SEQUENCE_ERROR);
            }
            if bsc == 0xFF {
                wrapped = true;
            }
            bsc = bsc.wrapping_add(1);
        }
        assert!(wrapped);
        assert_eq!(bsc, ((300 + 1) % 256) as u8);
        // Data beyond the requested length.
        assert_eq!(
            t.block(bsc, &[1]).last_sent().unwrap(),
            &[0x7F, 0x36, nrc::TRANSFER_DATA_SUSPENDED]
        );
        let p = t.plan(&[0x37]);
        assert_eq!(p.last_sent().unwrap(), &[0x77]);
        assert!(p.write_image);
        assert_eq!(
            t.s.memory()
                .read(u64::from(base), data.len() as u64)
                .unwrap(),
            &data[..]
        );
        assert_eq!(t.nrc(&[0x36, bsc, 0]), nrc::REQUEST_SEQUENCE_ERROR);

        let crc = crate::crc::crc32(&data);
        let mut r = vec![0x31, 0x01, 0x02, 0x02];
        r.extend_from_slice(&crc.to_be_bytes());
        assert_eq!(t.rq(&r), vec![0x71, 0x01, 0x02, 0x02, 0x00]);
        assert_eq!(
            t.rq(&[0x31, 0x01, 0xFF, 0x01]),
            vec![0x71, 0x01, 0xFF, 0x01, 0x00]
        );
        let mut no_arg = vec![0x71, 0x01, 0x02, 0x02, 0x00];
        no_arg.extend_from_slice(&crc.to_be_bytes());
        assert_eq!(t.rq(&[0x31, 0x01, 0x02, 0x02]), no_arg);
        r[7] ^= 1;
        assert_eq!(t.rq(&r), vec![0x71, 0x01, 0x02, 0x02, 0x01]);
        assert_eq!(
            t.rq(&[0x31, 0x01, 0xFF, 0x01]),
            vec![0x71, 0x01, 0xFF, 0x01, 0x01]
        );
        assert_eq!(
            t.rq(&[0x31, 0x03, 0x02, 0x02]),
            vec![0x71, 0x03, 0x02, 0x02, 0x01]
        );
        assert_eq!(
            t.nrc(&[0x31, 0x01, 0x02, 0x02, 0x00]),
            nrc::INCORRECT_MESSAGE_LENGTH
        );

        // Second download over programmed (non-erased) memory -> 0x70.
        assert_eq!(
            t.req_download(base, 16),
            vec![0x7F, 0x34, nrc::UPLOAD_DOWNLOAD_NOT_ACCEPTED]
        );
    }

    #[test]
    fn programming_non_erased_byte_is_0x72() {
        let mut t = T::new(&[]);
        t.enter_programming_unlocked();
        t.erase(REGION.0, 0x100);
        assert_eq!(t.req_download(REGION.0, 0x10)[0], 0x74);
        t.block(1, &[0; 0x10]);
        t.rq(&[0x37]);
        // Erase only a sub-range then download overlapping into programmed bytes:
        // the download check catches it first (0x70); simulate via a region that
        // is erased at 0x34 time but programmed meanwhile is impossible, so check
        // the memory layer directly.
        let mut m = t.s.memory().clone();
        assert!(m.program(u64::from(REGION.0), &[1]).is_err());
    }

    #[test]
    fn session_change_aborts_download() {
        let mut t = T::new(&[]);
        t.enter_programming_unlocked();
        t.erase(REGION.0, 0x100);
        t.req_download(REGION.0, 0x20);
        t.rq(&[0x10, 0x03]);
        t.rq(&[0x10, 0x02]);
        t.unlock(0x11);
        assert_eq!(t.nrc(&[0x36, 0x01, 0x00]), nrc::REQUEST_SEQUENCE_ERROR);
    }

    // ------------------------------------------------------------ faults
    #[test]
    fn fault_pending78() {
        let mut t = T::new(&["pending78:0x3E:3"]);
        let p = t.plan(&[0x3E, 0x00]);
        let sent = p.sent();
        assert_eq!(sent.len(), 4);
        assert!(sent[..3].iter().all(|s| *s == [0x7F, 0x3E, 0x78]));
        assert_eq!(sent[3], &[0x7E, 0x00]);
        // With SPRMIB the final response is still sent after 0x78s.
        assert_eq!(t.plan(&[0x3E, 0x80]).last_sent().unwrap(), &[0x7E, 0x00]);
        // Other services unaffected.
        assert_eq!(t.plan(&[0x22, 0xF1, 0x90]).sent().len(), 1);
    }

    #[test]
    fn fault_slow() {
        let mut t = T::new(&["slow:0x22:120"]);
        let p = t.plan(&[0x22, 0xF1, 0x95]);
        assert_eq!(p.steps[0], Step::Delay(Duration::from_millis(120)));
        assert_eq!(p.sent().len(), 1);
        assert!(!t
            .plan(&[0x3E, 0x00])
            .steps
            .iter()
            .any(|s| matches!(s, Step::Delay(_))));
    }

    #[test]
    fn fault_nrc_once_and_always() {
        let mut t = T::new(&["nrc:0x22:0x22:once", "nrc:3E:0x21:always"]);
        assert_eq!(t.nrc(&[0x22, 0xF1, 0x90]), 0x22);
        assert_eq!(t.rq(&[0x22, 0xF1, 0x95])[0], 0x62);
        for _ in 0..3 {
            assert_eq!(t.nrc(&[0x3E, 0x00]), 0x21);
        }
    }

    fn start_download(faults: &[&str], len: u32) -> T {
        let mut t = T::new(faults);
        t.enter_programming_unlocked();
        assert_eq!(t.erase(REGION.0, 0x1000)[0], 0x71);
        assert_eq!(t.req_download(REGION.0, len)[0], 0x74);
        t
    }

    #[test]
    fn fault_silent_after_block() {
        let mut t = start_download(&["silent-after-block:2"], 64);
        assert_eq!(t.block(1, &[1; 16]).last_sent().unwrap(), &[0x76, 1]);
        assert_eq!(t.block(2, &[2; 16]).last_sent().unwrap(), &[0x76, 2]);
        assert!(t.s.is_silent());
        assert!(t.block(3, &[3; 16]).steps.is_empty());
        assert!(t.plan(&[0x3E, 0x00]).steps.is_empty());
        assert!(t.plan(&[0x11, 0x01]).steps.is_empty());
    }

    #[test]
    fn fault_wrong_seq_once() {
        let mut t = start_download(&["wrong-seq-once:2"], 48);
        assert_eq!(t.block(1, &[1; 16]).last_sent().unwrap(), &[0x76, 1]);
        assert_eq!(
            t.block(2, &[2; 16]).last_sent().unwrap(),
            &[0x7F, 0x36, 0x73]
        );
        // Not written; resend succeeds.
        assert_eq!(
            t.s.memory().read(u64::from(REGION.0) + 16, 1).unwrap(),
            &[0xFF]
        );
        assert_eq!(t.block(2, &[2; 16]).last_sent().unwrap(), &[0x76, 2]);
        assert_eq!(t.block(3, &[3; 16]).last_sent().unwrap(), &[0x76, 3]);
        assert_eq!(t.rq(&[0x37]), vec![0x77]);
    }

    #[test]
    fn fault_drop_response_once_no_double_write() {
        let mut t = start_download(&["drop-response-once:2"], 48);
        t.block(1, &[1; 16]);
        let p = t.block(2, &[2; 16]);
        assert!(p.steps.is_empty(), "response dropped");
        assert_eq!(
            t.s.memory().read(u64::from(REGION.0) + 16, 16).unwrap(),
            &[2; 16]
        );
        // Client resends the same counter -> ack, no rewrite (would be 0x72).
        assert_eq!(t.block(2, &[2; 16]).last_sent().unwrap(), &[0x76, 2]);
        assert_eq!(t.block(3, &[3; 16]).last_sent().unwrap(), &[0x76, 3]);
        assert_eq!(t.rq(&[0x37]), vec![0x77]);
        let runs = t.s.memory().written_runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].1.len(), 48);
    }

    #[test]
    fn fault_max_block_len() {
        let mut t = start_download(&["max-block-len:0x22"], 64);
        assert_eq!(t.s.max_block_len(), 0x22);
        // advertised in 0x74 (checked in a fresh server)
        let mut t2 = T::new(&["max-block-len:0x22"]);
        t2.enter_programming_unlocked();
        t2.erase(REGION.0, 0x100);
        assert_eq!(
            t2.req_download(REGION.0, 0x40),
            vec![0x74, 0x20, 0x00, 0x22]
        );
        // enforced: 2 + 32 = 34 ok, 2 + 33 rejected
        assert_eq!(
            t.block(1, &[0; 33]).last_sent().unwrap(),
            &[0x7F, 0x36, 0x13]
        );
        assert_eq!(t.block(1, &[0; 32]).last_sent().unwrap(), &[0x76, 1]);
        let mut big = T::new(&["max-block-len:0x10002"]);
        big.enter_programming_unlocked();
        big.erase(REGION.0, 0x100);
        assert_eq!(
            big.req_download(REGION.0, 0x40),
            vec![0x74, 0x40, 0x00, 0x01, 0x00, 0x02]
        );
    }

    #[test]
    fn fault_reset_during_transfer() {
        let mut t = start_download(&["reset-during-transfer:2"], 48);
        t.block(1, &[1; 16]);
        let p = t.block(2, &[2; 16]);
        assert_eq!(p.sent().len(), 0);
        assert!(matches!(p.steps.as_slice(), [Step::Reboot(_)]));
        assert_eq!(t.s.session(), Session::Default);
        assert_eq!(t.s.unlocked_level(), None);
        assert_eq!(
            t.nrc(&[0x36, 0x02, 0x00]),
            nrc::SERVICE_NOT_SUPPORTED_IN_SESSION
        );
        // Block 2 was not programmed; block 1 survives (non-volatile flash).
        assert_eq!(
            t.s.memory().read(u64::from(REGION.0), 17).unwrap()[15..],
            [1, 0xFF]
        );
        // Fault fires once: a retried flash succeeds.
        t.enter_programming_unlocked();
        t.erase(REGION.0, 0x1000);
        t.req_download(REGION.0, 48);
        for b in 1..=3u8 {
            assert_eq!(t.block(b, &[b; 16]).last_sent().unwrap(), &[0x76, b]);
        }
        assert_eq!(t.rq(&[0x37]), vec![0x77]);
    }

    #[test]
    fn fault_erase_time() {
        let mut t = T::new(&["erase-time:1234"]);
        t.enter_programming_unlocked();
        let p = t.plan(&[0x31, 0x01, 0xFF, 0x00]);
        assert_eq!(p.steps[0], Step::Send(vec![0x7F, 0x31, 0x78]));
        assert_eq!(p.steps[1], Step::Delay(Duration::from_millis(1234)));
    }

    // ------------------------------------------------------------ OEM flow
    #[test]
    fn boot_jump_silence_only_when_entering_programming() {
        let mut t = T::new(&[]);
        let p = t.plan(&[0x10, 0x03]);
        assert!(!p.steps.iter().any(|s| matches!(s, Step::Silence(_))));
        let p = t.plan(&[0x10, 0x02]);
        assert_eq!(
            p.steps,
            vec![
                Step::Send(vec![0x50, 0x02, 0x00, 0x32, 0x01, 0xF4]),
                Step::Silence(Duration::from_millis(300)),
            ]
        );
        assert!(p.notes.iter().any(|n| n.contains("jump to bootloader")));
        // Already in Programming: no second jump.
        let p = t.plan(&[0x10, 0x02]);
        assert_eq!(p.steps.len(), 1);
        // suppressPosRsp: no response, but the jump still happens.
        t.rq(&[0x10, 0x03]);
        assert_eq!(
            t.plan(&[0x10, 0x82]).steps,
            vec![Step::Silence(Duration::from_millis(300))]
        );
        // Rejected 10 02 (from Default): no jump.
        t.rq(&[0x10, 0x01]);
        let p = t.plan(&[0x10, 0x02]);
        assert_eq!(p.steps, vec![Step::Send(vec![0x7F, 0x10, 0x22])]);
        // Disabled.
        let mut d = Server::new(ServerConfig {
            boot_jump_ms: 0,
            allow_direct_programming: true,
            ..ServerConfig::default()
        });
        assert_eq!(
            d.handle(&[0x10, 0x02], Instant::now(), false).steps.len(),
            1
        );
    }

    #[test]
    fn routine_0203_check_programming_preconditions() {
        let mut t = T::new(&[]);
        let req = [0x31, 0x01, 0x02, 0x03];
        assert_eq!(t.nrc(&req), nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        t.rq(&[0x10, 0x03]);
        assert_eq!(t.rq(&req), vec![0x71, 0x01, 0x02, 0x03, 0x00]);
        assert_eq!(
            t.rq(&[0x31, 0x03, 0x02, 0x03]),
            vec![0x71, 0x03, 0x02, 0x03, 0x00]
        );
        assert_eq!(
            t.nrc(&[0x31, 0x01, 0x02, 0x03, 0x00]),
            nrc::INCORRECT_MESSAGE_LENGTH
        );
        // Other programming RIDs stay Programming-only.
        assert_eq!(t.nrc(&[0x31, 0x01, 0xFF, 0x01]), nrc::REQUEST_OUT_OF_RANGE);
        t.rq(&[0x10, 0x02]);
        assert_eq!(t.rq(&req), vec![0x71, 0x01, 0x02, 0x03, 0x00]);

        let mut f = T::new(&["precondition-fail"]);
        f.rq(&[0x10, 0x03]);
        assert_eq!(f.rq(&req), vec![0x71, 0x01, 0x02, 0x03, 0x01]);
        // NRC variant through the generic nrc fault.
        let mut n = T::new(&["nrc:0x31:0x22:once"]);
        n.rq(&[0x10, 0x03]);
        assert_eq!(n.nrc(&req), nrc::CONDITIONS_NOT_CORRECT);
        assert_eq!(n.rq(&req)[4], 0x00);
    }

    #[test]
    fn fingerprint_f15a_and_alias_f184() {
        let mut t = T::new(&[]);
        let fp = [0x26, 0x11, 0x17, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78];
        let mut w = vec![0x2E, 0xF1, 0x5A];
        w.extend_from_slice(&fp);
        assert_eq!(t.read_did(DID_FINGERPRINT), vec![0u8; 9]);
        assert_eq!(t.nrc(&w), nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        t.rq(&[0x10, 0x03]);
        // Extended, even unlocked: still the wrong session.
        t.unlock(0x01);
        assert_eq!(t.nrc(&w), nrc::SERVICE_NOT_SUPPORTED_IN_SESSION);
        t.rq(&[0x10, 0x02]);
        assert_eq!(t.nrc(&w), nrc::SECURITY_ACCESS_DENIED);
        assert_eq!(t.nrc(&[0x2E, 0xF1, 0x5A]), nrc::INCORRECT_MESSAGE_LENGTH);
        let mut long = vec![0x2E, 0xF1, 0x5A];
        long.extend_from_slice(&[0u8; MAX_FINGERPRINT_LEN + 1]);
        assert_eq!(t.nrc(&long), nrc::INCORRECT_MESSAGE_LENGTH);
        t.unlock(0x11);
        let p = t.plan(&w);
        assert_eq!(p.last_sent().unwrap(), &[0x6E, 0xF1, 0x5A]);
        assert!(p
            .notes
            .iter()
            .any(|n| n.contains("fingerprint (0xF15A) written: 26 11 17")));
        assert_eq!(t.read_did(DID_FINGERPRINT), fp);
        assert_eq!(t.read_did(DID_FINGERPRINT_ALIAS), fp);
        w[2] = 0x84;
        w[3] = 0x99;
        assert_eq!(t.rq(&w), vec![0x6E, 0xF1, 0x84]);
        assert_eq!(t.read_did(DID_FINGERPRINT)[0], 0x99);
        // Non-volatile: survives an ECU reset.
        t.rq(&[0x11, 0x01]);
        assert_eq!(t.read_did(DID_FINGERPRINT)[0], 0x99);
        assert_eq!(t.s.fingerprint().len(), 9);
    }

    #[test]
    fn identification_dids() {
        let mut t = T::new(&[]);
        assert_eq!(t.read_did(DID_SW_VERSION), b"SW 1.0.0");
        assert_eq!(t.read_did(DID_HW_NUMBER), b"HW-NX-01");
        assert_eq!(t.read_did(DID_SPARE_PART), b"NX-ECU-SIM-0001");
        assert_eq!(t.read_did(DID_VIN), b"NEXUSCANSIM000001");
        assert_eq!(t.read_did(DID_ACTIVE_SESSION), vec![0x01]);
        let r = t.rq(&[0x22, 0xF1, 0x89, 0xF1, 0x91]);
        assert_eq!(
            r,
            [
                &[0x62, 0xF1, 0x89][..],
                b"SW 1.0.0",
                &[0xF1, 0x91],
                b"HW-NX-01"
            ]
            .concat()
        );
    }

    /// Two segments with a gap, erased / downloaded / checked one at a time.
    #[test]
    fn per_segment_erase_crc_dependencies_and_sw_version_update() {
        let mut t = T::new(&[]);
        let (a, b) = (REGION.0 + 0x100, REGION.0 + 0x1_0000);
        let (da, db) = (pattern(0x150), pattern(0x233));
        t.enter_programming_unlocked();
        // FF01 with nothing downloaded fails.
        assert_eq!(t.dependencies(), 0x01);
        assert_eq!(t.erase(a, da.len() as u32)[0], 0x71);
        // Exactly that range is erased: the byte before / after is not.
        assert!(t
            .s
            .memory()
            .is_erased(u64::from(a), da.len() as u64)
            .unwrap());
        assert!(!t.s.memory().is_erased(u64::from(a) - 1, 1).unwrap());
        assert!(!t
            .s
            .memory()
            .is_erased(u64::from(a) + da.len() as u64, 1)
            .unwrap());
        t.download(a, &da);
        assert_eq!(t.check_crc(crate::crc::crc32(&da)), 0x00);
        // Segment B not erased yet, the gap never: 0x70.
        assert_eq!(t.req_download(b, db.len() as u32), vec![0x7F, 0x34, 0x70]);
        assert_eq!(t.req_download(a + 0x200, 0x10), vec![0x7F, 0x34, 0x70]);
        // Re-erasing B must not touch A.
        assert_eq!(t.erase(b, db.len() as u32)[0], 0x71);
        assert_eq!(t.s.segments().len(), 1);
        t.download(b, &db);
        // F189 unchanged until the flash is validated and the ECU resets.
        assert_eq!(t.check_crc(crate::crc::crc32(&db)), 0x00);
        assert_eq!(t.s.segments().iter().filter(|s| s.verified).count(), 2);
        // Earlier segment and whole image still match.
        assert_eq!(t.check_crc(crate::crc::crc32(&da)), 0x00);
        assert_eq!(
            t.check_crc(crate::crc::crc32(&[da.clone(), db.clone()].concat())),
            0x00
        );
        assert_eq!(t.dependencies(), 0x00);
        assert_eq!(t.read_did(DID_SW_VERSION), b"SW 1.0.0");
        let p = t.plan(&[0x11, 0x01]);
        assert!(p.notes.iter().any(|n| n.contains("new software active")));
        assert_eq!(t.read_did(DID_SW_VERSION), b"SW 1.1.0");
        // Flash is non-volatile: both segments still there.
        assert_eq!(
            t.s.memory().read(u64::from(b), db.len() as u64).unwrap(),
            &db[..]
        );
    }

    #[test]
    fn integrity_mismatch_makes_dependencies_fail_until_reerase() {
        let mut t = T::new(&[]);
        let (a, b) = (REGION.0, REGION.0 + 0x2000);
        let (da, db) = (pattern(0x80), pattern(0x90));
        t.enter_programming_unlocked();
        t.erase(a, 0x80);
        t.download(a, &da);
        assert_eq!(t.check_crc(crate::crc::crc32(&da)), 0x00);
        t.erase(b, 0x90);
        t.download(b, &db);
        assert_eq!(t.check_crc(crate::crc::crc32(&db) ^ 1), 0x01);
        assert!(t.s.segments()[1].failed);
        assert_eq!(t.dependencies(), 0x01);
        // A later correct check does not clear the failure (sticky).
        assert_eq!(t.check_crc(crate::crc::crc32(&db)), 0x00);
        assert_eq!(t.dependencies(), 0x01);
        // No SW update armed: F189 unchanged after reset.
        t.rq(&[0x11, 0x01]);
        assert_eq!(t.read_did(DID_SW_VERSION), b"SW 1.0.0");
        // Re-erase + re-download of B clears it.
        t.enter_programming_unlocked();
        t.erase(b, 0x90);
        t.download(b, &db);
        assert_eq!(t.dependencies(), 0x01, "B not yet verified");
        assert_eq!(t.check_crc(crate::crc::crc32(&db)), 0x00);
        assert_eq!(t.dependencies(), 0x00);
        // A download without any 0202 -> FF01 fails.
        let mut u = T::new(&[]);
        u.enter_programming_unlocked();
        u.erase(a, 0x80);
        u.download(a, &da);
        assert_eq!(u.dependencies(), 0x01);
        // Erase after a successful FF01 disarms the SW update.
        assert_eq!(u.check_crc(crate::crc::crc32(&da)), 0x00);
        assert_eq!(u.dependencies(), 0x00);
        u.erase(b, 0x10);
        u.rq(&[0x11, 0x01]);
        assert_eq!(u.read_did(DID_SW_VERSION), b"SW 1.0.0");
    }

    #[test]
    fn sw_version_from_image_address() {
        let mut s = Server::new(ServerConfig {
            sw_version_addr: Some(REGION.0 + 0x10),
            erase_ms: 0,
            reboot_ms: 0,
            ..ServerConfig::default()
        });
        let mut t = T {
            s,
            now: Instant::now(),
        };
        let mut img = vec![0u8; 0x40];
        img[0x10..0x1A].copy_from_slice(b"APP 2.3.4\0");
        t.enter_programming_unlocked();
        t.erase(REGION.0, 0x40);
        t.download(REGION.0, &img);
        assert_eq!(t.check_crc(crate::crc::crc32(&img)), 0x00);
        assert_eq!(t.dependencies(), 0x00);
        t.rq(&[0x11, 0x01]);
        assert_eq!(t.read_did(DID_SW_VERSION), b"APP 2.3.4");
        // Non-printable data at the address: fall back to --new-sw-version.
        s = Server::new(ServerConfig {
            sw_version_addr: Some(REGION.0),
            ..ServerConfig::default()
        });
        t = T {
            s,
            now: Instant::now(),
        };
        t.enter_programming_unlocked();
        t.erase(REGION.0, 0x10);
        t.download(REGION.0, &[0x01; 0x10]);
        t.check_crc(crate::crc::crc32(&[0x01; 0x10]));
        assert_eq!(t.dependencies(), 0x00);
        t.rq(&[0x11, 0x01]);
        assert_eq!(t.read_did(DID_SW_VERSION), b"SW 1.1.0");
    }

    #[test]
    fn functional_oem_services_and_keepalive() {
        let mut t = T::new(&[]);
        t.rq(&[0x10, 0x03]);
        // 85 82 / 28 83 01 with SPR: state changes, no response.
        assert!(t.fplan(&[0x85, 0x82]).steps.is_empty());
        assert!(!t.s.dtc_setting_on);
        assert!(t.fplan(&[0x28, 0x83, 0x01]).steps.is_empty());
        assert_eq!(t.s.comm_control, 0x03);
        assert_eq!(
            t.fplan(&[0x14, 0xFF, 0xFF, 0xFF]).last_sent(),
            Some(&[0x54][..])
        );
        assert_eq!(
            t.fplan(&[0x22, 0xF1, 0x89]).last_sent().unwrap()[..3],
            [0x62, 0xF1, 0x89]
        );
        // Physical-only services: NRC 0x11 suppressed on the functional address.
        assert!(t.fplan(&[0x31, 0x01, 0x02, 0x03]).steps.is_empty());
        assert!(t.fplan(&[0x2E, 0xF1, 0x5A, 0x00]).steps.is_empty());
        assert!(t.fplan(&[0x27, 0x01]).steps.is_empty());
        // 3E 80 functional keeps S3 alive in Extended and Programming.
        for session in [0x03u8, 0x02] {
            t.rq(&[0x10, session]);
            for _ in 0..5 {
                t.now += Duration::from_millis(4000);
                assert!(t.fplan(&[0x3E, 0x80]).steps.is_empty());
            }
            t.s.tick(t.now);
            assert_eq!(t.s.session() as u8, session);
        }
        t.now += Duration::from_millis(5001);
        t.s.tick(t.now);
        assert_eq!(t.s.session(), Session::Default);
        // 28 80 01 / 85 81 restore; 11 01 functional reboots.
        t.rq(&[0x10, 0x03]);
        assert!(t.fplan(&[0x28, 0x80, 0x01]).steps.is_empty());
        assert!(t.fplan(&[0x85, 0x81]).steps.is_empty());
        assert!(t.s.dtc_setting_on);
        assert_eq!(t.s.comm_control, 0x00);
        assert!(matches!(
            t.fplan(&[0x11, 0x81]).steps.as_slice(),
            [Step::Reboot(_)]
        ));
    }
}
