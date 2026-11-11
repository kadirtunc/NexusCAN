//! `table` provider: exact seed → key lookup.
//!
//! Entries are parsed once at build time (malformed hex, empty or oversized
//! seeds/keys and too many entries → `InvalidInput`). Lookup compares the
//! decoded seed bytes, so case, whitespace, `0x`, `-` and `:` separators in the
//! profile do not matter. First matching entry wins.

use super::super::{to_hex, KeyProvider, SeedKeyError, SeedKeyPairDto, SeedKeyRequest};
use super::{check_seed_len, parse_bounded_hex, MAX_TABLE_ENTRIES};

pub(super) struct TableProvider {
    entries: Vec<(Vec<u8>, Vec<u8>)>,
}

impl TableProvider {
    pub(super) fn new(entries: &[SeedKeyPairDto]) -> Result<Self, SeedKeyError> {
        if entries.len() > MAX_TABLE_ENTRIES {
            return Err(SeedKeyError::InvalidInput(format!(
                "entries: {} entries exceed the limit of {MAX_TABLE_ENTRIES}",
                entries.len()
            )));
        }
        let parsed = entries
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let seed = parse_bounded_hex(&e.seed_hex, &format!("entries[{i}].seedHex"))?;
                let key = parse_bounded_hex(&e.key_hex, &format!("entries[{i}].keyHex"))?;
                Ok((seed, key))
            })
            .collect::<Result<Vec<_>, SeedKeyError>>()?;
        Ok(Self { entries: parsed })
    }
}

impl KeyProvider for TableProvider {
    fn kind(&self) -> &'static str {
        "table"
    }

    fn compute_key(&self, req: &SeedKeyRequest<'_>) -> Result<Vec<u8>, SeedKeyError> {
        check_seed_len(req.seed)?;
        self.entries
            .iter()
            .find(|(seed, _)| seed.as_slice() == req.seed)
            .map(|(_, key)| key.clone())
            .ok_or_else(|| {
                SeedKeyError::NotFound(format!("seed {} not in table", to_hex(req.seed)))
            })
    }
}
