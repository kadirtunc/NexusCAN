pub mod bit_plan;
pub mod mux_tree;

pub use bit_plan::NormalizedBitSpan;
pub use mux_tree::{MuxBranch, MuxDecisionTree, MAX_MUX_DEPTH};

use crate::error::DbError;
use crate::ir::{
    attrs::FrameProtocol,
    mux::{MuxRole, SignalId},
    ByteOrder, NetworkDatabase, SignalValueType,
};
use indexmap::IndexMap;
use nexus_core::CanIdKey;
use rustc_hash::{FxHashMap, FxHashSet};
use smallvec::SmallVec;

/// Pre-compiled execution plan for a signal, enabling zero-allocation runtime RX decoding & TX packing.
#[derive(Clone, Debug)]
pub struct CompiledSignal {
    pub id: SignalId,
    pub name: String,
    pub long_name: Option<String>,
    pub start_bit: u16,
    pub bit_len: u8,
    pub byte_order: ByteOrder,
    pub value_type: SignalValueType,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub unit: String,
    pub receivers: Vec<String>,
    pub mux_role: MuxRole,
    pub bit_span: NormalizedBitSpan,
    pub initial_value: Option<f64>,
    pub has_bounds: bool,
    pub has_enum_table: bool,
    pub enum_values: IndexMap<i64, String>,
    pub comment: Option<String>,
}

impl CompiledSignal {
    #[inline(always)]
    pub fn extract_raw(&self, payload: &[u8]) -> u64 {
        self.bit_span.extract_raw_u64(payload)
    }

    #[inline(always)]
    pub fn decode_physical(&self, raw: u64) -> (i64, f64, bool) {
        let (raw_int, phys) = match self.value_type {
            SignalValueType::Unsigned => {
                let phys = (raw as f64) * self.factor + self.offset;
                (raw as i64, phys)
            }
            SignalValueType::Signed => {
                let shift = 64 - self.bit_len;
                let signed_raw = ((raw << shift) as i64) >> shift;
                let phys = (signed_raw as f64) * self.factor + self.offset;
                (signed_raw, phys)
            }
            SignalValueType::Float32 => {
                let f_val = f32::from_bits(raw as u32) as f64;
                let phys = f_val * self.factor + self.offset;
                (raw as i64, phys)
            }
            SignalValueType::Float64 => {
                let f_val = f64::from_bits(raw);
                let phys = f_val * self.factor + self.offset;
                (raw as i64, phys)
            }
        };

        let out_of_range = if self.has_bounds {
            phys < self.min - 1e-9 || phys > self.max + 1e-9
        } else {
            false
        };

        (raw_int, phys, out_of_range)
    }
}

/// Normalizes a signal's `[min|max]` engineering range for TX clamping / RX range checks.
///
/// Returns `(min, max, has_bounds)`:
/// - `[0|0]` (the DBC convention for "no range") -> unbounded.
/// - Inverted ranges (`min > max`) are **swapped**, never treated as "unbounded": an OEM typo must not
///   silently disable TX clamping. The DBC parser additionally emits an `INVERTED_BOUNDS` warning.
/// - A NaN bound is treated as open on that side (`-inf` / `+inf`), so `clamp` can never panic.
pub fn normalize_bounds(min: f64, max: f64) -> (f64, f64, bool) {
    let mut lo = if min.is_nan() { f64::NEG_INFINITY } else { min };
    let mut hi = if max.is_nan() { f64::INFINITY } else { max };
    if lo > hi {
        std::mem::swap(&mut lo, &mut hi);
    }
    let unbounded = (lo == 0.0 && hi == 0.0) || (lo == f64::NEG_INFINITY && hi == f64::INFINITY);
    (lo, hi, !unbounded)
}

/// Pre-compiled execution plan for a CAN/CAN-FD message.
#[derive(Clone, Debug)]
pub struct CompiledMessage {
    pub can_id: CanIdKey,
    pub name: String,
    pub dlc: u8,
    pub transmitters: Vec<String>,
    pub protocol: FrameProtocol,
    pub expected_cycle_ms: Option<u32>,
    pub comment: Option<String>,
    pub static_signals: Vec<CompiledSignal>,
    pub mux_tree: Option<MuxDecisionTree>,
    pub master_switch_id: Option<SignalId>,
    pub all_signals: Vec<CompiledSignal>,
    pub all_signal_ids: Vec<SignalId>,
}

/// Fully compiled, deterministic network database ready for high-speed RX decoding & TX encoding.
#[derive(Clone, Debug)]
pub struct CompiledDatabase {
    pub messages: Vec<CompiledMessage>,
    pub message_index: FxHashMap<CanIdKey, usize>,
    pub j1939_pgn_index: FxHashMap<u32, SmallVec<[usize; 2]>>,
    pub signals: Vec<CompiledSignal>,
    pub total_signals: usize,
    pub raw_database: NetworkDatabase,
}

impl CompiledDatabase {
    pub fn compile(raw: NetworkDatabase) -> Result<Self, DbError> {
        let mut messages = Vec::with_capacity(raw.messages.len());
        let mut message_index = FxHashMap::default();
        let mut j1939_pgn_index: FxHashMap<u32, SmallVec<[usize; 2]>> = FxHashMap::default();
        let mut signals: Vec<CompiledSignal> = Vec::new();

        let mut current_sig_id: SignalId = 0;

        for (can_id, msg_def) in &raw.messages {
            let msg_idx = messages.len();
            message_index.insert(*can_id, msg_idx);

            // Index 29-bit J1939 PGNs ONLY for messages configured with J1939Pg protocol
            if msg_def.protocol == FrameProtocol::J1939Pg {
                if let Some(pgn) = can_id.extract_j1939_pgn() {
                    j1939_pgn_index.entry(pgn).or_default().push(msg_idx);
                }
            }

            // First pass: assign dense IDs to all signals in this message
            let mut name_to_id = FxHashMap::default();
            let mut temp_compiled_sigs = Vec::with_capacity(msg_def.signals.len());

            for sig_def in &msg_def.signals {
                let id = current_sig_id;
                current_sig_id += 1;
                name_to_id.insert(sig_def.name.clone(), id);

                let bit_span =
                    NormalizedBitSpan::compile(sig_def.start_bit, sig_def.bit_len, sig_def.byte_order)?;

                let (min, max, has_bounds) = normalize_bounds(sig_def.min, sig_def.max);
                let has_enum_table = !sig_def.enum_values.is_empty();
                // A NaN/Inf start value (e.g. GenSigStartValue * factor overflow) is never packed.
                let initial_value = sig_def.initial_value.filter(|v| v.is_finite());

                let comp_sig = CompiledSignal {
                    id,
                    name: sig_def.name.clone(),
                    long_name: sig_def.long_name.clone(),
                    start_bit: sig_def.start_bit,
                    bit_len: sig_def.bit_len,
                    byte_order: sig_def.byte_order,
                    value_type: sig_def.value_type,
                    factor: sig_def.factor,
                    offset: sig_def.offset,
                    min,
                    max,
                    unit: sig_def.unit.clone(),
                    receivers: sig_def.receivers.clone(),
                    mux_role: sig_def.mux_role.clone(),
                    bit_span,
                    initial_value,
                    has_bounds,
                    has_enum_table,
                    enum_values: sig_def.enum_values.clone(),
                    comment: sig_def.comment.clone(),
                };

                temp_compiled_sigs.push(comp_sig);
            }

            // Second pass: resolve multiplexer switch signal IDs & collect referenced switches
            let mut referenced_switches: FxHashSet<String> = FxHashSet::default();
            for sig in &mut temp_compiled_sigs {
                if let MuxRole::Multiplexed {
                    ref switch_signal_name,
                    ref mut switch_signal,
                    ..
                } = sig.mux_role
                {
                    if let Some(&sw_id) = name_to_id.get(switch_signal_name) {
                        *switch_signal = sw_id;
                        referenced_switches.insert(switch_signal_name.clone());
                    } else {
                        // Unresolvable switch name (typo / truncated file). Leaving the parser default
                        // `switch_signal = 0` would silently bind it to global signal 0 of an unrelated
                        // message (wrong decode tree, and the TX encoder would pack a foreign signal).
                        // Fall back to decoding it unconditionally.
                        sig.mux_role = MuxRole::Static;
                    }
                }
            }

            // Promote referenced switches so SG_MUL_VAL_-only multiplexers and N-level cascaded
            // chains (Outer -> Mid -> Inner -> Leaf) always build nested MuxDecisionTree sub-trees
            // even when `M` or `m0M` suffixes were omitted in .dbc/.kcd syntax.
            if !referenced_switches.is_empty() {
                for sig in &mut temp_compiled_sigs {
                    if referenced_switches.contains(&sig.name) {
                        match sig.mux_role {
                            MuxRole::Static => {
                                sig.mux_role = MuxRole::MasterSwitch;
                            }
                            MuxRole::Multiplexed {
                                ref mut is_sub_switch,
                                ..
                            } => {
                                *is_sub_switch = true;
                            }
                            MuxRole::MasterSwitch => {}
                        }
                    }
                }
            }

            // Partition static signals vs multiplexed
            let mut static_signals = Vec::new();
            let mut master_switch_id = None;

            for sig in &temp_compiled_sigs {
                match sig.mux_role {
                    MuxRole::Static => static_signals.push(sig.clone()),
                    MuxRole::MasterSwitch => {
                        static_signals.push(sig.clone());
                        if master_switch_id.is_none() {
                            master_switch_id = Some(sig.id);
                        }
                    }
                    MuxRole::Multiplexed { .. } => {}
                }
            }

            // Compile MuxDecisionTree if a switch exists
            let mux_tree = if let Some(m_id) = master_switch_id {
                let mut visited = FxHashSet::default();
                Some(MuxDecisionTree::build(m_id, &temp_compiled_sigs, &mut visited)?)
            } else {
                None
            };

            let all_signal_ids: Vec<SignalId> = temp_compiled_sigs.iter().map(|s| s.id).collect();

            // Append to global signals vector
            for sig in &temp_compiled_sigs {
                signals.push(sig.clone());
            }

            let comp_msg = CompiledMessage {
                can_id: *can_id,
                name: msg_def.name.clone(),
                dlc: msg_def.dlc,
                transmitters: msg_def.transmitters.clone(),
                protocol: msg_def.protocol,
                expected_cycle_ms: msg_def.expected_cycle_ms,
                comment: msg_def.comment.clone(),
                static_signals,
                mux_tree,
                master_switch_id,
                all_signals: temp_compiled_sigs,
                all_signal_ids,
            };

            messages.push(comp_msg);
        }

        let total_signals = signals.len();

        Ok(Self {
            messages,
            message_index,
            j1939_pgn_index,
            signals,
            total_signals,
            raw_database: raw,
        })
    }

    #[inline]
    pub fn get_message(&self, can_id: &CanIdKey) -> Option<&CompiledMessage> {
        if let Some(&idx) = self.message_index.get(can_id) {
            return self.messages.get(idx);
        }

        // Try J1939 PGN lookup if extended
        if let Some(pgn) = can_id.extract_j1939_pgn() {
            if let Some(indices) = self.j1939_pgn_index.get(&pgn) {
                if let Some(&first_idx) = indices.first() {
                    return self.messages.get(first_idx);
                }
            }
        }

        None
    }

    #[inline]
    pub fn get_signal(&self, signal_id: SignalId) -> Option<&CompiledSignal> {
        self.signals.get(signal_id as usize)
    }
}
