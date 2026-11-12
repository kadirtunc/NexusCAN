//! Lightweight zero-external-crate async HTTP/1.1 `GET` client over `tokio::net::TcpStream`
//! for `auto_sync_dbc` database downloads from `NexusCANCloud`.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine as _;
use nexus_cloud::DeviceApiToken;
use serde::Deserialize;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_HTTP_RESPONSE_BYTES: usize = 16 * 1024 * 1024; // 16 MiB safety cap

#[derive(Debug, Error)]
pub enum HttpClientError {
    /// The URL is always redacted (`nexus_cloud::redact_url`): no token / credentials.
    #[error("Unsupported or invalid HTTP URL '{0}' (only http:// is supported without external TLS proxy)")]
    UnsupportedUrl(String),

    /// WP-10: plaintext HTTP to a non-loopback host (URL redacted).
    #[error("{msg} (refusing '{0}')", msg = nexus_cloud::TLS_NOT_SUPPORTED_MSG)]
    InsecureTransport(String),

    #[error("HTTP request timed out after 4s")]
    Timeout,

    #[error("I/O error during HTTP request: {0}")]
    Io(#[from] std::io::Error),

    #[error("Malformed HTTP response: {0}")]
    MalformedResponse(String),

    #[error("HTTP {status} error: {body_preview}")]
    HttpStatus { status: u16, body_preview: String },

    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug)]
pub struct SyncedCloudDatabase {
    pub database_id: String,
    pub file_name: String,
    pub content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDatabasesResponse {
    #[serde(default)]
    databases: Vec<CloudDatabaseItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudDatabaseItem {
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseDownloadResponse {
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    content_base64: String,
    #[serde(default)]
    content_text: Option<String>,
}

/// Queries `NexusCANCloud` for the project's active database list and downloads
/// the primary `.dbc` / `.kcd` file (`?format=json`) if one exists.
pub async fn sync_project_database_from_cloud(
    cloud_url: &str,
    project_id: &str,
    token: &DeviceApiToken,
) -> Result<Option<SyncedCloudDatabase>, HttpClientError> {
    let base = cloud_url.trim().trim_end_matches('/');
    let list_url = format!("{base}/api/projects/{project_id}/databases");
    let list_bytes = http_get_authenticated(&list_url, token).await?;
    let list_resp: ProjectDatabasesResponse = serde_json::from_slice(&list_bytes)?;

    let Some(first_db) = list_resp
        .databases
        .into_iter()
        .find(|d| !d.id.trim().is_empty())
    else {
        return Ok(None);
    };

    let db_id = first_db.id.trim().to_string();
    let dl_url = format!("{base}/api/projects/{project_id}/databases/{db_id}/download?format=json");
    let dl_bytes = http_get_authenticated(&dl_url, token).await?;
    let dl_resp: DatabaseDownloadResponse = serde_json::from_slice(&dl_bytes)?;

    let content_base64 = if !dl_resp.content_base64.trim().is_empty() {
        dl_resp.content_base64.trim().to_string()
    } else if let Some(text) = dl_resp.content_text {
        BASE64_STD.encode(text.as_bytes())
    } else {
        return Err(HttpClientError::MalformedResponse(
            "Database download JSON contained neither contentBase64 nor contentText".to_string(),
        ));
    };

    let file_name = if !dl_resp.file_name.trim().is_empty() {
        dl_resp.file_name.trim().to_string()
    } else if !first_db.name.trim().is_empty() {
        let n = first_db.name.trim();
        if n.ends_with(".dbc") || n.ends_with(".kcd") {
            n.to_string()
        } else {
            format!("{n}.dbc")
        }
    } else {
        "cloud_synced.dbc".to_string()
    };

    Ok(Some(SyncedCloudDatabase {
        database_id: db_id,
        file_name,
        content_base64,
    }))
}

/// Performs an authenticated HTTP/1.1 `GET` request with `4s` overall timeout,
/// `Connection: close`, and support for both `Content-Length` and `Transfer-Encoding: chunked`.
pub async fn http_get_authenticated(
    url: &str,
    token: &DeviceApiToken,
) -> Result<Vec<u8>, HttpClientError> {
    tokio::time::timeout(HTTP_REQUEST_TIMEOUT, http_get_inner(url, Some(token)))
        .await
        .map_err(|_| HttpClientError::Timeout)?
}

/// Performs an unauthenticated HTTP/1.1 `GET` request (useful for local health/status verification).
pub async fn http_get_plain(url: &str) -> Result<(u16, Vec<u8>), HttpClientError> {
    let (status, _ct, body) = http_get_plain_with_content_type(url).await?;
    Ok((status, body))
}

/// Performs an unauthenticated HTTP/1.1 `GET` request returning `(status, content_type, body)`.
pub async fn http_get_plain_with_content_type(
    url: &str,
) -> Result<(u16, String, Vec<u8>), HttpClientError> {
    tokio::time::timeout(HTTP_REQUEST_TIMEOUT, http_get_raw_response(url, None))
        .await
        .map_err(|_| HttpClientError::Timeout)?
}

async fn http_get_inner(
    url: &str,
    token: Option<&DeviceApiToken>,
) -> Result<Vec<u8>, HttpClientError> {
    let (status, _ct, body) = http_get_raw_response(url, token).await?;
    if !(200..=299).contains(&status) {
        let preview = String::from_utf8_lossy(&body[..body.len().min(256)]).into_owned();
        return Err(HttpClientError::HttpStatus {
            status,
            body_preview: preview,
        });
    }
    Ok(body)
}

struct ParsedHttpUrl {
    connect_host: String,
    host_header: String,
    port: u16,
    path_and_query: String,
}

fn parse_http_url(url: &str) -> Result<ParsedHttpUrl, HttpClientError> {
    if url.trim().starts_with("https://") {
        return Err(HttpClientError::InsecureTransport(nexus_cloud::redact_url(
            url,
        )));
    }
    let rest = url
        .trim()
        .strip_prefix("http://")
        .ok_or_else(|| HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(url)))?;

    let (authority, path_part) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };

    if authority.is_empty() {
        return Err(HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(
            url,
        )));
    }

    let (connect_host, port) = if authority.starts_with('[') {
        // IPv6 authority e.g. [::1]:3000 or [::1]
        let end_bracket = authority
            .find(']')
            .ok_or_else(|| HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(url)))?;
        let ipv6_host = &authority[1..end_bracket];
        let after = &authority[end_bracket + 1..];
        let p = if let Some(port_str) = after.strip_prefix(':') {
            port_str
                .parse::<u16>()
                .map_err(|_| HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(url)))?
        } else if after.is_empty() {
            80
        } else {
            return Err(HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(
                url,
            )));
        };
        (ipv6_host.to_string(), p)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p_str)) => {
                let p = p_str
                    .parse::<u16>()
                    .map_err(|_| HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(url)))?;
                (h.to_string(), p)
            }
            None => (authority.to_string(), 80),
        }
    };

    if connect_host.is_empty() || authority.contains('@') {
        return Err(HttpClientError::UnsupportedUrl(nexus_cloud::redact_url(
            url,
        )));
    }
    // WP-10: no TLS yet -> plaintext only towards a loopback test server.
    if !nexus_cloud::is_loopback_host(&connect_host) {
        return Err(HttpClientError::InsecureTransport(nexus_cloud::redact_url(
            url,
        )));
    }

    Ok(ParsedHttpUrl {
        connect_host,
        host_header: authority.to_string(),
        port,
        path_and_query: path_part.to_string(),
    })
}

async fn http_get_raw_response(
    url: &str,
    token: Option<&DeviceApiToken>,
) -> Result<(u16, String, Vec<u8>), HttpClientError> {
    let parsed = parse_http_url(url)?;
    let mut stream = TcpStream::connect((parsed.connect_host.as_str(), parsed.port)).await?;
    stream.set_nodelay(true)?;

    let auth_line = match token {
        Some(t) => format!("Authorization: {}\r\n", t.bearer_header_value()),
        None => String::new(),
    };

    let req = format!(
        "GET {} HTTP/1.1\r\n\
         Host: {}\r\n\
         Accept: application/json, text/html;q=0.9, */*;q=0.8\r\n\
         User-Agent: nexuscan-cli/0.1.0-cli\r\n\
         {}\
         Connection: close\r\n\r\n",
        parsed.path_and_query, parsed.host_header, auth_line
    );
    stream.write_all(req.as_bytes()).await?;

    let mut raw_resp = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        if raw_resp.len().saturating_add(n) > MAX_HTTP_RESPONSE_BYTES {
            return Err(HttpClientError::MalformedResponse(
                "HTTP response exceeded 16 MiB safety limit".to_string(),
            ));
        }
        raw_resp.extend_from_slice(&chunk[..n]);
    }

    let Some(hdr_end) = find_double_crlf(&raw_resp) else {
        return Err(HttpClientError::MalformedResponse(
            "Missing HTTP header terminator \\r\\n\\r\\n".to_string(),
        ));
    };

    let header_str = String::from_utf8_lossy(&raw_resp[..hdr_end]);
    let body_slice = &raw_resp[hdr_end + 4..];

    let mut lines = header_str.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| {
            HttpClientError::MalformedResponse(format!("Invalid HTTP status line '{status_line}'"))
        })?;

    let mut is_chunked = false;
    let mut content_length: Option<usize> = None;
    let mut content_type = String::new();

    for line in lines {
        if let Some((name, val)) = line.split_once(':') {
            let lower = name.trim().to_ascii_lowercase();
            let val_trimmed = val.trim();
            if lower == "transfer-encoding" && val_trimmed.to_ascii_lowercase().contains("chunked")
            {
                is_chunked = true;
            } else if lower == "content-length" {
                content_length = val_trimmed.parse::<usize>().ok();
            } else if lower == "content-type" {
                content_type = val_trimmed.to_string();
            }
        }
    }

    let decoded_body = if is_chunked {
        decode_chunked_body(body_slice)?
    } else if let Some(len) = content_length {
        if body_slice.len() < len {
            return Err(HttpClientError::MalformedResponse(format!(
                "Truncated HTTP body: expected {len} bytes, got {}",
                body_slice.len()
            )));
        }
        body_slice[..len].to_vec()
    } else {
        body_slice.to_vec()
    };

    Ok((status, content_type, decoded_body))
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn decode_chunked_body(mut input: &[u8]) -> Result<Vec<u8>, HttpClientError> {
    let mut out = Vec::with_capacity(input.len());
    loop {
        let Some(line_end) = input.windows(2).position(|w| w == b"\r\n") else {
            return Err(HttpClientError::MalformedResponse(
                "Malformed chunked body: missing CRLF after chunk size".to_string(),
            ));
        };
        let size_line = String::from_utf8_lossy(&input[..line_end]);
        let hex_part = size_line.split(';').next().unwrap_or("").trim();
        let chunk_len = usize::from_str_radix(hex_part, 16).map_err(|_| {
            HttpClientError::MalformedResponse(format!("Invalid hex chunk size '{hex_part}'"))
        })?;

        input = &input[line_end + 2..];
        if chunk_len == 0 {
            break;
        }
        if input.len() < chunk_len + 2 {
            return Err(HttpClientError::MalformedResponse(
                "Truncated chunked payload".to_string(),
            ));
        }
        out.extend_from_slice(&input[..chunk_len]);
        if &input[chunk_len..chunk_len + 2] != b"\r\n" {
            return Err(HttpClientError::MalformedResponse(
                "Missing trailing CRLF after chunk data".to_string(),
            ));
        }
        input = &input[chunk_len + 2..];
    }
    Ok(out)
}

#[cfg(test)]
mod wp10_url_tests {
    use super::*;

    #[test]
    fn http_url_is_loopback_only_and_errors_never_contain_secrets() {
        assert!(parse_http_url("http://127.0.0.1:3000/api/x?token=nxc_tok_secret").is_ok());
        assert!(parse_http_url("http://localhost:3000").is_ok());
        for bad in [
            "http://cloud.nexuscan.io/api?token=nxc_tok_secret",
            "https://cloud.nexuscan.io/api?token=nxc_tok_secret",
        ] {
            let err = parse_http_url(bad).err().expect("refused");
            let msg = err.to_string();
            assert!(
                matches!(err, HttpClientError::InsecureTransport(_)),
                "{msg}"
            );
            assert!(!msg.contains("nxc_tok_secret"), "{msg}");
        }
        let err = parse_http_url("ftp://h/?token=nxc_tok_secret")
            .err()
            .expect("invalid");
        assert!(!err.to_string().contains("nxc_tok_secret"));
        let err = parse_http_url("http://u:nxc_tok_secret@127.0.0.1/")
            .err()
            .expect("creds");
        assert!(!err.to_string().contains("nxc_tok_secret"));
    }
}
