//! [`Channel`]: streaming RX / TX over one channel WebSocket.

use std::net::Shutdown;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::BytesMut;
use tungstenite::Message;

use super::device::DeviceInner;
use super::ws::{is_timeout, map_error, Ws};
use super::{Device, Error};
use crate::proto::{encode_hdlc, CanFrame, Decoder, DecoderStats, EncodeError, Event};

/// Close-confirmation wait per §2.7 step (WS close, then `DELETE /ws`).
const CLOSE_ACK_WAIT: Duration = Duration::from_millis(500);
/// Smallest socket read timeout used by [`Channel::poll`] (a zero timeout is not allowed).
const MIN_WAIT: Duration = Duration::from_millis(1);
/// Re-arm the socket read timeout only when the remaining time shrank by more than this.
const REARM_SLACK: Duration = Duration::from_millis(1);
/// TX staging buffer; [`encode_hdlc`] caps each HDLC frame at [`crate::proto::MAX_WIRE_HDLC`].
const TX_BUF: usize = 1500;
/// Capacity of the reused TX message buffer (≥ one HDLC frame).
const TX_MSG_CAP: usize = 2 * TX_BUF;

/// One open CAN channel (`wss://<host>/api/can/{ch}/ws`).
///
/// RX: [`Channel::poll`] feeds binary WebSocket messages into the streaming [`Decoder`] (HDLC
/// frames are not aligned to messages). TX: [`Channel::send`] packs frames into HDLC frames of at
/// most 1400 bytes, one binary message each. RX allocates per WebSocket message at most, never per
/// CAN frame. TX reuses one message buffer (no SDK allocation in steady state); the TLS layer
/// (rustls) still allocates one record buffer per flushed write, i.e. per `send` call. Close with [`Channel::close`]; dropping performs the same §2.7
/// sequence best-effort.
pub struct Channel {
    dev: Arc<DeviceInner>,
    ch: u8,
    ws: Ws,
    decoder: Decoder,
    tx_buf: [u8; TX_BUF],
    /// Reused message buffer: each message is `split().freeze()`d off it; tungstenite copies the
    /// payload into its write buffer and drops it, so `reserve` reclaims the same allocation.
    tx_msg: BytesMut,
    /// Read timeout currently set on the socket.
    armed: Option<Duration>,
    /// Set once the connection ended (peer close / error); later calls fail with this reason.
    ended: Option<String>,
    /// Close sequence already ran.
    done: bool,
    text_messages: u64,
}

impl std::fmt::Debug for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Channel")
            .field("ch", &self.ch)
            .field("ended", &self.ended)
            .field("stats", &self.decoder.stats())
            .finish_non_exhaustive()
    }
}

impl Channel {
    pub(crate) fn new(dev: Arc<DeviceInner>, ch: u8, ws: Ws) -> Self {
        Self {
            dev,
            ch,
            ws,
            decoder: Decoder::new(),
            tx_buf: [0; TX_BUF],
            tx_msg: BytesMut::with_capacity(TX_MSG_CAP),
            armed: None,
            ended: None,
            done: false,
            text_messages: 0,
        }
    }

    /// Channel number (1-based).
    pub fn number(&self) -> u8 {
        self.ch
    }

    fn check_open(&self) -> Result<(), Error> {
        match (&self.ended, self.done) {
            (Some(reason), _) => Err(Error::Ws(reason.clone())),
            (None, true) => Err(Error::Ws("channel closed".into())),
            (None, false) => Ok(()),
        }
    }

    /// Sets the socket read timeout to `d` unless the armed value is already within slack.
    fn arm(&mut self, d: Duration) -> Result<(), Error> {
        let d = d.max(MIN_WAIT);
        let keep = matches!(self.armed, Some(cur) if cur >= d && cur <= d + REARM_SLACK);
        if !keep {
            self.ws.get_ref().sock.set_read_timeout(Some(d))?;
            self.armed = Some(d);
        }
        Ok(())
    }

    /// Delivers received events to `sink`, waiting at most about `timeout` (+≤ 1 ms) in total.
    /// Returns the number of events delivered (`0` on timeout). After the device ended the
    /// session (close, `DELETE /ws`, connection loss) it returns an error.
    pub fn poll(
        &mut self,
        timeout: Duration,
        sink: &mut impl FnMut(Event),
    ) -> Result<usize, Error> {
        self.check_open()?;
        let deadline = Instant::now() + timeout;
        let mut n = 0usize;
        let mut first = true;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if !first && remaining.is_zero() {
                return Ok(n);
            }
            first = false;
            self.arm(remaining)?;
            match self.ws.read() {
                Ok(Message::Binary(b)) => {
                    self.decoder.push(&b, &mut |e| {
                        n += 1;
                        sink(e);
                    });
                }
                Ok(Message::Text(_)) => self.text_messages += 1,
                Ok(Message::Close(_)) => {
                    // tungstenite queued the confirmation; push it out.
                    let _ = self.ws.flush();
                    self.ended = Some("WebSocket closed by the device".into());
                    return if n > 0 {
                        Ok(n)
                    } else {
                        self.check_open().map(|()| 0)
                    };
                }
                Ok(_) => {} // ping / pong / raw frame: tungstenite answers pings itself
                Err(e) if is_timeout(&e) => return Ok(n),
                Err(e) => {
                    let e = map_error(e);
                    self.ended = Some(format!("connection lost: {e}"));
                    return if n > 0 { Ok(n) } else { Err(e) };
                }
            }
        }
    }

    /// Sends `frames` (TX_ACK is never set on the wire); large batches are split into several
    /// HDLC frames of ≤ 1400 bytes, one binary WebSocket message each. A frame that cannot be
    /// represented (id / DLC / flag combination, timestamp ≥ 2^48) fails with
    /// [`Error::Protocol`]; frames before it have been queued.
    pub fn send(&mut self, frames: &[CanFrame]) -> Result<(), Error> {
        self.check_open()?;
        let mut i = 0;
        while i < frames.len() {
            let (len, used) = encode_hdlc(&frames[i..], &mut self.tx_buf).map_err(|e| {
                Error::Protocol(match e {
                    EncodeError::InvalidFrame => format!("frame #{i} cannot be encoded"),
                    EncodeError::BufferTooSmall => format!("frame #{i} does not fit one HDLC"),
                })
            })?;
            if used == 0 {
                break;
            }
            // Unique again once the previous message was consumed → reclaims, no allocation.
            self.tx_msg.reserve(TX_MSG_CAP);
            self.tx_msg.extend_from_slice(&self.tx_buf[..len]);
            let msg = Message::Binary(self.tx_msg.split().freeze());
            if let Err(e) = self.ws.write(msg) {
                return Err(self.fail(e));
            }
            i += used;
        }
        if let Err(e) = self.ws.flush() {
            return Err(self.fail(e));
        }
        Ok(())
    }

    fn fail(&mut self, e: tungstenite::Error) -> Error {
        let e = map_error(e);
        if !matches!(e, Error::Io(ref io) if super::ws::is_timeout_io(io)) {
            self.ended = Some(format!("connection lost: {e}"));
        }
        e
    }

    /// Decoder counters (CRC errors, garbage bytes, …).
    pub fn stats(&self) -> DecoderStats {
        self.decoder.stats()
    }

    /// Text WebSocket messages received and ignored (the device only sends binary data).
    pub fn ignored_text_messages(&self) -> u64 {
        self.text_messages
    }

    /// §2.7 close: WebSocket close → wait ≤ 500 ms for the confirmation → otherwise
    /// `DELETE /api/can/{ch}/ws` and wait ≤ 500 ms more → TLS close_notify + TCP shutdown.
    /// Returns the `DELETE` error if that fallback was needed and failed.
    pub fn close(mut self, device: &Device) -> Result<(), Error> {
        self.shutdown(device.inner())
    }

    fn shutdown(&mut self, dev: &DeviceInner) -> Result<(), Error> {
        if self.done {
            return Ok(());
        }
        self.done = true;
        let mut confirmed = self.ended.is_some();
        if !confirmed {
            match self.ws.close(None) {
                Ok(()) => {}
                Err(e) if is_timeout(&e) => {}
                Err(_) => confirmed = true, // already closed / broken: nothing to confirm
            }
            confirmed = confirmed || self.wait_close(CLOSE_ACK_WAIT);
        }
        let mut result = Ok(());
        if !confirmed {
            result = dev.abort_ws(self.ch);
            self.wait_close(CLOSE_ACK_WAIT);
        }
        let s = self.ws.get_mut();
        s.conn.send_close_notify();
        let _ = s.conn.write_tls(&mut s.sock);
        let _ = s.sock.shutdown(Shutdown::Both);
        result
    }

    /// Reads (discarding data) until the close confirmation or end of connection; `false` on timeout.
    fn wait_close(&mut self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || self.arm(remaining).is_err() {
                return false;
            }
            match self.ws.read() {
                Ok(Message::Close(_)) => {
                    let _ = self.ws.flush();
                    return true;
                }
                Ok(_) => {}
                Err(e) if is_timeout(&e) => {}
                Err(_) => return true, // ConnectionClosed / EOF: the session is over
            }
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        let dev = Arc::clone(&self.dev);
        let _ = self.shutdown(&dev);
    }
}
