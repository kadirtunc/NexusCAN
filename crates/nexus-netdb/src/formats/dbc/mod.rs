pub mod lexer;
pub mod parser;
pub mod writer;

pub use parser::DbcParser;
pub use writer::DbcWriter;

use crate::error::{DbError, DbParseError};
use crate::formats::encoding::decode_text_lossless;
use crate::formats::{
    DatabaseFormatExporter, DatabaseFormatParser, ParseOptions, ParsedDatabaseBundle,
};
use crate::ir::NetworkDatabase;

#[derive(Default, Clone, Copy, Debug)]
pub struct DbcFormat;

impl DatabaseFormatParser for DbcFormat {
    fn format_id(&self) -> &'static str {
        "dbc"
    }

    fn supported_extensions(&self) -> &'static [&'static str] {
        &["dbc"]
    }

    fn sniff(&self, header_bytes: &[u8]) -> bool {
        let sample = decode_text_lossless(if header_bytes.len() > 1024 {
            &header_bytes[..1024]
        } else {
            header_bytes
        });
        sample.text.contains("VERSION ")
            || sample.text.contains("NS_ :")
            || sample.text.contains("BS_:")
            || sample.text.contains("BU_:")
            || sample.text.contains("BO_ ")
    }

    fn parse(
        &self,
        bytes: &[u8],
        opts: &ParseOptions,
    ) -> Result<ParsedDatabaseBundle, DbParseError> {
        let transcode = decode_text_lossless(bytes);
        let parser = DbcParser::new(&transcode.text, opts.fault_tolerant);
        let (database, mut diagnostics) = parser.parse();

        if let Some(diag) = transcode.diagnostic {
            diagnostics.insert(0, diag);
        }

        Ok(ParsedDatabaseBundle {
            database,
            diagnostics,
            format_name: "dbc",
            source_encoding: transcode.encoding_name,
        })
    }
}

impl DatabaseFormatExporter for DbcFormat {
    fn format_id(&self) -> &'static str {
        "dbc"
    }

    fn export(&self, db: &NetworkDatabase) -> Result<Vec<u8>, DbError> {
        let writer = DbcWriter::new(db);
        let text = writer.write_to_string()?;
        Ok(text.into_bytes())
    }
}
