//! Outermost HTTP guard for `/mcp`: DNS-rebinding protection (`Host` / `Origin`), bearer-token
//! authentication (constant-time compare) and active-client tracking.

use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A client counts as connected while it made an authenticated request within this window.
pub const CLIENT_ACTIVE_WINDOW: Duration = Duration::from_secs(60);

const SESSION_HEADER: &str = "mcp-session-id";

/// Shared guard state.
pub struct GuardState {
    token: String,
    clients: ClientTracker,
}

impl GuardState {
    pub fn new(token: String) -> Self {
        Self {
            token,
            clients: ClientTracker::default(),
        }
    }

    pub fn connected_clients(&self) -> u32 {
        self.clients.active_count(Instant::now())
    }
}

/// Distinct MCP clients seen in the last [`CLIENT_ACTIVE_WINDOW`]. A client is identified by its
/// `Mcp-Session-Id` (legacy session mode; also taken from the `initialize` response), otherwise
/// (stateless 2026-07-28 protocol, no sessions) by its TCP peer address. `DELETE` with a session
/// id (explicit session close) removes the entry immediately.
#[derive(Default)]
pub struct ClientTracker {
    seen: Mutex<HashMap<String, Instant>>,
}

impl ClientTracker {
    pub fn touch(&self, key: String, now: Instant) {
        let mut seen = self.seen.lock();
        seen.insert(key, now);
        if seen.len() > 256 {
            seen.retain(|_, t| now.duration_since(*t) <= CLIENT_ACTIVE_WINDOW);
        }
    }

    pub fn remove(&self, key: &str) {
        self.seen.lock().remove(key);
    }

    pub fn active_count(&self, now: Instant) -> u32 {
        let mut seen = self.seen.lock();
        seen.retain(|_, t| now.duration_since(*t) <= CLIENT_ACTIVE_WINDOW);
        u32::try_from(seen.len()).unwrap_or(u32::MAX)
    }
}

/// Length-revealing but content-constant-time comparison (the token length is not secret).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Host name part of a `Host` header (`name[:port]`, `[v6]:port`), lower-cased.
fn host_name(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    let name = if let Some(rest) = v.strip_prefix('[') {
        let end = rest.find(']')?;
        &rest[..end]
    } else {
        match v.rsplit_once(':') {
            Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
            _ => v,
        }
    };
    Some(name.to_ascii_lowercase())
}

/// `Host` must be `127.0.0.1` or `localhost` (any port).
pub fn host_allowed(headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .and_then(host_name)
        .is_some_and(|h| h == "127.0.0.1" || h == "localhost")
}

/// A present `Origin` must be `http://127.0.0.1[:port]` or `http://localhost[:port]`.
pub fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(o) = origin.to_str() else {
        return false;
    };
    let o = o.trim().to_ascii_lowercase();
    ["http://127.0.0.1", "http://localhost"]
        .iter()
        .any(|prefix| {
            o.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty()
                    || rest.strip_prefix(':').is_some_and(|port| {
                        !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
                    })
            })
        })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

fn reject(status: StatusCode, msg: &'static str) -> Response {
    let mut resp = (status, msg).into_response();
    if status == StatusCode::UNAUTHORIZED {
        resp.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("Bearer realm=\"nexuscan-mcp\""),
        );
    }
    resp
}

/// axum middleware: 403 on foreign `Host`/`Origin`, 401 on missing/wrong bearer token.
pub async fn guard(
    State(state): State<Arc<GuardState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let headers = req.headers();
    if !host_allowed(headers) {
        return reject(
            StatusCode::FORBIDDEN,
            "forbidden: Host must be 127.0.0.1 or localhost",
        );
    }
    if !origin_allowed(headers) {
        return reject(StatusCode::FORBIDDEN, "forbidden: Origin not allowed");
    }
    let authorized = bearer_token(headers)
        .is_some_and(|t| constant_time_eq(t.as_bytes(), state.token.as_bytes()));
    if !authorized {
        return reject(
            StatusCode::UNAUTHORIZED,
            "unauthorized: missing or invalid bearer token",
        );
    }

    let is_delete = req.method() == Method::DELETE;
    let req_session = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| format!("session:{s}"));
    let resp = next.run(req).await;

    let now = Instant::now();
    match req_session {
        Some(key) if is_delete && resp.status().is_success() => state.clients.remove(&key),
        Some(key) => state.clients.touch(key, now),
        None => {
            let key = resp
                .headers()
                .get(SESSION_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(|s| format!("session:{s}"))
                .unwrap_or_else(|| format!("peer:{peer}"));
            state.clients.touch(key, now);
        }
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn hm(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(k.clone(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn host_rules() {
        assert!(host_allowed(&hm(&[(header::HOST, "127.0.0.1:47800")])));
        assert!(host_allowed(&hm(&[(header::HOST, "LOCALHOST:1")])));
        assert!(host_allowed(&hm(&[(header::HOST, "localhost")])));
        assert!(!host_allowed(&hm(&[(header::HOST, "evil.com:47800")])));
        assert!(!host_allowed(&hm(&[(header::HOST, "localhost.evil.com")])));
        assert!(!host_allowed(&HeaderMap::new()));
    }

    #[test]
    fn origin_rules() {
        assert!(origin_allowed(&HeaderMap::new()));
        assert!(origin_allowed(&hm(&[(
            header::ORIGIN,
            "http://localhost:5173"
        )])));
        assert!(origin_allowed(&hm(&[(header::ORIGIN, "http://127.0.0.1")])));
        assert!(!origin_allowed(&hm(&[(
            header::ORIGIN,
            "http://localhost.evil.com"
        )])));
        assert!(!origin_allowed(&hm(&[(
            header::ORIGIN,
            "https://evil.com"
        )])));
        assert!(!origin_allowed(&hm(&[(header::ORIGIN, "null")])));
        assert!(!origin_allowed(&hm(&[(
            header::ORIGIN,
            "http://127.0.0.1.nip.io"
        )])));
    }

    #[test]
    fn ct_eq() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn tracker_window() {
        let t = ClientTracker::default();
        let now = Instant::now();
        t.touch("a".into(), now);
        t.touch("b".into(), now);
        assert_eq!(t.active_count(now), 2);
        t.remove("a");
        assert_eq!(t.active_count(now), 1);
        assert_eq!(
            t.active_count(now + CLIENT_ACTIVE_WINDOW + Duration::from_secs(1)),
            0
        );
    }
}
