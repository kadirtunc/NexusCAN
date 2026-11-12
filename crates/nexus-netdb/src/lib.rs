//! # nexus-netdb
//!
//! A standalone, zero-Tauri-dependency, deterministic 3-stage CAN / CAN-FD signal database compiler,
//! 512-bit safe bitwise codec, and two-plane UI schema generator.
//!
//! Supports Vector CANdb++ (`.dbc`) and Kayak XML (`.kcd`), extended multiplexing (`SG_MUL_VAL_`),
//! Intel and Motorola Sawtooth bit coordinates up to 64 bytes (512 bits), signed two's complement,
//! IEEE-754 floats, and J1939 29-bit PGN masking.

#![forbid(unsafe_code)]

pub mod codec;
pub mod compiler;
pub mod error;
pub mod formats;
pub mod ir;
pub mod ui_dto;

pub use codec::{DecodeSummary, DecodedSignalSample};
pub use compiler::{
    bit_plan::NormalizedBitSpan, mux_tree::{MuxBranch, MuxDecisionTree, MAX_MUX_DEPTH}, CompiledDatabase,
    CompiledMessage, CompiledSignal,
};
pub use error::{
    BitPlanError, DbError, DbParseError, DiagnosticSeverity, EncodeError, ParseDiagnostic,
};
pub use formats::{
    dbc::{DbcFormat, DbcParser, DbcWriter},
    kcd::{KcdFormat, KcdParser},
    DatabaseFormatExporter, DatabaseFormatParser, FormatRegistry, ParseOptions,
    ParsedDatabaseBundle,
};
pub use ir::{
    attrs::{
        AttributeDef, AttributeTargetType, AttributeValue, AttributeValueType, FrameProtocol,
        ValueTable,
    },
    mux::{MuxRange, MuxRole, SignalId},
    ByteOrder, EcuNode, MessageDef, NetworkDatabase, SignalDef, SignalGroupDef, SignalValueType,
};
pub use ui_dto::{
    BitCellDto, DatabaseInfoDto, DatabaseSchemaDto, EcuNodeDto, MessageSchemaDto, SignalSchemaDto,
};

/// Merges multiple canonical databases into a unified `NetworkDatabase`.
/// Later messages or nodes with identical keys overwrite earlier ones while emitting line-free diagnostics.
pub fn merge_databases(dbs: Vec<NetworkDatabase>) -> (NetworkDatabase, Vec<ParseDiagnostic>) {
    let mut merged = NetworkDatabase::new("MergedDatabase");
    let mut diagnostics = Vec::new();

    for db in dbs {
        if merged.version.is_none() && db.version.is_some() {
            merged.version = db.version;
        }
        if merged.comment.is_none() && db.comment.is_some() {
            merged.comment = db.comment;
        }

        // Merge nodes
        for (node_name, node) in db.nodes {
            merged.nodes.insert(node_name, node);
        }

        // Merge messages and check for collisions
        for (can_id, msg) in db.messages {
            if merged.messages.contains_key(&can_id) {
                diagnostics.push(ParseDiagnostic::warning(
                    "DUPLICATE_CAN_ID",
                    format!(
                        "Message with CAN ID {} ('{}') was defined in multiple databases; later definition overwrites earlier",
                        can_id.schema_key(),
                        msg.name
                    ),
                    None,
                    None,
                    Some(can_id.schema_key()),
                ));
            }
            merged.messages.insert(can_id, msg);
        }

        // Merge independent signals
        merged.independent_signals.extend(db.independent_signals);

        // Merge value tables
        for (vt_name, vt) in db.value_tables {
            merged.value_tables.insert(vt_name, vt);
        }

        // Merge attribute defs
        for (attr_name, attr_def) in db.attribute_defs {
            merged.attribute_defs.insert(attr_name, attr_def);
        }

        // Merge network attributes
        for (attr_name, val) in db.network_attributes {
            merged.network_attributes.insert(attr_name, val);
        }

        // Merge signal groups
        merged.signal_groups.extend(db.signal_groups);
    }

    (merged, diagnostics)
}

/// Convenience function to parse raw database bytes, compile the runtime engine,
/// and produce the static `DatabaseSchemaDto` in a single call.
pub fn parse_and_compile(
    bytes: &[u8],
    file_hint: Option<&str>,
    opts: &ParseOptions,
) -> Result<(CompiledDatabase, DatabaseSchemaDto), DbError> {
    let registry = FormatRegistry::new();
    let bundle = registry.parse_bytes(bytes, file_hint, opts)?;

    let db_info = DatabaseInfoDto {
        name: bundle.database.name.clone(),
        version: bundle.database.version.clone(),
        format: bundle.format_name.to_string(),
        source_encoding: bundle.source_encoding.to_string(),
        message_count: bundle.database.messages.len(),
        signal_count: bundle.database.messages.values().map(|m| m.signals.len()).sum(),
        diagnostics: bundle.diagnostics,
    };

    let compiled = CompiledDatabase::compile(bundle.database)?;
    let schema_dto = compiled.to_schema_dto(db_info);

    Ok((compiled, schema_dto))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::CanIdKey;

    #[test]
    fn three_level_cascaded_dbc_and_two_level_nested_kcd_compile_and_decode_outer_to_inner() {
        // 1. 3-level cascaded .dbc (`OuterMux -> MidMux -> InnerMux -> LeafSig`)
        // Deliberately omits `M` on `OuterMux` and `m2M`/`m5M` on intermediate switches to verify
        // `SG_MUL_VAL_`-driven switch promotion across arbitrary cascade depth!
        let dbc_3lvl = r#"VERSION "1.0"
BU_: BMS VCU
BO_ 512 DeepCascadedMuxMsg: 8 BMS
 SG_ OuterMux : 0|4@1+ (1,0) [0|15] "" VCU
 SG_ StaticCounter : 4|4@1+ (1,0) [0|15] "" VCU
 SG_ MidMux m2 : 8|8@1+ (1,0) [0|255] "" VCU
 SG_ InnerMux m5 : 16|8@1+ (1,0) [0|255] "" VCU
 SG_ LeafCellMv m9 : 24|16@1+ (0.1,0) [0|5000] "mV" VCU
 SG_ AltLeafTemp m10 : 24|16@1- (0.01,0) [-40|125] "degC" VCU

SG_MUL_VAL_ 512 MidMux OuterMux 2-2;
SG_MUL_VAL_ 512 InnerMux MidMux 5-5;
SG_MUL_VAL_ 512 LeafCellMv InnerMux 9-9;
SG_MUL_VAL_ 512 AltLeafTemp InnerMux 10-10;
"#;

        let (compiled_dbc, schema_dbc) =
            parse_and_compile(dbc_3lvl.as_bytes(), Some("deep3.dbc"), &ParseOptions::default())
                .expect("compile 3-level cascaded dbc");

        let find_id = |schema: &DatabaseSchemaDto, name: &str| -> SignalId {
            schema
                .signals
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("missing signal {name}"))
                .signal_id
        };

        let outer_id = find_id(&schema_dbc, "OuterMux");
        let mid_id = find_id(&schema_dbc, "MidMux");
        let inner_id = find_id(&schema_dbc, "InnerMux");
        let leaf_id = find_id(&schema_dbc, "LeafCellMv");

        // Encode LeafCellMv = 3712.5 mV -> auto-populates InnerMux=9, MidMux=5, OuterMux=2!
        let frame_dbc = compiled_dbc
            .encode_raw_frame(0, CanIdKey::Standard(0x200), &[(leaf_id, 3_712.5)], 1_000)
            .expect("encode 3-level cascaded frame");

        let mut sig_buf = [DecodedSignalSample {
            signal_id: 0,
            raw_bits: 0,
            raw_int: 0,
            physical_value: 0.0,
            out_of_range: false,
            is_mux_switch: false,
        }; 32];
        let mut sw_buf = [(0u32, 0i64); 8];

        let summary_dbc = compiled_dbc
            .decode_frame_into(&frame_dbc, &mut sig_buf, &mut sw_buf)
            .expect("decode 3-level cascaded frame");

        assert_eq!(
            &sw_buf[..summary_dbc.active_switch_count],
            &[(outer_id, 2), (mid_id, 5), (inner_id, 9)],
            "3-level cascaded DBC switches must decode in exact outer-to-inner order"
        );
        let leaf_decoded = sig_buf[..summary_dbc.decoded_count]
            .iter()
            .find(|s| s.signal_id == leaf_id)
            .expect("LeafCellMv decoded");
        assert!((leaf_decoded.physical_value - 3_712.5).abs() < 1e-6);

        // 2. 2-level nested .kcd (`<Multiplex>` nested inside `<MuxGroup count="1">`)
        let kcd_2lvl = r#"<?xml version="1.0" encoding="UTF-8"?>
<NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0">
  <Document name="NestedKcdMux" version="1.0"/>
  <Node id="1" name="BMS"/>
  <Node id="2" name="VCU"/>
  <Bus name="Primary">
    <Message id="0x310" name="NestedMuxStatus" length="8" interval="25">
      <Producer><NodeRef id="1"/></Producer>
      <Signal name="PackHeartbeat" offset="4" length="4"/>
      <Multiplex name="DomainMux" offset="0" length="4">
        <Notes>Top-level KCD domain selector</Notes>
        <Consumer><NodeRef id="2"/></Consumer>
        <MuxGroup count="1">
          <Multiplex name="BankSubMux" offset="8" length="4">
            <Notes>Inner KCD bank selector</Notes>
            <MuxGroup count="3">
              <Signal name="NestedBank3Mv" offset="16" length="16">
                <Value type="unsigned" slope="0.1" intercept="0" min="0" max="5000" unit="mV"/>
              </Signal>
            </MuxGroup>
          </Multiplex>
          <Signal name="Domain1SharedTemp" offset="32" length="8">
            <Value type="signed" slope="1" intercept="0" min="-40" max="125" unit="degC"/>
          </Signal>
        </MuxGroup>
        <MuxGroup count="2">
          <Signal name="Domain2IsoKOhm" offset="16" length="16">
            <Value type="unsigned" slope="0.5" intercept="0" min="0" max="30000" unit="kOhm"/>
          </Signal>
        </MuxGroup>
      </Multiplex>
    </Message>
  </Bus>
</NetworkDefinition>"#;

        let (compiled_kcd, schema_kcd) =
            parse_and_compile(kcd_2lvl.as_bytes(), Some("nested2.kcd"), &ParseOptions::default())
                .expect("compile 2-level nested kcd");

        let dom_id = find_id(&schema_kcd, "DomainMux");
        let bank_id = find_id(&schema_kcd, "BankSubMux");
        let nested_mv_id = find_id(&schema_kcd, "NestedBank3Mv");
        let shared_temp_id = find_id(&schema_kcd, "Domain1SharedTemp");

        // Verify outer mux context was restored after </Multiplex> so Domain1SharedTemp attaches to DomainMux == 1
        let frame_kcd = compiled_kcd
            .encode_raw_frame(
                0,
                CanIdKey::Standard(0x310),
                &[(nested_mv_id, 3_698.4), (shared_temp_id, 31.0)],
                2_000,
            )
            .expect("encode 2-level nested kcd frame");

        let summary_kcd = compiled_kcd
            .decode_frame_into(&frame_kcd, &mut sig_buf, &mut sw_buf)
            .expect("decode 2-level nested kcd frame");

        assert_eq!(
            &sw_buf[..summary_kcd.active_switch_count],
            &[(dom_id, 1), (bank_id, 3)],
            "2-level nested KCD switches must decode in exact outer-to-inner order"
        );
        let mv_sample = sig_buf[..summary_kcd.decoded_count]
            .iter()
            .find(|s| s.signal_id == nested_mv_id)
            .expect("NestedBank3Mv decoded");
        assert!((mv_sample.physical_value - 3_698.4).abs() < 1e-6);

        let temp_sample = sig_buf[..summary_kcd.decoded_count]
            .iter()
            .find(|s| s.signal_id == shared_temp_id)
            .expect("Domain1SharedTemp decoded after inner </Multiplex>");
        assert!((temp_sample.physical_value - 31.0).abs() < 1e-6);
    }
}
