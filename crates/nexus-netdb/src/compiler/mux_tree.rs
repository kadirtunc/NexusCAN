use crate::compiler::CompiledSignal;
use crate::error::DbError;
use crate::ir::mux::{MuxRange, MuxRole, SignalId};
use rustc_hash::FxHashSet;
use smallvec::SmallVec;

/// A branch within a multiplexer decision tree that activates when its parent switch matches one of `ranges`.
#[derive(Clone, Debug)]
pub struct MuxBranch {
    pub ranges: SmallVec<[MuxRange; 2]>,
    pub signals: Vec<CompiledSignal>,
    pub sub_switches: Vec<MuxDecisionTree>,
}

impl MuxBranch {
    #[inline]
    pub fn matches_value(&self, val: i64) -> bool {
        self.ranges.iter().any(|r| r.contains(val))
    }
}

/// A node in the multiplexer decision tree controlling downstream conditional signals.
#[derive(Clone, Debug)]
pub struct MuxDecisionTree {
    pub switch_signal_id: SignalId,
    pub branches: Vec<MuxBranch>,
}

impl MuxDecisionTree {
    /// Compiles a hierarchy of multiplexed signals into a cycle-checked decision tree.
    pub fn build(
        switch_signal_id: SignalId,
        all_signals: &[CompiledSignal],
        visited: &mut FxHashSet<SignalId>,
    ) -> Result<Self, DbError> {
        if !visited.insert(switch_signal_id) {
            return Err(DbError::CyclicMux(format!(
                "Multiplexer dependency cycle detected involving switch signal ID {}",
                switch_signal_id
            )));
        }

        // Find all signals directly multiplexed on this switch_signal_id
        let mut branches_map: Vec<(SmallVec<[MuxRange; 2]>, Vec<CompiledSignal>)> = Vec::new();

        for sig in all_signals {
            if let MuxRole::Multiplexed {
                switch_signal,
                ranges,
                ..
            } = &sig.mux_role
            {
                if *switch_signal == switch_signal_id {
                    let mut found = false;
                    for (b_ranges, b_sigs) in &mut branches_map {
                        if b_ranges == ranges {
                            b_sigs.push(sig.clone());
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        branches_map.push((ranges.clone(), vec![sig.clone()]));
                    }
                }
            }
        }

        let mut branches = Vec::with_capacity(branches_map.len());

        for (ranges, sigs) in branches_map {
            let mut sub_switches = Vec::new();

            // Look for sub-switches in this branch
            for sig in &sigs {
                if sig.mux_role.is_switch() {
                    let sub_tree = Self::build(sig.id, all_signals, visited)?;
                    sub_switches.push(sub_tree);
                }
            }

            branches.push(MuxBranch {
                ranges,
                signals: sigs,
                sub_switches,
            });
        }

        visited.remove(&switch_signal_id);

        Ok(Self {
            switch_signal_id,
            branches,
        })
    }
}
