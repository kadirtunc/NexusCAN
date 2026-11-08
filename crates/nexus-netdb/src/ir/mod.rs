pub mod attrs;
pub mod mux;

pub use attrs::{
    AttributeDef, AttributeTargetType, AttributeValue, AttributeValueType, FrameProtocol,
    ValueTable,
};
pub use mux::{MuxRange, MuxRole, SignalId};

use indexmap::IndexMap;
use nexus_core::CanIdKey;
use serde::{Deserialize, Serialize};

/// Endianness (byte order) convention for signal bits in the CAN payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ByteOrder {
    /// Intel byte order (@1 in DBC). `start_bit` specifies the Least Significant Bit (LSB).
    /// Bits increment linearly across bytes.
    LittleEndian,

    /// Motorola byte order (@0 in DBC) with Vector Sawtooth numbering.
    /// `start_bit` specifies the Most Significant Bit (MSB).
    /// Bits decrement within a byte (7 down to 0); at bit 0 boundary, steps to the next byte bit 7.
    BigEndian,
}

impl ByteOrder {
    #[inline]
    pub fn is_little_endian(&self) -> bool {
        matches!(self, Self::LittleEndian)
    }

    #[inline]
    pub fn is_big_endian(&self) -> bool {
        matches!(self, Self::BigEndian)
    }
}

/// Underlying representation and sign encoding of a signal's raw bit field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalValueType {
    /// Unsigned integer (0..2^N - 1), indicated by '+' in DBC.
    Unsigned,
    /// Signed integer encoded via two's complement, indicated by '-' in DBC.
    Signed,
    /// IEEE-754 32-bit single-precision float (DBC `SIG_VALTYPE_ : 1`).
    Float32,
    /// IEEE-754 64-bit double-precision float (DBC `SIG_VALTYPE_ : 2`).
    Float64,
}

impl SignalValueType {
    #[inline]
    pub fn is_float(&self) -> bool {
        matches!(self, Self::Float32 | Self::Float64)
    }

    #[inline]
    pub fn is_signed(&self) -> bool {
        matches!(self, Self::Signed)
    }
}

/// Bus network definition.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusDef {
    pub name: String,
    pub baudrate: Option<u32>,
    pub data_baudrate: Option<u32>,
}

/// ECU / Network Node definition (`BU_`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuNode {
    pub name: String,
    pub comment: Option<String>,
    pub attributes: IndexMap<String, AttributeValue>,
}

/// A logical grouping of signals (e.g. for E2E CRC, counters, or status blocks: `SIG_GROUP_`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalGroupDef {
    pub name: String,
    pub group_id: u32,
    pub signals: Vec<String>,
}

/// Environment variable definition (`EV_`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentVarDef {
    pub name: String,
    pub var_type: u32,
    pub min: f64,
    pub max: f64,
    pub unit: String,
    pub initial_value: f64,
    pub env_id: u32,
    pub access: u32,
    pub nodes: Vec<String>,
}

/// Canonical intermediate representation of a CAN signal (`SG_`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDef {
    /// Dense identifier assigned by compiler (0 initially during Stage 1 parsing).
    pub id: SignalId,
    /// Identifier name of the signal.
    pub name: String,
    /// Extended symbol name from DBC `BA_ "SystemSignalLongSymbol"`.
    pub long_name: Option<String>,
    /// Start bit location: LSB for LittleEndian, Vector Sawtooth MSB for BigEndian (0..511).
    pub start_bit: u16,
    /// Bit length (1..=64).
    pub bit_len: u8,
    /// Byte order convention.
    pub byte_order: ByteOrder,
    /// Value type and sign extension mode.
    pub value_type: SignalValueType,
    /// Linear scaling multiplier: `physical = raw * factor + offset`.
    pub factor: f64,
    /// Linear scaling offset.
    pub offset: f64,
    /// Engineering minimum allowable physical value.
    pub min: f64,
    /// Engineering maximum allowable physical value.
    pub max: f64,
    /// Engineering unit text (e.g., "km/h", "degC", "V", "A", "%").
    pub unit: String,
    /// Receiving ECU node names.
    pub receivers: Vec<String>,
    /// Multiplexing role.
    pub mux_role: MuxRole,
    /// Free-form comment or description (`CM_ SG_`).
    pub comment: Option<String>,
    /// Enum text labels for specific integer values (`VAL_`).
    pub enum_values: IndexMap<i64, String>,
    /// Initial / power-on physical default value (`GenSigStartValue`).
    pub initial_value: Option<f64>,
    /// Assigned attributes (`BA_`).
    pub attributes: IndexMap<String, AttributeValue>,
}

impl SignalDef {
    /// Returns true if engineering min/max bounds are actively defined.
    #[inline]
    pub fn has_bounds(&self) -> bool {
        !(self.min == 0.0 && self.max == 0.0) && self.min <= self.max
    }

    /// Evaluates whether a physical engineering value falls within defined min/max bounds.
    #[inline]
    pub fn is_value_in_bounds(&self, val: f64) -> bool {
        if !self.has_bounds() {
            true
        } else {
            val >= self.min - 1e-9 && val <= self.max + 1e-9
        }
    }
}

/// Canonical intermediate representation of a CAN message (`BO_`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDef {
    /// Canonical CAN ID key (Standard 11-bit or Extended 29-bit).
    pub can_id: CanIdKey,
    /// Message name in the network database.
    pub name: String,
    /// Data Length Code in bytes (0..64).
    pub dlc: u8,
    /// Transmitting ECU node names.
    pub transmitters: Vec<String>,
    /// Contained signals.
    pub signals: Vec<SignalDef>,
    /// Free-form comment or description (`CM_ BO_`).
    pub comment: Option<String>,
    /// Inferred or declared protocol format (Classical CAN, CAN-FD, J1939).
    pub protocol: FrameProtocol,
    /// Expected transmission cycle period in milliseconds (`GenMsgCycleTime`).
    pub expected_cycle_ms: Option<u32>,
    /// Assigned attributes (`BA_`).
    pub attributes: IndexMap<String, AttributeValue>,
    /// Signal groupings defined for this message (`SIG_GROUP_`).
    pub signal_groups: Vec<SignalGroupDef>,
}

impl MessageDef {
    #[inline]
    pub fn is_extended(&self) -> bool {
        self.can_id.is_extended()
    }

    #[inline]
    pub fn arb_id(&self) -> u32 {
        self.can_id.raw_id()
    }
}

/// Format-agnostic canonical representation of an entire network database.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDatabase {
    pub name: String,
    pub version: Option<String>,
    pub comment: Option<String>,
    pub buses: Vec<BusDef>,
    pub nodes: IndexMap<String, EcuNode>,
    pub messages: IndexMap<CanIdKey, MessageDef>,
    /// Independent signals parsed from `VECTOR__INDEPENDENT_SIG_MSG` (0xC0000000 / 3221225472).
    /// Kept strictly isolated so they never pollute active message routing tables!
    pub independent_signals: Vec<SignalDef>,
    pub value_tables: IndexMap<String, ValueTable>,
    pub attribute_defs: IndexMap<String, AttributeDef>,
    pub network_attributes: IndexMap<String, AttributeValue>,
    pub signal_groups: Vec<SignalGroupDef>,
    pub env_vars: IndexMap<String, EnvironmentVarDef>,
}

impl NetworkDatabase {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }
}
