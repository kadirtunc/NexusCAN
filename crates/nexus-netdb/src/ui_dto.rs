use crate::compiler::CompiledDatabase;
use crate::error::ParseDiagnostic;
use crate::ir::mux::{MuxRole, SignalId};
use crate::ir::{ByteOrder, SignalValueType};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// High-level summary of a loaded database file for the UI header.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfoDto {
    pub name: String,
    pub version: Option<String>,
    pub format: String,
    pub source_encoding: String,
    pub message_count: usize,
    pub signal_count: usize,
    pub diagnostics: Vec<ParseDiagnostic>,
}

/// Static representation of an ECU / Network Node.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuNodeDto {
    pub name: String,
    pub comment: Option<String>,
    pub tx_message_keys: Vec<String>,
    pub rx_message_keys: Vec<String>,
}

/// Pre-computed bit-cell coordinate for React `BitLayoutMatrix` (8x8 or 64x8 visual grid).
/// Completely eliminates the need to perform Motorola sawtooth or bit math in TypeScript/JavaScript!
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitCellDto {
    pub byte_index: u8,
    pub bit_in_byte: u8,
    pub signal_id: SignalId,
    pub signal_bit_index: u8,
    pub is_msb: bool,
    pub is_lsb: bool,
    pub is_mux_switch: bool,
    pub is_multiplexed: bool,
    pub switch_signal_id: Option<SignalId>,
    pub mux_ranges: Vec<[i64; 2]>,
}

/// Static schema for a CAN / CAN-FD message.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSchemaDto {
    pub message_key: String,
    pub arb_id: u32,
    pub is_extended: bool,
    pub protocol: String,
    pub name: String,
    pub dlc: u8,
    pub transmitters: Vec<String>,
    pub expected_cycle_ms: Option<u32>,
    pub comment: Option<String>,
    pub signal_ids: Vec<SignalId>,
    pub bit_layout: Vec<BitCellDto>,
    pub is_multiplexed: bool,
    pub master_switch_id: Option<SignalId>,
}

/// Static schema for an individual signal with dense SignalId matching its array index.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalSchemaDto {
    pub signal_id: SignalId,
    pub message_key: String,
    pub name: String,
    pub long_name: Option<String>,
    pub start_bit: u16,
    pub bit_length: u8,
    pub byte_order: String,
    pub value_type: String,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub unit: String,
    pub receivers: Vec<String>,
    pub comment: Option<String>,
    pub mux_role: String,
    pub switch_signal_id: Option<SignalId>,
    pub mux_ranges: Vec<[i64; 2]>,
    pub enum_table: IndexMap<i64, String>,
    pub initial_value: Option<f64>,
}

/// Complete Plane 1 static database schema sent once over IPC upon database load.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSchemaDto {
    pub info: DatabaseInfoDto,
    pub ecus: Vec<EcuNodeDto>,
    pub messages: Vec<MessageSchemaDto>,
    pub signals: Vec<SignalSchemaDto>,
}

impl CompiledDatabase {
    /// Builds the complete Plane 1 static schema DTO.
    /// Invariant: `signals[i].signal_id == i as u32` for O(1) frontend indexing!
    pub fn to_schema_dto(&self, info: DatabaseInfoDto) -> DatabaseSchemaDto {
        // 1. Build ECU nodes
        let mut ecus = Vec::with_capacity(self.raw_database.nodes.len());
        for (node_name, node) in &self.raw_database.nodes {
            let mut tx_message_keys = Vec::new();
            let mut rx_message_keys = Vec::new();

            for msg in &self.messages {
                let m_key = msg.can_id.schema_key();
                if msg.transmitters.contains(node_name) {
                    tx_message_keys.push(m_key.clone());
                }
                if msg.all_signals.iter().any(|s| s.receivers.contains(node_name)) {
                    rx_message_keys.push(m_key);
                }
            }

            ecus.push(EcuNodeDto {
                name: node_name.clone(),
                comment: node.comment.clone(),
                tx_message_keys,
                rx_message_keys,
            });
        }

        // 2. Build MessageSchemaDto
        let mut messages = Vec::with_capacity(self.messages.len());
        for msg in &self.messages {
            let message_key = msg.can_id.schema_key();
            let mut bit_layout = Vec::new();

            for sig in &msg.all_signals {
                let is_mux_switch = sig.mux_role.is_switch();
                let is_multiplexed = sig.mux_role.is_multiplexed();
                let (switch_signal_id, mux_ranges) = match &sig.mux_role {
                    MuxRole::Multiplexed {
                        switch_signal,
                        ranges,
                        ..
                    } => (
                        Some(*switch_signal),
                        ranges.iter().map(|r| [r.start, r.end]).collect(),
                    ),
                    _ => (None, Vec::new()),
                };

                for (k, &(byte_idx, bit_in_byte)) in sig.bit_span.bit_coords.iter().enumerate() {
                    bit_layout.push(BitCellDto {
                        byte_index: byte_idx,
                        bit_in_byte,
                        signal_id: sig.id,
                        signal_bit_index: k as u8,
                        is_lsb: k == 0,
                        is_msb: k == (sig.bit_len - 1) as usize,
                        is_mux_switch,
                        is_multiplexed,
                        switch_signal_id,
                        mux_ranges: mux_ranges.clone(),
                    });
                }
            }

            messages.push(MessageSchemaDto {
                message_key,
                arb_id: msg.can_id.raw_id(),
                is_extended: msg.can_id.is_extended(),
                protocol: msg.protocol.as_str().to_string(),
                name: msg.name.clone(),
                dlc: msg.dlc,
                transmitters: msg.transmitters.clone(),
                expected_cycle_ms: msg.expected_cycle_ms,
                comment: msg.comment.clone(),
                signal_ids: msg.all_signal_ids.clone(),
                bit_layout,
                is_multiplexed: msg.mux_tree.is_some(),
                master_switch_id: msg.master_switch_id,
            });
        }

        // 3. Build SignalSchemaDto (dense ordering matching self.signals)
        let mut signals = Vec::with_capacity(self.signals.len());
        for sig in &self.signals {
            // Find parent message key
            let parent_msg = self.messages.iter().find(|m| m.all_signal_ids.contains(&sig.id));
            let message_key = parent_msg.map(|m| m.can_id.schema_key()).unwrap_or_default();

            let byte_order_str = match sig.byte_order {
                ByteOrder::LittleEndian => "littleEndian",
                ByteOrder::BigEndian => "bigEndian",
            };

            let value_type_str = match sig.value_type {
                SignalValueType::Unsigned => "unsigned",
                SignalValueType::Signed => "signed",
                SignalValueType::Float32 => "float32",
                SignalValueType::Float64 => "float64",
            };

            let (mux_role_str, switch_signal_id, mux_ranges) = match &sig.mux_role {
                MuxRole::Static => ("static", None, Vec::new()),
                MuxRole::MasterSwitch => ("masterSwitch", None, Vec::new()),
                MuxRole::Multiplexed {
                    switch_signal,
                    ranges,
                    ..
                } => (
                    "multiplexed",
                    Some(*switch_signal),
                    ranges.iter().map(|r| [r.start, r.end]).collect(),
                ),
            };

            signals.push(SignalSchemaDto {
                signal_id: sig.id,
                message_key,
                name: sig.name.clone(),
                long_name: sig.long_name.clone(),
                start_bit: sig.start_bit,
                bit_length: sig.bit_len,
                byte_order: byte_order_str.to_string(),
                value_type: value_type_str.to_string(),
                factor: sig.factor,
                offset: sig.offset,
                min: sig.min,
                max: sig.max,
                unit: sig.unit.clone(),
                receivers: sig.receivers.clone(),
                comment: sig.comment.clone(),
                mux_role: mux_role_str.to_string(),
                switch_signal_id,
                mux_ranges,
                enum_table: sig.enum_values.clone(),
                initial_value: sig.initial_value,
            });
        }

        DatabaseSchemaDto {
            info,
            ecus,
            messages,
            signals,
        }
    }
}
