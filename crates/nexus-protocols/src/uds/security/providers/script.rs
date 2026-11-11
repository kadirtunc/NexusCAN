//! `script` provider: sandboxed Rhai (`feature = "script"`).
//!
//! # Script contract
//! ```rhai
//! fn calculate_key(seed, level) {   // seed: Blob, level: INT
//!     let key = blob();
//!     for b in seed { key.push(b ^ 0xFF); }
//!     key                           // Blob, or Array of INT 0..=255
//! }
//! ```
//!
//! # Sandbox
//! * Minimal engine (`Engine::new_raw`) + an explicit package list. Left out on
//!   purpose: `LanguageCorePackage` (`sleep` blocks the thread and cannot be
//!   interrupted by `on_progress`; `exit`, tags, reflection) and
//!   `BasicTimePackage` (non-deterministic `timestamp`).
//! * Crate built with `no_module` → no `import`, no module resolver/file access.
//! * `eval` disabled as a symbol (parse error); `print`/`debug` are swallowed.
//! * Limits: operations, call depth 32, expression depth, string 4096,
//!   array/blob 1024 (Rhai applies `max_array_size` to blobs too), map 256,
//!   variables, functions, source ≤ 64 KiB.
//! * `for b in seed` yields INT (custom Blob iterator), matching `seed[i]`.
//! * Wall-clock deadline (`timeoutMs`) enforced from `on_progress`; the engine
//!   is re-created per call (cheap: packages are shared `Arc`s) so concurrent
//!   calls each get their own deadline. The AST is compiled once per provider.

use std::any::TypeId;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use rhai::packages::{
    ArithmeticPackage, BasicArrayPackage, BasicBlobPackage, BasicFnPackage, BasicIteratorPackage,
    BasicMapPackage, BasicMathPackage, BasicStringPackage, BitFieldPackage, LogicPackage,
    MoreStringPackage, Package,
};
use rhai::{Blob, Dynamic, Engine, EvalAltResult, Module, Scope, Shared, AST, INT};

type SharedModule = Shared<Module>;

use super::super::{KeyProvider, SeedKeyError, SeedKeyRequest, MAX_KEY_LEN};
use super::check_seed_len;

/// Hard upper bound on Rhai operations per call (backs up the wall clock).
pub const SCRIPT_MAX_OPERATIONS: u64 = 50_000_000;
pub const SCRIPT_MAX_CALL_LEVELS: usize = 32;
pub const SCRIPT_MAX_STRING_SIZE: usize = 4096;
/// Also bounds blobs (Rhai uses the array limit for `Blob`).
pub const SCRIPT_MAX_ARRAY_SIZE: usize = 1024;
pub const SCRIPT_MAX_MAP_SIZE: usize = 256;
const SCRIPT_MAX_VARIABLES: usize = 1024;
const SCRIPT_MAX_FUNCTIONS: usize = 256;
const SCRIPT_MAX_EXPR_DEPTH: usize = 64;
const SCRIPT_MAX_FN_EXPR_DEPTH: usize = 32;
/// `on_progress` checks the clock every N operations.
const CLOCK_CHECK_INTERVAL: u64 = 256;
const ENTRY_POINT: &str = "calculate_key";

fn packages() -> &'static [SharedModule] {
    static PACKAGES: OnceLock<Vec<SharedModule>> = OnceLock::new();
    PACKAGES.get_or_init(|| {
        vec![
            ArithmeticPackage::new().as_shared_module(),
            LogicPackage::new().as_shared_module(),
            BitFieldPackage::new().as_shared_module(),
            BasicMathPackage::new().as_shared_module(),
            BasicStringPackage::new().as_shared_module(),
            MoreStringPackage::new().as_shared_module(),
            BasicIteratorPackage::new().as_shared_module(),
            BasicFnPackage::new().as_shared_module(),
            BasicArrayPackage::new().as_shared_module(),
            BasicBlobPackage::new().as_shared_module(),
            BasicMapPackage::new().as_shared_module(),
            // Registered last → searched first: overrides the stock `u8` Blob iterator.
            blob_int_iterator(),
        ]
    })
}

/// `for b in seed` yields INT (like `seed[i]`) instead of Rhai's default `u8`,
/// so `b ^ 0xFF` works without `to_int()` casts.
fn blob_int_iterator() -> SharedModule {
    let mut module = Module::new();
    module.set_iter(TypeId::of::<Blob>(), |value: Dynamic| {
        let blob = value.try_cast::<Blob>().unwrap_or_default();
        Box::new(blob.into_iter().map(|b| Dynamic::from_int(INT::from(b))))
    });
    module.build_index();
    Shared::new(module)
}

/// Sandboxed engine without a deadline (used for compilation).
fn sandbox_engine() -> Engine {
    let mut engine = Engine::new_raw();
    for module in packages() {
        engine.register_global_module(module.clone());
    }
    engine
        .disable_symbol("eval")
        .on_print(|_| {})
        .on_debug(|_, _, _| {})
        .set_max_operations(SCRIPT_MAX_OPERATIONS)
        .set_max_call_levels(SCRIPT_MAX_CALL_LEVELS)
        .set_max_expr_depths(SCRIPT_MAX_EXPR_DEPTH, SCRIPT_MAX_FN_EXPR_DEPTH)
        .set_max_string_size(SCRIPT_MAX_STRING_SIZE)
        .set_max_array_size(SCRIPT_MAX_ARRAY_SIZE)
        .set_max_map_size(SCRIPT_MAX_MAP_SIZE)
        .set_max_variables(SCRIPT_MAX_VARIABLES)
        .set_max_functions(SCRIPT_MAX_FUNCTIONS);
    engine
}

/// Compiles `source` and checks that `calculate_key(seed, level)` exists.
pub(super) fn compile(source: &str) -> Result<AST, SeedKeyError> {
    let ast = sandbox_engine()
        .compile(source)
        .map_err(|e| SeedKeyError::Script(format!("compile error: {e}")))?;
    let has_entry = ast
        .iter_functions()
        .any(|f| f.name == ENTRY_POINT && f.params.len() == 2);
    if !has_entry {
        return Err(SeedKeyError::Script(format!(
            "script must define `fn {ENTRY_POINT}(seed, level)`"
        )));
    }
    Ok(ast)
}

pub(super) struct ScriptProvider {
    ast: AST,
    timeout_ms: u32,
}

impl ScriptProvider {
    pub(super) fn new(source: &str, timeout_ms: u32) -> Result<Self, SeedKeyError> {
        Ok(Self {
            ast: compile(source)?,
            timeout_ms,
        })
    }
}

impl KeyProvider for ScriptProvider {
    fn kind(&self) -> &'static str {
        "script"
    }

    fn compute_key(&self, req: &SeedKeyRequest<'_>) -> Result<Vec<u8>, SeedKeyError> {
        check_seed_len(req.seed)?;
        let timeout_ms = self.timeout_ms;
        let limit = Duration::from_millis(u64::from(timeout_ms));
        let start = Instant::now();

        let mut engine = sandbox_engine();
        engine.on_progress(move |ops| {
            if ops % CLOCK_CHECK_INTERVAL == 0 && start.elapsed() >= limit {
                Some(Dynamic::UNIT)
            } else {
                None
            }
        });

        let mut scope = Scope::new();
        let seed: Blob = req.seed.to_vec();
        let level = INT::from(req.level);
        let result = engine
            .call_fn::<Dynamic>(&mut scope, &self.ast, ENTRY_POINT, (seed, level))
            .map_err(|e| map_eval_error(*e, timeout_ms))?;
        // A cheap, uninterruptible final step may still push us past the deadline.
        if start.elapsed() > limit {
            return Err(SeedKeyError::Timeout { ms: timeout_ms });
        }
        convert_key(result)
    }
}

fn map_eval_error(err: EvalAltResult, timeout_ms: u32) -> SeedKeyError {
    match err {
        // Only our `on_progress` callback terminates scripts.
        EvalAltResult::ErrorTerminated(..) => SeedKeyError::Timeout { ms: timeout_ms },
        EvalAltResult::ErrorTooManyOperations(..) => SeedKeyError::Script(format!(
            "operation limit ({SCRIPT_MAX_OPERATIONS}) exceeded"
        )),
        other => SeedKeyError::Script(other.to_string()),
    }
}

fn convert_key(value: Dynamic) -> Result<Vec<u8>, SeedKeyError> {
    let type_name = value.type_name();
    let key: Vec<u8> = if value.is_blob() {
        value
            .into_blob()
            .map_err(|t| SeedKeyError::Script(format!("unexpected return type {t}")))?
    } else if value.is_array() {
        let array = value
            .into_array()
            .map_err(|t| SeedKeyError::Script(format!("unexpected return type {t}")))?;
        array
            .into_iter()
            .enumerate()
            .map(|(i, item)| {
                item.as_int()
                    .ok()
                    .and_then(|v| u8::try_from(v).ok())
                    .ok_or_else(|| {
                        SeedKeyError::Script(format!(
                            "{ENTRY_POINT} returned array element [{i}] that is not an INT in 0..=255"
                        ))
                    })
            })
            .collect::<Result<_, _>>()?
    } else {
        return Err(SeedKeyError::Script(format!(
            "{ENTRY_POINT} must return a Blob or an Array of INT 0..=255, got {type_name}"
        )));
    };
    if key.is_empty() {
        return Err(SeedKeyError::Script(format!(
            "{ENTRY_POINT} returned an empty key"
        )));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(SeedKeyError::Script(format!(
            "{ENTRY_POINT} returned {} bytes (max {MAX_KEY_LEN})",
            key.len()
        )));
    }
    Ok(key)
}
