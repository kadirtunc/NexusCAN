pub mod dbc;
pub mod encoding;
pub mod kcd;

use crate::error::{DbError, DbParseError, ParseDiagnostic};
use crate::ir::NetworkDatabase;
use dbc::DbcFormat;
use kcd::KcdFormat;

/// Configuration options controlling file parsing and diagnostic reporting.
#[derive(Clone, Debug)]
pub struct ParseOptions {
    /// If true, parser emits non-fatal line/column diagnostics rather than failing on vendor quirks.
    pub fault_tolerant: bool,
    /// Default network bus name assigned to parsed messages.
    pub default_bus_name: String,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            fault_tolerant: true,
            default_bus_name: "can0".to_string(),
        }
    }
}

/// The result bundle returned upon successful parsing of a network database file.
pub struct ParsedDatabaseBundle {
    pub database: NetworkDatabase,
    pub diagnostics: Vec<ParseDiagnostic>,
    pub format_name: &'static str,
    pub source_encoding: &'static str,
}

/// Trait implemented by pluggable network database format readers.
pub trait DatabaseFormatParser: Send + Sync {
    /// Format identifier, e.g. "dbc", "kcd", "sym", "arxml".
    fn format_id(&self) -> &'static str;

    /// File extensions associated with this format without leading dot, e.g. &["dbc"].
    fn supported_extensions(&self) -> &'static [&'static str];

    /// Quickly inspect header bytes to determine whether this format matches.
    fn sniff(&self, header_bytes: &[u8]) -> bool;

    /// Parse raw file bytes into the canonical NetworkDatabase intermediate representation.
    fn parse(
        &self,
        bytes: &[u8],
        opts: &ParseOptions,
    ) -> Result<ParsedDatabaseBundle, DbParseError>;
}

/// Trait implemented by format exporters that serialize canonical IR back to file formats.
pub trait DatabaseFormatExporter: Send + Sync {
    fn format_id(&self) -> &'static str;
    fn export(&self, db: &NetworkDatabase) -> Result<Vec<u8>, DbError>;
}

/// Pluggable registry containing all available database parsers and exporters.
pub struct FormatRegistry {
    parsers: Vec<Box<dyn DatabaseFormatParser>>,
    exporters: Vec<Box<dyn DatabaseFormatExporter>>,
}

impl Default for FormatRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl FormatRegistry {
    pub fn new() -> Self {
        Self {
            parsers: vec![Box::new(DbcFormat), Box::new(KcdFormat)],
            exporters: vec![Box::new(DbcFormat)],
        }
    }

    pub fn register_parser(&mut self, parser: Box<dyn DatabaseFormatParser>) {
        self.parsers.push(parser);
    }

    pub fn register_exporter(&mut self, exporter: Box<dyn DatabaseFormatExporter>) {
        self.exporters.push(exporter);
    }

    /// Automatically sniffs format from content, falling back to file extension hint if provided.
    pub fn parse_bytes(
        &self,
        bytes: &[u8],
        file_hint: Option<&str>,
        opts: &ParseOptions,
    ) -> Result<ParsedDatabaseBundle, DbParseError> {
        if bytes.is_empty() {
            return Err(DbParseError::EmptyInput);
        }

        // 1. Try content sniffing first
        for parser in &self.parsers {
            if parser.sniff(bytes) {
                return parser.parse(bytes, opts);
            }
        }

        // 2. Try matching file extension if sniffing did not match
        if let Some(hint) = file_hint {
            let clean_hint = hint.rsplit('.').next().unwrap_or(hint).to_lowercase();
            for parser in &self.parsers {
                if parser
                    .supported_extensions()
                    .iter()
                    .any(|ext| ext.eq_ignore_ascii_case(&clean_hint))
                {
                    return parser.parse(bytes, opts);
                }
            }
        }

        // 3. Fallback to DBC as the default industrial standard
        if let Some(dbc_parser) = self.parsers.iter().find(|p| p.format_id() == "dbc") {
            return dbc_parser.parse(bytes, opts);
        }

        Err(DbParseError::UnsupportedFormat(
            file_hint.unwrap_or("unknown").to_string(),
        ))
    }

    pub fn export_database(
        &self,
        format_id: &str,
        db: &NetworkDatabase,
    ) -> Result<Vec<u8>, DbError> {
        for exporter in &self.exporters {
            if exporter.format_id().eq_ignore_ascii_case(format_id) {
                return exporter.export(db);
            }
        }
        Err(DbError::Generic(format!(
            "No exporter registered for format '{}'",
            format_id
        )))
    }
}
