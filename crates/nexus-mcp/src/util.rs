//! Small shared helpers: CAN ID / hex parsing, response-size budgeting, string clipping.

use nexus_core::CanIdKey;
use serde_json::{json, Value};

/// Hard cap for one serialized tool response (bytes of JSON text).
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;

/// Budget used while trimming arrays, leaving room for fields added afterwards
/// (`truncated`, `omitted_items`, `next_cursor`, ...).
pub const TRIM_BUDGET_BYTES: usize = MAX_RESPONSE_BYTES - 512;

/// Maximum characters kept from free-form comments.
pub const COMMENT_CLIP_CHARS: usize = 160;

/// Maximum characters of caller input echoed back inside an error message (MCP-QA-01).
pub const ECHO_CLIP_CHARS: usize = 64;

/// Maximum characters of a whole tool error message (MCP-QA-01).
pub const ERROR_CLIP_CHARS: usize = 512;

/// Clips caller-supplied text before it is echoed in an error message.
pub fn echo(s: &str) -> String {
    clip(s.trim(), ECHO_CLIP_CHARS)
}

/// User-facing tool error (rendered as an MCP tool-level error with a JSON body). The message is
/// always clipped to [`ERROR_CLIP_CHARS`], so error responses stay far below the response cap
/// even if a caller passes megabyte-sized arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError(pub String);

impl ToolError {
    pub fn new(msg: impl Into<String>) -> Self {
        let msg: String = msg.into();
        Self(clip(&msg, ERROR_CLIP_CHARS))
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub type ToolResult = Result<Value, ToolError>;

/// A parsed arbitration ID plus whether the caller *explicitly* asked for a 29-bit ID by writing
/// all 8 hex digits (`0x000001A0`, `000001A0h`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParsedId {
    pub id: u32,
    pub explicit_extended: bool,
}

impl ParsedId {
    /// Extended-ness rule shared by every tool (MCP-QA-04): an explicit `is_extended` wins;
    /// otherwise the ID is extended when it is above `0x7FF` or written with 8 hex digits.
    pub fn is_extended(self, is_extended: Option<bool>) -> bool {
        is_extended.unwrap_or(self.id > 0x7FF || self.explicit_extended)
    }

    pub fn key(self, is_extended: Option<bool>) -> Result<CanIdKey, ToolError> {
        can_key(self.id, Some(self.is_extended(is_extended)))
    }
}

/// Parses a CAN arbitration ID: `0x1A0` / `0X1a0` (hex), `416` (decimal), or a bare hex string
/// containing `a-f` digits (`1A0`, `18FEF100`). Optional `h` suffix is accepted for hex.
/// Hex written with exactly 8 digits marks the ID as explicitly extended.
pub fn parse_id(raw: &str) -> Result<ParsedId, ToolError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(ToolError::new("arbitration ID is empty"));
    }
    let (digits, radix) = if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        (h, 16)
    } else if let Some(h) = s.strip_suffix('h').or_else(|| s.strip_suffix('H')) {
        (h, 16)
    } else if s.chars().all(|c| c.is_ascii_digit()) {
        (s, 10)
    } else {
        (s, 16)
    };
    let digits = digits.replace('_', "");
    let invalid = || {
        ToolError::new(format!(
            "invalid arbitration ID '{}': use hex with 0x prefix (e.g. 0x1A0, or 0x000001A0 for a 29-bit ID) or decimal (e.g. 416)",
            echo(s)
        ))
    };
    if digits.is_empty() || digits.len() > 10 {
        return Err(invalid());
    }
    let id = u32::from_str_radix(&digits, radix).map_err(|_| invalid())?;
    if id > nexus_core::EXT_CAN_ID_MASK {
        return Err(ToolError::new(format!(
            "arbitration ID '{}' exceeds the 29-bit range (max 0x1FFFFFFF)",
            echo(s)
        )));
    }
    Ok(ParsedId {
        id,
        explicit_extended: radix == 16 && digits.len() == 8,
    })
}

/// Numeric value of an arbitration ID (see [`parse_id`]).
pub fn parse_arb_id(raw: &str) -> Result<u32, ToolError> {
    parse_id(raw).map(|p| p.id)
}

/// Builds the canonical key; IDs above `0x7FF` are always extended.
pub fn can_key(id: u32, is_extended: Option<bool>) -> Result<CanIdKey, ToolError> {
    let ext = is_extended.unwrap_or(id > 0x7FF);
    if !ext && id > 0x7FF {
        return Err(ToolError::new(format!(
            "ID 0x{id:X} does not fit an 11-bit standard identifier; set is_extended=true"
        )));
    }
    Ok(CanIdKey::new_masked(id, ext))
}

/// Formats a CAN ID: `0x1A0` (standard, 3 digits) / `0x18FEF100` (extended, 8 digits).
pub fn fmt_id(id: u32, is_extended: bool) -> String {
    if is_extended {
        format!("0x{id:08X}")
    } else {
        format!("0x{id:03X}")
    }
}

pub fn fmt_key(key: CanIdKey) -> String {
    fmt_id(key.raw_id(), key.is_extended())
}

/// Parses payload hex: `DEADBEEF`, `de ad be ef`, `DE:AD:BE:EF`, `0xDE 0xAD`, ... (max 64 bytes).
pub fn parse_data_hex(raw: &str) -> Result<Vec<u8>, ToolError> {
    let mut cleaned = String::with_capacity(raw.len());
    for tok in raw.split(|c: char| c.is_whitespace() || matches!(c, ':' | '-' | ',' | '_')) {
        let tok = tok
            .strip_prefix("0x")
            .or_else(|| tok.strip_prefix("0X"))
            .unwrap_or(tok);
        cleaned.push_str(tok);
    }
    if let Some(bad) = cleaned.chars().find(|c| !c.is_ascii_hexdigit()) {
        return Err(ToolError::new(format!(
            "data_hex contains a non-hex character '{bad}'"
        )));
    }
    if !cleaned.len().is_multiple_of(2) {
        return Err(ToolError::new(
            "data_hex must contain an even number of hex digits (whole bytes)",
        ));
    }
    let n = cleaned.len() / 2;
    if n > 64 {
        return Err(ToolError::new(format!(
            "data_hex has {n} bytes; CAN-FD payloads are at most 64 bytes"
        )));
    }
    let bytes = (0..n)
        .map(|i| u8::from_str_radix(&cleaned[2 * i..2 * i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| ToolError::new("data_hex is not valid hex"))?;
    Ok(bytes)
}

pub fn hex_upper(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0F) as usize] as char);
    }
    s
}

/// Clips `s` to at most `max_chars` characters (adds `…` when clipped).
pub fn clip(s: &str, max_chars: usize) -> String {
    let mut it = s.char_indices();
    match it.nth(max_chars) {
        None => s.to_string(),
        Some((idx, _)) => format!("{}…", &s[..idx]),
    }
}

/// Rounds to `decimals` places for compact JSON (non-finite values become `null`).
pub fn round(v: f64, decimals: i32) -> Value {
    if !v.is_finite() {
        return Value::Null;
    }
    let p = 10f64.powi(decimals);
    json!((v * p).round() / p)
}

pub fn json_len(v: &Value) -> usize {
    serde_json::to_string(v)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
}

/// Trims the array at JSON pointer `array_ptr` (from the end) until the serialized value fits
/// `budget` bytes. Returns the number of array items kept. Sets `"truncated": true` and
/// `"omitted_items": n` on the root object when anything was removed.
pub fn fit_array(value: &mut Value, array_ptr: &str, budget: usize) -> usize {
    let total = match value.pointer(array_ptr).and_then(Value::as_array) {
        Some(a) => a.len(),
        None => return 0,
    };
    if json_len(value) <= budget {
        return total;
    }
    let full: Vec<Value> = value
        .pointer_mut(array_ptr)
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .unwrap_or_default();
    // Reserve the flags up front (`omitted_items = total` is the widest number written later).
    if let Some(obj) = value.as_object_mut() {
        obj.insert("truncated".into(), Value::Bool(true));
        obj.insert("omitted_items".into(), json!(total));
    }
    // Largest `keep` in [0, total] whose serialization fits (size is monotone in `keep`).
    let (mut lo, mut hi) = (0usize, total);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if let Some(arr) = value.pointer_mut(array_ptr) {
            *arr = Value::Array(full[..mid].to_vec());
        }
        if json_len(value) <= budget {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if let Some(arr) = value.pointer_mut(array_ptr) {
        *arr = Value::Array(full[..lo].to_vec());
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert("truncated".into(), Value::Bool(true));
        obj.insert("omitted_items".into(), json!(total - lo));
    }
    lo
}

/// Final guard applied to every tool response: if it still exceeds [`MAX_RESPONSE_BYTES`] the
/// payload is replaced by a small explanatory object with `"truncated": true`.
pub fn enforce_cap(value: Value) -> String {
    let text = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    if text.len() <= MAX_RESPONSE_BYTES {
        return text;
    }
    json!({
        "truncated": true,
        "error": format!(
            "response exceeded {} bytes and was dropped; narrow the request (smaller limit, time window or filter)",
            MAX_RESPONSE_BYTES
        ),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ids() {
        assert_eq!(parse_arb_id("0x1A0").unwrap(), 0x1A0);
        assert_eq!(parse_arb_id("416").unwrap(), 416);
        assert_eq!(parse_arb_id("18FEF100").unwrap(), 0x18FE_F100);
        assert_eq!(parse_arb_id("1A0h").unwrap(), 0x1A0);
        assert!(parse_arb_id("0x2000_0000").is_err());
        assert!(parse_arb_id("zz").is_err());
        assert!(can_key(0x800, Some(false)).is_err());
        assert_eq!(can_key(0x100, None).unwrap(), CanIdKey::Standard(0x100));
        assert_eq!(
            can_key(0x100, Some(true)).unwrap(),
            CanIdKey::Extended(0x100)
        );
    }

    #[test]
    fn explicit_extended_spelling() {
        let std = parse_id("0x1A0").unwrap();
        assert!(!std.is_extended(None));
        let ext = parse_id("0x000001A0").unwrap();
        assert_eq!(ext.id, 0x1A0);
        assert!(ext.is_extended(None));
        assert!(parse_id("000001A0h").unwrap().is_extended(None));
        assert!(!parse_id("00000416").unwrap().is_extended(None)); // decimal, not hex
        assert!(parse_id("0x800").unwrap().is_extended(None));
        assert!(!ext.is_extended(Some(false)));
        assert_eq!(ext.key(None).unwrap(), CanIdKey::Extended(0x1A0));
        assert_eq!(std.key(None).unwrap(), CanIdKey::Standard(0x1A0));
    }

    #[test]
    fn errors_are_clipped() {
        let huge = "1".repeat(200_000);
        let e = parse_id(&format!("0x{huge}")).unwrap_err();
        assert!(e.0.chars().count() <= ERROR_CLIP_CHARS + 1);
        assert!(!e.0.contains(&"1".repeat(100)));
        let e = ToolError::new("x".repeat(10_000));
        assert_eq!(e.0.chars().count(), ERROR_CLIP_CHARS + 1); // + ellipsis
        assert_eq!(echo(&"a".repeat(100)).chars().count(), ECHO_CLIP_CHARS + 1);
    }

    #[test]
    fn parses_hex_payloads() {
        assert_eq!(
            parse_data_hex("de ad:BE-ef").unwrap(),
            vec![0xDE, 0xAD, 0xBE, 0xEF]
        );
        assert_eq!(parse_data_hex("0x01 0x02").unwrap(), vec![1, 2]);
        assert_eq!(parse_data_hex("").unwrap(), Vec::<u8>::new());
        assert!(parse_data_hex("ABC").is_err());
        assert!(parse_data_hex("GG").is_err());
        assert_eq!(parse_data_hex(&"00".repeat(64)).unwrap().len(), 64);
        assert!(parse_data_hex(&"00".repeat(65)).is_err());
    }

    #[test]
    fn fit_array_trims_and_flags() {
        let mut v =
            json!({ "items": (0..5000).map(|i| format!("item-{i:06}")).collect::<Vec<_>>() });
        let kept = fit_array(&mut v, "/items", 4096);
        assert!(kept > 0 && kept < 5000);
        assert!(json_len(&v) <= 4096);
        assert_eq!(v["truncated"], json!(true));
        assert_eq!(v["omitted_items"], json!(5000 - kept));

        let mut small = json!({ "items": [1, 2, 3] });
        assert_eq!(fit_array(&mut small, "/items", 4096), 3);
        assert!(small.get("truncated").is_none());
    }

    #[test]
    fn clip_is_char_safe() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("µµµµ", 2), "µµ…");
    }
}
