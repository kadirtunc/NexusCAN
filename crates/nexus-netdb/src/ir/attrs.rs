use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// High-level frame protocol classification inferred from DBC attributes (`VFrameFormat`) or message properties.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameProtocol {
    /// Classical CAN 2.0A (11-bit standard) or 2.0B (29-bit extended), max 8 bytes DLC.
    ClassicalCan,
    /// CAN-FD frame (ISO or non-ISO), up to 64 bytes payload with Bit Rate Switch (BRS).
    CanFd,
    /// Heavy-duty / Commercial vehicle protocol with 29-bit CAN ID masking (PGN + SA + Priority).
    J1939Pg,
}

impl FrameProtocol {
    #[inline]
    pub fn is_can_fd(&self) -> bool {
        matches!(self, Self::CanFd)
    }

    #[inline]
    pub fn is_j1939(&self) -> bool {
        matches!(self, Self::J1939Pg)
    }

    #[inline]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClassicalCan => "CAN",
            Self::CanFd => "CAN_FD",
            Self::J1939Pg => "J1939",
        }
    }
}

/// Target object to which a DBC attribute definition applies (`BA_DEF_`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttributeTargetType {
    Network,
    Node,
    Message,
    Signal,
    EnvVar,
}

/// Underlying data type of a DBC attribute definition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttributeValueType {
    Int { min: i64, max: i64 },
    Hex { min: i64, max: i64 },
    Float { min: f64, max: f64 },
    String,
    Enum { values: Vec<String> },
}

/// Concrete value of an attribute assigned to a network, node, message, or signal (`BA_`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttributeValue {
    Int(i64),
    Float(f64),
    String(String),
    Enum { index: usize, label: String },
}

impl AttributeValue {
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(v) => Some(*v),
            Self::Enum { index, .. } => Some(*index as i64),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Float(v) => Some(*v),
            Self::Int(v) => Some(*v as f64),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s.as_str()),
            Self::Enum { label, .. } => Some(label.as_str()),
            _ => None,
        }
    }
}

/// Definition of an attribute template declared in a DBC (`BA_DEF_`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeDef {
    pub name: String,
    pub target_type: AttributeTargetType,
    pub value_type: AttributeValueType,
    pub default_value: Option<AttributeValue>,
}

/// A named value table defining integer-to-text enum mappings (`VAL_TABLE_` / `VAL_`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueTable {
    pub name: String,
    pub entries: IndexMap<i64, String>,
}

impl ValueTable {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            entries: IndexMap::new(),
        }
    }

    pub fn insert(&mut self, val: i64, desc: impl Into<String>) {
        self.entries.insert(val, desc.into());
    }

    pub fn get(&self, val: i64) -> Option<&str> {
        self.entries.get(&val).map(|s| s.as_str())
    }
}
