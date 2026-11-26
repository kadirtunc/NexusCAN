//! Minimal HTTP/1.1 server (keep-alive, Content-Length bodies) + REST subset of the CANsub OpenAPI.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rustls::{ServerConnection, StreamOwned};
use serde::{Deserialize, Serialize};

use super::{lock, BitTiming, Phy, Shared, SimRequest};

pub(crate) type TlsStream = StreamOwned<ServerConnection, TcpStream>;

const HTTP_POLL: Duration = Duration::from_millis(50);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;

/// Replays already-buffered bytes before reading from the inner stream (hands the parsed upgrade
/// request back to tungstenite).
pub(crate) struct Prefixed<S> {
    pre: Vec<u8>,
    pos: usize,
    pub(crate) inner: S,
}

impl<S: Read> Read for Prefixed<S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.pre.len() {
            let n = buf.len().min(self.pre.len() - self.pos);
            buf[..n].copy_from_slice(&self.pre[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

impl<S: Write> Write for Prefixed<S> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.inner.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn would_block(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

/// TLS handshake + HTTP request loop for one TCP connection.
pub(crate) fn serve_connection(shared: &Arc<Shared>, tcp: TcpStream) {
    let _ = tcp.set_nodelay(true);
    if tcp.set_read_timeout(Some(HTTP_POLL)).is_err() {
        return;
    }
    let Ok(conn) = ServerConnection::new(Arc::clone(&shared.tls)) else {
        return;
    };
    let mut tls = StreamOwned::new(conn, tcp);
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    while tls.conn.is_handshaking() {
        match tls.conn.complete_io(&mut tls.sock) {
            Ok((0, 0)) => return, // EOF during handshake
            Ok(_) => {}
            Err(e) if would_block(&e) => {
                if shared.stopping() || Instant::now() > deadline {
                    return;
                }
            }
            Err(_) => return, // e.g. TLS 1.3-only client or unsupported suite: alert already sent
        }
    }

    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        let head = match read_head(shared, &mut tls, &mut buf) {
            Some(Ok(h)) => h,
            Some(Err(())) => {
                let _ = write_response(&mut tls, &Reply::text(400, "malformed request"), true);
                return;
            }
            None => return,
        };
        if head.upgrade_ws {
            log_request(shared, &head.method, &head.path, "");
            let ch = ws_channel(&head.path);
            match ch.filter(|&c| head.method == "GET" && shared.channel(c).is_some()) {
                Some(c) => {
                    let pre = std::mem::take(&mut buf);
                    super::ws::serve(
                        shared,
                        c,
                        Prefixed {
                            pre,
                            pos: 0,
                            inner: tls,
                        },
                    );
                }
                None => {
                    let _ =
                        write_response(&mut tls, &Reply::text(404, "CAN channel not found"), true);
                }
            }
            return;
        }
        if head.content_length > MAX_BODY {
            let _ = write_response(&mut tls, &Reply::text(413, "payload too large"), true);
            return;
        }
        buf.drain(..head.head_len);
        while buf.len() < head.content_length {
            if !fill(shared, &mut tls, &mut buf, Instant::now() + IDLE_TIMEOUT) {
                return;
            }
        }
        let body: Vec<u8> = buf.drain(..head.content_length).collect();
        let body = String::from_utf8_lossy(&body).into_owned();
        if head.path != "/sim/log" {
            log_request(shared, &head.method, &head.path, &body);
        }
        let reply = route(shared, &head.method, &head.path, &body);
        if write_response(&mut tls, &reply, head.close).is_err() || head.close {
            tls.conn.send_close_notify();
            let _ = tls.flush();
            return;
        }
    }
}

fn log_request(shared: &Shared, method: &str, path: &str, body: &str) {
    lock(&shared.requests).push(SimRequest {
        method: method.into(),
        path: path.into(),
        body: body.into(),
    });
}

/// Reads more bytes into `buf`; `false` on EOF, error, stop or deadline.
fn fill(shared: &Shared, s: &mut TlsStream, buf: &mut Vec<u8>, deadline: Instant) -> bool {
    let mut tmp = [0u8; 4096];
    loop {
        match s.read(&mut tmp) {
            Ok(0) => return false,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                return true;
            }
            Err(e) if would_block(&e) => {
                if shared.stopping() || Instant::now() > deadline {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
}

struct Head {
    method: String,
    path: String,
    content_length: usize,
    upgrade_ws: bool,
    close: bool,
    head_len: usize,
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn read_head(shared: &Shared, s: &mut TlsStream, buf: &mut Vec<u8>) -> Option<Result<Head, ()>> {
    let deadline = Instant::now() + IDLE_TIMEOUT;
    loop {
        if let Some(end) = find_head_end(buf) {
            return Some(parse_head(&buf[..end]));
        }
        if buf.len() > MAX_HEAD {
            return Some(Err(()));
        }
        if !fill(shared, s, buf, deadline) {
            return None;
        }
    }
}

fn parse_head(raw: &[u8]) -> Result<Head, ()> {
    let text = std::str::from_utf8(raw).map_err(|_| ())?;
    let mut lines = text.split("\r\n");
    let mut req = lines.next().ok_or(())?.split(' ');
    let method = req.next().ok_or(())?.to_string();
    let target = req.next().ok_or(())?;
    let version = req.next().ok_or(())?;
    if !version.starts_with("HTTP/1.") || method.is_empty() {
        return Err(());
    }
    let path = target.split('?').next().unwrap_or("").to_string();
    let mut head = Head {
        method,
        path,
        content_length: 0,
        upgrade_ws: false,
        close: version == "HTTP/1.0",
        head_len: raw.len(),
    };
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(())?;
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => head.content_length = value.parse().map_err(|_| ())?,
            "transfer-encoding" if !value.eq_ignore_ascii_case("identity") => return Err(()),
            "upgrade" if value.eq_ignore_ascii_case("websocket") => head.upgrade_ws = true,
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

pub(crate) struct Reply {
    status: u16,
    ctype: &'static str,
    body: String,
}

impl Reply {
    fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            ctype: "text/plain",
            body: body.into(),
        }
    }
    fn json(value: &impl Serialize) -> Self {
        match serde_json::to_string(value) {
            Ok(body) => Self {
                status: 200,
                ctype: "application/json",
                body,
            },
            Err(e) => Self::text(500, &e.to_string()),
        }
    }
    fn empty(status: u16) -> Self {
        Self {
            status,
            ctype: "text/plain",
            body: String::new(),
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    }
}

fn write_response(s: &mut impl Write, r: &Reply, close: bool) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n",
        r.status,
        reason(r.status),
        r.ctype,
        r.body.len(),
        if close { "close" } else { "keep-alive" }
    );
    s.write_all(head.as_bytes())?;
    s.write_all(r.body.as_bytes())?;
    s.flush()
}

fn ws_channel(path: &str) -> Option<u8> {
    let rest = path.strip_prefix("/api/can/")?.strip_suffix("/ws")?;
    rest.parse().ok()
}

// ---------------------------------------------------------------------------------------------------
// REST routes (OpenAPI field names, cansub4 API 05.00)
// ---------------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct Info<'a> {
    id: &'a str,
    hw_ver: &'a str,
    fw_ver: &'a str,
    mac: String,
    usb: &'a str,
}

#[derive(Serialize, Deserialize)]
struct TimeDto {
    utc: String,
    rate_ppb: i64,
}

#[derive(Serialize)]
struct PtpDto {
    master: Option<String>,
    state: &'static str,
    offset_ns: i64,
}

#[derive(Serialize)]
struct StatusDto {
    state: &'static str,
    frame_count: u64,
    frame_rate: u64,
    bus_load: u64,
    rx_error_count: u32,
    tx_error_count: u32,
    bus_error_count: u64,
}

fn route(shared: &Shared, method: &str, path: &str, body: &str) -> Reply {
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match (method, segs.as_slice()) {
        ("GET", ["api", "version"]) => Reply::text(200, "05.00"),
        ("GET", ["api", "info"]) => Reply::json(&Info {
            id: &shared.device_id,
            hw_ver: "01.00",
            fw_ver: "01.00.00",
            mac: format!("0011{}", shared.device_id),
            usb: "04D8&E487",
        }),
        ("GET", ["api", "time"]) => {
            let c = *lock(&shared.clock);
            let unix = c.device_us_at(Instant::now()) + super::wire::DEVICE_EPOCH_UNIX_US;
            Reply::json(&TimeDto {
                utc: format_utc(unix),
                rate_ppb: c.rate_ppb,
            })
        }
        ("PUT", ["api", "time"]) => put_time(shared, body),
        ("GET", ["api", "time", "ptp"]) => {
            let state = if lock(&shared.clock).set_by_rest {
                "disabled"
            } else {
                "idle"
            };
            Reply::json(&PtpDto {
                master: None,
                state,
                offset_ns: 0,
            })
        }
        ("GET", ["api", "can"]) => {
            Reply::json(&(1..=shared.channels.len() as u8).collect::<Vec<u8>>())
        }
        (_, ["api", "can", ch, rest @ ..]) => {
            let Some((n, c)) = ch
                .parse::<u8>()
                .ok()
                .and_then(|n| Some((n, shared.channel(n)?)))
            else {
                return Reply::text(404, "CAN channel not found");
            };
            channel_route(c, n, method, rest, body)
        }
        ("GET", ["sim", "log"]) => Reply::json(&shared.log()),
        (
            _,
            ["api", "version" | "info" | "time" | "can"] | ["api", "time", "ptp"] | ["sim", "log"],
        ) => Reply::text(405, "method not allowed"),
        _ => Reply::text(404, "not found"),
    }
}

fn channel_route(
    c: &super::ChannelState,
    _ch: u8,
    method: &str,
    rest: &[&str],
    body: &str,
) -> Reply {
    match (method, rest) {
        ("GET", []) => {
            let open = c.ws_active.load(Ordering::Acquire);
            let rate = c.frame_rate.load(Ordering::Acquire);
            let t = lock(&c.phy).timing;
            let bitrate = 80_000_000u64
                / (u64::from(t.brp) * (1 + u64::from(t.seg1) + u64::from(t.seg2))).max(1);
            Reply::json(&StatusDto {
                state: if open { "error_active" } else { "stopped" },
                frame_count: c.frame_count.load(Ordering::Acquire),
                frame_rate: rate,
                // ~130 bits per frame on average (rough estimate for the emulator).
                bus_load: (rate * 130 * 100 / bitrate.max(1)).min(100),
                rx_error_count: 0,
                tx_error_count: 0,
                bus_error_count: c.bus_errors.load(Ordering::Acquire),
            })
        }
        ("GET", ["phy"]) => Reply::json(&*lock(&c.phy)),
        ("PUT", ["phy"]) => match serde_json::from_str::<Phy>(body) {
            Ok(phy) if valid_timing(&phy.timing) && valid_timing(&phy.timing_data) => {
                c.set_phy(phy);
                Reply::empty(200)
            }
            _ => Reply::text(400, "Bad request (invalid JSON)"),
        },
        ("GET", ["transmit"]) => Reply::json(&*lock(&c.transmit_ids)),
        ("POST", ["transmit"]) => {
            if serde_json::from_str::<serde_json::Value>(body)
                .map(|v| v.is_object())
                .unwrap_or(false)
            {
                let id = c.next_transmit_id.fetch_add(1, Ordering::AcqRel);
                lock(&c.transmit_ids).push(id);
                Reply {
                    status: 201,
                    ctype: "text/plain",
                    body: id.to_string(),
                }
            } else {
                Reply::text(400, "Bad request (invalid JSON)")
            }
        }
        ("GET" | "DELETE", ["transmit", id]) => {
            let Ok(id) = id.parse::<u32>() else {
                return Reply::text(404, "Transmit sequence not found");
            };
            let mut ids = lock(&c.transmit_ids);
            match ids.iter().position(|&x| x == id) {
                Some(i) => {
                    if method == "DELETE" {
                        ids.remove(i);
                    }
                    Reply::empty(200)
                }
                None => Reply::text(404, "Transmit sequence not found"),
            }
        }
        ("DELETE", ["ws"]) => {
            if c.ws_active.load(Ordering::Acquire) {
                c.abort.store(true, Ordering::Release);
                Reply::empty(200)
            } else {
                Reply::text(404, "No active WebSocket connection on the channel")
            }
        }
        (_, [] | ["phy"] | ["transmit"] | ["transmit", _] | ["ws"]) => {
            Reply::text(405, "method not allowed")
        }
        _ => Reply::text(404, "not found"),
    }
}

fn valid_timing(t: &BitTiming) -> bool {
    t.brp >= 1 && t.seg1 >= 1 && t.seg2 >= 1 && t.sjw >= 1
}

fn put_time(shared: &Shared, body: &str) -> Reply {
    let Ok(dto) = serde_json::from_str::<TimeDto>(body) else {
        return Reply::text(400, "Bad request (invalid object)");
    };
    if !(-200_000..=200_000).contains(&dto.rate_ppb) {
        return Reply::text(400, "Bad request (rate outside the supported range)");
    }
    let Some(unix) = parse_utc(&dto.utc) else {
        return Reply::text(400, "Bad request (unsupported time format)");
    };
    let Some(dev) = unix
        .checked_sub(super::wire::DEVICE_EPOCH_UNIX_US)
        .filter(|d| *d <= super::wire::TIMESTAMP_MASK)
    else {
        return Reply::text(400, "Bad request (time outside the supported range)");
    };
    *lock(&shared.clock) = super::Clock {
        base_dev_us: dev,
        base: Instant::now(),
        rate_ppb: dto.rate_ppb,
        set_by_rest: true,
    };
    Reply::empty(200)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` (fraction optional, 1..=9 digits) → Unix µs.
pub(crate) fn parse_utc(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let mo: u32 = dp.next()?.parse().ok()?;
    let d: u32 = dp.next()?.parse().ok()?;
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut tp = hms.split(':');
    let h: u64 = tp.next()?.parse().ok()?;
    let mi: u64 = tp.next()?.parse().ok()?;
    let sec: u64 = tp.next()?.parse().ok()?;
    if dp.next().is_some()
        || tp.next().is_some()
        || !(1..=12).contains(&mo)
        || !(1..=31).contains(&d)
    {
        return None;
    }
    if h > 23 || mi > 59 || sec > 60 || frac.len() > 9 || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let mut us = 0u64;
    for (i, b) in frac.bytes().enumerate().take(6) {
        us += u64::from(b - b'0') * 10u64.pow(5 - i as u32);
    }
    let days = u64::try_from(days_from_civil(y, mo, d)).ok()?;
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec) * 1_000_000) + us)
}

/// Unix µs → `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub(crate) fn format_utc(unix_us: u64) -> String {
    let secs = unix_us / 1_000_000;
    let ms = (unix_us % 1_000_000) / 1000;
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_roundtrip() {
        assert_eq!(
            parse_utc("2025-01-01T00:00:00.000Z"),
            Some(super::super::wire::DEVICE_EPOCH_UNIX_US)
        );
        let t = parse_utc("2026-11-23T13:21:05.123Z").unwrap();
        assert_eq!(format_utc(t), "2026-11-23T13:21:05.123Z");
        assert!(parse_utc("2026-11-23 13:21:05Z").is_none());
        assert!(parse_utc("2026-13-01T00:00:00Z").is_none());
    }

    #[test]
    fn head_parsing() {
        let h = parse_head(
            b"GET /api/can/2/ws?x=1 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        )
        .unwrap();
        assert!(h.upgrade_ws && h.path == "/api/can/2/ws");
        assert_eq!(ws_channel(&h.path), Some(2));
        assert!(parse_head(b"garbage\r\n\r\n").is_err());
    }
}
