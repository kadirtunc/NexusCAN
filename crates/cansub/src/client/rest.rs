//! Minimal HTTP/1.1 client over the device TLS stream (keep-alive, `Content-Length` and
//! `Transfer-Encoding: chunked` responses, one reconnect on a stale connection).

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::tls::{TlsStream, TlsTarget};
use super::Error;

const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;
/// Interim (1xx) responses accepted before the final one.
const MAX_INTERIM: usize = 8;
/// Smallest socket read timeout (a zero timeout is not allowed).
const MIN_WAIT: Duration = Duration::from_millis(1);

/// A completed HTTP response.
#[derive(Debug)]
pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Vec<u8>,
}

impl Response {
    /// `Ok(body)` for 2xx, otherwise [`Error::Http`].
    pub(crate) fn ok(self) -> Result<Vec<u8>, Error> {
        if (200..300).contains(&self.status) {
            Ok(self.body)
        } else {
            Err(Error::Http {
                status: self.status,
                body: String::from_utf8_lossy(&self.body).trim().to_string(),
            })
        }
    }
}

/// One keep-alive REST connection.
#[derive(Debug)]
pub(crate) struct Rest {
    target: Arc<TlsTarget>,
    conn: Option<TlsStream>,
    buf: Vec<u8>,
    req: Vec<u8>,
}

fn eof() -> Error {
    Error::Io(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "connection closed by the device",
    ))
}

fn bad(msg: &str) -> Error {
    Error::Protocol(format!("malformed HTTP response: {msg}"))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Reads more bytes into `buf`; EOF is an error (a response is always expected to continue).
fn fill<R: Read>(s: &mut R, buf: &mut Vec<u8>) -> Result<(), Error> {
    let mut tmp = [0u8; 4096];
    let n = s.read(&mut tmp)?;
    if n == 0 {
        return Err(eof());
    }
    buf.extend_from_slice(&tmp[..n]);
    Ok(())
}

fn timed_out() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "HTTP response not complete within the timeout",
    )
}

/// Plaintext reader over the TLS stream whose every socket read is bounded by one overall
/// `deadline` (the socket read timeout is set to the remaining time before each read).
struct Timed<'a> {
    s: &'a mut TlsStream,
    deadline: Instant,
}

impl Read for Timed<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        loop {
            match self.s.conn.reader().read(out) {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                r => return r, // data, clean EOF (close_notify) or UnexpectedEof
            }
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(timed_out());
            }
            if self.s.conn.wants_write() {
                self.s.conn.write_tls(&mut self.s.sock)?;
            }
            self.s
                .sock
                .set_read_timeout(Some(remaining.max(MIN_WAIT)))?;
            match self.s.conn.read_tls(&mut self.s.sock) {
                Ok(_) => {}
                Err(e) if super::ws::is_timeout_io(&e) => return Err(timed_out()),
                Err(e) => return Err(e),
            }
            self.s
                .conn
                .process_new_packets()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        }
    }
}

/// Parses a chunk-size line value (hex digits only; anything above `MAX_BODY` is refused here,
/// so later arithmetic cannot overflow).
fn chunk_size(line: &str) -> Result<usize, Error> {
    let hex = line.split(';').next().unwrap_or("").trim();
    if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad("chunk size"));
    }
    let digits = hex.trim_start_matches('0');
    // MAX_BODY (1 MiB) has 6 hex digits; anything longer cannot be valid here (and could
    // overflow `usize`).
    if digits.len() > 8 {
        return Err(bad("body too large"));
    }
    let size = usize::from_str_radix(if digits.is_empty() { "0" } else { digits }, 16)
        .map_err(|_| bad("chunk size"))?;
    if size > MAX_BODY {
        return Err(bad("body too large"));
    }
    Ok(size)
}

struct Head {
    status: u16,
    len: usize,
    content_length: Option<usize>,
    chunked: bool,
    close: bool,
}

fn parse_head(raw: &[u8]) -> Result<Head, Error> {
    let text = std::str::from_utf8(raw).map_err(|_| bad("head is not UTF-8"))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().ok_or_else(|| bad("empty"))?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(bad("not HTTP/1.x"));
    }
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| bad("status code"))?;
    let mut head = Head {
        status,
        len: raw.len(),
        content_length: None,
        chunked: false,
        close: version == "HTTP/1.0",
    };
    for line in lines.filter(|l| !l.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(bad("header line"));
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(bad("Content-Length"));
                }
                // Overflowing `usize` is a parse error, never a wrap.
                head.content_length = Some(value.parse().map_err(|_| bad("Content-Length"))?);
            }
            "transfer-encoding" => {
                head.chunked = value.to_ascii_lowercase().contains("chunked");
            }
            "connection" => {
                let v = value.to_ascii_lowercase();
                if v.contains("close") {
                    head.close = true;
                } else if v.contains("keep-alive") {
                    head.close = false;
                }
            }
            _ => {}
        }
    }
    Ok(head)
}

impl Rest {
    pub(crate) fn new(target: Arc<TlsTarget>) -> Self {
        Self {
            target,
            conn: None,
            buf: Vec::with_capacity(4096),
            req: Vec::with_capacity(512),
        }
    }

    /// Sends one request; on an I/O failure (other than a timeout) of a reused (possibly stale)
    /// connection, reconnects and retries once. Non-2xx statuses are returned, not mapped to errors.
    pub(crate) fn request(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<Response, Error> {
        // `try_once` takes the connection out and only puts it back after a clean response, so a
        // failed connection is never reused.
        let reused = self.conn.is_some();
        match self.try_once(method, path, body) {
            // A timeout is not a stale connection: retrying would double the time budget.
            Err(Error::Io(e)) if reused && e.kind() != std::io::ErrorKind::TimedOut => {
                self.try_once(method, path, body)
            }
            r => r,
        }
    }

    fn try_once(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<Response, Error> {
        let mut s = match self.conn.take() {
            Some(s) => s,
            None => self.target.connect()?,
        };
        self.req.clear();
        let _ = write!(
            self.req,
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nUser-Agent: cansub-rs/{}\r\n\
             Accept: application/json, text/plain\r\nConnection: keep-alive\r\n",
            self.target.endpoint.authority,
            env!("CARGO_PKG_VERSION"),
        );
        match body {
            Some(b) => {
                let _ = write!(
                    self.req,
                    "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    b.len()
                );
                self.req.extend_from_slice(b);
            }
            None if matches!(method, "PUT" | "POST") => {
                self.req.extend_from_slice(b"Content-Length: 0\r\n\r\n");
            }
            None => self.req.extend_from_slice(b"\r\n"),
        }
        s.write_all(&self.req)?;
        s.flush()?;
        let (resp, keep) = self.read_response(&mut s, method == "HEAD")?;
        if keep {
            self.conn = Some(s);
        } else {
            s.conn.send_close_notify();
            let _ = s.flush();
        }
        Ok(resp)
    }

    /// Returns the response and whether the connection may be reused. The whole response
    /// (interim 1xx responses, head and body) must arrive within the connect timeout.
    fn read_response(
        &mut self,
        s: &mut TlsStream,
        head_only: bool,
    ) -> Result<(Response, bool), Error> {
        let deadline = Instant::now() + self.target.timeout;
        let mut r = Timed { s, deadline };
        let result = Self::read_response_from(&mut r, &mut self.buf, head_only);
        // Keep-alive reuse: restore the default read timeout for the next request.
        r.s.sock.set_read_timeout(Some(self.target.timeout))?;
        result
    }

    fn read_response_from<R: Read>(
        s: &mut R,
        buf: &mut Vec<u8>,
        head_only: bool,
    ) -> Result<(Response, bool), Error> {
        buf.clear();
        let mut interim = 0usize;
        let head = loop {
            if let Some(end) = find(buf, b"\r\n\r\n") {
                let h = parse_head(&buf[..end + 4])?;
                if (100..200).contains(&h.status) {
                    interim += 1;
                    if interim > MAX_INTERIM {
                        return Err(bad("too many interim (1xx) responses"));
                    }
                    buf.drain(..end + 4); // 1xx interim response: skip
                    continue;
                }
                break h;
            }
            if buf.len() > MAX_HEAD {
                return Err(bad("head too large"));
            }
            fill(s, buf)?;
        };
        buf.drain(..head.len);
        let no_body = head_only || head.status == 204 || head.status == 304;
        let (body, keep) = if no_body {
            (Vec::new(), !head.close)
        } else if head.chunked {
            (read_chunked(s, buf)?, !head.close)
        } else if let Some(n) = head.content_length {
            if n > MAX_BODY {
                return Err(bad("body too large"));
            }
            while buf.len() < n {
                fill(s, buf)?;
            }
            (buf[..n].to_vec(), !head.close)
        } else {
            // Delimited by connection close.
            let mut tmp = [0u8; 4096];
            loop {
                match s.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => return Err(e.into()),
                }
                if buf.len() > MAX_BODY {
                    return Err(bad("body too large"));
                }
            }
            (std::mem::take(buf), false)
        };
        Ok((
            Response {
                status: head.status,
                body,
            },
            keep,
        ))
    }
}

/// Decodes a chunked body starting at `buf[0]` (more data read from `s` as needed). Consumed
/// bytes are dropped from `buf` after every chunk, so wire overhead (extensions, trailers) cannot
/// grow it beyond one chunk plus one line.
fn read_chunked<R: Read>(s: &mut R, buf: &mut Vec<u8>) -> Result<Vec<u8>, Error> {
    let mut body = Vec::new();
    loop {
        let line_end = loop {
            if let Some(i) = find(buf, b"\r\n") {
                break i;
            }
            if buf.len() > 1024 {
                return Err(bad("chunk size line"));
            }
            fill(s, buf)?;
        };
        let line = std::str::from_utf8(&buf[..line_end]).map_err(|_| bad("chunk size"))?;
        let size = chunk_size(line)?;
        buf.drain(..line_end + 2);
        if size == 0 {
            // Trailer section: header lines until an empty line, at most MAX_HEAD bytes in total.
            let mut trailer = 0usize;
            loop {
                let end = loop {
                    if let Some(i) = find(buf, b"\r\n") {
                        break i;
                    }
                    if trailer.saturating_add(buf.len()) > MAX_HEAD {
                        return Err(bad("trailer"));
                    }
                    fill(s, buf)?;
                };
                trailer = trailer.saturating_add(end + 2);
                if trailer > MAX_HEAD {
                    return Err(bad("trailer"));
                }
                buf.drain(..end + 2);
                if end == 0 {
                    return Ok(body);
                }
            }
        }
        if body.len().checked_add(size).is_none_or(|t| t > MAX_BODY) {
            return Err(bad("body too large"));
        }
        let need = size.checked_add(2).ok_or_else(|| bad("chunk size"))?;
        while buf.len() < need {
            fill(s, buf)?;
        }
        if &buf[size..need] != b"\r\n" {
            return Err(bad("chunk terminator"));
        }
        body.extend_from_slice(&buf[..size]);
        buf.drain(..need);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_parse() {
        let h =
            parse_head(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\n")
                .unwrap();
        assert_eq!(
            (h.status, h.content_length, h.chunked, h.close),
            (200, Some(5), false, false)
        );
        let h = parse_head(
            b"HTTP/1.1 409 Conflict\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
        assert!(h.chunked && h.close && h.status == 409);
        assert!(parse_head(b"FOO 200\r\n\r\n").is_err());
    }

    #[test]
    fn chunked_body_split_across_reads() {
        let mut buf = b"4\r\nWi".to_vec();
        let mut rest =
            std::io::Cursor::new(b"ki\r\n5;ext=1\r\npedia\r\n0\r\nX-T: 1\r\n\r\n".to_vec());
        assert_eq!(read_chunked(&mut rest, &mut buf).unwrap(), b"Wikipedia");
        let mut buf = b"4\r\nWikiXX".to_vec();
        assert!(read_chunked(&mut std::io::empty(), &mut buf).is_err());
    }

    fn chunked(wire: &[u8]) -> Result<Vec<u8>, Error> {
        let mut buf = Vec::new();
        read_chunked(&mut std::io::Cursor::new(wire.to_vec()), &mut buf)
    }

    #[test]
    fn chunk_size_overflow_is_an_error() {
        for wire in [
            &b"5\r\nhello\r\nFFFFFFFFFFFFFFFF\r\nxx\r\n0\r\n\r\n"[..],
            b"FFFFFFFFFFFFFFFFFFFFFFFF\r\n",
            b"100001\r\n",
            b"+5\r\nhello\r\n0\r\n\r\n",
            b"\r\n",
        ] {
            assert!(matches!(chunked(wire), Err(Error::Protocol(_))), "{wire:?}");
        }
        assert_eq!(chunked(b"0005\r\nhello\r\n0\r\n\r\n").unwrap(), b"hello");
        assert!(chunk_size("100000").is_ok() && chunk_size("100001").is_err());
    }

    #[test]
    fn chunk_trailers_are_bounded() {
        let mut wire = b"0\r\n".to_vec();
        for _ in 0..4096 {
            wire.extend_from_slice(b"X-T: 1\r\n");
        }
        wire.extend_from_slice(b"\r\n");
        assert!(matches!(chunked(&wire), Err(Error::Protocol(_))));
    }

    fn response(wire: &[u8]) -> Result<(Response, bool), Error> {
        let mut buf = Vec::new();
        Rest::read_response_from(&mut std::io::Cursor::new(wire.to_vec()), &mut buf, false)
    }

    #[test]
    fn interim_responses_are_limited() {
        let mut wire = b"HTTP/1.1 100 Continue\r\n\r\n".repeat(MAX_INTERIM);
        wire.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        let (r, keep) = response(&wire).unwrap();
        assert_eq!((r.status, r.body.as_slice(), keep), (200, &b"ok"[..], true));
        let mut wire = b"HTTP/1.1 100 Continue\r\n\r\n".repeat(MAX_INTERIM + 1);
        wire.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        assert!(matches!(response(&wire), Err(Error::Protocol(_))));
    }

    #[test]
    fn content_length_overflow_is_an_error() {
        for cl in ["99999999999999999999999", "+2", "-1", "1 2", ""] {
            let wire = format!("HTTP/1.1 200 OK\r\nContent-Length: {cl}\r\n\r\nok");
            assert!(
                matches!(response(wire.as_bytes()), Err(Error::Protocol(_))),
                "{cl}"
            );
        }
    }
}
