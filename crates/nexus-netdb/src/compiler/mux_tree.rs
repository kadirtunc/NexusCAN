use crate::compiler::CompiledSignal;
use crate::error::DbError;
use crate::ir::mux::{MuxRange, MuxRole, SignalId};
use rustc_hash::FxHashSet;
use smallvec::SmallVec;

/// Maximum number of nested multiplexer switch levels (master switch = level 1, each cascaded
/// `m<N>M` sub-switch adds one level). Real-world OEM / BMS databases use at most 3–4 levels.
///
/// Enforced at every place that walks the hierarchy so an untrusted `.dbc` / `.kcd` can never drive
/// unbounded recursion (stack overflow):
/// - KCD parse (`<Multiplex>` nesting) -> `DbParseError::Fatal`
/// - compile (`MuxDecisionTree::build`) -> `DbError::MuxTooDeep`
/// - runtime RX (`evaluate_mux_tree`) -> sub-trees deeper than the limit are not evaluated
/// - TX encoder ancestor walk -> `EncodeError::MuxTooDeep`
///
/// Because a tree deeper than this is never constructed, the compiler-generated recursive `Drop`
/// of `MuxDecisionTree` is also bounded to `MAX_MUX_DEPTH` frames.
pub const MAX_MUX_DEPTH: usize = 16;

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
    /// Number of switch levels in this tree (1 = master switch only).
    pub fn depth(&self) -> usize {
        // Iterative (explicit stack) so even a hand-built over-deep tree cannot overflow the stack here.
        let mut max = 0;
        let mut stack: Vec<(&MuxDecisionTree, usize)> = vec![(self, 1)];
        while let Some((t, d)) = stack.pop() {
            max = max.max(d);
            for b in &t.branches {
                for st in &b.sub_switches {
                    stack.push((st, d + 1));
                }
            }
        }
        max
    }

    /// Compiles a hierarchy of multiplexed signals into a cycle-checked decision tree.
    ///
    /// Fails with `DbError::MuxTooDeep` if the cascade exceeds [`MAX_MUX_DEPTH`] levels and with
    /// `DbError::CyclicMux` on a dependency cycle.
    pub fn build(
        switch_signal_id: SignalId,
        all_signals: &[CompiledSignal],
        visited: &mut FxHashSet<SignalId>,
    ) -> Result<Self, DbError> {
        Self::build_at_depth(switch_signal_id, all_signals, visited, 1)
    }

    fn build_at_depth(
        switch_signal_id: SignalId,
        all_signals: &[CompiledSignal],
        visited: &mut FxHashSet<SignalId>,
        depth: usize,
    ) -> Result<Self, DbError> {
        if depth > MAX_MUX_DEPTH {
            let switch = all_signals
                .iter()
                .find(|s| s.id == switch_signal_id)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| switch_signal_id.to_string());
            return Err(DbError::MuxTooDeep {
                depth,
                max: MAX_MUX_DEPTH,
                switch,
            });
        }
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
                    let sub_tree = Self::build_at_depth(sig.id, all_signals, visited, depth + 1)?;
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
