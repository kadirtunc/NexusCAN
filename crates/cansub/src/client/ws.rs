//! WebSocket upgrade on our own TLS stream (no tungstenite TLS feature, contract §3.5).

use std::time::Instant;

use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::HandshakeError;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::WebSocket;

use super::tls::{TlsStream, TlsTarget};
use super::Error;

/// Channel WebSocket over the device TLS stream.
pub(crate) type Ws = WebSocket<TlsStream>;

/// Largest accepted WebSocket message / frame. The device streams HDLC frames of at most a few
/// KB per message (TX side: ≤ 1400 B, contract §2); anything above 1 MiB is refused with an
/// error before it is buffered.
pub(crate) const MAX_WS_MESSAGE: usize = 1024 * 1024;

/// Write buffer: all messages of one `Channel::send` are coalesced and written by its `flush`
/// (one TLS record for a typical batch); the buffer keeps its capacity across sends.
const WRITE_BUFFER: usize = 16 * 1024;

/// Bounded receive limits and a bounded, reused write buffer.
pub(crate) fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_MESSAGE))
        .write_buffer_size(WRITE_BUFFER)
        .max_write_buffer_size(WRITE_BUFFER + MAX_WS_MESSAGE)
}

/// `true` for read / write timeouts (`SO_RCVTIMEO` → `WouldBlock` on Unix, `TimedOut` on Windows).
pub(crate) fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if is_timeout_io(io))
}

pub(crate) fn is_timeout_io(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/// Maps a tungstenite error (upgrade refusals: 409 → [`Error::Busy`]).
pub(crate) fn map_error(e: tungstenite::Error) -> Error {
    match e {
        tungstenite::Error::Io(io) => Error::Io(io),
        tungstenite::Error::Http(resp) => {
            let status = resp.status().as_u16();
            if status == 409 {
                Error::Busy
            } else {
                Error::Http {
                    status,
                    body: resp
                        .body()
                        .as_deref()
                        .map(|b| String::from_utf8_lossy(b).trim().to_string())
                        .unwrap_or_default(),
                }
            }
        }
        tungstenite::Error::Tls(t) => Error::Tls(t.to_string()),
        other => Error::Ws(other.to_string()),
    }
}

/// Opens `wss://<host>/api/can/{ch}/ws` (TLS + upgrade, bounded by the connect timeout).
pub(crate) fn open(target: &TlsTarget, ch: u8) -> Result<Ws, Error> {
    let stream = target.connect()?;
    let url = format!("wss://{}/api/can/{ch}/ws", target.endpoint.authority);
    let request = url.into_client_request().map_err(map_error)?;
    let deadline = Instant::now() + target.timeout;
    let mut attempt = tungstenite::client::client_with_config(request, stream, Some(config()));
    loop {
        match attempt {
            Ok((ws, _response)) => return Ok(ws),
            Err(HandshakeError::Interrupted(mid)) => {
                if Instant::now() >= deadline {
                    return Err(Error::Io(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "WebSocket upgrade timed out",
                    )));
                }
                attempt = mid.handshake();
            }
            Err(HandshakeError::Failure(e)) => return Err(map_error(e)),
        }
    }
}
