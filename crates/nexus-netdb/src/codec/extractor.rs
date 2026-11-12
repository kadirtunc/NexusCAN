use crate::compiler::{CompiledDatabase, CompiledSignal, MuxDecisionTree, MAX_MUX_DEPTH};
use crate::ir::mux::SignalId;
use nexus_core::{CanIdKey, RawCanFrame};

/// Result of decoding an individual signal from a raw CAN/CAN-FD payload.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecodedSignalSample {
    pub signal_id: SignalId,
    pub raw_bits: u64,
    pub raw_int: i64,
    pub physical_value: f64,
    pub out_of_range: bool,
    pub is_mux_switch: bool,
}

/// Execution summary returned by the zero-allocation decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeSummary {
    pub message_index: usize,
    pub decoded_count: usize,
    pub active_switch_count: usize,
}

impl CompiledDatabase {
    /// Zero-allocation hot-path extraction from a raw slice payload.
    /// Fills `out_signals` with decoded signal samples and `out_switches` with active multiplexer switch states.
    #[inline]
    pub fn decode_payload_into(
        &self,
        can_id: CanIdKey,
        payload: &[u8],
        out_signals: &mut [DecodedSignalSample],
        out_switches: &mut [(SignalId, i64)],
    ) -> Option<DecodeSummary> {
        let (msg_idx, msg) = match self.message_index.get(&can_id) {
            Some(&idx) => (idx, &self.messages[idx]),
            None => {
                let pgn = can_id.extract_j1939_pgn()?;
                let indices = self.j1939_pgn_index.get(&pgn)?;
                let idx = *indices.first()?;
                (idx, &self.messages[idx])
            }
        };

        let mut decoded_count = 0;
        let mut switch_count = 0;

        // 1. Decode static signals (including any master switch)
        for sig in &msg.static_signals {
            if decoded_count >= out_signals.len() {
                break;
            }
            let raw_bits = sig.extract_raw(payload);
            let (raw_int, physical_value, out_of_range) = sig.decode_physical(raw_bits);
            let is_mux_switch = sig.mux_role.is_switch();

            out_signals[decoded_count] = DecodedSignalSample {
                signal_id: sig.id,
                raw_bits,
                raw_int,
                physical_value,
                out_of_range,
                is_mux_switch,
            };
            decoded_count += 1;

            if is_mux_switch && switch_count < out_switches.len() {
                out_switches[switch_count] = (sig.id, raw_int);
                switch_count += 1;
            }
        }

        // 2. Evaluate multiplexer decision tree if present
        if let Some(tree) = &msg.mux_tree {
            evaluate_mux_tree(
                tree,
                payload,
                &self.signals,
                out_signals,
                &mut decoded_count,
                out_switches,
                &mut switch_count,
                1,
            );
        }

        Some(DecodeSummary {
            message_index: msg_idx,
            decoded_count,
            active_switch_count: switch_count,
        })
    }

    /// Zero-allocation hot-path extraction from a `RawCanFrame`.
    #[inline]
    pub fn decode_frame_into(
        &self,
        frame: &RawCanFrame,
        out_signals: &mut [DecodedSignalSample],
        out_switches: &mut [(SignalId, i64)],
    ) -> Option<DecodeSummary> {
        self.decode_payload_into(
            frame.can_id_key(),
            frame.payload(),
            out_signals,
            out_switches,
        )
    }
}

/// Recursion is bounded by `depth <= MAX_MUX_DEPTH`. `CompiledDatabase::compile` never builds a deeper
/// tree, but the fields are public, so a hand-assembled tree is also cut off here instead of being able
/// to exhaust the stack on the RX hot path.
#[allow(clippy::too_many_arguments)]
fn evaluate_mux_tree(
    tree: &MuxDecisionTree,
    payload: &[u8],
    all_signals: &[CompiledSignal],
    out_signals: &mut [DecodedSignalSample],
    decoded_count: &mut usize,
    out_switches: &mut [(SignalId, i64)],
    switch_count: &mut usize,
    depth: usize,
) {
    if depth > MAX_MUX_DEPTH {
        return;
    }
    let switch_sig = match all_signals.get(tree.switch_signal_id as usize) {
        Some(s) => s,
        None => return,
    };

    let switch_raw = switch_sig.extract_raw(payload);
    let (switch_val, _, _) = switch_sig.decode_physical(switch_raw);

    for branch in &tree.branches {
        if branch.matches_value(switch_val) {
            for sig in &branch.signals {
                if *decoded_count >= out_signals.len() {
                    return;
                }
                let raw_bits = sig.extract_raw(payload);
                let (raw_int, physical_value, out_of_range) = sig.decode_physical(raw_bits);
                let is_mux_switch = sig.mux_role.is_switch();

                out_signals[*decoded_count] = DecodedSignalSample {
                    signal_id: sig.id,
                    raw_bits,
                    raw_int,
                    physical_value,
                    out_of_range,
                    is_mux_switch,
                };
                *decoded_count += 1;

                if is_mux_switch && *switch_count < out_switches.len() {
                    out_switches[*switch_count] = (sig.id, raw_int);
                    *switch_count += 1;
                }
            }

            for sub_tree in &branch.sub_switches {
                evaluate_mux_tree(
                    sub_tree,
                    payload,
                    all_signals,
                    out_signals,
                    decoded_count,
                    out_switches,
                    switch_count,
                    depth + 1,
                );
            }
        }
    }
}
