use nexus_core::CanIdKey;
use serde::{Deserialize, Serialize};

/// Severity levels for non-fatal and fatal parsing diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Warning,
    Error,
    Info,
}

/// A structured, line/column-aware diagnostic produced during parsing or compilation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub context: Option<String>,
}

impl ParseDiagnostic {
    pub fn new(
        severity: DiagnosticSeverity,
        code: impl Into<String>,
        message: impl Into<String>,
        line: Option<usize>,
        column: Option<usize>,
        context: Option<String>,
    ) -> Self {
        Self {
            severity,
            code: code.into(),
            message: message.into(),
            line,
            column,
            context,
        }
    }

    pub fn warning(
        code: impl Into<String>,
        message: impl Into<String>,
        line: Option<usize>,
        column: Option<usize>,
        context: Option<String>,
    ) -> Self {
        Self::new(
            DiagnosticSeverity::Warning,
            code,
            message,
            line,
            column,
            context,
        )
    }

    pub fn error(
        code: impl Into<String>,
        message: impl Into<String>,
        line: Option<usize>,
        column: Option<usize>,
        context: Option<String>,
    ) -> Self {
        Self::new(
            DiagnosticSeverity::Error,
            code,
            message,
            line,
            column,
            context,
        )
    }

    pub fn info(
        code: impl Into<String>,
        message: impl Into<String>,
        line: Option<usize>,
        column: Option<usize>,
        context: Option<String>,
    ) -> Self {
        Self::new(
            DiagnosticSeverity::Info,
            code,
            message,
            line,
            column,
            context,
        )
    }
}

/// Errors occurring during bit plan calculation for signal extraction or packing.
#[derive(thiserror::Error, Clone, Debug, PartialEq, Eq)]
pub enum BitPlanError {
    #[error("Start bit {start_bit} is out of allowable range (max {max_allowed})")]
    StartBitOutOfRange { start_bit: u16, max_allowed: u16 },

    #[error("Bit length must be between 1 and 64 bits, got 0")]
    BitLengthZero,

    #[error("Bit length {bit_len} exceeds maximum supported 64 bits")]
    BitLengthTooLarge { bit_len: u8, max_allowed: u8 },

    #[error("Signal bit span (start_bit {start_bit}, bit_len {bit_len}) exceeds payload limit {max_bits} bits")]
    SpanExceedsPayload {
        start_bit: u16,
        bit_len: u8,
        max_bits: u16,
    },

    #[error("Motorola sawtooth bit span stepped into invalid byte index {byte_index} (start_bit {start_bit}, bit_len {bit_len})")]
    MotorolaByteOverflow {
        start_bit: u16,
        bit_len: u8,
        byte_index: usize,
    },
}

/// Errors occurring during signal TX packing.
#[derive(thiserror::Error, Clone, Debug, PartialEq)]
pub enum EncodeError {
    #[error("Target message with CAN ID {0:?} was not found in the database")]
    MessageNotFound(CanIdKey),

    #[error("Signal with dense ID {0} was not found in compiled database")]
    SignalNotFound(u32),

    #[error("Signal with dense ID {signal_id} does not belong to message '{message_key}'")]
    SignalNotInMessage { signal_id: u32, message_key: String },

    #[error("Conflicting multiplexer branches specified for switch signal ID {switch_id} in message '{message_key}': branch {branch_a} vs branch {branch_b}")]
    ConflictingMuxBranches {
        message_key: String,
        switch_id: u32,
        branch_a: i64,
        branch_b: i64,
    },

    #[error("Bit plan layout error: {0}")]
    BitPlan(#[from] BitPlanError),

    #[error("Physical value {value} for signal '{signal_name}' is not a finite number; refusing to transmit")]
    NonFiniteValue { signal_name: String, value: f64 },

    #[error("Signal '{signal_name}' has unusable scaling (factor {factor}, offset {offset}); cannot invert physical -> raw")]
    InvalidScaling {
        signal_name: String,
        factor: f64,
        offset: f64,
    },

    #[error("Multiplexer ancestor chain of signal ID {signal_id} exceeds the maximum depth of {max} (cycle or over-deep cascade)")]
    MuxTooDeep { signal_id: u32, max: usize },

    #[error(
        "Physical value {value} for signal '{signal_name}' is out of valid bounds [{min}, {max}]"
    )]
    ValueOutOfRange {
        signal_name: String,
        value: f64,
        min: f64,
        max: f64,
    },
}

/// Errors occurring during database parsing across formats.
#[derive(thiserror::Error, Debug)]
pub enum DbParseError {
    #[error("Fatal parse error: {message} (line: {line:?}, col: {column:?})")]
    Fatal {
        message: String,
        line: Option<usize>,
        column: Option<usize>,
    },

    #[error("I/O error while reading database: {0}")]
    Io(#[from] std::io::Error),

    #[error("Unsupported or unrecognized database format: {0}")]
    UnsupportedFormat(String),

    #[error("XML parsing error: {0}")]
    Xml(String),

    #[error("Database input is empty")]
    EmptyInput,
}

/// General top-level database error covering parsing, compilation, and encoding.
#[derive(thiserror::Error, Debug)]
pub enum DbError {
    #[error("Parse error: {0}")]
    Parse(#[from] DbParseError),

    #[error("Encode error: {0}")]
    Encode(#[from] EncodeError),

    #[error("Cyclic multiplexer dependency detected: {0}")]
    CyclicMux(String),

    #[error("Cascaded multiplexer nesting depth {depth} exceeds the maximum of {max} (switch signal '{switch}')")]
    MuxTooDeep {
        depth: usize,
        max: usize,
        switch: String,
    },

    #[error("Bit plan error: {0}")]
    BitPlan(#[from] BitPlanError),

    #[error("Message not found: {0}")]
    MessageNotFound(String),

    #[error("Signal not found: {0}")]
    SignalNotFound(String),

    #[error("General database error: {0}")]
    Generic(String),
}
