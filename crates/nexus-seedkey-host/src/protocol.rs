//! Wire protocol between `nexus-seedkey-native` (parent) and `nexus-seedkey-host` (child).
//!
//! * The parent writes exactly one JSON line to the child's stdin and closes it.
//! * The child writes exactly one JSON line ([`HostResponse`]) to stdout and exits.
//! * A library may print to stdout itself, so the parent scans stdout lines from the end and
//!   takes the last line that parses as a [`HostResponse`].
//! * No response + abnormal exit status = the library crashed the helper.
//!
//! Request examples:
//! ```json
//! {"op":"compute","path":"C:\\keys\\ecu.dll","variant":null,"options":null,"level":1,"seedHex":"A1B2","maxKeyLen":64}
//! {"op":"probe","path":"/opt/keys/libecu.so"}
//! ```
//! Response examples:
//! ```json
//! {"ok":true,"keyHex":"04170EE1"}
//! {"ok":false,"code":"library_call","message":"GenerateKeyEx returned 3","libraryCode":3}
//! ```
//! `code` strings are `nexus_protocols::uds::security::SeedKeyErrorCode::as_str` values; the
//! constants in [`codes`] are kept in sync by a test in `nexus-seedkey-native`.

use serde::{Deserialize, Serialize};

/// Hard cap on the request line read by the helper.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Hard cap on the helper's stdout accepted by the parent.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Upper bound for seed and key buffers (mirrors `nexus_protocols` `MAX_SEED_LEN` / `MAX_KEY_LEN`).
pub const MAX_BUFFER_LEN: usize = 256;
/// Upper bound for `variant` / `options` strings.
pub const MAX_STRING_ARG_LEN: usize = 4 * 1024;

/// Error code strings (subset of `SeedKeyErrorCode::as_str`).
pub mod codes {
    pub const INVALID_INPUT: &str = "invalid_input";
    pub const LIBRARY_LOAD: &str = "library_load";
    pub const LIBRARY_CALL: &str = "library_call";
    pub const UNSUPPORTED: &str = "unsupported";
}

/// One request per helper process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum HostRequest {
    /// Calls `GenerateKeyExOpt` when `options` is `Some`, else `GenerateKeyEx`.
    Compute {
        path: String,
        #[serde(default)]
        variant: Option<String>,
        #[serde(default)]
        options: Option<String>,
        /// `iSecurityLevel` (the UDS requestSeed sub-function).
        level: u32,
        seed_hex: String,
        max_key_len: u32,
    },
    /// Loads the library and reports which entry points it exports.
    Probe { path: String },
}

/// Result of a `probe` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbeDto {
    /// `"pe" | "elf" | "macho" | "unknown"`
    pub format: String,
    /// `"x86" | "x86_64" | "aarch64" | "arm" | "unknown"`
    pub arch: String,
    /// Architecture the helper itself was built for.
    pub host_arch: String,
    pub has_generate_key_ex: bool,
    pub has_generate_key_ex_opt: bool,
    /// Exact export name that resolved (`GenerateKeyEx`, `_GenerateKeyEx@28`, ...).
    pub generate_key_ex_symbol: Option<String>,
    pub generate_key_ex_opt_symbol: Option<String>,
}

/// The helper's single stdout line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResponse {
    pub ok: bool,
    /// Uppercase hex key (`compute` success).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_hex: Option<String>,
    /// `probe` success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<Box<HostProbeDto>>,
    /// Error code string (see [`codes`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Raw non-zero `VKeyGenResultEx` value when `code == "library_call"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_code: Option<i64>,
}

impl HostResponse {
    pub fn key(key_hex: String) -> Self {
        Self {
            ok: true,
            key_hex: Some(key_hex),
            ..Self::default()
        }
    }

    pub fn probe(probe: HostProbeDto) -> Self {
        Self {
            ok: true,
            probe: Some(Box::new(probe)),
            ..Self::default()
        }
    }

    pub fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            code: Some(code.to_string()),
            message: Some(message.into()),
            ..Self::default()
        }
    }

    pub fn library_call(library_code: i64, message: impl Into<String>) -> Self {
        Self {
            library_code: Some(library_code),
            ..Self::error(codes::LIBRARY_CALL, message)
        }
    }
}

/// Finds the helper's response in its stdout: the last line that parses as [`HostResponse`]
/// (libraries may print their own lines before ours).
pub fn find_response(stdout: &[u8]) -> Option<HostResponse> {
    stdout
        .split(|b| *b == b'\n')
        .rev()
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .filter(|line| line.first() == Some(&b'{'))
        .find_map(|line| serde_json::from_slice::<HostResponse>(line).ok())
}

/// Uppercase hex without separators.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0F)] as char);
    }
    out
}

/// Strict hex decoder (even number of `[0-9a-fA-F]`, no separators).
pub fn from_hex(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let (pairs, _) = bytes.as_chunks::<2>();
    pairs
        .iter()
        .map(|&[hi, lo]| Some((val(hi)? << 4) | val(lo)?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_json_shape() {
        let req: HostRequest = serde_json::from_str(
            r#"{"op":"compute","path":"/x.so","variant":null,"options":"pw","level":1,"seedHex":"A1B2","maxKeyLen":64}"#,
        )
        .unwrap();
        assert_eq!(
            req,
            HostRequest::Compute {
                path: "/x.so".into(),
                variant: None,
                options: Some("pw".into()),
                level: 1,
                seed_hex: "A1B2".into(),
                max_key_len: 64,
            }
        );
        let probe: HostRequest = serde_json::from_str(r#"{"op":"probe","path":"/x.so"}"#).unwrap();
        assert_eq!(
            probe,
            HostRequest::Probe {
                path: "/x.so".into()
            }
        );
    }

    #[test]
    fn response_json_shape_and_scan() {
        let ok = serde_json::to_string(&HostResponse::key("0102".into())).unwrap();
        assert_eq!(ok, r#"{"ok":true,"keyHex":"0102"}"#);
        let err = serde_json::to_string(&HostResponse::library_call(3, "rc 3")).unwrap();
        assert_eq!(
            err,
            r#"{"ok":false,"code":"library_call","message":"rc 3","libraryCode":3}"#
        );
        let noisy = format!("debug from dll\n{{not json\n{ok}\r\n\n");
        assert_eq!(
            find_response(noisy.as_bytes()).unwrap().key_hex.as_deref(),
            Some("0102")
        );
        assert!(find_response(b"garbage only\n").is_none());
    }

    #[test]
    fn hex_helpers() {
        assert_eq!(to_hex(&[0x0A, 0xFF]), "0AFF");
        assert_eq!(from_hex("0aFF"), Some(vec![0x0A, 0xFF]));
        assert_eq!(from_hex("0"), None);
        assert_eq!(from_hex("zz"), None);
    }
}
