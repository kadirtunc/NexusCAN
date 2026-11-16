//! D-003 diag session manager: `PipelineEngine::open_diag_tap` + `cmd_diag_*` commands.
//!
//! One [`UdsSession`] per [`DiagSessionConfigDto`] key = the WHOLE config except `protocol`
//! (`busId, requestId, responseId, isExtendedId, functionalId, useFd, padding, p2MarginMs`,
//! `addressFormat` + effective `targetAddress` / `responseAddress`; team-lead clarification of
//! contract §2). Opening a session whose addressing
//! `(busId, requestId, responseId, isExtendedId, response address byte)` matches an existing session with different
//! settings CLOSES the old one first: two clients on the same ids would both answer with
//! Flow Control frames. Every command that
//! talks to an ECU auto-opens its session when missing or invalidated (closed tap) — this
//! requires a connected, armed bus (`bus_not_connected` / `listen_only` / `disarmed` /
//! `panic_latched` otherwise). Read-only commands (`cmd_diag_session_info`,
//! `cmd_diag_get_conversation`) never open a session and keep working on an invalidated one,
//! so the HMI can still inspect the log after a Panic Stop.
//!
//! All methods are BLOCKING (UDS round trips). Async callers (bridge/axum, Tauri) must use
//! `spawn_blocking`.

use super::diag_tap::{DiagTapStatus, HalDiagPort, MAX_TAP_FILTERS};
use super::*;
use nexus_protocols::uds::client::{session_address_bytes, UdsSession};
use nexus_protocols::uds::dto::{
    AddressFormatDto, ConversationPageDto, DiagOrigin, DiagSessionConfigDto, DiagSessionInfoDto,
    DidReadResultDto, DtcEntryDto, IsoTpFramePageDto, UdsRequestOptionsDto, UdsResponseDto,
};
use std::collections::HashMap;

/// Event queue depth of a session tap. A 4095-byte classical ISO-TP response is 586 frames;
/// the client drains continuously, so 2048 leaves ample headroom (~170 KiB per session).
pub const DIAG_SESSION_TAP_DEPTH: usize = 2_048;
/// Default / maximum page size of `cmd_diag_get_conversation`.
pub const DEFAULT_CONVERSATION_PAGE: usize = 500;
pub const MAX_CONVERSATION_PAGE: usize = 10_000;
/// Default / maximum page size of `cmd_diag_get_isotp_frames`.
pub const DEFAULT_ISOTP_PAGE: usize = 500;
pub const MAX_ISOTP_PAGE: usize = 2_000;
/// Default `statusMask` of `cmd_diag_read_stored_dtcs`.
pub const DEFAULT_DTC_STATUS_MASK: u8 = 0xFF;

const MAX_CLASSICAL_ISOTP_PDU: usize = 4_095;
const MAX_FD_ISOTP_PDU: usize = 65_535;

/// Session map key: whole config except the informational `protocol` field.
///
/// The ISO 15765-2 address fields are part of it in their EFFECTIVE form: `targetAddress` /
/// `responseAddress` are ignored for `normal` / `normalFixed` (no address byte), and a `mixed`
/// response byte defaults to the target byte, so configs that put the same bytes on the wire
/// share one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct DiagKey {
    bus_id: u8,
    request_id: u32,
    response_id: u32,
    is_extended_id: bool,
    functional_id: Option<u32>,
    use_fd: bool,
    padding: Option<u8>,
    p2_margin_ms: u32,
    address_format: AddressFormatDto,
    /// Effective N_TA / N_AE byte the tester sends.
    tx_addr: Option<u8>,
    /// Effective first byte required in ECU frames.
    rx_addr: Option<u8>,
}

/// Effective `(tx, rx)` address bytes of `c` (`None` = no address byte / not resolvable;
/// an unresolvable config is rejected by [`validate_config`] before it is keyed).
fn effective_address_bytes(c: &DiagSessionConfigDto) -> (Option<u8>, Option<u8>) {
    match c.address_format {
        AddressFormatDto::Normal | AddressFormatDto::NormalFixed => (None, None),
        AddressFormatDto::Extended => (c.target_address, c.response_address),
        AddressFormatDto::Mixed => (c.target_address, c.response_address.or(c.target_address)),
    }
}

fn diag_key(c: &DiagSessionConfigDto) -> DiagKey {
    let (tx_addr, rx_addr) = effective_address_bytes(c);
    DiagKey {
        bus_id: c.bus_id,
        request_id: c.request_id,
        response_id: c.response_id,
        is_extended_id: c.is_extended_id,
        functional_id: c.functional_id,
        use_fd: c.use_fd,
        padding: c.padding,
        p2_margin_ms: c.p2_margin_ms,
        address_format: c.address_format,
        tx_addr,
        rx_addr,
    }
}

/// Physical addressing of a key: sessions sharing it must not coexist (both would accept the
/// same ECU frames and answer with Flow Control). The response address byte is part of it:
/// under extended / mixed addressing, frames with another first byte are not ours.
#[inline]
fn addressing_of(k: &DiagKey) -> (u8, u32, u32, bool, Option<u8>) {
    (
        k.bus_id,
        k.request_id,
        k.response_id,
        k.is_extended_id,
        k.rx_addr,
    )
}

struct DiagEntry {
    session: Arc<UdsSession>,
    tap: DiagTapStatus,
}

impl DiagEntry {
    fn is_valid(&self) -> bool {
        !self.tap.is_closed()
    }
}

/// `HashMap<key, Arc<UdsSession>>` owned by [`PipelineEngine`].
#[derive(Default)]
pub(crate) struct DiagSessionMap(Mutex<HashMap<DiagKey, DiagEntry>>);

impl DiagSessionMap {
    /// A VALID (open tap) session on the physical addressing of `config`
    /// (`(bus, request, response, ext, response address byte)`), whatever its other settings. Used by ECU discovery's identify step so it never opens a
    /// second client (double Flow Control) next to a user session on the same ids.
    pub(super) fn valid_for_addressing(
        &self,
        config: &DiagSessionConfigDto,
    ) -> Option<Arc<UdsSession>> {
        let want = addressing_of(&diag_key(config));
        self.0
            .lock()
            .iter()
            .find(|(k, e)| addressing_of(k) == want && e.is_valid())
            .map(|(_, e)| Arc::clone(&e.session))
    }

    /// Closes every tap and drops all sessions (engine shutdown).
    pub(crate) fn clear(&self) {
        let drained: Vec<DiagEntry> = self.0.lock().drain().map(|(_, e)| e).collect();
        for e in &drained {
            e.tap.close();
            e.session.close();
        }
        drop(drained);
    }
}

pub(super) fn invalid(msg: impl Into<String>) -> DiagError {
    DiagError::new(DiagErrorCode::InvalidInput, msg)
}

/// Maps a gate / tap verdict to the IPC error taxonomy.
pub(crate) fn reject_to_diag_error(bus_id: BusId, reason: DiagTxReject) -> DiagError {
    match reason {
        DiagTxReject::ListenOnly => DiagError::new(
            DiagErrorCode::ListenOnly,
            format!(
                "bus {bus_id} is in Listen-Only mode; reconnect it in active mode and engage Arm Active Bus"
            ),
        ),
        DiagTxReject::Disarmed => DiagError::new(
            DiagErrorCode::Disarmed,
            format!("bus {bus_id} TX is disarmed; engage Arm Active Bus first"),
        ),
        DiagTxReject::PanicLatched => DiagError::new(
            DiagErrorCode::PanicLatched,
            "Panic Stop is latched; re-arm the bus before diagnostics",
        ),
        DiagTxReject::Closed => DiagError::new(
            DiagErrorCode::SessionClosed,
            format!("diag tap on bus {bus_id} was closed"),
        ),
        DiagTxReject::QueueFull => DiagError::new(
            DiagErrorCode::Busy,
            format!("bus {bus_id} TX queue is full"),
        ),
        DiagTxReject::DriverError => DiagError::new(
            DiagErrorCode::Internal,
            format!("bus {bus_id} driver rejected the frame"),
        ),
    }
}

pub(super) fn check_id(name: &str, id: u32, extended: bool) -> Result<(), DiagError> {
    let max = if extended { 0x1FFF_FFFF } else { 0x7FF };
    if id > max {
        return Err(invalid(format!(
            "{name} 0x{id:X} exceeds the {} identifier range (max 0x{max:X})",
            if extended { "29-bit" } else { "11-bit" }
        )));
    }
    Ok(())
}

fn validate_config(c: &DiagSessionConfigDto) -> Result<(), DiagError> {
    check_id("requestId", c.request_id, c.is_extended_id)?;
    check_id("responseId", c.response_id, c.is_extended_id)?;
    if c.request_id == c.response_id {
        return Err(invalid("requestId and responseId must differ"));
    }
    if let Some(f) = c.functional_id {
        check_id("functionalId", f, c.is_extended_id)?;
        if f == c.response_id {
            return Err(invalid("functionalId must differ from responseId"));
        }
    }
    if c.p2_margin_ms > 60_000 {
        return Err(invalid("p2MarginMs must be <= 60000"));
    }
    // Address format rules (address bytes present, 29-bit id forms).
    session_address_bytes(c)?;
    Ok(())
}

pub(super) fn tap_filters(c: &DiagSessionConfigDto) -> ([DiagTapFilter; MAX_TAP_FILTERS], usize) {
    let exact = |id: u32| {
        if c.is_extended_id {
            DiagTapFilter::exact_ext(id)
        } else {
            DiagTapFilter::exact_std(id)
        }
    };
    let mut out = [exact(c.response_id); MAX_TAP_FILTERS];
    out[1] = exact(c.request_id);
    let mut n = 2;
    if let Some(f) = c.functional_id {
        if f != c.request_id {
            out[n] = exact(f);
            n += 1;
        }
    }
    (out, n)
}

fn closed_info(config: DiagSessionConfigDto) -> DiagSessionInfoDto {
    DiagSessionInfoDto {
        config,
        open: false,
        active_session: 1,
        unlocked_level: None,
        tester_present_enabled: false,
        tester_present_interval_ms: 2_000,
        p2_server_ms: None,
        p2_star_server_ms: None,
        last_seq: 0,
    }
}

impl PipelineEngine {
    /// D-003: opens a filtered diagnostic tap on the bus-io owner thread of `bus_id`.
    ///
    /// Requires a connected bus in active mode, armed, with no Panic Stop latched. Matching RX
    /// frames (and TX echoes of other origins) are delivered as [`DiagPortEvent::Rx`]; frames
    /// sent through the port are confirmed/rejected to this port only. The tap closes on Panic
    /// Stop, disarm, mode change and disconnect.
    pub fn open_diag_tap(
        &self,
        bus_id: u8,
        filters: &[DiagTapFilter],
        depth: usize,
    ) -> Result<HalDiagPort, DiagError> {
        if filters.is_empty() || filters.len() > MAX_TAP_FILTERS {
            return Err(invalid(format!(
                "a diag tap needs 1..={MAX_TAP_FILTERS} acceptance filters"
            )));
        }
        let guard = self.buses.lock();
        let bus = guard
            .get(&bus_id)
            .filter(|b| b.is_connected())
            .ok_or_else(|| {
                DiagError::new(
                    DiagErrorCode::BusNotConnected,
                    format!("bus {bus_id} is not connected"),
                )
            })?;
        let gate = GateRefs {
            listen_only: bus.listen_only,
            tx_armed: Arc::clone(&bus.tx_armed),
            panic_latched: Arc::clone(&self.tx_panic_latched),
            tx_epoch: Arc::clone(&self.tx_epoch),
        };
        gate.verdict()
            .map_err(|r| reject_to_diag_error(bus_id, r))?;
        let reg = bus.diag.register(filters, depth).map_err(|e| match e {
            TapRegisterError::NoFreeSlot => DiagError::new(
                DiagErrorCode::Busy,
                format!(
                    "bus {bus_id} already has {} diag taps open; close a session first",
                    diag_tap::MAX_DIAG_TAPS
                ),
            ),
            TapRegisterError::BadFilters => invalid("invalid diag tap filters"),
            TapRegisterError::BusGone => DiagError::new(
                DiagErrorCode::BusNotConnected,
                format!("bus {bus_id} I/O thread is gone"),
            ),
        })?;
        Ok(HalDiagPort::new(
            bus_id,
            bus.fd_enabled(),
            reg,
            bus.tx_sender.clone(),
            gate,
            Arc::clone(&bus.diag),
        ))
    }

    /// Number of diag taps registered on `bus_id` (diagnostics / tests).
    pub fn diag_tap_count(&self, bus_id: u8) -> usize {
        self.buses
            .lock()
            .get(&bus_id)
            .map_or(0, |b| b.diag.registered())
    }

    pub(super) fn bus_fd_enabled(&self, bus_id: u8) -> Option<bool> {
        self.buses.lock().get(&bus_id).map(|b| b.fd_enabled())
    }

    /// Returns a valid session for `config`, opening (or reopening) it when needed.
    fn diag_session(&self, config: &DiagSessionConfigDto) -> Result<Arc<UdsSession>, DiagError> {
        validate_config(config)?;
        let key = diag_key(config);
        let mut stale: Vec<DiagEntry> = Vec::new();
        let result = (|| {
            let mut map = self.diag_sessions.0.lock();
            if let Some(e) = map.get(&key) {
                if e.is_valid() {
                    return Ok(Arc::clone(&e.session));
                }
            }
            if config.use_fd && self.bus_fd_enabled(config.bus_id) == Some(false) {
                return Err(invalid(format!(
                    "useFd requires bus {} to be connected with CAN-FD enabled",
                    config.bus_id
                )));
            }
            // Gate first: if the tap cannot be opened (not connected / Listen-Only / disarmed /
            // Panic latched) the old, closed session stays in the map with its conversation
            // log, so `session_info` / `get_conversation` keep showing it.
            let (filters, n) = tap_filters(config);
            let port = self.open_diag_tap(config.bus_id, &filters[..n], DIAG_SESSION_TAP_DEPTH)?;
            let tap = port.status();

            // Invalidated entry for this key, plus any session on the same physical
            // addressing with different settings (avoid double Flow Control on the bus):
            // silence their taps now, replace the map entries only once the new session is up.
            let addr = addressing_of(&key);
            let conflicting: Vec<DiagKey> = map
                .keys()
                .filter(|k| addressing_of(k) == addr)
                .copied()
                .collect();
            for k in &conflicting {
                if let Some(old) = map.get(k) {
                    old.tap.close();
                }
            }
            let session = Arc::new(UdsSession::open(Box::new(port), config.clone())?);
            for k in conflicting {
                if let Some(old) = map.remove(&k) {
                    stale.push(old);
                }
            }
            map.insert(
                key,
                DiagEntry {
                    session: Arc::clone(&session),
                    tap,
                },
            );
            Ok(session)
        })();
        // Drop replaced sessions outside the map lock (their Drop may join worker threads).
        for old in stale {
            old.session.close();
        }
        result
    }

    /// [`Self::diag_session`] for sibling command modules (0x19 reports, sweeps).
    pub(super) fn diag_session_for(
        &self,
        config: &DiagSessionConfigDto,
    ) -> Result<Arc<UdsSession>, DiagError> {
        self.diag_session(config)
    }

    /// Existing entry (valid or invalidated) without opening anything.
    fn diag_existing(&self, config: &DiagSessionConfigDto) -> Option<(Arc<UdsSession>, bool)> {
        self.diag_sessions
            .0
            .lock()
            .get(&diag_key(config))
            .map(|e| (Arc::clone(&e.session), e.is_valid()))
    }

    fn info_of(session: &UdsSession, valid: bool) -> DiagSessionInfoDto {
        let mut info = session.info();
        if !valid {
            // Closed tap: nothing runs anymore, whatever the session last recorded.
            info.open = false;
            info.tester_present_enabled = false;
        }
        info
    }

    /// `cmd_diag_open_session` → opens (or returns the already open) session.
    pub fn cmd_diag_open_session(
        &self,
        config: DiagSessionConfigDto,
    ) -> Result<DiagSessionInfoDto, DiagError> {
        let session = self.diag_session(&config)?;
        Ok(Self::info_of(&session, true))
    }

    /// `cmd_diag_close_session` → stops keepalive and closes the tap. Idempotent.
    pub fn cmd_diag_close_session(&self, config: DiagSessionConfigDto) -> Result<(), DiagError> {
        let entry = self.diag_sessions.0.lock().remove(&diag_key(&config));
        if let Some(e) = entry {
            // Closing the tap first makes a request still in flight on another thread fail
            // fast; `close(&self)` is idempotent and stops keepalive.
            e.tap.close();
            e.session.close();
        }
        Ok(())
    }

    /// `cmd_diag_session_info` → state of an existing session; never opens one.
    pub fn cmd_diag_session_info(
        &self,
        config: DiagSessionConfigDto,
    ) -> Result<DiagSessionInfoDto, DiagError> {
        validate_config(&config)?;
        Ok(match self.diag_existing(&config) {
            Some((session, valid)) => Self::info_of(&session, valid),
            None => closed_info(config),
        })
    }

    /// `cmd_diag_send_uds` → request PDU = `[sid] + [subFunction if Some] + data`.
    pub fn cmd_diag_send_uds(
        &self,
        config: DiagSessionConfigDto,
        sid: u8,
        sub_function: Option<u8>,
        data: Vec<u8>,
        options: Option<UdsRequestOptionsDto>,
    ) -> Result<UdsResponseDto, DiagError> {
        let mut payload = Vec::with_capacity(data.len() + 1);
        if let Some(sf) = sub_function {
            payload.push(sf);
        }
        payload.extend_from_slice(&data);
        let max = if config.use_fd {
            MAX_FD_ISOTP_PDU
        } else {
            MAX_CLASSICAL_ISOTP_PDU
        };
        if payload.len() + 1 > max {
            return Err(invalid(format!(
                "request PDU of {} bytes exceeds the ISO-TP limit of {max} bytes",
                payload.len() + 1
            )));
        }
        let opts = options.unwrap_or_default();
        let session = self.diag_session(&config)?;
        session.request(sid, &payload, &opts)
    }

    /// `cmd_diag_read_did` → 0x22 for one DID (data record only). `origin` tags the
    /// conversation events (default [`DiagOrigin::Did`]).
    pub fn cmd_diag_read_did(
        &self,
        config: DiagSessionConfigDto,
        did: u16,
        origin: Option<DiagOrigin>,
    ) -> Result<DidReadResultDto, DiagError> {
        self.diag_session(&config)?
            .read_did_with(did, origin.unwrap_or(DiagOrigin::Did))
    }

    /// `cmd_diag_read_stored_dtcs` → 0x19 0x02 (default `statusMask` 0xFF). `origin` tags the
    /// conversation events (default [`DiagOrigin::Dtc`]).
    pub fn cmd_diag_read_stored_dtcs(
        &self,
        config: DiagSessionConfigDto,
        status_mask: Option<u8>,
        origin: Option<DiagOrigin>,
    ) -> Result<Vec<DtcEntryDto>, DiagError> {
        self.diag_session(&config)?.read_dtcs_by_status_with(
            status_mask.unwrap_or(DEFAULT_DTC_STATUS_MASK),
            origin.unwrap_or(DiagOrigin::Dtc),
        )
    }

    /// `cmd_diag_set_tester_present` → background `3E 80`. Disabling never opens a session.
    pub fn cmd_diag_set_tester_present(
        &self,
        config: DiagSessionConfigDto,
        enabled: bool,
        interval_ms: Option<u32>,
    ) -> Result<DiagSessionInfoDto, DiagError> {
        if let Some(ms) = interval_ms {
            if !(100..=60_000).contains(&ms) {
                return Err(invalid("intervalMs must be within 100..=60000"));
            }
        }
        if !enabled {
            validate_config(&config)?;
            return match self.diag_existing(&config) {
                Some((session, valid)) => {
                    if valid {
                        session.set_tester_present(false, interval_ms)?;
                    }
                    Ok(Self::info_of(&session, valid))
                }
                None => Ok(closed_info(config)),
            };
        }
        let session = self.diag_session(&config)?;
        session.set_tester_present(true, interval_ms)?;
        Ok(Self::info_of(&session, true))
    }

    /// `cmd_diag_get_conversation` → events with `seq > since_seq` (default max 500).
    /// Never opens a session; an unknown session yields an empty page.
    pub fn cmd_diag_get_conversation(
        &self,
        config: DiagSessionConfigDto,
        since_seq: u64,
        max: Option<u32>,
    ) -> Result<ConversationPageDto, DiagError> {
        validate_config(&config)?;
        let max = max
            .map_or(DEFAULT_CONVERSATION_PAGE, |m| m as usize)
            .clamp(1, MAX_CONVERSATION_PAGE);
        Ok(match self.diag_existing(&config) {
            Some((session, _)) => session.conversation_since(since_seq, max),
            None => ConversationPageDto {
                events: Vec::new(),
                last_seq: 0,
                truncated: false,
            },
        })
    }

    /// `cmd_diag_get_isotp_frames` → captured CAN frames (tap Rx + TxConfirmed) with
    /// `seq > since_seq` (default max 500, clamped 1..=2000). Never opens a session; an unknown
    /// session yields an empty page. Works on an invalidated session (log kept after Panic Stop).
    pub fn cmd_diag_get_isotp_frames(
        &self,
        config: DiagSessionConfigDto,
        since_seq: u64,
        max: Option<u32>,
    ) -> Result<IsoTpFramePageDto, DiagError> {
        validate_config(&config)?;
        let max = max
            .map_or(DEFAULT_ISOTP_PAGE, |m| m as usize)
            .clamp(1, MAX_ISOTP_PAGE);
        Ok(match self.diag_existing(&config) {
            Some((session, _)) => session.isotp_frames_since(since_seq, max),
            None => IsoTpFramePageDto {
                frames: Vec::new(),
                last_seq: 0,
                truncated: false,
                dropped: 0,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DiagSessionConfigDto {
        serde_json::from_str(
            r#"{"busId":0,"requestId":2020,"responseId":2028,"isExtendedId":false}"#,
        )
        .expect("cfg")
    }

    #[test]
    fn config_validation() {
        let mut c = cfg();
        assert!(validate_config(&c).is_ok());
        c.response_id = c.request_id;
        assert_eq!(
            validate_config(&c).unwrap_err().code,
            DiagErrorCode::InvalidInput
        );
        let mut c = cfg();
        c.request_id = 0x800;
        assert_eq!(
            validate_config(&c).unwrap_err().code,
            DiagErrorCode::InvalidInput
        );
        c.is_extended_id = true;
        assert!(validate_config(&c).is_ok());
        let mut c = cfg();
        c.functional_id = Some(c.response_id);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn key_covers_whole_config_except_protocol() {
        let a = cfg();
        let mut b = cfg();
        b.protocol = Some("uds".into());
        assert_eq!(diag_key(&a), diag_key(&b));
        b.padding = None;
        assert_ne!(diag_key(&a), diag_key(&b));
        assert_eq!(addressing_of(&diag_key(&a)), addressing_of(&diag_key(&b)));
        let mut c = cfg();
        c.p2_margin_ms = 250;
        assert_ne!(diag_key(&a), diag_key(&c));
    }

    #[test]
    fn key_includes_address_format_and_effective_address_bytes() {
        let normal = cfg();
        let ext = |ta: u8, rx: u8| DiagSessionConfigDto {
            address_format: AddressFormatDto::Extended,
            target_address: Some(ta),
            response_address: Some(rx),
            ..cfg()
        };
        // Sessions differing ONLY in the address fields no longer collide.
        assert_ne!(diag_key(&normal), diag_key(&ext(0x10, 0xF1)));
        assert_ne!(diag_key(&ext(0x10, 0xF1)), diag_key(&ext(0x11, 0xF1)));
        assert_ne!(diag_key(&ext(0x10, 0xF1)), diag_key(&ext(0x10, 0xF2)));
        let mixed = DiagSessionConfigDto {
            address_format: AddressFormatDto::Mixed,
            target_address: Some(0x55),
            ..cfg()
        };
        assert_ne!(diag_key(&normal), diag_key(&mixed));
        // Mixed: the response byte defaults to the target byte (same wire behaviour, same key).
        let mixed_explicit = DiagSessionConfigDto {
            response_address: Some(0x55),
            ..mixed.clone()
        };
        assert_eq!(diag_key(&mixed), diag_key(&mixed_explicit));
        // Normal: address bytes are ignored on the wire, so they do not split the key.
        let normal_noise = DiagSessionConfigDto {
            target_address: Some(0x10),
            response_address: Some(0xF1),
            ..cfg()
        };
        assert_eq!(diag_key(&normal), diag_key(&normal_noise));

        // Physical addressing: same CAN ids + same response byte conflict (both would take the
        // ECU frames), another response byte does not.
        assert_eq!(
            addressing_of(&diag_key(&ext(0x10, 0xF1))),
            addressing_of(&diag_key(&ext(0x11, 0xF1)))
        );
        assert_ne!(
            addressing_of(&diag_key(&ext(0x10, 0xF1))),
            addressing_of(&diag_key(&ext(0x10, 0xF2)))
        );
        assert_ne!(
            addressing_of(&diag_key(&normal)),
            addressing_of(&diag_key(&ext(0x10, 0xF1)))
        );
        let fixed = |f| DiagSessionConfigDto {
            is_extended_id: true,
            request_id: 0x18DA_10F1,
            response_id: 0x18DA_F110,
            address_format: f,
            ..cfg()
        };
        assert_ne!(
            diag_key(&fixed(AddressFormatDto::Normal)),
            diag_key(&fixed(AddressFormatDto::NormalFixed))
        );
        assert_eq!(
            addressing_of(&diag_key(&fixed(AddressFormatDto::Normal))),
            addressing_of(&diag_key(&fixed(AddressFormatDto::NormalFixed))),
            "same bytes on the wire"
        );
    }

    #[test]
    fn config_validation_checks_address_format() {
        let mut c = cfg();
        c.address_format = AddressFormatDto::Extended;
        c.target_address = Some(0x10);
        assert_eq!(
            validate_config(&c).unwrap_err().code,
            DiagErrorCode::InvalidInput,
            "extended needs responseAddress"
        );
        c.response_address = Some(0xF1);
        assert!(validate_config(&c).is_ok());
        let mut c = cfg();
        c.address_format = AddressFormatDto::NormalFixed;
        assert!(validate_config(&c).is_err(), "normalFixed needs 29-bit ids");
    }

    #[test]
    fn filters_cover_request_response_functional() {
        let mut c = cfg();
        c.functional_id = Some(0x7DD);
        let (f, n) = tap_filters(&c);
        assert_eq!(n, 3);
        assert_eq!(f[0], DiagTapFilter::exact_std(0x7EC));
        assert_eq!(f[1], DiagTapFilter::exact_std(0x7E4));
        assert_eq!(f[2], DiagTapFilter::exact_std(0x7DD));
        c.is_extended_id = true;
        let (f, _) = tap_filters(&c);
        assert_eq!(f[0].extended, Some(true));
    }
}
