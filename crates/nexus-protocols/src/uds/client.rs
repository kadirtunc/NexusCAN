//! UDS client session (D-003 contract v1). Public API FROZEN; body implemented by
//! protocol-specialist on top of `automotive` (ISO-TP, pinned =0.6.0)
//! and a [`DiagCanPort`] supplied by the HAL. See `planning/contracts/uds-client-d003-v1.md`.
//!
//! Threading model: the API is **blocking** and `Send + Sync`. Requests on one
//! session are serialized (one outstanding request per ECU). Callers in async
//! contexts (bridge/axum, Tauri) should use `spawn_blocking` (calling from a runtime thread does
//! not panic, it only blocks that thread).
//!
//! ## Internals (per session)
//! * **pump thread** (`nexus-uds-pump`): blocks on [`DiagCanPort::recv_timeout`] (50 ms), observes
//!   HAL timestamps / PDU boundaries and forwards events to the ISO-TP worker
//!   (see [`bridge`](self::bridge)).
//! * **`automotive` worker thread**: owned by `AsyncCanAdapter`, runs our `PortAdapter`
//!   (blocking `recv_timeout`, no spin).
//! * **private tokio runtime** (`multi_thread`, 1 worker, timers only, `nexus-uds-rt`): runs the
//!   ISO-TP futures, the persistent receiver and the TesterPresent task. A private runtime keeps
//!   the API independent of the caller's runtime and lets `close()` join every thread it
//!   started. Blocking calls submit a future with `spawn` and wait on a std channel, so they
//!   work from any thread (`Runtime::block_on` would panic inside another runtime).
//!
//! Idle cost: ~20 wake-ups/s on the pump, ~20/s on the worker, 1/s from the ISO-TP idle timer.

mod bridge;
mod capture;
mod conversation;
mod engine;
mod format;
mod nrc;

pub use bridge::{ISOTP_MAX_WFT, MAX_RESPONSE_PDU};
pub use capture::{classify_kind, IsoTpCapture, TxnTag, ISOTP_CAPTURE_CAPACITY};
pub use conversation::{CONVERSATION_BYTE_BUDGET, CONVERSATION_CAPACITY};
pub use engine::MAX_REQUEST_PDU;
pub use format::{
    decode_did_record, dtc_format_name, format_dtc_code, parse_dtc_count,
    parse_dtc_ext_data_record, parse_dtc_list, parse_dtc_snapshot_identification,
    parse_dtc_snapshot_record, parse_dtcs_by_status, parse_read_dtc_report, response_matches,
};
pub use nrc::nrc_name;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use automotive::can::Identifier;
use automotive::transports::isotp::{IsoTPConfig, IsoTPConfigBuilder};
use parking_lot::Mutex;

use self::bridge::{Addressing, BridgeShared, PortMsg, CRATE_BUS, PORT_QUEUE_DEPTH};
use self::engine::{
    err, keepalive_loop, ExchangeOpts, Inner, BUSY_RETRY_DELAY_RANGE_MS,
    DEFAULT_BUSY_RETRY_DELAY_MS, ISOTP_TIMEOUT, MAX_BUSY_RETRIES, MAX_EXCHANGE,
    NRC_BUSY_REPEAT_REQUEST, TP_INTERVAL_RANGE_MS,
};
use self::format::negative_code;
use super::addressing::{check_id_forms, resolve_address_bytes, AddressBytes};
use super::dto::{
    ConversationPageDto, DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto,
    DiagSessionInfoDto, DidReadResultDto, DtcEntryDto, IsoTpFramePageDto, UdsAddressing,
    UdsRequestOptionsDto, UdsResponseDto,
};
use super::port::DiagCanPort;

/// Threads / runtime owned by one session; taken on close.
struct Resources {
    runtime: tokio::runtime::Runtime,
    pump: JoinHandle<()>,
    pump_stop: Arc<AtomicBool>,
}

/// One tester ↔ ECU session on one bus.
pub struct UdsSession {
    inner: Arc<Inner>,
    handle: tokio::runtime::Handle,
    resources: Mutex<Option<Resources>>,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<UdsSession>();
};

fn identifier(id: u32, extended: bool, what: &str) -> Result<Identifier, DiagError> {
    let r = if extended {
        Identifier::extended(id)
    } else {
        Identifier::standard(id)
    };
    r.map_err(|_| {
        err(
            DiagErrorCode::InvalidInput,
            format!(
                "{what} {id:#X} is not a valid {} CAN id",
                if extended { "29-bit" } else { "11-bit" }
            ),
        )
    })
}

/// Validates the ISO 15765-2 address format of `cfg` (address bytes + id forms).
pub fn session_address_bytes(cfg: &DiagSessionConfigDto) -> Result<AddressBytes, DiagError> {
    let invalid = |m: String| err(DiagErrorCode::InvalidInput, m);
    let bytes = resolve_address_bytes(cfg.address_format, cfg.target_address, cfg.response_address)
        .map_err(invalid)?;
    check_id_forms(
        cfg.address_format,
        cfg.is_extended_id,
        &[
            ("requestId", cfg.request_id),
            ("responseId", cfg.response_id),
        ],
        cfg.functional_id,
    )
    .map_err(invalid)?;
    Ok(bytes)
}

fn isotp_config(
    builder: IsoTPConfigBuilder,
    cfg: &DiagSessionConfigDto,
    addr: AddressBytes,
) -> Result<IsoTPConfig, DiagError> {
    let mut b = builder.bus(CRATE_BUS).fd(cfg.use_fd).timeout(ISOTP_TIMEOUT);
    // Functional requests use the same N_TA / N_AE byte as physical ones.
    if let Some(tx) = addr.tx {
        b = b.ext_address(tx);
        if let Some(rx) = addr.rx {
            b = b.rx_ext_address(rx);
        }
    }
    let b = match cfg.padding {
        Some(p) => b.padding(p),
        None => b.without_padding(),
    };
    b.build().map_err(|e| {
        err(
            DiagErrorCode::InvalidInput,
            format!("invalid ISO-TP configuration: {e}"),
        )
    })
}

fn nrc_error(nrc: u8) -> DiagError {
    err(
        DiagErrorCode::NegativeResponse,
        format!("nrc=0x{nrc:02X} {}", nrc_name(nrc)),
    )
}

impl UdsSession {
    /// Opens the session over `port` (tap already filtered to request/response/functional ids).
    pub fn open(
        port: Box<dyn DiagCanPort>,
        config: DiagSessionConfigDto,
    ) -> Result<Self, DiagError> {
        let port: Arc<dyn DiagCanPort> = Arc::from(port);
        if port.is_closed() {
            return Err(err(
                DiagErrorCode::SessionClosed,
                "diagnostic tap is already closed",
            ));
        }
        if config.use_fd && !port.fd_enabled() {
            return Err(err(
                DiagErrorCode::InvalidInput,
                "useFd requires a channel opened with CAN-FD",
            ));
        }
        let ext = config.is_extended_id;
        let req = identifier(config.request_id, ext, "requestId")?;
        let resp = identifier(config.response_id, ext, "responseId")?;
        let addr = session_address_bytes(&config)?;
        let phys_cfg = isotp_config(IsoTPConfig::builder(req).rx_id(resp), &config, addr)?;
        let func_cfg = match config.functional_id {
            Some(f) => {
                let fid = identifier(f, ext, "functionalId")?;
                Some(isotp_config(
                    IsoTPConfig::builder(fid).rx_id(resp),
                    &config,
                    addr,
                )?)
            }
            None => None,
        };

        let bridge = Arc::new(BridgeShared::new(Addressing {
            request_id: config.request_id,
            response_id: config.response_id,
            functional_id: config.functional_id,
            extended: ext,
            fd: config.use_fd,
            padding: config.padding,
            addr,
        }));
        let (port_tx, port_rx) = crossbeam_channel::bounded::<PortMsg>(PORT_QUEUE_DEPTH);

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .thread_name("nexus-uds-rt")
            .enable_time()
            .build()
            .map_err(|e| {
                err(
                    DiagErrorCode::Internal,
                    format!("cannot start UDS runtime: {e}"),
                )
            })?;
        let handle = runtime.handle().clone();

        let inner = Arc::new(Inner::new(
            config,
            port.clone(),
            bridge.clone(),
            port_tx.clone(),
            port_rx,
            phys_cfg,
            func_cfg,
        ));

        let pump_stop = Arc::new(AtomicBool::new(false));
        let pump = {
            let (port, bridge, stop) = (port.clone(), bridge.clone(), pump_stop.clone());
            let weak = Arc::downgrade(&inner);
            std::thread::Builder::new()
                .name("nexus-uds-pump".into())
                .spawn(move || {
                    bridge::pump_loop(port, bridge, port_tx, stop);
                    if let Some(inner) = weak.upgrade() {
                        if !inner.client_closed.load(Ordering::Acquire) {
                            inner.log_closed("tap_closed");
                        }
                    }
                })
                .map_err(|e| {
                    err(
                        DiagErrorCode::Internal,
                        format!("cannot start UDS pump thread: {e}"),
                    )
                })?
        };

        handle.spawn(keepalive_loop(inner.clone(), inner.tp_cfg.subscribe()));

        Ok(Self {
            inner,
            handle,
            resources: Mutex::new(Some(Resources {
                runtime,
                pump,
                pump_stop,
            })),
        })
    }

    /// Runs `fut` on the session runtime and blocks the calling thread for its result.
    fn run<T, F>(&self, fut: F) -> Result<T, DiagError>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T, DiagError>> + Send + 'static,
    {
        if self.inner.client_closed.load(Ordering::Acquire) {
            return Err(err(DiagErrorCode::SessionClosed, "UDS session was closed"));
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.handle.spawn(async move {
            let _ = tx.send(fut.await);
        });
        rx.recv()
            .unwrap_or_else(|_| Err(err(DiagErrorCode::SessionClosed, "UDS session was closed")))
    }

    /// Sends `[sid, data...]` and waits for the matching final response (0x78 aware).
    ///
    /// Timing: the response must START within P2client (ECU P2 from 0x50, default 50 ms,
    /// plus `p2MarginMs`); each 0x78 restarts a P2*client wait. `opts.timeout_ms` replaces the
    /// initial wait and caps the whole exchange. Concurrent callers queue; `busy` only when the
    /// queue wait exceeds the request's own budget (`timeout_ms`, else P2*client).
    pub fn request(
        &self,
        sid: u8,
        data: &[u8],
        opts: &UdsRequestOptionsDto,
    ) -> Result<UdsResponseDto, DiagError> {
        if opts.timeout_ms == Some(0) {
            return Err(err(DiagErrorCode::InvalidInput, "timeoutMs must be > 0"));
        }
        let mut pdu = Vec::with_capacity(data.len() + 1);
        pdu.push(sid);
        pdu.extend_from_slice(data);
        let addressing = opts.addressing.unwrap_or(UdsAddressing::Physical);
        let origin = opts.origin.unwrap_or_default();
        let total = opts
            .timeout_ms
            .map(|ms| Duration::from_millis(u64::from(ms)));
        let busy_max = match addressing {
            UdsAddressing::Physical => opts.busy_retry_max.unwrap_or(0).min(MAX_BUSY_RETRIES),
            // A functional retry would re-broadcast to every ECU.
            UdsAddressing::Functional => 0,
        };
        let (lo, hi) = BUSY_RETRY_DELAY_RANGE_MS;
        let busy_delay = Duration::from_millis(u64::from(
            opts.busy_retry_delay_ms
                .unwrap_or(DEFAULT_BUSY_RETRY_DELAY_MS)
                .clamp(lo, hi),
        ));
        let inner = self.inner.clone();
        self.run(async move {
            let queue_wait = total.unwrap_or_else(|| inner.timings().1);
            let mut eng = tokio::time::timeout(queue_wait, inner.engine.lock())
                .await
                .map_err(|_| {
                    err(
                        DiagErrorCode::Busy,
                        format!(
                            "another request is still in progress after {} ms",
                            queue_wait.as_millis()
                        ),
                    )
                })?;
            // First attempt unchanged; 0x21 retries end within timeoutMs (if set) counted from
            // the first send, and never beyond MAX_EXCHANGE.
            let start = Instant::now();
            let cap = start + total.unwrap_or(MAX_EXCHANGE).min(MAX_EXCHANGE);
            let mut o = ExchangeOpts::new(total, origin);
            let mut ex = inner.exchange(&mut eng, &pdu, addressing, o).await?;
            o.cap = Some(cap);
            let mut retries: u8 = 0;
            while retries < busy_max && negative_code(&ex.raw) == Some(NRC_BUSY_REPEAT_REQUEST) {
                let at = Instant::now() + busy_delay;
                if at >= cap {
                    break;
                }
                inner.busy_retry_wait(at).await;
                retries += 1;
                // New transmission: same gates / tap checks as the first attempt (a closed
                // gate or tap fails here before any TX).
                o.retry = Some(retries);
                o.total = total.map(|_| cap.saturating_duration_since(Instant::now()));
                ex = inner.exchange(&mut eng, &pdu, addressing, o).await?;
            }
            let nrc = negative_code(&ex.raw);
            Ok(UdsResponseDto {
                positive: nrc.is_none(),
                suppressed: ex.suppressed,
                nrc,
                nrc_name: nrc.map(nrc_name),
                response_pending_count: ex.pending_count,
                elapsed_us: ex.elapsed_us,
                transaction_seq: ex.seq,
                busy_retry_count: retries,
                raw: ex.raw,
            })
        })
    }

    /// 0x22 for one DID (origin [`DiagOrigin::Did`]). A negative response → `Err` with code
    /// `NegativeResponse` and message `"nrc=0xXX <nrcName>"` (raw `request` instead returns
    /// `Ok(positive=false)`).
    pub fn read_did(&self, did: u16) -> Result<DidReadResultDto, DiagError> {
        self.read_did_with(did, DiagOrigin::Did)
    }

    /// [`Self::read_did`] with an explicit origin tag for the conversation log.
    pub fn read_did_with(
        &self,
        did: u16,
        origin: DiagOrigin,
    ) -> Result<DidReadResultDto, DiagError> {
        let opts = UdsRequestOptionsDto {
            origin: Some(origin),
            ..Default::default()
        };
        let r = self.request(0x22, &did.to_be_bytes(), &opts)?;
        if let Some(nrc) = r.nrc {
            return Err(nrc_error(nrc));
        }
        if r.raw.len() < 3 || r.raw[1..3] != did.to_be_bytes() {
            return Err(err(
                DiagErrorCode::UnexpectedResponse,
                format!("malformed 0x62 response for DID {did:04X}"),
            ));
        }
        let raw = r.raw[3..].to_vec();
        Ok(DidReadResultDto {
            did,
            decoded: decode_did_record(&raw),
            raw,
            transaction_seq: r.transaction_seq,
        })
    }

    /// 0x19 0x02 with `status_mask` (origin [`DiagOrigin::Dtc`]).
    pub fn read_dtcs_by_status(&self, status_mask: u8) -> Result<Vec<DtcEntryDto>, DiagError> {
        self.read_dtcs_by_status_with(status_mask, DiagOrigin::Dtc)
    }

    /// [`Self::read_dtcs_by_status`] with an explicit origin tag for the conversation log.
    pub fn read_dtcs_by_status_with(
        &self,
        status_mask: u8,
        origin: DiagOrigin,
    ) -> Result<Vec<DtcEntryDto>, DiagError> {
        let opts = UdsRequestOptionsDto {
            origin: Some(origin),
            ..Default::default()
        };
        let r = self.request(0x19, &[0x02, status_mask], &opts)?;
        if let Some(nrc) = r.nrc {
            return Err(nrc_error(nrc));
        }
        parse_dtcs_by_status(&r.raw).ok_or_else(|| {
            err(
                DiagErrorCode::UnexpectedResponse,
                "malformed 0x59 0x02 response",
            )
        })
    }

    /// Background TesterPresent (`3E 80`), serialized with requests. `interval_ms` default 2000.
    pub fn set_tester_present(
        &self,
        enabled: bool,
        interval_ms: Option<u32>,
    ) -> Result<(), DiagError> {
        if self.inner.is_closed() {
            return Err(err(DiagErrorCode::SessionClosed, "UDS session is closed"));
        }
        let interval = match interval_ms {
            Some(ms) if !TP_INTERVAL_RANGE_MS.contains(&ms) => {
                return Err(err(
                    DiagErrorCode::InvalidInput,
                    format!(
                        "intervalMs must be {}..={}",
                        TP_INTERVAL_RANGE_MS.start(),
                        TP_INTERVAL_RANGE_MS.end()
                    ),
                ));
            }
            Some(ms) => ms,
            None => self.inner.state.lock().tester_present_interval_ms,
        };
        {
            let mut st = self.inner.state.lock();
            st.tester_present_enabled = enabled;
            st.tester_present_interval_ms = interval;
        }
        self.inner.tp_cfg.send_replace((enabled, interval));
        Ok(())
    }

    pub fn info(&self) -> DiagSessionInfoDto {
        let st = self.inner.state.lock().clone();
        DiagSessionInfoDto {
            config: self.inner.config.clone(),
            open: !self.inner.is_closed(),
            active_session: st.active_session,
            unlocked_level: st.unlocked_level,
            tester_present_enabled: st.tester_present_enabled,
            tester_present_interval_ms: st.tester_present_interval_ms,
            p2_server_ms: st.p2_server_ms,
            p2_star_server_ms: st.p2_star_server_ms,
            last_seq: self.inner.log.lock().last_seq(),
        }
    }

    /// Conversation events with `seq > since_seq`, at most `max`.
    pub fn conversation_since(&self, since_seq: u64, max: usize) -> ConversationPageDto {
        self.inner.log.lock().since(since_seq, max)
    }

    /// ISO-TP Monitor: CAN frames (tap `Rx` + `TxConfirmed`, bus order) with `seq > since_seq`,
    /// at most `max`, each tagged with the conversation `seq` of the exchange in flight
    /// (`requestSeq`). Frames of an exchange whose request event is not logged yet are held back
    /// until the next call. Works on a closed session too (the ring is kept until drop).
    pub fn isotp_frames_since(&self, since_seq: u64, max: usize) -> IsoTpFramePageDto {
        self.inner.bridge.capture.since(since_seq, max)
    }

    /// Stops keepalive, closes the tap. Idempotent; later calls on this session return
    /// `SessionClosed` (contract change approved by team-lead: `&self` for `Arc<UdsSession>`).
    pub fn close(&self) {
        let Some(res) = self.resources.lock().take() else {
            return;
        };
        self.inner.client_closed.store(true, Ordering::Release);
        self.inner.state.lock().tester_present_enabled = false;
        self.inner
            .tp_cfg
            .send_replace((false, self.inner.state.lock().tester_present_interval_ms));
        self.inner.log_closed("client_close");
        // Stop the ISO-TP worker first (it blocks ≤ 50 ms in recv; the kick wakes it now).
        let _ = self.inner.kick.try_send(PortMsg::Kick);
        if let Some(adapter) = self.inner.adapter_handle.lock().take() {
            adapter.close();
        }
        res.pump_stop.store(true, Ordering::Release);
        let _ = res.pump.join();
        // Drop tasks (they hold the IsoTP stack and the port). Blocking shutdown is not allowed
        // from inside another runtime; there the worker exits on its own right after.
        if tokio::runtime::Handle::try_current().is_ok() {
            res.runtime.shutdown_background();
        } else {
            res.runtime.shutdown_timeout(Duration::from_secs(2));
        }
        // Release the ISO-TP stack and the port: the HAL tap is freed now, not at drop.
        if let Ok(mut eng) = self.inner.engine.try_lock() {
            *eng = engine::Engine::default();
        }
        self.inner.release_port();
    }
}

impl Drop for UdsSession {
    fn drop(&mut self) {
        self.close();
    }
}
