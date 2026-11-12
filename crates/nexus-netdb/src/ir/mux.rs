use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

/// Dense unique index assigned to each signal in the compiled database.
pub type SignalId = u32;

/// A range of multiplexer selector values [start, end] inclusive.
/// For single-value multiplexers (e.g. `m0`), `start == end`.
/// For Vector extended multiplexers (`SG_MUL_VAL_ 0-3, 10-15`), represents each range.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxRange {
    pub start: i64,
    pub end: i64,
}

impl MuxRange {
    #[inline]
    pub const fn new(start: i64, end: i64) -> Self {
        Self { start, end }
    }

    #[inline]
    pub const fn single(val: i64) -> Self {
        Self {
            start: val,
            end: val,
        }
    }

    #[inline]
    pub fn contains(&self, val: i64) -> bool {
        val >= self.start && val <= self.end
    }

    #[inline]
    pub fn overlaps(&self, other: &Self) -> bool {
        self.start <= other.end && other.start <= self.end
    }
}

/// Multiplexing role of a signal within its parent message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MuxRole {
    /// Signal is present and transmitted unconditionally in every frame.
    Static,

    /// Signal acts as the master switch (selector) for multiplexed signals.
    /// In DBC syntax: `SG_ ... M : ...`
    MasterSwitch,

    /// Signal is only valid when its selector switch is within one of the specified ranges.
    /// In DBC syntax:
    /// - Standard single value: `m0`, `m1`
    /// - Cascaded multiplexer: `m2M` (multiplexed on parent switch with value 2, AND serves as sub-switch)
    /// - Multi-range: `SG_MUL_VAL_ <msg_id> <sig> <switch_sig> 0-3, 10-15;`
    Multiplexed {
        /// Name of the switch signal controlling this signal.
        switch_signal_name: String,
        /// Dense ID of the switch signal (resolved during compilation).
        switch_signal: SignalId,
        /// Ranges of raw switch integer values that activate this signal.
        ranges: SmallVec<[MuxRange; 2]>,
        /// If true, this signal also acts as a sub-switch for further downstream cascaded signals (`m<N>M`).
        is_sub_switch: bool,
    },
}

impl MuxRole {
    #[inline]
    pub fn is_switch(&self) -> bool {
        match self {
            Self::MasterSwitch => true,
            Self::Multiplexed { is_sub_switch, .. } => *is_sub_switch,
            Self::Static => false,
        }
    }

    #[inline]
    pub fn is_multiplexed(&self) -> bool {
        matches!(self, Self::Multiplexed { .. })
    }

    #[inline]
    pub fn matches_value(&self, val: i64) -> bool {
        match self {
            Self::Static => true,
            Self::MasterSwitch => true,
            Self::Multiplexed { ranges, .. } => ranges.iter().any(|r| r.contains(val)),
        }
    }
}
