//! Database selection for MCP tools (M1.1). NexusCAN can hold a global database (bound to the
//! `StateTable`) and per-bus databases (`cmd_set_bus_databases`). Every `db_*` tool resolves the
//! database through [`DbSet::resolve`] so the rule is identical everywhere:
//!
//! 1. `bus_id` given: that bus's database, or an explicit error listing the buses that have one.
//! 2. otherwise the global database;
//! 3. otherwise, if exactly one bus has a database, that one;
//! 4. otherwise (several bus databases) an explicit "specify bus_id" error.

use crate::tools_db::NO_DB_MESSAGE;
use crate::util::ToolError;
use nexus_hal::pipeline::PipelineEngine;
use nexus_netdb::{CompiledDatabase, DatabaseInfoDto};
use serde_json::{json, Value};
use std::sync::Arc;

/// Snapshot of every loaded database (cheap `Arc` clones).
#[derive(Clone, Default)]
pub struct DbSet {
    pub global: Option<(Arc<CompiledDatabase>, DatabaseInfoDto)>,
    /// Ascending by bus id.
    pub buses: Vec<(u8, Arc<CompiledDatabase>, DatabaseInfoDto)>,
}

/// Where a resolved database comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DbScope {
    Global,
    Bus(u8),
}

/// A resolved database plus its origin.
pub struct SelectedDb<'a> {
    pub db: &'a CompiledDatabase,
    pub info: &'a DatabaseInfoDto,
    pub scope: DbScope,
}

impl SelectedDb<'_> {
    /// `{ "scope": "global"|"bus", "bus_id": n|null, "name": ... }`
    pub fn describe(&self) -> Value {
        describe(self.scope, self.info)
    }
}

pub fn describe(scope: DbScope, info: &DatabaseInfoDto) -> Value {
    match scope {
        DbScope::Global => json!({ "scope": "global", "bus_id": Value::Null, "name": info.name }),
        DbScope::Bus(b) => json!({ "scope": "bus", "bus_id": b, "name": info.name }),
    }
}

impl DbSet {
    pub fn from_engine(engine: &PipelineEngine) -> Self {
        let global = engine
            .current_compiled_database()
            .zip(engine.current_database_info());
        Self {
            global,
            buses: engine.bus_databases(),
        }
    }

    /// Global database only (used by tests and single-DB callers).
    pub fn global_only(db: Arc<CompiledDatabase>, info: DatabaseInfoDto) -> Self {
        Self {
            global: Some((db, info)),
            buses: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.global.is_none() && self.buses.is_empty()
    }

    pub fn bus_ids(&self) -> Vec<u8> {
        self.buses.iter().map(|(b, _, _)| *b).collect()
    }

    fn bus(&self, bus_id: u8) -> Option<SelectedDb<'_>> {
        self.buses
            .iter()
            .find(|(b, _, _)| *b == bus_id)
            .map(|(b, db, info)| SelectedDb {
                db,
                info,
                scope: DbScope::Bus(*b),
            })
    }

    fn global(&self) -> Option<SelectedDb<'_>> {
        self.global.as_ref().map(|(db, info)| SelectedDb {
            db,
            info,
            scope: DbScope::Global,
        })
    }

    /// The single resolution rule shared by every `db_*` tool (see module docs).
    pub fn resolve(&self, bus_id: Option<u8>) -> Result<SelectedDb<'_>, ToolError> {
        if let Some(b) = bus_id {
            return self.bus(b).ok_or_else(|| {
                ToolError::new(format!(
                    "bus {b} has no database bound; buses with a database: {:?}{}",
                    self.bus_ids(),
                    if self.global.is_some() {
                        " (a global database is also loaded: omit bus_id to use it)"
                    } else {
                        ""
                    }
                ))
            });
        }
        if let Some(g) = self.global() {
            return Ok(g);
        }
        match self.buses.as_slice() {
            [] => Err(ToolError::new(NO_DB_MESSAGE)),
            [(b, _, _)] => Ok(self.bus(*b).expect("present")),
            _ => Err(ToolError::new(format!(
                "several bus databases are loaded and no global one; specify bus_id: available {:?}",
                self.bus_ids()
            ))),
        }
    }

    /// Database used to decode a frame received on `bus`: the bus's own database, else global.
    pub fn for_frame_bus(&self, bus: u8) -> Option<SelectedDb<'_>> {
        self.bus(bus).or_else(|| self.global())
    }
}
