//! MCP M3 Reverse-Engineering tools (`re_status`, `re_series`, `re_correlate`,
//! `re_scan_results`, `re_row_detail`, `re_dbc_generate`). See planning/contracts/mcp-v1.md §9.
//!
//! Strictly read-only with respect to the RE engine state the user controls:
//! * never starts / stops / resets RE, never changes the phase, never adds markers, never changes
//!   the focus set and never runs a value-scan step (`cmd_re_scan_first/next/undo/reset`);
//! * `re_series` / `re_correlate` pre-check that the target (and a reference target) is already
//!   focused, so the engine's reference auto-focus (which would allocate a new focus ring) is
//!   never triggered from MCP;
//! * the `NRS1` series binary (re-toolkit-v1 §6.3) is decoded with bounds checks
//!   ([`decode_nrs1`]): a malformed buffer is an error, never a panic, and raw bytes are never
//!   returned;
//! * `re_dbc_generate` is the pure generator (no file is written or loaded).

use crate::util::{
    clip, echo, fit_array, fmt_id, json_len, parse_id, round, ToolError, ToolResult,
    TRIM_BUDGET_BYTES,
};
use nexus_hal::pipeline::re_analyzer::{
    re_dbc_generate as engine_dbc_generate, ReByteOrder, ReCandidateDto, ReCorrelateRequest,
    ReFocusStatusDto, ReMarkerPointDto, ReReferenceDto, ReScanCandidateDto, ReScanSort,
    ReSearchDto, ReSeriesRequest, ReTargetDto, ReValueType, RE_SERIES_ENTRY_BYTES,
    RE_SERIES_HEADER_BYTES, RE_SERIES_KIND_CANDIDATE, RE_SERIES_KIND_REFERENCE, RE_SERIES_MAGIC,
    RE_SERIES_MAX_CANDIDATES, RE_SERIES_MAX_POINTS, RE_SERIES_MIN_POINTS, RE_SERIES_POINT_BYTES,
};
use nexus_hal::pipeline::PipelineEngine;
use nexus_netdb::re_export::{
    ReByteOrder as DraftByteOrder, ReProvenance, ReSignalDraft, ReSignalValueType,
    ReValueTableEntry,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

// ─── Limits ─────────────────────────────────────────────────────────────────

/// Markers returned by `re_status` (newest first).
pub const MAX_STATUS_MARKERS: usize = 50;
/// Scan history entries returned by `re_status` (most recent).
pub const MAX_SCAN_HISTORY: usize = 20;
/// Candidate series per `re_series` call (engine limit; + 1 reference = 5 series).
pub const MAX_SERIES_CANDIDATES: usize = RE_SERIES_MAX_CANDIDATES;
/// Upper bound of `re_series.max_points` (engine allows more; MCP caps for the 16 KB budget).
pub const MAX_SERIES_POINTS: u32 = 500;
/// Default `re_series.max_points`.
pub const DEFAULT_SERIES_POINTS: u32 = 100;
/// Upper bound of `re_correlate.top_n`.
pub const MAX_CORRELATE_TOP_N: u32 = 20;
/// Default `re_correlate.top_n`.
pub const DEFAULT_CORRELATE_TOP_N: u32 = 10;
/// Upper bound of `re_scan_results.limit`.
pub const MAX_SCAN_RESULTS: u32 = 100;
/// Default `re_scan_results.limit`.
pub const DEFAULT_SCAN_RESULTS: u32 = 20;
/// Contained (overlapping) candidates listed per scan result row.
pub const MAX_CONTAINED_PER_ROW: usize = 4;
/// Drafts per `re_dbc_generate` call.
pub const MAX_DBC_DRAFTS: usize = 256;
/// Diagnostics returned by `re_dbc_generate`.
pub const MAX_DBC_DIAGNOSTICS: usize = 50;

const RE_NOT_RUNNING: &str = "the RE sniffer is not running; the user starts it in the RE view \
(MCP never starts, stops or resets RE). Previously collected rows may still be readable with \
re_row_detail.";

// ─── Tool input schemas ─────────────────────────────────────────────────────

/// Byte order of a candidate / draft bit field.
#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ByteOrderArg {
    /// Intel / little-endian; start_bit = LSB (DBC @1). Default.
    #[default]
    Intel,
    /// Motorola / big-endian; start_bit = MSB in DBC sawtooth numbering (DBC @0).
    Motorola,
}

impl ByteOrderArg {
    fn engine(self) -> ReByteOrder {
        match self {
            Self::Intel => ReByteOrder::Intel,
            Self::Motorola => ReByteOrder::Motorola,
        }
    }
    fn draft(self) -> DraftByteOrder {
        match self {
            Self::Intel => DraftByteOrder::Intel,
            Self::Motorola => DraftByteOrder::Motorola,
        }
    }
}

/// Raw value interpretation.
#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ValueTypeArg {
    /// Unsigned integer (default).
    #[default]
    Unsigned,
    /// Two's-complement signed integer.
    Signed,
    /// IEEE-754 single (bit_length must be 32).
    Float32,
    /// IEEE-754 double (bit_length must be 64).
    Float64,
}

impl ValueTypeArg {
    fn engine(self) -> ReValueType {
        match self {
            Self::Unsigned => ReValueType::Unsigned,
            Self::Signed => ReValueType::Signed,
            Self::Float32 => ReValueType::Float32,
            Self::Float64 => ReValueType::Float64,
        }
    }
    fn draft(self) -> ReSignalValueType {
        match self {
            Self::Unsigned => ReSignalValueType::Unsigned,
            Self::Signed => ReSignalValueType::Signed,
            Self::Float32 => ReSignalValueType::Float32,
            Self::Float64 => ReSignalValueType::Float64,
        }
    }
}

/// A candidate bit field inside the target frame.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CandidateArg {
    /// Start bit (Intel: LSB; Motorola: DBC MSB sawtooth bit), 0..511.
    pub start_bit: u16,
    /// Length in bits, 1..=64 (float32 = 32, float64 = 64).
    pub bit_length: u16,
    /// "intel" (default) or "motorola".
    #[serde(default)]
    pub byte_order: Option<ByteOrderArg>,
    /// "unsigned" (default), "signed", "float32" or "float64".
    #[serde(default)]
    pub value_type: Option<ValueTypeArg>,
    /// Scale factor (default 1).
    #[serde(default)]
    pub factor: Option<f64>,
    /// Offset (default 0).
    #[serde(default)]
    pub offset: Option<f64>,
    /// Optional label used in the output (default derived from the bit field).
    #[serde(default)]
    pub label: Option<String>,
}

impl CandidateArg {
    fn engine(&self) -> Result<ReCandidateDto, ToolError> {
        let factor = self.factor.unwrap_or(1.0);
        let offset = self.offset.unwrap_or(0.0);
        if !factor.is_finite() || !offset.is_finite() {
            return Err(ToolError::new("candidate factor / offset must be finite"));
        }
        Ok(ReCandidateDto {
            start_bit: self.start_bit,
            bit_length: self.bit_length,
            byte_order: self.byte_order.unwrap_or_default().engine(),
            value_type: self.value_type.unwrap_or_default().engine(),
            factor,
            offset,
        })
    }

    fn label(&self) -> String {
        match &self.label {
            Some(l) if !l.trim().is_empty() => clip(l.trim(), 64),
            _ => format!(
                "{}|{}@{}{}",
                self.start_bit,
                self.bit_length,
                if self.byte_order.unwrap_or_default() == ByteOrderArg::Motorola {
                    "0"
                } else {
                    "1"
                },
                match self.value_type.unwrap_or_default() {
                    ValueTypeArg::Unsigned => "+",
                    ValueTypeArg::Signed => "-",
                    ValueTypeArg::Float32 => "f32",
                    ValueTypeArg::Float64 => "f64",
                }
            ),
        }
    }
}

/// One marker step of a `markers` reference.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct MarkerPointArg {
    /// Marker id as listed by re_status.
    pub marker_id: u32,
    /// Reference value from this marker on (step function).
    pub value: f64,
}

/// Reference signal to compare candidates against.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReferenceArg {
    /// OBD-II Mode-01 PID decoded from on-bus responses (0x7E8..0x7EF / 0x18DAF1xx). An OBD
    /// response ID on that bus must already be focused in the RE view.
    ObdPid {
        /// PID, e.g. 13 (0x0D vehicle speed).
        pid: u8,
        /// Bus of the OBD responses (default: the target bus).
        #[serde(default)]
        bus: Option<u8>,
    },
    /// Step function at RE marker timestamps (>= 2 points; marker ids from re_status).
    Markers { points: Vec<MarkerPointArg> },
    /// Another candidate as reference; its frame must already be focused in the RE view.
    Candidate {
        /// Logical bus of the reference frame.
        bus_id: u8,
        /// Arbitration ID of the reference frame ("0x1A0", "416", "0x18FF50E5").
        id: String,
        /// Explicit 29-bit flag (default: ID > 0x7FF or written with 8 hex digits).
        #[serde(default)]
        is_extended: Option<bool>,
        candidate: CandidateArg,
    },
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReSeriesArgs {
    /// Logical bus of the focused target (0 = Bus 1).
    pub bus_id: u8,
    /// Arbitration ID of the focused target ("0x1A0", "416", "0x18FF50E5").
    pub id: String,
    /// Explicit 29-bit flag (default: ID > 0x7FF or written with 8 hex digits).
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Candidate bit fields (max 4).
    #[serde(default)]
    pub candidates: Vec<CandidateArg>,
    /// Optional reference series.
    #[serde(default)]
    pub reference: Option<ReferenceArg>,
    /// Window start, absolute RE microseconds (see re_status focus first_us / last_us).
    #[serde(default)]
    pub from_us: Option<u64>,
    /// Window end, absolute RE microseconds.
    #[serde(default)]
    pub to_us: Option<u64>,
    /// Max points per series (default 100, min 16, max 500); may be lowered to fit 16 KB.
    #[serde(default)]
    pub max_points: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReCorrelateArgs {
    /// Logical bus of the focused target (0 = Bus 1).
    pub bus_id: u8,
    /// Arbitration ID of the focused target.
    pub id: String,
    /// Explicit 29-bit flag (default: ID > 0x7FF or written with 8 hex digits).
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Reference series to correlate bit fields against.
    pub reference: ReferenceArg,
    /// Window start, absolute RE microseconds.
    #[serde(default)]
    pub from_us: Option<u64>,
    /// Window end, absolute RE microseconds.
    #[serde(default)]
    pub to_us: Option<u64>,
    /// First (Intel-numbered) bit searched (default 0).
    #[serde(default)]
    pub bit_from: Option<u16>,
    /// Last (Intel-numbered) bit searched (default 63).
    #[serde(default)]
    pub bit_to: Option<u16>,
    /// Shortest field length (default 1, max 32).
    #[serde(default)]
    pub min_length: Option<u16>,
    /// Longest field length (default 16, max 32).
    #[serde(default)]
    pub max_length: Option<u16>,
    /// Byte orders tried (default both).
    #[serde(default)]
    pub byte_orders: Option<Vec<ByteOrderArg>>,
    /// Also try signed fields (default false = unsigned only).
    #[serde(default)]
    pub include_signed: Option<bool>,
    /// Number of best rows (default 10, max 20).
    #[serde(default)]
    pub top_n: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScanSortArg {
    /// By bus / ID / start bit.
    Id,
    /// Most value changes first (default).
    #[default]
    Changes,
    /// Widest fields first.
    Width,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ReScanResultsArgs {
    /// First row (default 0).
    #[serde(default)]
    pub offset: Option<u32>,
    /// Rows (default 20, max 100).
    #[serde(default)]
    pub limit: Option<u32>,
    /// "id", "changes" (default) or "width".
    #[serde(default)]
    pub sort: Option<ScanSortArg>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReRowDetailArgs {
    /// Logical bus (0 = Bus 1).
    pub bus_id: u8,
    /// Arbitration ID ("0x1A0", "416", "0x18FF50E5").
    pub id: String,
    /// Explicit 29-bit flag (default: ID > 0x7FF or written with 8 hex digits).
    #[serde(default)]
    pub is_extended: Option<bool>,
}

/// One VAL_ entry of a draft.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ValueEntryArg {
    pub value: i64,
    pub label: String,
}

/// A found signal to write into DBC text.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct DraftArg {
    /// Signal name (DBC identifier).
    pub name: String,
    /// Arbitration ID of the message ("0x1A0", "0x18FF50E5").
    pub id: String,
    /// Explicit 29-bit flag (default: ID > 0x7FF or written with 8 hex digits).
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Logical bus the signal was found on (default 0).
    #[serde(default)]
    pub bus_id: Option<u8>,
    /// Message name (default generated from the ID).
    #[serde(default)]
    pub message_name: Option<String>,
    /// Message payload length in bytes (default 8; up to 64 for CAN-FD).
    #[serde(default)]
    pub dlc_bytes: Option<u8>,
    /// Start bit (Intel: LSB; Motorola: MSB sawtooth).
    pub start_bit: u16,
    /// Length in bits (1..=64).
    pub bit_length: u8,
    /// "intel" (default) or "motorola".
    #[serde(default)]
    pub byte_order: Option<ByteOrderArg>,
    /// "unsigned" (default), "signed", "float32", "float64".
    #[serde(default)]
    pub value_type: Option<ValueTypeArg>,
    /// Scale factor (default 1).
    #[serde(default)]
    pub factor: Option<f64>,
    /// Offset (default 0).
    #[serde(default)]
    pub offset: Option<f64>,
    /// Minimum physical value (default 0).
    #[serde(default)]
    pub min: Option<f64>,
    /// Maximum physical value (default 0 = unspecified).
    #[serde(default)]
    pub max: Option<f64>,
    /// Unit (default empty).
    #[serde(default)]
    pub unit: Option<String>,
    /// Comment (default empty).
    #[serde(default)]
    pub comment: Option<String>,
    /// Optional VAL_ table.
    #[serde(default)]
    pub value_table: Option<Vec<ValueEntryArg>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReDbcGenerateArgs {
    /// Signals to write (1..=256).
    pub drafts: Vec<DraftArg>,
    /// Merge into a loaded database. NOT SUPPORTED via MCP yet (the engine keeps no source text
    /// of loaded databases); omit it to generate a standalone DBC.
    #[serde(default)]
    pub base_db_id: Option<String>,
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

fn hal_err(e: impl std::fmt::Display) -> ToolError {
    ToolError::new(e.to_string())
}

fn target_of(bus: u8, id: &str, is_extended: Option<bool>) -> Result<ReTargetDto, ToolError> {
    let key = parse_id(id)
        .map_err(|e| ToolError::new(format!("id '{}': {e}", echo(id))))?
        .key(is_extended)?;
    Ok(ReTargetDto {
        bus,
        arb_id: key.raw_id(),
        is_extended: key.is_extended(),
    })
}

fn target_json(t: &ReTargetDto) -> Value {
    json!({ "bus_id": t.bus, "id": fmt_id(t.arb_id, t.is_extended), "is_extended": t.is_extended })
}

fn byte_order_str(b: ReByteOrder) -> &'static str {
    match b {
        ReByteOrder::Intel => "intel",
        ReByteOrder::Motorola => "motorola",
    }
}

fn value_type_str(v: ReValueType) -> &'static str {
    match v {
        ReValueType::Unsigned => "unsigned",
        ReValueType::Signed => "signed",
        ReValueType::Float32 => "float32",
        ReValueType::Float64 => "float64",
    }
}

fn disabled_response(extra: Value) -> Value {
    let mut v = json!({ "enabled": false, "message": RE_NOT_RUNNING });
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    v
}

fn focus_error(t: &ReTargetDto, what: &str) -> ToolError {
    ToolError::new(format!(
        "{what} {} on bus {} is not focused. Ask the user to focus it in the RE view (Signal \
         Inspector); MCP never changes the RE focus set.",
        fmt_id(t.arb_id, t.is_extended),
        t.bus
    ))
}

fn is_focused(focus: &ReFocusStatusDto, t: &ReTargetDto) -> bool {
    focus
        .targets
        .iter()
        .any(|f| f.bus == t.bus && f.arb_id == t.arb_id && f.is_extended == t.is_extended)
}

fn is_obd_response(bus: u8, arb_id: u32, is_extended: bool, want_bus: u8) -> bool {
    bus == want_bus
        && if is_extended {
            arb_id & 0x1FFF_FF00 == 0x18DA_F100
        } else {
            (0x7E8..=0x7EF).contains(&arb_id)
        }
}

/// Converts a reference argument and checks that the engine will not need to auto-focus
/// anything for it (read-only guarantee).
fn reference_of(
    r: &ReferenceArg,
    target_bus: u8,
    focus: &ReFocusStatusDto,
) -> Result<(ReReferenceDto, String), ToolError> {
    match r {
        ReferenceArg::ObdPid { pid, bus } => {
            let bus = bus.unwrap_or(target_bus);
            let focused = focus
                .targets
                .iter()
                .any(|f| is_obd_response(f.bus, f.arb_id, f.is_extended, bus));
            if !focused {
                return Err(ToolError::new(format!(
                    "no OBD-II response ID (0x7E8..0x7EF / 0x18DAF1xx) on bus {bus} is focused. \
                     Ask the user to focus it in the RE view (or use the OBD reference there once); \
                     MCP never changes the RE focus set."
                )));
            }
            Ok((
                ReReferenceDto::ObdPid { pid: *pid, bus },
                format!("reference obd_pid 0x{pid:02X} bus {bus}"),
            ))
        }
        ReferenceArg::Markers { points } => {
            if points.len() > 1024 {
                return Err(ToolError::new(
                    "markers reference has more than 1024 points",
                ));
            }
            Ok((
                ReReferenceDto::Markers {
                    points: points
                        .iter()
                        .map(|p| ReMarkerPointDto {
                            marker_id: p.marker_id,
                            value: p.value,
                        })
                        .collect(),
                },
                format!("reference markers ({} points)", points.len()),
            ))
        }
        ReferenceArg::Candidate {
            bus_id,
            id,
            is_extended,
            candidate,
        } => {
            let t = target_of(*bus_id, id, *is_extended)?;
            if !is_focused(focus, &t) {
                return Err(focus_error(&t, "reference frame"));
            }
            Ok((
                ReReferenceDto::Candidate {
                    target: t,
                    candidate: candidate.engine()?,
                },
                format!(
                    "reference {} bus {} {}",
                    fmt_id(t.arb_id, t.is_extended),
                    t.bus,
                    candidate.label()
                ),
            ))
        }
    }
}

// ─── re_status ──────────────────────────────────────────────────────────────

pub fn re_status(engine: &PipelineEngine) -> ToolResult {
    let st = engine.re_status();
    let focus = engine.cmd_re_focus_status();
    let scan = engine.cmd_re_scan_status();
    let markers = engine.cmd_re_markers();
    let markers_total = markers.len();
    let newest: Vec<Value> = markers
        .iter()
        .rev()
        .take(MAX_STATUS_MARKERS)
        .map(|m| json!({ "id": m.id, "ts_us": m.ts_us, "label": clip(&m.label, 64), "phase": m.phase }))
        .collect();
    let hist_skip = scan.history.len().saturating_sub(MAX_SCAN_HISTORY);
    let mut v = json!({
        "enabled": st.enabled,
        "phase": st.phase,
        "rows": st.rows,
        "overflow_rows": st.overflow_rows,
        "frames_ingested": st.frames_ingested,
        "started_at_us": st.started_at_us,
        "phase_started_at_us": st.phase_started_at_us,
        "focus": focus.targets.iter().map(|f| json!({
            "bus_id": f.bus,
            "id": fmt_id(f.arb_id, f.is_extended),
            "is_extended": f.is_extended,
            "samples": f.samples,
            "first_us": f.first_us,
            "last_us": f.last_us,
            "auto": f.auto,
        })).collect::<Vec<_>>(),
        "scan": {
            "active": scan.active,
            "scan_id": scan.scan_id,
            "step": scan.step,
            "candidates": scan.candidates,
            "history_recent": &scan.history[hist_skip..],
            "truncated": scan.truncated,
            "undo_depth": scan.undo_depth,
            "history_covered": scan.history_covered,
        },
        "markers_total": markers_total,
        "markers": newest,
    });
    if !st.enabled {
        v["message"] = json!(RE_NOT_RUNNING);
    }
    fit_array(&mut v, "/markers", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── NRS1 decoder (re-toolkit-v1 §6.3) ──────────────────────────────────────

/// One decoded `NRS1` point: `(t_rel_us, min, max)`.
pub type Nrs1Point = (u32, f64, f64);

#[derive(Debug, Clone, PartialEq)]
pub struct Nrs1Series {
    /// 0 = candidate, 1 = reference.
    pub kind: u8,
    pub index: u8,
    pub points: Vec<Nrs1Point>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Nrs1 {
    pub max_points: u16,
    pub from_us: u64,
    pub series: Vec<Nrs1Series>,
}

fn rd<const N: usize>(buf: &[u8], at: usize) -> Result<[u8; N], ToolError> {
    buf.get(at..at.checked_add(N).ok_or_else(nrs1_short)?)
        .and_then(|s| <[u8; N]>::try_from(s).ok())
        .ok_or_else(nrs1_short)
}

fn nrs1_short() -> ToolError {
    ToolError::new("malformed RE series buffer (NRS1): truncated")
}

/// Bounds-checked decoder of the `NRS1` series binary:
/// header `magic[4] "NRS1", seriesCount u8, reserved u8, maxPoints u16, fromUs u64` (16 B),
/// then per series `kind u8, index u8, reserved u16, count u32` (8 B) and `count` points of
/// `tRelUs u32, min f64, max f64` (20 B), all little-endian. Any inconsistency is an error.
pub fn decode_nrs1(buf: &[u8]) -> Result<Nrs1, ToolError> {
    if buf.len() < RE_SERIES_HEADER_BYTES {
        return Err(nrs1_short());
    }
    if rd::<4>(buf, 0)? != RE_SERIES_MAGIC {
        return Err(ToolError::new(
            "malformed RE series buffer: bad magic (expected NRS1)",
        ));
    }
    let count = usize::from(buf[4]);
    if count > RE_SERIES_MAX_CANDIDATES + 1 {
        return Err(ToolError::new(format!(
            "malformed RE series buffer: {count} series (max {})",
            RE_SERIES_MAX_CANDIDATES + 1
        )));
    }
    let max_points = u16::from_le_bytes(rd::<2>(buf, 6)?);
    let from_us = u64::from_le_bytes(rd::<8>(buf, 8)?);
    let mut at = RE_SERIES_HEADER_BYTES;
    let mut series = Vec::with_capacity(count);
    for _ in 0..count {
        let h = rd::<RE_SERIES_ENTRY_BYTES>(buf, at)?;
        at += RE_SERIES_ENTRY_BYTES;
        let kind = h[0];
        if kind != RE_SERIES_KIND_CANDIDATE && kind != RE_SERIES_KIND_REFERENCE {
            return Err(ToolError::new(format!(
                "malformed RE series buffer: unknown series kind {kind}"
            )));
        }
        let n = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
        if n > usize::from(max_points.min(RE_SERIES_MAX_POINTS)) {
            return Err(ToolError::new(format!(
                "malformed RE series buffer: {n} points exceed maxPoints {max_points}"
            )));
        }
        let need = n
            .checked_mul(RE_SERIES_POINT_BYTES)
            .and_then(|b| b.checked_add(at))
            .ok_or_else(nrs1_short)?;
        if need > buf.len() {
            return Err(nrs1_short());
        }
        let mut points = Vec::with_capacity(n);
        for _ in 0..n {
            let t = u32::from_le_bytes(rd::<4>(buf, at)?);
            let lo = f64::from_le_bytes(rd::<8>(buf, at + 4)?);
            let hi = f64::from_le_bytes(rd::<8>(buf, at + 12)?);
            points.push((t, lo, hi));
            at += RE_SERIES_POINT_BYTES;
        }
        series.push(Nrs1Series {
            kind,
            index: h[1],
            points,
        });
    }
    if at != buf.len() {
        return Err(ToolError::new(format!(
            "malformed RE series buffer: {} trailing bytes",
            buf.len() - at
        )));
    }
    Ok(Nrs1 {
        max_points,
        from_us,
        series,
    })
}

fn point_json(p: &Nrs1Point) -> Value {
    let (t, lo, hi) = *p;
    if lo == hi || (lo.is_nan() && hi.is_nan()) {
        json!([t, round(lo, 6)])
    } else {
        json!([t, round(lo, 6), round(hi, 6)])
    }
}

// ─── re_series ──────────────────────────────────────────────────────────────

pub fn re_series(engine: &PipelineEngine, a: &ReSeriesArgs) -> ToolResult {
    let target = target_of(a.bus_id, &a.id, a.is_extended)?;
    if a.candidates.len() > MAX_SERIES_CANDIDATES {
        return Err(ToolError::new(format!(
            "{} candidates given; at most {MAX_SERIES_CANDIDATES} (plus one reference)",
            a.candidates.len()
        )));
    }
    if a.candidates.is_empty() && a.reference.is_none() {
        return Err(ToolError::new("give at least one candidate or a reference"));
    }
    if !engine.re_status().enabled {
        return Ok(disabled_response(json!({ "target": target_json(&target) })));
    }
    let focus = engine.cmd_re_focus_status();
    if !is_focused(&focus, &target) {
        return Err(focus_error(&target, "target"));
    }
    let candidates = a
        .candidates
        .iter()
        .map(CandidateArg::engine)
        .collect::<Result<Vec<_>, _>>()?;
    let (reference, ref_label) = match &a.reference {
        Some(r) => {
            let (dto, label) = reference_of(r, a.bus_id, &focus)?;
            (Some(dto), Some(label))
        }
        None => (None, None),
    };
    let requested = a
        .max_points
        .unwrap_or(DEFAULT_SERIES_POINTS)
        .clamp(u32::from(RE_SERIES_MIN_POINTS), MAX_SERIES_POINTS);
    let labels: Vec<String> = a.candidates.iter().map(CandidateArg::label).collect();

    let mut max_points = requested as u16;
    loop {
        let req = ReSeriesRequest {
            target,
            candidates: candidates.clone(),
            reference: reference.clone(),
            from_us: a.from_us,
            to_us: a.to_us,
            max_points,
        };
        let buf = engine.cmd_re_series(req).map_err(hal_err)?;
        let decoded = decode_nrs1(&buf)?;
        let series: Vec<Value> = decoded
            .series
            .iter()
            .map(|s| {
                let label = if s.kind == RE_SERIES_KIND_REFERENCE {
                    ref_label.clone().unwrap_or_else(|| "reference".into())
                } else {
                    labels
                        .get(usize::from(s.index))
                        .cloned()
                        .unwrap_or_else(|| format!("candidate {}", s.index))
                };
                json!({
                    "label": label,
                    "kind": if s.kind == RE_SERIES_KIND_REFERENCE { "reference" } else { "candidate" },
                    "point_count": s.points.len(),
                    "points": s.points.iter().map(point_json).collect::<Vec<_>>(),
                })
            })
            .collect();
        let mut v = json!({
            "enabled": true,
            "target": target_json(&target),
            "from_us": decoded.from_us,
            "time_base": "point t_us is relative to from_us; [t_us, value] or [t_us, min, max] when a bucket was min/max-decimated",
            "max_points_requested": requested,
            "max_points_used": max_points,
            "series": series,
        });
        if json_len(&v) <= TRIM_BUDGET_BYTES {
            if u32::from(max_points) < requested {
                v["truncated"] = json!(true);
                v["note"] = json!("max_points was lowered to fit the 16 KB response cap; narrow from_us/to_us or ask for fewer series for more detail");
            }
            return Ok(v);
        }
        if max_points <= RE_SERIES_MIN_POINTS {
            // Last resort: trim the points of each series from the end.
            let n = v["series"].as_array().map_or(0, Vec::len);
            let per = TRIM_BUDGET_BYTES / n.max(1);
            for i in 0..n {
                let mut s = v["series"][i].take();
                fit_array(&mut s, "/points", per.saturating_sub(64));
                v["series"][i] = s;
            }
            v["truncated"] = json!(true);
            return Ok(v);
        }
        max_points = (max_points / 2).max(RE_SERIES_MIN_POINTS);
    }
}

// ─── re_correlate ───────────────────────────────────────────────────────────

pub fn re_correlate(engine: &PipelineEngine, a: &ReCorrelateArgs) -> ToolResult {
    let target = target_of(a.bus_id, &a.id, a.is_extended)?;
    if !engine.re_status().enabled {
        return Ok(disabled_response(json!({ "target": target_json(&target) })));
    }
    let focus = engine.cmd_re_focus_status();
    if !is_focused(&focus, &target) {
        return Err(focus_error(&target, "target"));
    }
    let (reference, ref_label) = reference_of(&a.reference, a.bus_id, &focus)?;
    let bit_from = a.bit_from.unwrap_or(0).min(511);
    let bit_to = a.bit_to.unwrap_or(63).min(511);
    if bit_from > bit_to {
        return Err(ToolError::new(format!(
            "bit_from {bit_from} > bit_to {bit_to}"
        )));
    }
    let min_len = a.min_length.unwrap_or(1).clamp(1, 32);
    let max_len = a.max_length.unwrap_or(16).clamp(1, 32);
    if min_len > max_len {
        return Err(ToolError::new(format!(
            "min_length {min_len} > max_length {max_len}"
        )));
    }
    let mut byte_orders: Vec<ReByteOrder> = a
        .byte_orders
        .clone()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| vec![ByteOrderArg::Intel, ByteOrderArg::Motorola])
        .into_iter()
        .map(ByteOrderArg::engine)
        .collect();
    byte_orders.dedup();
    let signed = if a.include_signed.unwrap_or(false) {
        vec![false, true]
    } else {
        vec![false]
    };
    let top_n = a
        .top_n
        .unwrap_or(DEFAULT_CORRELATE_TOP_N)
        .clamp(1, MAX_CORRELATE_TOP_N) as u8;
    let req = ReCorrelateRequest {
        target,
        reference,
        from_us: a.from_us,
        to_us: a.to_us,
        search: ReSearchDto {
            bit_from,
            bit_to,
            lengths: [min_len, max_len],
            byte_orders,
            signed,
        },
        top_n,
    };
    let res = engine.cmd_re_correlate_observer(req).map_err(hal_err)?;
    let rows: Vec<Value> = res
        .rows
        .iter()
        .map(|r| {
            let c = &r.candidate;
            json!({
                "start_bit": c.start_bit,
                "bit_length": c.bit_length,
                "byte_order": byte_order_str(c.byte_order),
                "value_type": value_type_str(c.value_type),
                "factor": round(c.factor, 9),
                "offset": round(c.offset, 6),
                "r": round(r.r, 4),
                "r2": round(r.r2, 4),
                "rmse": round(r.rmse, 6),
                "samples": r.samples,
                "lag_ms": round(r.lag_ms, 1),
            })
        })
        .collect();
    let mut v = json!({
        "enabled": true,
        "target": target_json(&target),
        "reference": ref_label,
        "evaluated": res.evaluated,
        "reference_samples": res.reference_samples,
        "elapsed_ms": round(res.elapsed_ms, 1),
        "budget_exhausted": res.truncated,
        "note": "factor/offset are the least-squares fit raw -> reference; lag_ms > 0 means the target changes before the reference",
        "rows": rows,
    });
    fit_array(&mut v, "/rows", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── re_scan_results ────────────────────────────────────────────────────────

fn scan_cand_json(c: &ReScanCandidateDto) -> Value {
    json!({
        "bus_id": c.bus,
        "id": fmt_id(c.arb_id, c.is_extended),
        "start_bit": c.start_bit,
        "bit_length": c.bit_length,
        "byte_order": byte_order_str(c.byte_order),
        "value_type": value_type_str(c.value_type),
    })
}

/// `(offset, limit, sort)` after defaults and clamping.
pub fn scan_params(a: &ReScanResultsArgs) -> (u32, u32, ReScanSort) {
    let limit = a
        .limit
        .unwrap_or(DEFAULT_SCAN_RESULTS)
        .clamp(1, MAX_SCAN_RESULTS);
    let sort = match a.sort.unwrap_or_default() {
        ScanSortArg::Id => ReScanSort::Id,
        ScanSortArg::Changes => ReScanSort::Changes,
        ScanSortArg::Width => ReScanSort::Width,
    };
    (a.offset.unwrap_or(0), limit, sort)
}

pub fn re_scan_results(engine: &PipelineEngine, a: &ReScanResultsArgs) -> ToolResult {
    let enabled = engine.re_status().enabled;
    let status = engine.cmd_re_scan_status();
    if !status.active {
        let msg = "no active value scan; the user runs value scans (first / next) in the RE view. \
                   MCP never starts, steps, undoes or resets a scan.";
        if !enabled {
            return Ok(disabled_response(json!({ "active": false })));
        }
        return Ok(json!({ "enabled": enabled, "active": false, "message": msg }));
    }
    let (offset, limit, sort) = scan_params(a);
    let res = engine
        .cmd_re_scan_results(offset, limit, sort)
        .map_err(hal_err)?;
    let rows: Vec<Value> = res
        .rows
        .iter()
        .map(|r| {
            json!({
                "candidate": scan_cand_json(&r.candidate),
                "preset": r.preset.as_ref().map(|p| json!({ "factor": p.factor, "offset": p.offset })),
                "current_raw": r.current_raw.map(|x| round(x, 6)),
                "current_physical": r.current_physical.map(|x| round(x, 6)),
                "previous_raw": r.previous_raw.map(|x| round(x, 6)),
                "change_count": r.change_count,
                "kind_hint": r.kind_hint,
                "contained_count": r.contained_count,
                "contained": r.contained.iter().take(MAX_CONTAINED_PER_ROW).map(scan_cand_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    let returned = rows.len() as u32;
    let mut v = json!({
        "enabled": enabled,
        "active": true,
        "scan_id": res.scan_id,
        "step": res.step,
        "total_rows": res.total,
        "candidates": res.candidates,
        "offset": res.offset,
        "limit": limit,
        "sort": match sort { ReScanSort::Id => "id", ReScanSort::Changes => "changes", ReScanSort::Width => "width" },
        "rows": rows,
    });
    let kept = fit_array(&mut v, "/rows", TRIM_BUDGET_BYTES) as u32;
    let next = res.offset.saturating_add(kept.min(returned));
    v["next_offset"] = if next < res.total {
        json!(next)
    } else {
        Value::Null
    };
    Ok(v)
}

// ─── re_row_detail ──────────────────────────────────────────────────────────

pub fn re_row_detail(engine: &PipelineEngine, a: &ReRowDetailArgs) -> ToolResult {
    let t = target_of(a.bus_id, &a.id, a.is_extended)?;
    let enabled = engine.re_status().enabled;
    let detail = match engine.cmd_re_row_detail(t.bus, t.arb_id, t.is_extended) {
        Ok(d) => d,
        Err(_) if !enabled => {
            return Ok(disabled_response(json!({ "target": target_json(&t) })));
        }
        Err(e) => return Err(hal_err(e)),
    };
    let class = engine.cmd_re_classify(t.bus, t.arb_id, t.is_extended).ok();
    let mut v = json!({
        "enabled": enabled,
        "target": target_json(&t),
        "dlc_bytes": detail.dlc_bytes,
        "rx_count": detail.rx_count,
        "first_us": detail.first_us,
        "last_us": detail.last_us,
        "history_len": detail.history_len,
        "masks_note": "hex masks, byte 0 first; bit numbering = DBC Intel (bit = byte*8 + k, k=0 = LSB)",
        "constant_mask": detail.constant_mask,
        "baseline_mask": detail.baseline_mask,
        "action_mask": detail.action_mask,
        "diff_mask": detail.diff_mask,
        "noisy_mask": detail.noisy_mask,
        "toggles": detail.toggles,
    });
    if let Some(c) = class {
        v["classification"] = json!({
            "samples": c.samples,
            "period_ms": c.period_ms.map(|x| round(x, 3)),
            "jitter_ms": c.jitter_ms.map(|x| round(x, 3)),
            "fields": c.fields,
            "bit_entropy": c.bit_entropy.iter().map(|e| round(*e, 2)).collect::<Vec<_>>(),
        });
    }
    if json_len(&v) > TRIM_BUDGET_BYTES {
        if let Some(c) = v.get_mut("classification").and_then(Value::as_object_mut) {
            c.remove("bit_entropy");
        }
        v["truncated"] = json!(true);
    }
    if json_len(&v) > TRIM_BUDGET_BYTES {
        if let Some(o) = v.as_object_mut() {
            o.remove("toggles");
        }
    }
    if v.get("classification").is_some() {
        let mut c = v["classification"].take();
        fit_array(&mut c, "/fields", TRIM_BUDGET_BYTES / 2);
        v["classification"] = c;
    }
    Ok(v)
}

// ─── re_dbc_generate ────────────────────────────────────────────────────────

fn draft_of(i: usize, d: &DraftArg) -> Result<ReSignalDraft, ToolError> {
    let key = parse_id(&d.id)
        .map_err(|e| ToolError::new(format!("draft #{i} id '{}': {e}", echo(&d.id))))?
        .key(d.is_extended)?;
    let num = |x: Option<f64>, dflt: f64, what: &str| -> Result<f64, ToolError> {
        let x = x.unwrap_or(dflt);
        if x.is_finite() {
            Ok(x)
        } else {
            Err(ToolError::new(format!("draft #{i}: {what} must be finite")))
        }
    };
    Ok(ReSignalDraft {
        id: format!("mcp-{i}"),
        bus: d.bus_id.unwrap_or(0),
        arb_id: key.raw_id(),
        is_extended: key.is_extended(),
        message_name: d.message_name.clone(),
        dlc_bytes: d.dlc_bytes.unwrap_or(8),
        name: d.name.clone(),
        start_bit: d.start_bit,
        bit_length: d.bit_length,
        byte_order: d.byte_order.unwrap_or_default().draft(),
        value_type: d.value_type.unwrap_or_default().draft(),
        factor: num(d.factor, 1.0, "factor")?,
        offset: num(d.offset, 0.0, "offset")?,
        min: num(d.min, 0.0, "min")?,
        max: num(d.max, 0.0, "max")?,
        unit: d.unit.clone().unwrap_or_default(),
        comment: d.comment.clone().unwrap_or_default(),
        provenance: ReProvenance {
            r: None,
            lag_ms: None,
            reference: Some("MCP".to_string()),
            samples: None,
            created_at_ms: 0.0,
        },
        value_table: d
            .value_table
            .iter()
            .flatten()
            .map(|e| ReValueTableEntry {
                value: e.value,
                label: e.label.clone(),
            })
            .collect(),
    })
}

/// Clips `text` to at most `max_bytes` bytes, preferably at a line end (char-boundary safe).
fn clip_lines(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let head = &text[..end];
    match head.rfind('\n') {
        Some(nl) => &head[..=nl],
        None => head,
    }
}

pub fn re_dbc_generate(a: &ReDbcGenerateArgs) -> ToolResult {
    if let Some(b) = &a.base_db_id {
        return Err(ToolError::new(format!(
            "base_db_id '{}' is not supported via MCP: the engine keeps no source text of loaded \
             databases to merge into. Omit base_db_id to generate a standalone DBC (the user can \
             merge in the RE view).",
            echo(b)
        )));
    }
    if a.drafts.is_empty() {
        return Err(ToolError::new("drafts is empty; give at least one signal"));
    }
    if a.drafts.len() > MAX_DBC_DRAFTS {
        return Err(ToolError::new(format!(
            "{} drafts given; at most {MAX_DBC_DRAFTS}",
            a.drafts.len()
        )));
    }
    let drafts = a
        .drafts
        .iter()
        .enumerate()
        .map(|(i, d)| draft_of(i, d))
        .collect::<Result<Vec<_>, _>>()?;
    let res = engine_dbc_generate(&drafts, None).map_err(hal_err)?;
    let diag_total = res.diagnostics.len();
    let diagnostics: Vec<Value> = res
        .diagnostics
        .iter()
        .take(MAX_DBC_DIAGNOSTICS)
        .map(|d| {
            json!({
                "severity": d.severity,
                "draft": d.draft_id.as_deref().and_then(|id| id.strip_prefix("mcp-")).and_then(|n| n.parse::<usize>().ok()),
                "code": clip(&d.code, 32),
                "message": clip(&d.message, 240),
            })
        })
        .collect();
    let total_bytes = res.dbc_text.len();
    let mut v = json!({
        "ok": !res.dbc_text.is_empty(),
        "messages": res.messages,
        "signals": res.signals,
        "dbc_bytes": total_bytes,
        "diagnostics_total": diag_total,
        "diagnostics": diagnostics,
        "note": "generated text only: NOT saved to a file and NOT loaded into NexusCAN",
        "truncated": false,
        "dbc_text": "",
    });
    let budget = TRIM_BUDGET_BYTES.saturating_sub(json_len(&v));
    // JSON escaping can grow the text (quotes / backslashes / newlines); shrink until it fits.
    let mut max = budget;
    loop {
        let part = clip_lines(&res.dbc_text, max);
        v["dbc_text"] = json!(part);
        v["truncated"] = json!(part.len() < total_bytes || diag_total > MAX_DBC_DIAGNOSTICS);
        if json_len(&v) <= TRIM_BUDGET_BYTES || max == 0 {
            break;
        }
        max = max.saturating_sub((json_len(&v) - TRIM_BUDGET_BYTES).max(64));
    }
    Ok(v)
}
