//! RE Toolkit R2b: "Save found signals to DBC" generator.
//!
//! Contract: `planning/contracts/re-toolkit-v1.md` §7 (7.1 DTO, 7.2 generator, 7.5a frozen defaults).
//!
//! [`generate_re_dbc`] turns reverse-engineered signal drafts into Vector `.dbc` text, either as a
//! standalone database or merged into a base [`NetworkDatabase`]. It is pure (no I/O), deterministic and
//! never panics on hostile input. Every result is verified before it is returned: the produced text is
//! re-parsed and compiled with the regular pipeline ([`crate::parse_and_compile`]) and each draft (and each
//! base signal) must decode exactly like the IR it came from; otherwise a `roundtrip` error is reported and
//! no text is produced.
//!
//! Bit geometry is validated exclusively through [`NormalizedBitSpan`] (no separate Intel/Motorola math).

use crate::compiler::{CompiledDatabase, CompiledMessage, CompiledSignal, NormalizedBitSpan};
use crate::formats::{dbc::DbcWriter, ParseOptions};
use crate::ir::{
    attrs::FrameProtocol,
    mux::{MuxRange, MuxRole},
    ByteOrder, MessageDef, NetworkDatabase, SignalDef, SignalValueType,
};
use crate::{parse_and_compile, DecodedSignalSample};
use indexmap::IndexMap;
use nexus_core::CanIdKey;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

// ─── DTOs (shared Rust <-> TS, camelCase) ────────────────────────────────────────────────

/// Byte order of a draft signal (`"intel"` | `"motorola"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReByteOrder {
    /// Intel / little-endian (`@1`), start bit = LSB.
    Intel,
    /// Motorola / big-endian (`@0`), start bit = MSB in Vector sawtooth numbering.
    Motorola,
}

/// Raw value interpretation of a draft signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReSignalValueType {
    Unsigned,
    Signed,
    Float32,
    Float64,
}

/// Where a draft came from (correlation statistics); rendered as the `RE: ...` comment line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReProvenance {
    pub r: Option<f64>,
    pub lag_ms: Option<f64>,
    pub reference: Option<String>,
    pub samples: Option<u64>,
    pub created_at_ms: f64,
}

/// One `VAL_` entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReValueTableEntry {
    pub value: i64,
    pub label: String,
}

/// A signal found with the RE toolkit, ready to be written to a DBC.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReSignalDraft {
    pub id: String,
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
    pub message_name: Option<String>,
    pub dlc_bytes: u8,
    pub name: String,
    /// DBC convention: Intel = LSB, Motorola = MSB (sawtooth).
    pub start_bit: u16,
    pub bit_length: u8,
    pub byte_order: ReByteOrder,
    pub value_type: ReSignalValueType,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub unit: String,
    pub comment: String,
    pub provenance: ReProvenance,
    pub value_table: Vec<ReValueTableEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReDbcSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReDbcDiagnostic {
    pub severity: ReDbcSeverity,
    pub draft_id: Option<String>,
    /// `bad_name` | `duplicate_name` | `out_of_range` | `overlap` | `bad_scale` | `float_len` |
    /// `name_long` | `base_lossy` | `id_conflict_dlc` | `roundtrip`
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReDbcGenerateResult {
    /// `""` when any diagnostic has severity [`ReDbcSeverity::Error`].
    pub dbc_text: String,
    pub diagnostics: Vec<ReDbcDiagnostic>,
    /// Distinct messages that received >= 1 draft (0 on error).
    pub messages: usize,
    /// Draft signals written (0 on error); base signals are not counted.
    pub signals: usize,
}

// ─── Constants ───────────────────────────────────────────────────────────────────────────

/// Maximum identifier length accepted (longer → `bad_name`).
const MAX_NAME_LEN: usize = 64;
/// Identifiers longer than this get a `name_long` warning (classic CANdb++ limit).
const LONG_NAME_WARN: usize = 32;
/// Maximum CAN-FD payload.
const MAX_DLC: u8 = 64;
const MAX_BITS: usize = 512;
const STD_ID_MAX: u32 = 0x7FF;
const EXT_ID_MAX: u32 = 0x1FFF_FFFF;
const VECTOR_XXX: &str = "Vector__XXX";
const RE_NODE: &str = "RE_FOUND";
const RE_VERSION: &str = "NexusCAN RE";
/// At most this many individual `base_lossy` warnings; the rest is summarized in one more warning.
const MAX_LOSSY_WARNINGS: usize = 16;

// ─── Public entry point ──────────────────────────────────────────────────────────────────

/// Generates DBC text for `drafts`, standalone (`base == None`) or merged into `base`.
///
/// Any error diagnostic yields `dbc_text == ""` and `messages == signals == 0`.
pub fn generate_re_dbc(
    drafts: &[ReSignalDraft],
    base: Option<&NetworkDatabase>,
) -> ReDbcGenerateResult {
    let mut diags = Diags::default();

    // 1. Per-draft validation.
    let checked: Vec<CheckedDraft> = drafts.iter().map(|d| check_draft(d, &mut diags)).collect();

    // 2. Group bus-agnostically by (id, extended). BTreeMap → deterministic order (std before ext, by id).
    let mut groups: BTreeMap<CanIdKey, Vec<usize>> = BTreeMap::new();
    for (idx, c) in checked.iter().enumerate() {
        if let Some(key) = c.key {
            groups.entry(key).or_default().push(idx);
        }
    }

    // 3. Per-message validation (names, DLC vs base, duplicates, overlaps).
    let mut plans: Vec<MessagePlan> = Vec::with_capacity(groups.len());
    for (key, members) in &groups {
        let base_msg = base.and_then(|b| b.messages.get(key));
        plans.push(plan_message(
            *key, members, drafts, &checked, base_msg, &mut diags,
        ));
    }

    if diags.has_error() {
        return diags.into_failed();
    }

    // 4. Build the output IR.
    let db = build_database(drafts, &plans, base);

    // 5. Write.
    let text = match DbcWriter::new(&db).write_to_string() {
        Ok(t) => t,
        Err(e) => {
            diags.error(None, "roundtrip", format!("DBC writer failed: {e}"));
            return diags.into_failed();
        }
    };

    // 6. Round-trip self-check with the regular pipeline.
    verify_roundtrip(&text, &db, drafts, &plans, base, &mut diags);
    if diags.has_error() {
        return diags.into_failed();
    }

    ReDbcGenerateResult {
        dbc_text: text,
        diagnostics: diags.list,
        messages: plans.len(),
        signals: plans.iter().map(|p| p.members.len()).sum(),
    }
}

// ─── Diagnostics accumulator ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct Diags {
    list: Vec<ReDbcDiagnostic>,
}

impl Diags {
    fn push(&mut self, severity: ReDbcSeverity, draft: Option<&str>, code: &str, message: String) {
        self.list.push(ReDbcDiagnostic {
            severity,
            draft_id: draft.map(str::to_string),
            code: code.to_string(),
            message,
        });
    }

    fn error(&mut self, draft: Option<&str>, code: &str, message: String) {
        self.push(ReDbcSeverity::Error, draft, code, message);
    }

    fn warn(&mut self, draft: Option<&str>, code: &str, message: String) {
        self.push(ReDbcSeverity::Warning, draft, code, message);
    }

    fn has_error(&self) -> bool {
        self.list.iter().any(|d| d.severity == ReDbcSeverity::Error)
    }

    fn into_failed(self) -> ReDbcGenerateResult {
        ReDbcGenerateResult {
            dbc_text: String::new(),
            diagnostics: self.list,
            messages: 0,
            signals: 0,
        }
    }
}

// ─── Stage 1: per-draft checks ───────────────────────────────────────────────────────────

struct CheckedDraft {
    /// `None` when the arbitration id is out of range for its frame format.
    key: Option<CanIdKey>,
    /// `None` when the bit geometry is invalid (already reported).
    span: Option<NormalizedBitSpan>,
}

fn to_byte_order(o: ReByteOrder) -> ByteOrder {
    match o {
        ReByteOrder::Intel => ByteOrder::LittleEndian,
        ReByteOrder::Motorola => ByteOrder::BigEndian,
    }
}

fn to_value_type(v: ReSignalValueType) -> SignalValueType {
    match v {
        ReSignalValueType::Unsigned => SignalValueType::Unsigned,
        ReSignalValueType::Signed => SignalValueType::Signed,
        ReSignalValueType::Float32 => SignalValueType::Float32,
        ReSignalValueType::Float64 => SignalValueType::Float64,
    }
}

/// DBC identifier: `[A-Za-z_][A-Za-z0-9_]*` (ASCII only).
fn is_dbc_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Shortens untrusted text for inclusion in a diagnostic message.
fn preview(s: &str) -> String {
    const MAX: usize = 40;
    if s.chars().count() <= MAX {
        format!("{s:?}")
    } else {
        let head: String = s.chars().take(MAX).collect();
        format!("{head:?}…")
    }
}

fn check_draft(d: &ReSignalDraft, diags: &mut Diags) -> CheckedDraft {
    let id = Some(d.id.as_str());

    // Arbitration id range.
    let key = if d.is_extended {
        if d.arb_id <= EXT_ID_MAX {
            Some(CanIdKey::Extended(d.arb_id))
        } else {
            diags.error(
                id,
                "out_of_range",
                format!("extended id 0x{:X} exceeds 29 bits", d.arb_id),
            );
            None
        }
    } else if d.arb_id <= STD_ID_MAX {
        // Range-checked above, the narrowing cannot truncate.
        Some(CanIdKey::Standard(d.arb_id as u16))
    } else {
        diags.error(
            id,
            "out_of_range",
            format!("standard id 0x{:X} exceeds 11 bits", d.arb_id),
        );
        None
    };

    // Signal name.
    let name_len = d.name.chars().count();
    if !is_dbc_ident(&d.name) || name_len > MAX_NAME_LEN {
        diags.error(
            id,
            "bad_name",
            format!(
                "signal name {} is not a DBC identifier ([A-Za-z_][A-Za-z0-9_]*, at most {MAX_NAME_LEN} chars)",
                preview(&d.name)
            ),
        );
    } else if name_len > LONG_NAME_WARN {
        diags.warn(
            id,
            "name_long",
            format!(
                "signal name '{}' has {name_len} chars; some tools truncate names longer than {LONG_NAME_WARN}",
                d.name
            ),
        );
    }

    // Scaling.
    let mut scale_issues: Vec<&str> = Vec::new();
    if !d.factor.is_finite() {
        scale_issues.push("factor is not finite");
    } else if d.factor == 0.0 {
        scale_issues.push("factor is 0");
    }
    if !d.offset.is_finite() {
        scale_issues.push("offset is not finite");
    }
    if !d.min.is_finite() {
        scale_issues.push("min is not finite");
    }
    if !d.max.is_finite() {
        scale_issues.push("max is not finite");
    }
    if d.min.is_finite() && d.max.is_finite() && d.min > d.max {
        scale_issues.push("min > max");
    }
    if !scale_issues.is_empty() {
        diags.error(id, "bad_scale", scale_issues.join(", "));
    }

    // Float width.
    let float_ok = match d.value_type {
        ReSignalValueType::Float32 if d.bit_length != 32 => {
            diags.error(
                id,
                "float_len",
                format!("float32 needs bitLength 32, got {}", d.bit_length),
            );
            false
        }
        ReSignalValueType::Float64 if d.bit_length != 64 => {
            diags.error(
                id,
                "float_len",
                format!("float64 needs bitLength 64, got {}", d.bit_length),
            );
            false
        }
        _ => true,
    };

    // Bit geometry (only meaningful when the width itself is consistent).
    let span = if !float_ok {
        None
    } else if d.dlc_bytes == 0 || d.dlc_bytes > MAX_DLC {
        diags.error(
            id,
            "out_of_range",
            format!("dlcBytes {} is outside 1..={MAX_DLC}", d.dlc_bytes),
        );
        None
    } else {
        match NormalizedBitSpan::compile(d.start_bit, d.bit_length, to_byte_order(d.byte_order)) {
            Err(e) => {
                diags.error(
                    id,
                    "out_of_range",
                    format!(
                        "invalid bit span start {} length {}: {e}",
                        d.start_bit, d.bit_length
                    ),
                );
                None
            }
            Ok(span) if span.max_byte >= d.dlc_bytes => {
                diags.error(
                    id,
                    "out_of_range",
                    format!(
                        "bits {}|{} reach byte {} but dlcBytes is {}",
                        d.start_bit, d.bit_length, span.max_byte, d.dlc_bytes
                    ),
                );
                None
            }
            Ok(span) => Some(span),
        }
    };

    CheckedDraft { key, span }
}

// ─── Stage 2: per-message checks ─────────────────────────────────────────────────────────

struct MessagePlan {
    key: CanIdKey,
    /// Draft indices in input order.
    members: Vec<usize>,
    /// Name and DLC used when the message is new (ignored when the base already has it).
    new_name: String,
    new_dlc: u8,
}

#[derive(Clone, Copy)]
enum BitOwner {
    Free,
    Base(usize),
    Draft(usize),
}

fn auto_message_name(key: CanIdKey) -> String {
    match key {
        CanIdKey::Standard(id) => format!("RE_{:03X}", id),
        CanIdKey::Extended(id) => format!("RE_{:08X}", id),
    }
}

fn plan_message(
    key: CanIdKey,
    members: &[usize],
    drafts: &[ReSignalDraft],
    checked: &[CheckedDraft],
    base_msg: Option<&MessageDef>,
    diags: &mut Diags,
) -> MessagePlan {
    // Name / DLC.
    let mut new_name = auto_message_name(key);
    let mut new_dlc = 0u8;
    if let Some(bm) = base_msg {
        for &i in members {
            let d = &drafts[i];
            if d.dlc_bytes != bm.dlc {
                diags.warn(
                    Some(&d.id),
                    "id_conflict_dlc",
                    format!(
                        "base message '{}' has DLC {} but the draft says {}; the base DLC is kept",
                        bm.name, bm.dlc, d.dlc_bytes
                    ),
                );
            }
            if let Some(span) = &checked[i].span {
                if span.max_byte >= bm.dlc {
                    diags.error(
                        Some(&d.id),
                        "out_of_range",
                        format!(
                            "bits {}|{} reach byte {} but base message '{}' has DLC {}",
                            d.start_bit, d.bit_length, span.max_byte, bm.name, bm.dlc
                        ),
                    );
                }
            }
        }
    } else {
        for &i in members {
            let d = &drafts[i];
            if d.dlc_bytes <= MAX_DLC {
                new_dlc = new_dlc.max(d.dlc_bytes);
            }
        }
        if let Some(&i) = members.iter().find(|&&i| drafts[i].message_name.is_some()) {
            let d = &drafts[i];
            let requested = d.message_name.as_deref().unwrap_or_default();
            if is_dbc_ident(requested) && requested.chars().count() <= MAX_NAME_LEN {
                new_name = requested.to_string();
            } else {
                diags.error(
                    Some(&d.id),
                    "bad_name",
                    format!(
                        "message name {} is not a DBC identifier ([A-Za-z_][A-Za-z0-9_]*, at most {MAX_NAME_LEN} chars)",
                        preview(requested)
                    ),
                );
            }
        }
    }

    // Duplicate names inside the message (base signals first, then drafts in input order).
    let mut names: HashSet<&str> = base_msg
        .map(|bm| bm.signals.iter().map(|s| s.name.as_str()).collect())
        .unwrap_or_default();
    for &i in members {
        let d = &drafts[i];
        if !names.insert(d.name.as_str()) {
            diags.error(
                Some(&d.id),
                "duplicate_name",
                format!(
                    "signal name '{}' already exists in message {}",
                    d.name,
                    key.schema_key()
                ),
            );
        }
    }

    // Bit overlap: base signals (any mux branch, switches included) and earlier drafts.
    let mut owners = [BitOwner::Free; MAX_BITS];
    if let Some(bm) = base_msg {
        for (si, s) in bm.signals.iter().enumerate() {
            if let Ok(span) = NormalizedBitSpan::compile(s.start_bit, s.bit_len, s.byte_order) {
                for &(byte, bit) in &span.bit_coords {
                    let pos = usize::from(byte) * 8 + usize::from(bit);
                    if let Some(slot) = owners.get_mut(pos) {
                        if matches!(slot, BitOwner::Free) {
                            *slot = BitOwner::Base(si);
                        }
                    }
                }
            }
        }
    }
    for &i in members {
        let Some(span) = &checked[i].span else {
            continue;
        };
        let positions = span
            .bit_coords
            .iter()
            .map(|&(byte, bit)| usize::from(byte) * 8 + usize::from(bit));
        let conflict = positions.clone().find_map(|pos| match owners.get(pos) {
            Some(BitOwner::Free) | None => None,
            Some(o) => Some(*o),
        });
        match conflict {
            Some(BitOwner::Base(si)) => {
                let other = base_msg
                    .and_then(|bm| bm.signals.get(si))
                    .map(|s| s.name.as_str())
                    .unwrap_or("?");
                diags.error(
                    Some(&drafts[i].id),
                    "overlap",
                    format!(
                        "signal '{}' overlaps base signal '{}' in message {}",
                        drafts[i].name,
                        other,
                        key.schema_key()
                    ),
                );
            }
            Some(BitOwner::Draft(j)) => {
                diags.error(
                    Some(&drafts[i].id),
                    "overlap",
                    format!(
                        "signal '{}' overlaps draft '{}' in message {}",
                        drafts[i].name,
                        drafts[j].name,
                        key.schema_key()
                    ),
                );
            }
            Some(BitOwner::Free) | None => {
                for pos in positions {
                    if let Some(slot) = owners.get_mut(pos) {
                        *slot = BitOwner::Draft(i);
                    }
                }
            }
        }
    }

    MessagePlan {
        key,
        members: members.to_vec(),
        new_name,
        new_dlc,
    }
}

// ─── Stage 3: IR construction ────────────────────────────────────────────────────────────

/// `RE: r=<3 dp> lag=<signed int>ms ref=<ref> n=<samples>`; null tokens dropped; all null → `RE: manual`.
fn provenance_line(p: &ReProvenance) -> String {
    let mut tokens: Vec<String> = Vec::with_capacity(4);
    if let Some(r) = p.r {
        tokens.push(format!("r={r:.3}"));
    }
    if let Some(lag) = p.lag_ms {
        // `as` saturates (NaN → 0); `+0` for zero / negative zero.
        let lag = lag.round() as i64;
        tokens.push(format!("lag={lag:+}ms"));
    }
    if let Some(reference) = p.reference.as_deref().filter(|s| !s.trim().is_empty()) {
        tokens.push(format!("ref={reference}"));
    }
    if let Some(n) = p.samples {
        tokens.push(format!("n={n}"));
    }
    if tokens.is_empty() {
        "RE: manual".to_string()
    } else {
        format!("RE: {}", tokens.join(" "))
    }
}

fn comment_text(d: &ReSignalDraft) -> String {
    let line = provenance_line(&d.provenance);
    if d.comment.is_empty() {
        line
    } else {
        format!("{}\n{}", d.comment, line)
    }
}

fn draft_signal_def(d: &ReSignalDraft) -> SignalDef {
    let mut enum_values = IndexMap::with_capacity(d.value_table.len());
    for e in &d.value_table {
        enum_values.insert(e.value, e.label.clone());
    }
    SignalDef {
        id: 0,
        name: d.name.clone(),
        long_name: None,
        start_bit: d.start_bit,
        bit_len: d.bit_length,
        byte_order: to_byte_order(d.byte_order),
        value_type: to_value_type(d.value_type),
        factor: d.factor,
        offset: d.offset,
        min: d.min,
        max: d.max,
        unit: d.unit.clone(),
        receivers: vec![VECTOR_XXX.to_string()],
        mux_role: MuxRole::Static,
        comment: Some(comment_text(d)),
        enum_values,
        initial_value: None,
        attributes: IndexMap::new(),
    }
}

fn build_database(
    drafts: &[ReSignalDraft],
    plans: &[MessagePlan],
    base: Option<&NetworkDatabase>,
) -> NetworkDatabase {
    let mut db = match base {
        Some(b) => b.clone(),
        None => {
            let mut db = NetworkDatabase::new("RE_found");
            db.version = Some(RE_VERSION.to_string());
            db.nodes.insert(
                RE_NODE.to_string(),
                crate::ir::EcuNode {
                    name: RE_NODE.to_string(),
                    ..Default::default()
                },
            );
            db
        }
    };

    for plan in plans {
        let signals = plan.members.iter().map(|&i| draft_signal_def(&drafts[i]));
        if let Some(msg) = db.messages.get_mut(&plan.key) {
            msg.signals.extend(signals);
        } else {
            db.messages.insert(
                plan.key,
                MessageDef {
                    can_id: plan.key,
                    name: plan.new_name.clone(),
                    dlc: plan.new_dlc,
                    transmitters: vec![VECTOR_XXX.to_string()],
                    signals: signals.collect(),
                    comment: None,
                    protocol: if plan.new_dlc > 8 {
                        FrameProtocol::CanFd
                    } else {
                        FrameProtocol::ClassicalCan
                    },
                    expected_cycle_ms: None,
                    attributes: IndexMap::new(),
                    signal_groups: Vec::new(),
                },
            );
        }
    }
    db
}

// ─── Stage 4: round-trip verification ────────────────────────────────────────────────────

fn find_signal<'a>(msg: &'a CompiledMessage, name: &str) -> Option<&'a CompiledSignal> {
    msg.all_signals.iter().find(|s| s.name == name)
}

fn exact_message<'a>(db: &'a CompiledDatabase, key: &CanIdKey) -> Option<&'a CompiledMessage> {
    db.message_index.get(key).and_then(|&i| db.messages.get(i))
}

/// Mux role with the switch expressed as an index inside the message (dense ids differ between DBs).
#[derive(PartialEq, Debug)]
enum NormMux {
    Static,
    Master,
    Muxed {
        switch_index: Option<usize>,
        ranges: Vec<MuxRange>,
        is_sub_switch: bool,
    },
}

fn norm_mux(msg: &CompiledMessage, s: &CompiledSignal) -> NormMux {
    match &s.mux_role {
        MuxRole::Static => NormMux::Static,
        MuxRole::MasterSwitch => NormMux::Master,
        MuxRole::Multiplexed {
            switch_signal,
            ranges,
            is_sub_switch,
            ..
        } => NormMux::Muxed {
            switch_index: msg.all_signal_ids.iter().position(|id| id == switch_signal),
            ranges: ranges.to_vec(),
            is_sub_switch: *is_sub_switch,
        },
    }
}

/// Every field that influences RX decoding or TX packing of a signal.
fn decode_shape_differs(
    a_msg: &CompiledMessage,
    a: &CompiledSignal,
    b_msg: &CompiledMessage,
    b: &CompiledSignal,
) -> Option<&'static str> {
    if a.start_bit != b.start_bit || a.bit_len != b.bit_len {
        return Some("bit position");
    }
    if a.byte_order != b.byte_order {
        return Some("byte order");
    }
    if a.value_type != b.value_type {
        return Some("value type");
    }
    if a.factor.to_bits() != b.factor.to_bits() || a.offset.to_bits() != b.offset.to_bits() {
        return Some("factor/offset");
    }
    if a.min.to_bits() != b.min.to_bits()
        || a.max.to_bits() != b.max.to_bits()
        || a.has_bounds != b.has_bounds
    {
        return Some("min/max");
    }
    if norm_mux(a_msg, a) != norm_mux(b_msg, b) {
        return Some("multiplexing");
    }
    None
}

/// Deterministic test payloads (patterns + LCG noise) of `len` bytes.
fn test_payloads(len: usize) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = [0x00u8, 0xFF, 0xAA, 0x55]
        .iter()
        .map(|&b| vec![b; len])
        .collect();
    let mut seed: u64 = 0x4E58_5245_5F44_4243; // "NXRE_DBC"
    for _ in 0..4 {
        let p = (0..len)
            .map(|_| {
                seed = seed
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (seed >> 33) as u8
            })
            .collect();
        out.push(p);
    }
    out
}

fn decode_one(
    db: &CompiledDatabase,
    key: CanIdKey,
    payload: &[u8],
    sig_id: u32,
) -> Option<(u64, u64)> {
    let n = exact_message(db, &key)?.all_signals.len().max(1);
    let blank = DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    };
    let mut buf = vec![blank; n];
    let mut sw = vec![(0u32, 0i64); n];
    let sum = db.decode_payload_into(key, payload, &mut buf, &mut sw)?;
    buf.get(..sum.decoded_count)?
        .iter()
        .find(|s| s.signal_id == sig_id)
        .map(|s| (s.raw_bits, s.physical_value.to_bits()))
}

fn verify_roundtrip(
    text: &str,
    db: &NetworkDatabase,
    drafts: &[ReSignalDraft],
    plans: &[MessagePlan],
    base: Option<&NetworkDatabase>,
    diags: &mut Diags,
) {
    let (rt, _schema) = match parse_and_compile(
        text.as_bytes(),
        Some("RE_found.dbc"),
        &ParseOptions::default(),
    ) {
        Ok(v) => v,
        Err(e) => {
            diags.error(
                None,
                "roundtrip",
                format!("generated DBC does not re-parse/compile: {e}"),
            );
            return;
        }
    };
    let reference = match CompiledDatabase::compile(db.clone()) {
        Ok(c) => c,
        Err(e) => {
            diags.error(
                None,
                "roundtrip",
                format!("database does not compile before export: {e}"),
            );
            return;
        }
    };

    // Drafts: definition and decoded values must match the IR they came from.
    for plan in plans {
        let (Some(ref_msg), Some(rt_msg)) = (
            exact_message(&reference, &plan.key),
            exact_message(&rt, &plan.key),
        ) else {
            for &i in &plan.members {
                diags.error(
                    Some(&drafts[i].id),
                    "roundtrip",
                    format!("message {} missing after re-parse", plan.key.schema_key()),
                );
            }
            continue;
        };
        let payloads = test_payloads(usize::from(rt_msg.dlc.min(MAX_DLC)));
        for &i in &plan.members {
            let d = &drafts[i];
            let fail = |diags: &mut Diags, why: String| {
                diags.error(
                    Some(&d.id),
                    "roundtrip",
                    format!("signal '{}' does not round-trip: {why}", d.name),
                );
            };
            let (Some(a), Some(b)) = (find_signal(ref_msg, &d.name), find_signal(rt_msg, &d.name))
            else {
                fail(diags, "missing after re-parse".to_string());
                continue;
            };
            if let Some(what) = decode_shape_differs(ref_msg, a, rt_msg, b) {
                fail(diags, format!("{what} changed"));
                continue;
            }
            if b.mux_role != MuxRole::Static {
                fail(diags, "became multiplexed".to_string());
                continue;
            }
            if a.unit != b.unit || a.comment != b.comment || a.enum_values != b.enum_values {
                fail(diags, "unit/comment/value table changed".to_string());
                continue;
            }
            let decode_mismatch = payloads.iter().any(|p| {
                decode_one(&reference, plan.key, p, a.id) != decode_one(&rt, plan.key, p, b.id)
            });
            if decode_mismatch {
                fail(diags, "decoded value differs".to_string());
            }
        }
    }

    if let Some(base) = base {
        verify_base(base, &reference, &rt, diags);
    }
}

/// Base signals must decode bit-identically (error `roundtrip`); metadata loss → `base_lossy` warnings.
fn verify_base(
    base: &NetworkDatabase,
    reference: &CompiledDatabase,
    rt: &CompiledDatabase,
    diags: &mut Diags,
) {
    let mut lossy: Vec<String> = Vec::new();
    let rt_db = &rt.raw_database;

    for (key, bm) in &base.messages {
        let (Some(ref_msg), Some(rt_msg)) = (exact_message(reference, key), exact_message(rt, key))
        else {
            diags.error(
                None,
                "roundtrip",
                format!(
                    "base message '{}' ({}) is lost by the DBC writer",
                    bm.name,
                    key.schema_key()
                ),
            );
            continue;
        };
        // Base signals occupy the first `bm.signals.len()` slots in both (drafts are appended).
        for (si, sig) in bm.signals.iter().enumerate() {
            let (Some(a), Some(b)) = (ref_msg.all_signals.get(si), rt_msg.all_signals.get(si))
            else {
                diags.error(
                    None,
                    "roundtrip",
                    format!(
                        "base signal '{}' in '{}' is lost by the DBC writer",
                        sig.name, bm.name
                    ),
                );
                continue;
            };
            if let Some(what) = decode_shape_differs(ref_msg, a, rt_msg, b) {
                diags.error(
                    None,
                    "roundtrip",
                    format!(
                        "base signal '{}' in '{}' would decode differently after export ({what})",
                        sig.name, bm.name
                    ),
                );
            }
        }

        // Metadata.
        let Some(rm) = rt_db.messages.get(key) else {
            continue;
        };
        let m = &bm.name;
        if rm.name != bm.name {
            lossy.push(format!("message '{m}' is renamed to '{}'", rm.name));
        }
        if rm.dlc != bm.dlc {
            lossy.push(format!("message '{m}' DLC {} becomes {}", bm.dlc, rm.dlc));
        }
        if !same_nodes(&rm.transmitters, &bm.transmitters) {
            lossy.push(format!("message '{m}' transmitters change"));
        }
        if rm.comment != bm.comment {
            lossy.push(format!("message '{m}' comment changes"));
        }
        if rm.protocol != bm.protocol || rm.expected_cycle_ms != bm.expected_cycle_ms {
            lossy.push(format!("message '{m}' frame format / cycle time changes"));
        }
        if rm.attributes != bm.attributes {
            lossy.push(format!("message '{m}' attributes change"));
        }
        if rm.signal_groups != bm.signal_groups {
            lossy.push(format!("message '{m}' signal groups change"));
        }
        for (si, s) in bm.signals.iter().enumerate() {
            let Some(r) = rm.signals.get(si) else {
                continue;
            };
            let what = signal_metadata_diff(s, r);
            if !what.is_empty() {
                lossy.push(format!(
                    "signal '{}' in '{m}': {} change",
                    s.name,
                    what.join(", ")
                ));
            }
        }
    }

    // Database-level constructs.
    if rt_db.version != base.version {
        lossy.push("database version changes".to_string());
    }
    if rt_db.comment != base.comment {
        lossy.push("database comment changes".to_string());
    }
    if !base.buses.is_empty() {
        lossy.push(format!(
            "{} bus definition(s) cannot be expressed in DBC",
            base.buses.len()
        ));
    }
    if rt_db.nodes.len() != base.nodes.len()
        || base.nodes.iter().any(|(k, n)| {
            rt_db
                .nodes
                .get(k)
                .is_none_or(|r| r.comment != n.comment || r.attributes != n.attributes)
        })
    {
        lossy.push("node list / node comments / node attributes change".to_string());
    }
    if rt_db.value_tables != base.value_tables {
        lossy.push("VAL_TABLE_ definitions change".to_string());
    }
    if rt_db.attribute_defs != base.attribute_defs {
        lossy.push("attribute definitions (BA_DEF_ / BA_DEF_DEF_) change".to_string());
    }
    if rt_db.network_attributes != base.network_attributes {
        lossy.push("network attributes change".to_string());
    }
    if rt_db.signal_groups != base.signal_groups {
        lossy.push("database-level signal groups change".to_string());
    }
    if !base.env_vars.is_empty() && rt_db.env_vars != base.env_vars {
        lossy.push(format!(
            "{} environment variable(s) (EV_) are not written",
            base.env_vars.len()
        ));
    }
    if rt_db.independent_signals.len() != base.independent_signals.len()
        || base
            .independent_signals
            .iter()
            .zip(&rt_db.independent_signals)
            .any(|(a, b)| {
                a.name != b.name
                    || a.start_bit != b.start_bit
                    || a.bit_len != b.bit_len
                    || a.byte_order != b.byte_order
                    || a.value_type != b.value_type
                    || !signal_metadata_diff(a, b).is_empty()
            })
    {
        lossy.push("VECTOR__INDEPENDENT_SIG_MSG signals change".to_string());
    }

    let total = lossy.len();
    for msg in lossy.iter().take(MAX_LOSSY_WARNINGS) {
        diags.warn(None, "base_lossy", msg.clone());
    }
    if total > MAX_LOSSY_WARNINGS {
        diags.warn(
            None,
            "base_lossy",
            format!(
                "{} more base construct(s) cannot be round-tripped",
                total - MAX_LOSSY_WARNINGS
            ),
        );
    }
}

/// `[]` and `["Vector__XXX"]` both mean "no node".
fn same_nodes(a: &[String], b: &[String]) -> bool {
    let strip = |v: &[String]| -> Vec<String> {
        v.iter()
            .filter(|s| s.as_str() != VECTOR_XXX)
            .cloned()
            .collect()
    };
    strip(a) == strip(b)
}

fn signal_metadata_diff(s: &SignalDef, r: &SignalDef) -> Vec<&'static str> {
    let mut what = Vec::new();
    if r.name != s.name {
        what.push("name");
    }
    if r.long_name != s.long_name {
        what.push("long name");
    }
    if r.unit != s.unit {
        what.push("unit");
    }
    if !same_nodes(&r.receivers, &s.receivers) {
        what.push("receivers");
    }
    if r.comment != s.comment {
        what.push("comment");
    }
    if r.enum_values != s.enum_values {
        what.push("value table");
    }
    if r.attributes != s.attributes {
        what.push("attributes");
    }
    if r.min.to_bits() != s.min.to_bits() || r.max.to_bits() != s.max.to_bits() {
        what.push("min/max");
    }
    if r.initial_value.map(f64::to_bits) != s.initial_value.map(f64::to_bits) {
        what.push("start value");
    }
    what
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prov() -> ReProvenance {
        ReProvenance {
            r: None,
            lag_ms: None,
            reference: None,
            samples: None,
            created_at_ms: 0.0,
        }
    }

    #[test]
    fn provenance_tokens() {
        assert_eq!(provenance_line(&prov()), "RE: manual");
        let mut p = prov();
        p.lag_ms = Some(-0.4);
        assert_eq!(provenance_line(&p), "RE: lag=+0ms");
        p.lag_ms = Some(f64::NAN);
        p.reference = Some("  ".into());
        assert_eq!(provenance_line(&p), "RE: lag=+0ms");
    }

    #[test]
    fn ident_rules() {
        assert!(is_dbc_ident("_a1"));
        assert!(!is_dbc_ident(""));
        assert!(!is_dbc_ident("1a"));
        assert!(!is_dbc_ident("çay"));
    }

    #[test]
    fn hostile_ids_and_message_names_do_not_panic() {
        let d = ReSignalDraft {
            id: "h".into(),
            bus: 0,
            arb_id: u32::MAX,
            is_extended: false,
            message_name: Some("bad name\"".into()),
            dlc_bytes: 255,
            name: "x".repeat(10_000),
            start_bit: u16::MAX,
            bit_length: u8::MAX,
            byte_order: ReByteOrder::Motorola,
            value_type: ReSignalValueType::Float64,
            factor: f64::NAN,
            offset: f64::INFINITY,
            min: 1.0,
            max: 0.0,
            unit: "\"\\".into(),
            comment: "\0".into(),
            provenance: prov(),
            value_table: vec![ReValueTableEntry {
                value: i64::MIN,
                label: "\"".into(),
            }],
        };
        let res = generate_re_dbc(std::slice::from_ref(&d), None);
        assert!(res.dbc_text.is_empty());
        let mut e = d;
        e.arb_id = 0x7FF;
        e.name = "Ok".into();
        e.dlc_bytes = 8;
        e.start_bit = 0;
        e.bit_length = 64;
        e.byte_order = ReByteOrder::Intel;
        e.factor = 1.0;
        e.offset = 0.0;
        e.min = 0.0;
        e.max = 0.0;
        let res = generate_re_dbc(std::slice::from_ref(&e), None);
        assert!(res
            .diagnostics
            .iter()
            .any(|x| x.code == "bad_name" && x.message.contains("message name")));
        e.message_name = None;
        let res = generate_re_dbc(&[e], None);
        assert!(!res.dbc_text.is_empty(), "{:#?}", res.diagnostics);
    }
}
