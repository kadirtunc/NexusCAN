//! Diagnostics Workspace storage commands (contract `planning/contracts/diag-workspace-v1.md`
//! §9 flow library, §10 run store). Thin engine wrappers over [`crate::flowlib::FlowLibrary`]
//! and [`crate::runstore::RunStore`] rooted in the engine's [`crate::storage::DataRoot`].
//!
//! Errors stay typed ([`FlowLibError`] / [`RunStoreError`]); the IPC layers (`src-tauri`
//! commands, `nexus_bridge`) map them with `to_ipc_string()` to `"[flowlib:<code>] <message>"`
//! / `"[runstore:<code>] <message>"`, like the seed/key commands.

use super::PipelineEngine;
use crate::flowlib::{FlowLibEntryDto, FlowLibError, FlowLibRevisionDto};
use crate::runstore::{
    RunQueryFilterDto, RunRecordV1, RunScan, RunStoreError, MAX_QUERY_LIMIT, MIN_QUERY_LIMIT,
};

impl PipelineEngine {
    /// `cmd_flowlib_list`.
    pub fn cmd_flowlib_list(
        &self,
        include_deleted: bool,
    ) -> Result<Vec<FlowLibEntryDto>, FlowLibError> {
        self.flowlib.list(include_deleted)
    }

    /// `cmd_flowlib_revisions`: ascending by revision.
    pub fn cmd_flowlib_revisions(&self, id: &str) -> Result<Vec<FlowLibRevisionDto>, FlowLibError> {
        self.flowlib.revisions(id)
    }

    /// `cmd_flowlib_load`: raw file JSON (`revision: None` = latest; deleted ids still load).
    pub fn cmd_flowlib_load(
        &self,
        id: &str,
        revision: Option<u32>,
    ) -> Result<String, FlowLibError> {
        self.flowlib.load(id, revision)
    }

    /// `cmd_flowlib_save`: new immutable revision (`latest + 1`).
    pub fn cmd_flowlib_save(&self, file_json: &str) -> Result<FlowLibEntryDto, FlowLibError> {
        let entry = self.flowlib.save(file_json)?;
        self.debug_hub.record(
            "info",
            "WORKBENCH",
            "backend",
            None,
            "flowlib.save",
            format!(
                "Flow library: saved '{}' r{}",
                entry.id, entry.latest_revision
            ),
            Some(format!("kind={}, name={}", entry.kind.as_str(), entry.name)),
        );
        Ok(entry)
    }

    /// `cmd_flowlib_delete`: soft delete (revisions kept for pinned references).
    pub fn cmd_flowlib_delete(&self, id: &str) -> Result<(), FlowLibError> {
        self.flowlib.delete(id)?;
        self.debug_hub.record(
            "info",
            "WORKBENCH",
            "backend",
            None,
            "flowlib.delete",
            format!("Flow library: deleted '{id}' (soft)"),
            None,
        );
        Ok(())
    }

    /// `cmd_run_append`: appends one immutable run record.
    pub fn cmd_run_append(&self, record: &RunRecordV1) -> Result<(), RunStoreError> {
        self.runstore.append(record)
    }

    /// `cmd_run_query`: newest first, `limit` in `1..=5000`.
    pub fn cmd_run_query(
        &self,
        project_id: &str,
        filter: &RunQueryFilterDto,
        limit: i64,
    ) -> Result<Vec<RunRecordV1>, RunStoreError> {
        let limit = u32::try_from(limit)
            .ok()
            .filter(|l| (MIN_QUERY_LIMIT..=MAX_QUERY_LIMIT).contains(l))
            .ok_or_else(|| {
                RunStoreError::Invalid(format!(
                    "limit {limit} out of range {MIN_QUERY_LIMIT}..={MAX_QUERY_LIMIT}"
                ))
            })?;
        let scan = self.runstore.query(project_id, filter, limit)?;
        Ok(self.finish_run_scan(project_id, scan))
    }

    /// `cmd_run_latest`: latest top-level record per `(ecuId, flowId)`, newest first.
    pub fn cmd_run_latest(&self, project_id: &str) -> Result<Vec<RunRecordV1>, RunStoreError> {
        let scan = self.runstore.latest(project_id)?;
        Ok(self.finish_run_scan(project_id, scan))
    }

    fn finish_run_scan(&self, project_id: &str, scan: RunScan) -> Vec<RunRecordV1> {
        if scan.corrupt_lines > 0 {
            self.debug_hub.record(
                "warn",
                "WORKBENCH",
                "backend",
                None,
                "runstore.corrupt_lines",
                format!(
                    "Run store: skipped {} corrupt line(s) for project {project_id}",
                    scan.corrupt_lines
                ),
                None,
            );
        }
        scan.records
    }
}
