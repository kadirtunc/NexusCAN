//! WP-10 (CRIT-02 / HIGH-11) quick mitigations shared by `nexus-cloud` and `nexus-cli`.
//!
//! * TLS is not implemented yet, so plaintext `http://` / `ws://` is only allowed towards a
//!   loopback test server (`127.0.0.1`, `localhost`, `::1`).
//! * URLs are redacted (credentials and query string removed) before they are put into any
//!   error message or log line, because device tokens can travel in `?token=`.

/// Error text used when a plaintext URL points to a non-loopback host.
pub const TLS_NOT_SUPPORTED_MSG: &str =
    "TLS not yet supported; use a loopback test server (127.0.0.1, localhost or ::1)";

/// `true` for the loopback host names accepted for plaintext transports.
///
/// Accepts `localhost` (case-insensitive), `127.0.0.1`, `::1` and `[::1]`.
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim();
    h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1" || h == "[::1]"
}

/// Returns `url` with userinfo (`user:pass@`), query string and fragment removed, safe to
/// print. `ws://h:1/p?token=nxc_tok_x` -> `ws://h:1/p?<redacted>`.
pub fn redact_url(url: &str) -> String {
    let url = url.trim();
    let (scheme, rest) = match url.find("://") {
        Some(i) => (&url[..i + 3], &url[i + 3..]),
        None => ("", url),
    };
    let (before_query, had_query) = match rest.find(['?', '#']) {
        Some(i) => (&rest[..i], true),
        None => (rest, false),
    };
    let (authority, path) = match before_query.find('/') {
        Some(i) => (&before_query[..i], &before_query[i..]),
        None => (before_query, ""),
    };
    let authority = match authority.rfind('@') {
        Some(i) => format!("<redacted>@{}", &authority[i + 1..]),
        None => authority.to_string(),
    };
    let mut out = String::with_capacity(url.len().min(256));
    out.push_str(scheme);
    out.push_str(&authority);
    out.push_str(path);
    if had_query {
        out.push_str("?<redacted>");
    }
    // Never echo unbounded attacker-controlled input.
    if out.len() > 256 {
        let mut cut = 256;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts() {
        for ok in ["localhost", "LocalHost", "127.0.0.1", "::1", "[::1]"] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in ["cloud.nexuscan.io", "127.0.0.2", "10.0.0.1", "localhost.evil", "", "0.0.0.0"] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
    }

    #[test]
    fn redaction_removes_credentials_and_query() {
        assert_eq!(
            redact_url("ws://localhost:3000/api/bridge/ws?token=nxc_tok_abcdef0123456789abcdef"),
            "ws://localhost:3000/api/bridge/ws?<redacted>"
        );
        assert_eq!(
            redact_url("http://user:secret@host:1/p#frag"),
            "http://<redacted>@host:1/p?<redacted>"
        );
        assert_eq!(redact_url("ws://h/p"), "ws://h/p");
        let r = redact_url("garbage?token=nxc_tok_zzz");
        assert!(!r.contains("nxc_tok"), "{r}");
        assert!(redact_url(&"a".repeat(5000)).chars().count() <= 257);
    }
}
