//! RE Toolkit R2b — `cmd_re_dbc_generate` (`planning/contracts/re-toolkit-v1.md` §7.3 / §7.5a).
//!
//! Shared by the Tauri command (`src-tauri/src/commands.rs`) and the browser bridge
//! (`src/bin/nexus_bridge.rs`): bounds the input, decodes / parses the optional base database
//! with the regular format registry (`.dbc` / `.kcd`, content sniffing + file-name hint) and calls
//! the pure, round-trip-verified generator [`generate_re_dbc`]. CPU-bound and allocation-heavy,
//! never on the hot path: callers run it on a blocking worker. No file-system access.

use super::ReError;
use base64::engine::general_purpose::{STANDARD as BASE64_STD, STANDARD_NO_PAD as BASE64_NO_PAD};
use base64::Engine as _;
use nexus_netdb::re_export::{generate_re_dbc, ReDbcGenerateResult, ReSignalDraft};
use nexus_netdb::{FormatRegistry, ParseOptions};
use serde::{Deserialize, Serialize};

// ─── Limits ─────────────────────────────────────────────────────────────────

/// Maximum number of drafts per call.
pub const RE_DBC_MAX_DRAFTS: usize = 4_096;
/// Maximum decoded base database size (32 MiB).
pub const RE_DBC_MAX_BASE_BYTES: usize = 32 * 1024 * 1024;
/// Maximum base64 text length accepted before decoding (32 MiB decoded + padding / whitespace slack).
pub const RE_DBC_MAX_BASE_B64_LEN: usize = RE_DBC_MAX_BASE_BYTES / 3 * 4 + 4 * 1024;
/// Maximum base file-name hint length.
pub const RE_DBC_MAX_FILE_NAME: usize = 1_024;
/// Maximum `comment` length per draft (bytes).
pub const RE_DBC_MAX_COMMENT: usize = 64 * 1024;
/// Maximum `valueTable` entries per draft.
pub const RE_DBC_MAX_VALUE_TABLE: usize = 4_096;
/// Maximum `valueTable` entries summed over all drafts.
pub const RE_DBC_MAX_VALUE_TABLE_TOTAL: usize = 65_536;
/// Maximum length of any other draft string (`id`, `name`, `messageName`, `unit`, value label,
/// provenance reference). Semantic limits (name ≤ 64, unit ≤ 32) are the generator's diagnostics;
/// this is only a resource bound.
pub const RE_DBC_MAX_FIELD: usize = 4 * 1024;

// ─── DTOs ───────────────────────────────────────────────────────────────────

/// Optional merge base: the original content of a loaded catalog database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReDbcBaseDto {
    pub file_name: String,
    pub content_base64: String,
}

/// Bridge request body `{ drafts, base }` (camelCase, same as the Tauri command arguments).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReDbcGenerateRequest {
    pub drafts: Vec<ReSignalDraft>,
    #[serde(default)]
    pub base: Option<ReDbcBaseDto>,
}

// ─── Entry point ────────────────────────────────────────────────────────────

/// `cmd_re_dbc_generate`: validates resource bounds, parses `base` (if any) and runs the
/// generator. Generator findings (bad names, overlaps, …) are diagnostics in the `Ok` result;
/// only malformed / oversized input or an unparsable base is an `Err` (`"[re:invalid] …"`).
pub fn re_dbc_generate(
    drafts: &[ReSignalDraft],
    base: Option<&ReDbcBaseDto>,
) -> Result<ReDbcGenerateResult, ReError> {
    check_drafts(drafts)?;
    match base {
        None => Ok(generate_re_dbc(drafts, None)),
        Some(b) => {
            let db = parse_base(b)?;
            Ok(generate_re_dbc(drafts, Some(&db)))
        }
    }
}

fn invalid(msg: impl Into<String>) -> ReError {
    ReError::Invalid(msg.into())
}

fn check_field(what: &str, idx: usize, s: &str, max: usize) -> Result<(), ReError> {
    if s.len() > max {
        return Err(invalid(format!(
            "draft #{idx}: {what} too long ({} bytes, max {max})",
            s.len()
        )));
    }
    Ok(())
}

fn check_drafts(drafts: &[ReSignalDraft]) -> Result<(), ReError> {
    if drafts.len() > RE_DBC_MAX_DRAFTS {
        return Err(invalid(format!(
            "too many drafts: {} (max {RE_DBC_MAX_DRAFTS})",
            drafts.len()
        )));
    }
    let mut vt_total = 0usize;
    for (i, d) in drafts.iter().enumerate() {
        check_field("id", i, &d.id, RE_DBC_MAX_FIELD)?;
        check_field("name", i, &d.name, RE_DBC_MAX_FIELD)?;
        if let Some(m) = &d.message_name {
            check_field("messageName", i, m, RE_DBC_MAX_FIELD)?;
        }
        check_field("unit", i, &d.unit, RE_DBC_MAX_FIELD)?;
        check_field("comment", i, &d.comment, RE_DBC_MAX_COMMENT)?;
        if let Some(r) = &d.provenance.reference {
            check_field("provenance.reference", i, r, RE_DBC_MAX_FIELD)?;
        }
        if d.value_table.len() > RE_DBC_MAX_VALUE_TABLE {
            return Err(invalid(format!(
                "draft #{i}: valueTable has {} entries (max {RE_DBC_MAX_VALUE_TABLE})",
                d.value_table.len()
            )));
        }
        for e in &d.value_table {
            check_field("valueTable label", i, &e.label, RE_DBC_MAX_FIELD)?;
        }
        vt_total += d.value_table.len();
    }
    if vt_total > RE_DBC_MAX_VALUE_TABLE_TOTAL {
        return Err(invalid(format!(
            "valueTable entries total {vt_total} (max {RE_DBC_MAX_VALUE_TABLE_TOTAL})"
        )));
    }
    Ok(())
}

/// Decodes and parses the base with the regular registry (sniffing first, then the file-name
/// extension hint, then DBC). The DBC/KCD frontends are fault-tolerant and accept arbitrary
/// text as an empty database, so a base without any message is rejected: merging into it would
/// be meaningless and it is almost always not a database at all.
fn parse_base(base: &ReDbcBaseDto) -> Result<nexus_netdb::NetworkDatabase, ReError> {
    if base.file_name.len() > RE_DBC_MAX_FILE_NAME {
        return Err(invalid(format!(
            "base fileName too long ({} bytes, max {RE_DBC_MAX_FILE_NAME})",
            base.file_name.len()
        )));
    }
    if base.content_base64.len() > RE_DBC_MAX_BASE_B64_LEN {
        return Err(invalid(format!(
            "base content too large ({} base64 chars, max {RE_DBC_MAX_BASE_BYTES} bytes decoded)",
            base.content_base64.len()
        )));
    }
    let trimmed = base.content_base64.trim();
    let bytes = BASE64_STD
        .decode(trimmed)
        .or_else(|_| BASE64_NO_PAD.decode(trimmed))
        .map_err(|e| invalid(format!("base '{}': invalid base64: {e}", base.file_name)))?;
    if bytes.is_empty() {
        return Err(invalid(format!("base '{}': empty content", base.file_name)));
    }
    if bytes.len() > RE_DBC_MAX_BASE_BYTES {
        return Err(invalid(format!(
            "base '{}': {} bytes decoded (max {RE_DBC_MAX_BASE_BYTES})",
            base.file_name,
            bytes.len()
        )));
    }
    let hint = (!base.file_name.is_empty()).then_some(base.file_name.as_str());
    let bundle = FormatRegistry::new()
        .parse_bytes(&bytes, hint, &ParseOptions::default())
        .map_err(|e| invalid(format!("base '{}': parse failed: {e}", base.file_name)))?;
    if bundle.database.messages.is_empty() {
        return Err(invalid(format!(
            "base '{}': no messages found (not a .dbc / .kcd database?)",
            base.file_name
        )));
    }
    Ok(bundle.database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_netdb::re_export::{ReByteOrder, ReProvenance, ReSignalValueType};

    fn draft(name: &str) -> ReSignalDraft {
        ReSignalDraft {
            id: format!("id-{name}"),
            bus: 0,
            arb_id: 0x321,
            is_extended: false,
            message_name: None,
            dlc_bytes: 8,
            name: name.into(),
            start_bit: 0,
            bit_length: 16,
            byte_order: ReByteOrder::Intel,
            value_type: ReSignalValueType::Unsigned,
            factor: 0.25,
            offset: -40.0,
            min: -40.0,
            max: 16343.75,
            unit: "km/h".into(),
            comment: String::new(),
            provenance: ReProvenance {
                r: None,
                lag_ms: None,
                reference: None,
                samples: None,
                created_at_ms: 0.0,
            },
            value_table: vec![],
        }
    }

    #[test]
    fn too_many_drafts_is_invalid() {
        let d = draft("A");
        let drafts = vec![d; RE_DBC_MAX_DRAFTS + 1];
        let e = re_dbc_generate(&drafts, None).unwrap_err();
        assert!(
            e.to_string().starts_with("[re:invalid] too many drafts"),
            "{e}"
        );
    }

    #[test]
    fn oversized_comment_and_base_are_invalid() {
        let mut d = draft("A");
        d.comment = "x".repeat(RE_DBC_MAX_COMMENT + 1);
        let e = re_dbc_generate(&[d], None).unwrap_err();
        assert!(
            e.to_string().starts_with("[re:invalid] draft #0: comment"),
            "{e}"
        );

        let base = ReDbcBaseDto {
            file_name: "big.dbc".into(),
            content_base64: "A".repeat(RE_DBC_MAX_BASE_B64_LEN + 1),
        };
        let e = re_dbc_generate(&[], Some(&base)).unwrap_err();
        assert!(
            e.to_string()
                .starts_with("[re:invalid] base content too large"),
            "{e}"
        );
    }

    #[test]
    fn empty_base_content_is_invalid() {
        let base = ReDbcBaseDto {
            file_name: "e.dbc".into(),
            content_base64: String::new(),
        };
        let e = re_dbc_generate(&[], Some(&base)).unwrap_err();
        assert_eq!(e.code(), "invalid");
    }
}
