//! Per-channel WebSocket session: RX generation, client TX handling, chaos and close semantics (§2.7).

use std::cell::Cell;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::handshake::HandshakeError;
use tungstenite::http::StatusCode;
use tungstenite::{Bytes, Error as WsError, Message, WebSocket};

use super::http::{Prefixed, TlsStream};
use super::source::{mock_frame, Rng};
use super::wire::{self, Decoder, SimFrame, MAX_CAN_BYTES, MAX_HDLC_WIRE};
use super::{lock, ChannelState, Shared, SimCloseKind, SimSource};

type Ws = WebSocket<Prefixed<TlsStream>>;

/// Socket read timeout inside a session = loop pacing when idle.
const POLL: Duration = Duration::from_millis(1);
/// Max frames generated per loop iteration (bounds burst size after a stall).
const MAX_BATCH: u64 = 8192;
/// Max WebSocket reads handled per loop iteration.
const MAX_READS: usize = 64;
/// Max chunk size used by `split_ws`.
const SPLIT_MAX: usize = 512;

/// Upgrades the connection (one client per channel; a second one gets 409 Conflict) and runs the session.
// `ErrorResponse` size is dictated by tungstenite's `Callback` signature.
#[allow(clippy::result_large_err)]
pub(crate) fn serve(shared: &Arc<Shared>, ch: u8, stream: Prefixed<TlsStream>) {
    let Some(st) = shared.channel(ch) else { return };
    let claimed = Cell::new(false);
    let callback = |_req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if st
            .ws_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            claimed.set(true);
            Ok(resp)
        } else {
            let mut r = ErrorResponse::new(Some(
                "CAN channel busy: only one WebSocket client per channel".into(),
            ));
            *r.status_mut() = StatusCode::CONFLICT;
            Err(r)
        }
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut attempt = tungstenite::accept_hdr(stream, callback);
    let ws = loop {
        match attempt {
            Ok(ws) => break Some(ws),
            Err(HandshakeError::Interrupted(mid)) => {
                if shared.stopping() || Instant::now() > deadline {
                    break None;
                }
                attempt = mid.handshake();
            }
            Err(HandshakeError::Failure(_)) => break None,
        }
    };
    let Some(ws) = ws else {
        if claimed.get() {
            release(st);
        }
        return;
    };
    // A fresh session: discard stale abort requests.
    st.abort.store(false, Ordering::Release);
    let mut session = Session::new(shared, st, ch);
    let kind = session.run(ws);
    release(st);
    if let Some(kind) = kind {
        lock(&shared.ws_closes).push((ch, kind));
    }
}

fn release(st: &ChannelState) {
    lock(&st.inject).clear();
    st.abort.store(false, Ordering::Release);
    st.ws_active.store(false, Ordering::Release);
}

fn is_timeout(e: &WsError) -> bool {
    matches!(e, WsError::Io(io) if matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted))
}

struct Session<'a> {
    shared: &'a Shared,
    st: &'a ChannelState,
    ch: u8,
    rng: Rng,
    /// Raw (unstuffed) CAN frames of the HDLC being built.
    payload: Vec<u8>,
    payload_stuffed: usize,
    /// Wire bytes of the next WebSocket message(s).
    msg: Vec<u8>,
    tmp: [u8; MAX_CAN_BYTES],
    decoder: Decoder,
    tx_scratch: Vec<SimFrame>,
    inject_scratch: Vec<SimFrame>,
}

impl<'a> Session<'a> {
    fn new(shared: &'a Shared, st: &'a ChannelState, ch: u8) -> Self {
        let seed = shared.chaos.seed ^ (u64::from(ch) << 56);
        Self {
            shared,
            st,
            ch,
            rng: Rng::new(seed),
            payload: Vec::with_capacity(MAX_HDLC_WIRE),
            payload_stuffed: 0,
            msg: Vec::with_capacity(64 * 1024),
            tmp: [0; MAX_CAN_BYTES],
            decoder: Decoder::new(),
            tx_scratch: Vec::with_capacity(1024),
            inject_scratch: Vec::with_capacity(1024),
        }
    }

    /// Returns how the session ended (`None` = emulator shutdown).
    fn run(&mut self, mut ws: Ws) -> Option<SimCloseKind> {
        if ws
            .get_ref()
            .inner
            .sock
            .set_read_timeout(Some(POLL))
            .is_err()
        {
            return Some(SimCloseKind::TcpDrop);
        }
        let start = Instant::now();
        let mut emitted: u64 = 0;
        let mut replay_idx = 0usize;
        let replay = Arc::clone(&self.shared.replay);
        let replay_ch: &[(u64, SimFrame)] = replay
            .get(usize::from(self.ch) - 1)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut next_err = start + Duration::from_millis(20);
        let mut rate_mark = (start, self.st.frame_count.load(Ordering::Acquire));
        let mut frame = SimFrame::default();

        loop {
            if self.shared.stopping() {
                self.discard();
                close_and_linger(&mut ws, Duration::from_millis(20));
                return None;
            }
            if self.st.abort.load(Ordering::Acquire) {
                // DELETE /ws: discard queued data, complete the close immediately.
                self.discard();
                close_and_linger(&mut ws, Duration::from_millis(100));
                return Some(SimCloseKind::Delete);
            }

            // ---- client → device ----
            for _ in 0..MAX_READS {
                match ws.read() {
                    Ok(Message::Binary(b)) => {
                        if self.handle_tx(&b) && self.flush_out(&mut ws).is_err() {
                            return Some(SimCloseKind::TcpDrop);
                        }
                    }
                    Ok(Message::Close(_)) => {
                        // TX is processed on arrival, so the queue is already drained: confirm the close.
                        self.discard();
                        if let Some(delay) = self.shared.chaos.close_ack_delay {
                            if self.delay_close_ack(delay) {
                                let _ = finish_close(&mut ws);
                                return Some(SimCloseKind::Delete);
                            }
                        }
                        return Some(finish_close(&mut ws));
                    }
                    Ok(_) => {} // text / ping / pong: ignored (pong replies are automatic)
                    Err(e) if is_timeout(&e) => break,
                    Err(WsError::ConnectionClosed) => return Some(SimCloseKind::WsClose),
                    Err(_) => return Some(SimCloseKind::TcpDrop),
                }
            }

            // ---- device → client ----
            let now = Instant::now();
            let clock = *lock(&self.shared.clock);
            match &self.shared.source {
                SimSource::Mock { fps } if *fps > 0 => {
                    let fps = u64::from(*fps);
                    let due = (now - start).as_nanos() as u64 / 1000 * fps / 1_000_000;
                    if due > emitted + 2 * MAX_BATCH {
                        emitted = due - MAX_BATCH; // fell behind: skip instead of bursting forever
                    }
                    let end = due.min(emitted + MAX_BATCH);
                    while emitted < end {
                        mock_frame(self.ch, emitted, &mut frame);
                        let at = start + Duration::from_nanos(emitted * 1_000_000_000 / fps);
                        frame.timestamp = clock.device_us_at(at) & wire::TIMESTAMP_MASK;
                        self.push_frame(&frame);
                        emitted += 1;
                    }
                }
                SimSource::Replay(_) => {
                    let elapsed = (now - start).as_micros() as u64;
                    while let Some((off, f)) =
                        replay_ch.get(replay_idx).filter(|(off, _)| *off <= elapsed)
                    {
                        frame = *f;
                        frame.timestamp = clock.device_us_at(start + Duration::from_micros(*off))
                            & wire::TIMESTAMP_MASK;
                        self.push_frame(&frame);
                        replay_idx += 1;
                    }
                }
                _ => {}
            }
            {
                let mut q = lock(&self.st.inject);
                self.inject_scratch.extend(q.drain(..));
            }
            let mut injected = std::mem::take(&mut self.inject_scratch);
            for f in &mut injected {
                if f.timestamp == 0 {
                    f.timestamp = clock.device_us_at(now) & wire::TIMESTAMP_MASK;
                }
                self.push_frame(f);
            }
            injected.clear();
            self.inject_scratch = injected;

            if self.shared.chaos.inject_errors
                && self.st.error_frames.load(Ordering::Acquire)
                && now >= next_err
            {
                // Codes 0..=4 are defined; 5 exercises the "unknown code" path of clients.
                let mut e = SimFrame::error_frame(self.rng.range(0, 5) as u8);
                e.timestamp = clock.device_us_at(now) & wire::TIMESTAMP_MASK;
                self.push_frame(&e);
                self.st.bus_errors.fetch_add(1, Ordering::AcqRel);
                next_err = now + Duration::from_millis(self.rng.range(20, 80) as u64);
            }

            if self.flush_out(&mut ws).is_err() {
                return Some(SimCloseKind::TcpDrop);
            }

            if now.duration_since(rate_mark.0) >= Duration::from_secs(1) {
                let count = self.st.frame_count.load(Ordering::Acquire);
                let dt = now.duration_since(rate_mark.0).as_secs_f64();
                self.st.frame_rate.store(
                    ((count - rate_mark.1) as f64 / dt) as u64,
                    Ordering::Release,
                );
                rate_mark = (now, count);
            }
        }
    }

    /// Waits `delay` before confirming a client close; `true` if a `DELETE /ws` (or shutdown) cut it short.
    fn delay_close_ack(&self, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        while Instant::now() < deadline {
            if self.st.abort.load(Ordering::Acquire) || self.shared.stopping() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }

    /// Decodes client TX; returns `true` when TX acknowledgements were queued.
    fn handle_tx(&mut self, bytes: &[u8]) -> bool {
        let scratch = &mut self.tx_scratch;
        scratch.clear();
        self.decoder.push(bytes, |f| scratch.push(*f));
        let mut tx = std::mem::take(&mut self.tx_scratch);
        let mut acked = false;
        let listen_only = self.st.listen_only.load(Ordering::Acquire);
        let ack = self.st.tx_ack_frames.load(Ordering::Acquire);
        for f in tx.iter().filter(|f| f.error.is_none()) {
            if listen_only {
                self.st.dropped_tx.fetch_add(1, Ordering::AcqRel);
                continue;
            }
            self.st.received_tx.fetch_add(1, Ordering::AcqRel);
            if ack {
                let mut a = *f;
                a.tx_ack = true;
                a.timestamp =
                    lock(&self.shared.clock).device_us_at(Instant::now()) & wire::TIMESTAMP_MASK;
                self.push_frame(&a);
                acked = true;
            }
        }
        tx.clear();
        self.tx_scratch = tx;
        acked
    }

    fn push_frame(&mut self, f: &SimFrame) {
        let n = wire::serialize_frame(f, &mut self.tmp);
        let s = wire::stuffed_len(&self.tmp[..n]);
        // 2 boundary bytes + worst-case 8 stuffed CRC bytes.
        if !self.payload.is_empty() && self.payload_stuffed + s + 10 > MAX_HDLC_WIRE {
            self.finish_hdlc();
        }
        self.payload.extend_from_slice(&self.tmp[..n]);
        self.payload_stuffed += s;
        self.st.frame_count.fetch_add(1, Ordering::AcqRel);
    }

    fn finish_hdlc(&mut self) {
        if self.payload.is_empty() {
            return;
        }
        let chaos = &self.shared.chaos;
        if self.rng.chance(chaos.garbage) {
            for _ in 0..self.rng.range(1, 8) {
                let b = self.rng.next_u64() as u8;
                self.msg.push(if b == wire::FLAG { 0x00 } else { b });
            }
        }
        let mut crc = wire::crc32(&self.payload);
        if self.rng.chance(chaos.corrupt_crc) {
            crc ^= 1 << self.rng.range(0, 31);
        }
        wire::push_hdlc_with_crc(&self.payload, crc, &mut self.msg);
        self.payload.clear();
        self.payload_stuffed = 0;
    }

    fn discard(&mut self) {
        self.payload.clear();
        self.payload_stuffed = 0;
        self.msg.clear();
    }

    /// Sends everything built so far (one message, or random chunks with `split_ws`).
    fn flush_out(&mut self, ws: &mut Ws) -> Result<(), WsError> {
        self.finish_hdlc();
        if self.msg.is_empty() {
            return Ok(());
        }
        let result = if self.shared.chaos.split_ws {
            let mut i = 0;
            let mut r = Ok(());
            while i < self.msg.len() && r.is_ok() {
                let n = self.rng.range(1, (self.msg.len() - i).min(SPLIT_MAX));
                r = ws.write(Message::Binary(Bytes::copy_from_slice(&self.msg[i..i + n])));
                i += n;
            }
            r
        } else {
            ws.write(Message::Binary(Bytes::copy_from_slice(&self.msg)))
        };
        self.msg.clear();
        result?;
        ws.flush()
    }
}

/// Client initiated the close: tungstenite queued the confirmation; flush it, then end TLS + TCP.
fn finish_close(ws: &mut Ws) -> SimCloseKind {
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match ws.flush() {
            Ok(()) => break,
            Err(WsError::ConnectionClosed) => break,
            Err(e) if is_timeout(&e) && Instant::now() < deadline => continue,
            Err(_) => return SimCloseKind::TcpDrop,
        }
    }
    end_tls(ws);
    SimCloseKind::WsClose
}

/// Device initiated the close (DELETE / shutdown): send close, wait briefly for the echo, end TLS + TCP.
fn close_and_linger(ws: &mut Ws, linger: Duration) {
    let _ = ws.close(None);
    let deadline = Instant::now() + linger;
    while Instant::now() < deadline {
        match ws.read() {
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {}
            Err(_) => break,
        }
    }
    let _ = ws.flush();
    end_tls(ws);
}

fn end_tls(ws: &mut Ws) {
    let s = &mut ws.get_mut().inner;
    s.conn.send_close_notify();
    let _ = s.conn.complete_io(&mut s.sock);
}
