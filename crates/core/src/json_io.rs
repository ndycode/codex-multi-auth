//! THE byte-compat chokepoint for all persisted JSON (ARCHITECTURE.md §8.1).
//!
//! Every persisted-JSON write in the workspace goes through this module —
//! never `serde_json::to_string*` directly in feature code. Guarantees:
//!
//! - [`stringify_pretty2`] is byte-identical to `JSON.stringify(x, null, 2)`:
//!   2-space indent, `": "` after keys, `,\n` separators, `{}`/`[]` for empty
//!   containers, non-ASCII left unescaped, control chars escaped exactly like
//!   V8 (`\b \t \n \f \r` short forms, lowercase `\u00xx` otherwise), and —
//!   crucially — ECMAScript `Number::toString` float formatting (`5.0` → `5`,
//!   `1e21` → `"1e+21"`, `1e-7` → `"1e-7"`, `1e-6` → `"0.000001"`), which the
//!   default ryu-based serde_json output does NOT match.
//! - [`stringify_compact`] == `JSON.stringify(x)`.
//! - [`stringify_pretty_tab`] == `JSON.stringify(x, null, "\t")` (Codex.json).
//! - [`write_json_atomic`]/[`write_json_atomic_sync`] implement the shared
//!   write protocol: optional `.bak` snapshot (retry EBUSY/EPERM ×5, async
//!   delays 10/20/40/80 ms, silent give-up), staging via
//!   [`crate::temp_path::temp_path_for`], optional mode 0600 applied
//!   atomically at open(2) on unix (Node parity: no chmod window), optional
//!   mtime CAS (mismatch → `"ESTALE"`-coded error), atomic rename with
//!   per-site retry (EBUSY/EPERM ×5), best-effort temp unlink on failure.
//! - Trailing-newline matrix is expressed via [`TrailingNewline`] (accounts /
//!   settings YES; request-logs / runtime-observability / update-cache NO).
//! - [`strip_utf8_bom`] strips a leading U+FEFF before parsing (Windows
//!   editors), matching the TS `stripUtf8Bom` used on every config read.
//!
//! Key order: `serde_json` is built with `preserve_order`, so object key
//! order round-trips insertion order and structs serialize in declaration
//! order — matching V8 property-insertion order semantics.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::ser::{CompactFormatter, Formatter, PrettyFormatter, Serializer};

use crate::fs_retry::{Backoff, RetryOptions, io_error_with_code, with_retry, with_retry_sync};
use crate::temp_path::temp_path_for;

// ---------------------------------------------------------------------------
// ECMAScript number formatting
// ---------------------------------------------------------------------------

/// Format an `f64` exactly like ECMAScript `Number::toString(10)` (the number
/// formatting used by `JSON.stringify` and `String(n)`).
///
/// Also handles non-finite values (`"NaN"`, `"Infinity"`, `"-Infinity"`) for
/// callers like the config explain-report normalization; note that inside
/// JSON serialization non-finite floats become `null` (serde_json emits
/// `write_null` for them, matching `JSON.stringify(NaN) === "null"`).
pub fn format_js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        // Covers -0.0: String(-0) === "0" in JS (and JSON.stringify(-0) === "0"...
        // actually V8 prints "0" via ToString; JSON.stringify(-0) is "0" too).
        return "0".to_string();
    }

    let negative = value < 0.0;
    let abs = value.abs();

    // Rust's `{:e}` prints the shortest round-trip mantissa (no trailing
    // zeros, single nonzero leading digit) with a decimal exponent — exactly
    // the (s, k, n) decomposition ECMA-262 §6.1.6.1.20 needs.
    let exp_repr = format!("{abs:e}");
    let (mantissa, exp_part) = exp_repr
        .split_once('e')
        .expect("{:e} always contains an exponent");
    let exponent: i32 = exp_part.parse().expect("{:e} exponent is an integer");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let n = digits.len() as i32;
    // value = 0.<digits> * 10^k
    let k = exponent + 1;

    let body = if n <= k && k <= 21 {
        // Integer with trailing zeros.
        let mut s = digits.clone();
        for _ in 0..(k - n) {
            s.push('0');
        }
        s
    } else if 0 < k && k <= 21 {
        // Decimal point inside the digits.
        let (int_part, frac_part) = digits.split_at(k as usize);
        format!("{int_part}.{frac_part}")
    } else if -6 < k && k <= 0 {
        // 0.000ddd form.
        let mut s = String::from("0.");
        for _ in 0..(-k) {
            s.push('0');
        }
        s.push_str(&digits);
        s
    } else {
        // Exponential notation: d[.ddd]e±E where E = k - 1 (with explicit '+').
        let e = k - 1;
        let mantissa_out = if digits.len() == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        if e >= 0 {
            format!("{mantissa_out}e+{e}")
        } else {
            format!("{mantissa_out}e-{}", -e)
        }
    };

    if negative { format!("-{body}") } else { body }
}

// ---------------------------------------------------------------------------
// Formatters (serde_json formatter overrides for JS float output)
// ---------------------------------------------------------------------------

struct JsPrettyFormatter<'a> {
    inner: PrettyFormatter<'a>,
}

impl<'a> JsPrettyFormatter<'a> {
    fn with_indent(indent: &'a [u8]) -> Self {
        Self {
            inner: PrettyFormatter::with_indent(indent),
        }
    }
}

macro_rules! delegate_structural {
    ($inner:ident) => {
        fn begin_array<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.begin_array(writer)
        }

        fn end_array<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.end_array(writer)
        }

        fn begin_array_value<W>(&mut self, writer: &mut W, first: bool) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.begin_array_value(writer, first)
        }

        fn end_array_value<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.end_array_value(writer)
        }

        fn begin_object<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.begin_object(writer)
        }

        fn end_object<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.end_object(writer)
        }

        fn begin_object_key<W>(&mut self, writer: &mut W, first: bool) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.begin_object_key(writer, first)
        }

        fn begin_object_value<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.begin_object_value(writer)
        }

        fn end_object_value<W>(&mut self, writer: &mut W) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            self.$inner.end_object_value(writer)
        }
    };
}

macro_rules! js_float_writes {
    () => {
        fn write_f32<W>(&mut self, writer: &mut W, value: f32) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            // JS has only doubles; format the f32's exact double value.
            writer.write_all(format_js_number(f64::from(value)).as_bytes())
        }

        fn write_f64<W>(&mut self, writer: &mut W, value: f64) -> io::Result<()>
        where
            W: ?Sized + io::Write,
        {
            writer.write_all(format_js_number(value).as_bytes())
        }
    };
}

impl Formatter for JsPrettyFormatter<'_> {
    delegate_structural!(inner);
    js_float_writes!();
}

struct JsCompactFormatter;

impl Formatter for JsCompactFormatter {
    js_float_writes!();
}

// CompactFormatter is used only to prove the default-structural parity in
// tests; suppress the unused warning path by referencing it.
#[allow(dead_code)]
fn _assert_compact_exists() -> CompactFormatter {
    CompactFormatter
}

fn serialize_with_formatter<T, F>(value: &T, formatter: F) -> Result<String, serde_json::Error>
where
    T: ?Sized + Serialize,
    F: Formatter,
{
    let mut out: Vec<u8> = Vec::with_capacity(128);
    let mut ser = Serializer::with_formatter(&mut out, formatter);
    value.serialize(&mut ser)?;
    Ok(String::from_utf8(out).expect("serde_json output is always valid UTF-8"))
}

// ---------------------------------------------------------------------------
// stringify_*
// ---------------------------------------------------------------------------

/// `JSON.stringify(value, null, 2)` — byte-exact. Panics on serialization
/// failure (only possible for exotic types like maps with non-string keys;
/// `serde_json::Value` and all persisted-format structs never fail). Use
/// [`try_stringify_pretty2`] where the caller wants to handle the error.
pub fn stringify_pretty2<T: ?Sized + Serialize>(value: &T) -> String {
    try_stringify_pretty2(value).expect("JSON serialization failed")
}

/// Fallible variant of [`stringify_pretty2`].
pub fn try_stringify_pretty2<T: ?Sized + Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serialize_with_formatter(value, JsPrettyFormatter::with_indent(b"  "))
}

/// `JSON.stringify(value, null, "\t")` — TAB indent (Codex.json,
/// first-run-setup marker).
pub fn stringify_pretty_tab<T: ?Sized + Serialize>(value: &T) -> String {
    try_stringify_pretty_tab(value).expect("JSON serialization failed")
}

/// Fallible variant of [`stringify_pretty_tab`].
pub fn try_stringify_pretty_tab<T: ?Sized + Serialize>(
    value: &T,
) -> Result<String, serde_json::Error> {
    serialize_with_formatter(value, JsPrettyFormatter::with_indent(b"\t"))
}

/// `JSON.stringify(value)` — compact, no whitespace.
pub fn stringify_compact<T: ?Sized + Serialize>(value: &T) -> String {
    try_stringify_compact(value).expect("JSON serialization failed")
}

/// Fallible variant of [`stringify_compact`].
pub fn try_stringify_compact<T: ?Sized + Serialize>(
    value: &T,
) -> Result<String, serde_json::Error> {
    serialize_with_formatter(value, JsCompactFormatter)
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

/// Strip a single leading UTF-8 BOM (U+FEFF), matching the TS `stripUtf8Bom`
/// applied before every config-file `JSON.parse` (Windows editors add it).
pub fn strip_utf8_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{feff}').unwrap_or(raw)
}

/// Error from [`read_json_file`], distinguishing IO failures from JSON syntax
/// errors — storage's load ladder propagates SyntaxError but treats schema
/// errors separately, so callers need the split.
#[derive(Debug)]
pub enum ReadJsonError {
    Io(io::Error),
    Parse(serde_json::Error),
}

impl ReadJsonError {
    /// True when the underlying failure is file-not-found.
    pub fn is_not_found(&self) -> bool {
        matches!(self, ReadJsonError::Io(e) if e.kind() == io::ErrorKind::NotFound)
    }

    pub fn as_io(&self) -> Option<&io::Error> {
        match self {
            ReadJsonError::Io(e) => Some(e),
            ReadJsonError::Parse(_) => None,
        }
    }
}

impl std::fmt::Display for ReadJsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadJsonError::Io(e) => write!(f, "{e}"),
            ReadJsonError::Parse(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ReadJsonError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ReadJsonError::Io(e) => Some(e),
            ReadJsonError::Parse(e) => Some(e),
        }
    }
}

/// Read a file as (lossy) UTF-8 text — Node's `readFileSync(p, "utf-8")` is
/// lossy on invalid sequences, so this uses `from_utf8_lossy` rather than
/// failing.
pub fn read_text_file(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Read + BOM-strip + parse a JSON file into a [`serde_json::Value`]
/// (preserving key order).
pub fn read_json_file(path: &Path) -> Result<serde_json::Value, ReadJsonError> {
    read_json_file_as(path)
}

/// Read + BOM-strip + parse a JSON file into any deserializable type.
pub fn read_json_file_as<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> Result<T, ReadJsonError> {
    let raw = read_text_file(path).map_err(ReadJsonError::Io)?;
    serde_json::from_str(strip_utf8_bom(&raw)).map_err(ReadJsonError::Parse)
}

/// Millisecond mtime of `path` as a float (Node `stats.mtimeMs`); `Ok(None)`
/// when the file does not exist. Used for the mtime-CAS write option.
pub fn file_mtime_ms(path: &Path) -> io::Result<Option<f64>> {
    match fs::metadata(path) {
        Ok(meta) => {
            let modified = meta.modified()?;
            let ms = match modified.duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_secs_f64() * 1000.0,
                // Pre-epoch mtimes (clock weirdness): negative ms like Node.
                Err(e) => -(e.duration().as_secs_f64() * 1000.0),
            };
            Ok(Some(ms))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/// Trailing-newline matrix entry (per-file-type): accounts/settings files end
/// with `"\n"`; request logs, runtime-observability, update-check-cache do
/// not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrailingNewline {
    /// No trailing newline appended.
    None,
    /// A single `"\n"` appended after the serialized content.
    Lf,
}

/// Compare-and-swap on the destination's mtime, mirroring the TS unified
/// settings / env-path config save protocol: stat the target just before the
/// rename; `expected_mtime_ms = None` means "expected missing"; any mismatch
/// aborts with an `"ESTALE"`-coded error carrying `stale_message` so the
/// caller's CAS loop can re-read and retry.
#[derive(Debug, Clone)]
pub struct MtimeCas {
    pub expected_mtime_ms: Option<f64>,
    pub stale_message: String,
}

/// Pre-write `.bak` snapshot options. The copy is best-effort: retried on
/// EBUSY/EPERM up to 5 attempts (async delays 10/20/40/80 ms; sync retries
/// immediately) and given up silently — a failed backup never blocks the
/// write. Skipped when the source file does not exist. Callers that recovered
/// state from the backup itself must OMIT this option (spec 01 gotcha 10).
#[derive(Debug, Clone)]
pub struct BackupOptions {
    pub backup_path: PathBuf,
}

/// Options for [`write_json_atomic`] / [`write_json_atomic_sync`].
#[derive(Debug)]
pub struct WriteJsonOptions {
    pub trailing_newline: TrailingNewline,
    pub mtime_cas: Option<MtimeCas>,
    pub backup: Option<BackupOptions>,
    /// fsync the staged temp file before rename (local-client-tokens style).
    pub fsync: bool,
    /// Create the parent directory (recursively) before staging.
    pub ensure_parent_dir: bool,
    /// Mode for created parent directories (unix only; typically 0o700).
    pub parent_dir_mode: Option<u32>,
    /// Rename attempts (retrying EBUSY/EPERM). Default 5, matching the shared
    /// TS protocol; per-site overrides allowed.
    pub rename_max_attempts: u32,
}

impl Default for WriteJsonOptions {
    fn default() -> Self {
        Self {
            trailing_newline: TrailingNewline::Lf,
            mtime_cas: None,
            backup: None,
            fsync: false,
            ensure_parent_dir: false,
            parent_dir_mode: None,
            rename_max_attempts: 5,
        }
    }
}

const WRITE_RETRY_CODES: &[&str] = &["EBUSY", "EPERM"];

fn backup_retry_backoff() -> Backoff {
    // 10 * 2^(n-1) for the 1-based failed-attempt index → 10/20/40/80 ms.
    Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1))))
}

fn apply_payload(content: &str, trailing_newline: TrailingNewline) -> String {
    match trailing_newline {
        TrailingNewline::None => content.to_string(),
        TrailingNewline::Lf => format!("{content}\n"),
    }
}

fn ensure_parent_dir(path: &Path, mode: Option<u32>) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        if let Some(mode) = mode {
            builder.mode(mode);
        }
        return builder.create(parent);
    }
    #[cfg(not(unix))]
    {
        let _ = mode; // file modes are a no-op on Windows (Node parity)
        fs::create_dir_all(parent)
    }
}

/// Node `fs.writeFile(path, content, { mode })` parity: create/truncate and
/// write with `mode` applied atomically at open(2) (`O_CREAT`) on unix, so a
/// secret-bearing file NEVER exists with broader permissions — there is no
/// write-then-chmod window and no world-readable crash residue. Like Node,
/// the mode only takes effect when the open actually CREATES the file; a
/// pre-existing file keeps its permissions. Mode is a no-op on Windows.
pub fn write_text_file_with_mode_sync(
    path: &Path,
    content: &str,
    mode: Option<u32>,
) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode; // no-op on Windows (Node parity)
    let mut file = options.open(path)?;
    io::Write::write_all(&mut file, content.as_bytes())
}

fn stage_temp_file(path: &Path, payload: &str, mode: Option<u32>, fsync: bool) -> io::Result<PathBuf> {
    let temp = temp_path_for(path);
    if let Err(error) = write_text_file_with_mode_sync(&temp, payload, mode) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if fsync {
        let sync_result = fs::OpenOptions::new()
            .write(true)
            .open(&temp)
            .and_then(|f| f.sync_all());
        if let Err(error) = sync_result {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }
    Ok(temp)
}

fn check_mtime_cas(path: &Path, cas: &MtimeCas) -> io::Result<()> {
    let actual = file_mtime_ms(path)?;
    if actual != cas.expected_mtime_ms {
        return Err(io_error_with_code("ESTALE", cas.stale_message.clone()));
    }
    Ok(())
}

/// Atomically write `content` (a pre-serialized JSON string, typically from
/// [`stringify_pretty2`]) to `path` via the shared temp+rename protocol.
///
/// `mode` is the file mode for the destination (e.g. `0o600`); applied on
/// unix, a no-op on Windows (Node parity). See [`WriteJsonOptions`] for the
/// backup / mtime-CAS / trailing-newline knobs. Retry delays use tokio time.
pub async fn write_json_atomic(
    path: &Path,
    content: &str,
    mode: Option<u32>,
    options: &WriteJsonOptions,
) -> io::Result<()> {
    if options.ensure_parent_dir {
        ensure_parent_dir(path, options.parent_dir_mode)?;
    }

    if let Some(backup) = &options.backup
        && fs::metadata(path).is_ok()
    {
        let backup_path = backup.backup_path.clone();
        let source = path.to_path_buf();
        // Best-effort snapshot: retry EBUSY/EPERM ×5, then give up silently.
        let _ = with_retry(
            || {
                let source = source.clone();
                let backup_path = backup_path.clone();
                async move { fs::copy(&source, &backup_path).map(|_| ()) }
            },
            RetryOptions::<io::Error>::new(5, backup_retry_backoff()).with_codes(WRITE_RETRY_CODES),
        )
        .await;
    }

    let payload = apply_payload(content, options.trailing_newline);
    let temp = stage_temp_file(path, &payload, mode, options.fsync)?;

    if let Some(cas) = &options.mtime_cas
        && let Err(error) = check_mtime_cas(path, cas)
    {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    let rename_result = with_retry(
        || {
            let temp = temp.clone();
            let path = path.to_path_buf();
            async move { fs::rename(&temp, &path) }
        },
        RetryOptions::<io::Error>::new(options.rename_max_attempts.max(1), backup_retry_backoff())
            .with_codes(WRITE_RETRY_CODES),
    )
    .await;

    if let Err(error) = rename_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// Synchronous variant of [`write_json_atomic`]. Retries are immediate (no
/// sleeping), matching the TS sync writers which deliberately never block on
/// timers (spec 01 §10.1).
pub fn write_json_atomic_sync(
    path: &Path,
    content: &str,
    mode: Option<u32>,
    options: &WriteJsonOptions,
) -> io::Result<()> {
    if options.ensure_parent_dir {
        ensure_parent_dir(path, options.parent_dir_mode)?;
    }

    if let Some(backup) = &options.backup
        && fs::metadata(path).is_ok()
    {
        let _ = with_retry_sync(
            || fs::copy(path, &backup.backup_path).map(|_| ()),
            RetryOptions::<io::Error>::fixed(5, 0).with_codes(WRITE_RETRY_CODES),
        );
    }

    let payload = apply_payload(content, options.trailing_newline);
    let temp = stage_temp_file(path, &payload, mode, options.fsync)?;

    if let Some(cas) = &options.mtime_cas
        && let Err(error) = check_mtime_cas(path, cas)
    {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    let rename_result = with_retry_sync(
        || fs::rename(&temp, path),
        RetryOptions::<io::Error>::fixed(options.rename_max_attempts.max(1), 0)
            .with_codes(WRITE_RETRY_CODES),
    );

    if let Err(error) = rename_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_retry::code_of;
    use serde_json::json;

    // ----- format_js_number: ECMAScript Number::toString parity -----

    #[test]
    fn format_js_number_matches_ecmascript_tostring() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (5.0, "5"),
            (100.0, "100"),
            (0.1, "0.1"),
            (0.001, "0.001"),
            (123.456, "123.456"),
            (1234.5, "1234.5"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (2e21, "2e+21"),
            (1.2e22, "1.2e+22"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (-2.5e-10, "-2.5e-10"),
            (9007199254740992.0, "9007199254740992"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ];
        for (input, expected) in cases {
            assert_eq!(&format_js_number(*input), expected, "input {input:?}");
        }
    }

    #[test]
    fn format_js_number_handles_non_finite_values() {
        assert_eq!(format_js_number(f64::NAN), "NaN");
        assert_eq!(format_js_number(f64::INFINITY), "Infinity");
        assert_eq!(format_js_number(f64::NEG_INFINITY), "-Infinity");
    }

    // ----- stringify parity -----

    #[test]
    fn pretty2_formats_empty_containers_like_node() {
        assert_eq!(stringify_pretty2(&json!({})), "{}");
        assert_eq!(stringify_pretty2(&json!([])), "[]");
        assert_eq!(stringify_pretty2(&json!(null)), "null");
        assert_eq!(stringify_pretty2(&json!("x")), "\"x\"");
        assert_eq!(stringify_pretty2(&json!(42)), "42");
    }

    #[test]
    fn pretty2_matches_json_stringify_null_2_for_nested_values() {
        let value = json!({
            "name": "cma",
            "nested": {
                "empty": {},
                "arr": [1, "two", { "deep": true }, []],
                "nullv": null
            },
            "unicode": "héllo → 日本語 ✓"
        });
        // Verified against `JSON.stringify(value, null, 2)` in Node.
        let expected = concat!(
            "{\n",
            "  \"name\": \"cma\",\n",
            "  \"nested\": {\n",
            "    \"empty\": {},\n",
            "    \"arr\": [\n",
            "      1,\n",
            "      \"two\",\n",
            "      {\n",
            "        \"deep\": true\n",
            "      },\n",
            "      []\n",
            "    ],\n",
            "    \"nullv\": null\n",
            "  },\n",
            "  \"unicode\": \"héllo → 日本語 ✓\"\n",
            "}"
        );
        assert_eq!(stringify_pretty2(&value), expected);
    }

    #[test]
    fn pretty2_escapes_control_characters_exactly_like_v8() {
        let value = json!({ "escapes": "line1\nline2\ttab \"q\" \\ \u{1}\u{1f}\u{7f}" });
        // V8: \n and \t short escapes, / lowercase 4-digit,
        // U+007F NOT escaped, quote and backslash escaped.
        let expected = concat!(
            "{\n",
            "  \"escapes\": \"line1\\nline2\\ttab \\\"q\\\" \\\\ \\u0001\\u001f\u{7f}\"\n",
            "}"
        );
        assert_eq!(stringify_pretty2(&value), expected);
    }

    #[test]
    fn pretty2_uses_js_float_formatting_inside_documents() {
        let value = json!({ "big": 1e21, "whole": 5.0, "tiny": 1e-7, "frac": 0.1 });
        let expected = concat!(
            "{\n",
            "  \"big\": 1e+21,\n",
            "  \"whole\": 5,\n",
            "  \"tiny\": 1e-7,\n",
            "  \"frac\": 0.1\n",
            "}"
        );
        assert_eq!(stringify_pretty2(&value), expected);
    }

    #[test]
    fn compact_matches_json_stringify() {
        let value = json!({ "a": 1, "b": [1, 2], "c": "x", "f": 2.5 });
        assert_eq!(
            stringify_compact(&value),
            r#"{"a":1,"b":[1,2],"c":"x","f":2.5}"#
        );
    }

    #[test]
    fn pretty_tab_uses_tab_indentation() {
        let value = json!({ "a": { "b": 1 } });
        let expected = "{\n\t\"a\": {\n\t\t\"b\": 1\n\t}\n}";
        assert_eq!(stringify_pretty_tab(&value), expected);
    }

    #[test]
    fn key_order_round_trips_through_parse_and_stringify() {
        let raw = r#"{"z":1,"a":{"y":2,"b":3},"m":[{"k2":1,"k1":2}]}"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(stringify_compact(&value), raw);
    }

    #[test]
    fn integers_print_without_decimal_point() {
        let value = json!({ "epoch": 1750000000000i64, "neg": -12, "max": u64::MAX });
        assert_eq!(
            stringify_compact(&value),
            format!(r#"{{"epoch":1750000000000,"neg":-12,"max":{}}}"#, u64::MAX)
        );
    }

    // ----- strip_utf8_bom -----

    #[test]
    fn strips_a_single_leading_bom_only() {
        assert_eq!(strip_utf8_bom("\u{feff}{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_utf8_bom("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_utf8_bom("\u{feff}\u{feff}x"), "\u{feff}x");
        assert_eq!(strip_utf8_bom(""), "");
    }

    // ----- read helpers -----

    #[test]
    fn read_json_file_strips_bom_and_preserves_key_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "\u{feff}{\"z\":1,\"a\":2}").unwrap();
        let value = read_json_file(&path).unwrap();
        assert_eq!(stringify_compact(&value), r#"{"z":1,"a":2}"#);
    }

    #[test]
    fn read_json_file_distinguishes_io_from_parse_errors() {
        let dir = tempfile::tempdir().unwrap();
        let missing = read_json_file(&dir.path().join("missing.json")).unwrap_err();
        assert!(missing.is_not_found());

        let path = dir.path().join("broken.json");
        fs::write(&path, "{ not json").unwrap();
        let broken = read_json_file(&path).unwrap_err();
        assert!(matches!(broken, ReadJsonError::Parse(_)));
        assert!(!broken.is_not_found());
    }

    // ----- atomic writes -----

    fn list_tmp_files(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[tokio::test]
    async fn writes_content_with_trailing_newline_and_cleans_up_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let content = stringify_pretty2(&json!({ "version": 1 }));
        write_json_atomic(&path, &content, Some(0o600), &WriteJsonOptions::default())
            .await
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert_eq!(written, "{\n  \"version\": 1\n}\n");
        assert!(list_tmp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn honors_trailing_newline_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-observability.json");
        let options = WriteJsonOptions {
            trailing_newline: TrailingNewline::None,
            ..Default::default()
        };
        write_json_atomic(&path, "{}", Some(0o600), &options).await.unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
    }

    #[tokio::test]
    async fn snapshots_previous_content_to_backup_before_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let bak = dir.path().join("settings.json.bak");
        fs::write(&path, "old-content\n").unwrap();
        let options = WriteJsonOptions {
            backup: Some(BackupOptions {
                backup_path: bak.clone(),
            }),
            ..Default::default()
        };
        write_json_atomic(&path, "{\"new\":true}", None, &options)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), "old-content\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"new\":true}\n");
    }

    #[tokio::test]
    async fn backup_is_skipped_when_target_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let bak = dir.path().join("settings.json.bak");
        let options = WriteJsonOptions {
            backup: Some(BackupOptions {
                backup_path: bak.clone(),
            }),
            ..Default::default()
        };
        write_json_atomic(&path, "{}", None, &options).await.unwrap();
        assert!(!bak.exists());
    }

    #[tokio::test]
    async fn mtime_cas_mismatch_yields_estale_and_leaves_target_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "original").unwrap();
        let options = WriteJsonOptions {
            mtime_cas: Some(MtimeCas {
                expected_mtime_ms: None, // expected missing, but the file exists
                stale_message:
                    "Unified settings changed on disk during save; retrying with latest state."
                        .to_string(),
            }),
            ..Default::default()
        };
        let error = write_json_atomic(&path, "{}", None, &options)
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), Some("ESTALE"));
        assert!(
            error
                .to_string()
                .contains("Unified settings changed on disk during save")
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert!(list_tmp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn mtime_cas_match_allows_the_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "original").unwrap();
        let expected = file_mtime_ms(&path).unwrap();
        assert!(expected.is_some());
        let options = WriteJsonOptions {
            mtime_cas: Some(MtimeCas {
                expected_mtime_ms: expected,
                stale_message: "stale".to_string(),
            }),
            ..Default::default()
        };
        write_json_atomic(&path, "{\"ok\":true}", None, &options)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":true}\n");
    }

    #[tokio::test]
    async fn mtime_cas_expecting_missing_passes_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh.json");
        let options = WriteJsonOptions {
            mtime_cas: Some(MtimeCas {
                expected_mtime_ms: None,
                stale_message: "stale".to_string(),
            }),
            ..Default::default()
        };
        write_json_atomic(&path, "{}", None, &options).await.unwrap();
        assert!(path.exists());
    }

    #[test]
    fn sync_variant_writes_and_replaces_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "old").unwrap();
        write_json_atomic_sync(&path, "{\"v\":2}", Some(0o600), &WriteJsonOptions::default())
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":2}\n");
        assert!(list_tmp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn ensure_parent_dir_creates_missing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("codex-plugin").join("request-1-response.json");
        let options = WriteJsonOptions {
            trailing_newline: TrailingNewline::None,
            ensure_parent_dir: true,
            parent_dir_mode: Some(0o700),
            ..Default::default()
        };
        write_json_atomic(&path, "{}", Some(0o600), &options).await.unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn applies_file_mode_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.json");
        write_json_atomic(&path, "{}", Some(0o600), &WriteJsonOptions::default())
            .await
            .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn mode_is_applied_at_open_not_via_a_post_write_chmod() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();

        // Fresh file: created with the mode at open(2) — it can never exist
        // with bits outside 0600 (the pre-fix write-then-chmod pattern left a
        // 0644 window and 0644 crash residue).
        let fresh = dir.path().join("fresh-secret.json");
        write_text_file_with_mode_sync(&fresh, "{}", Some(0o600)).unwrap();
        let mode = fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & !0o600, 0, "no bits outside 0600: {mode:o}");

        // Pre-existing file: Node's fs.writeFile only uses `mode` when O_CREAT
        // actually creates the file, so existing permissions are preserved —
        // proving there is no chmod-after-write in the implementation.
        let existing = dir.path().join("existing.json");
        fs::write(&existing, "old").unwrap();
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o644)).unwrap();
        write_text_file_with_mode_sync(&existing, "new", Some(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&existing).unwrap(), "new");
        let mode = fs::metadata(&existing).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "pre-existing perms preserved (Node parity)");
    }

    #[test]
    fn file_mtime_ms_returns_none_for_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(file_mtime_ms(&dir.path().join("nope.json")).unwrap(), None);
        let path = dir.path().join("yes.json");
        fs::write(&path, "x").unwrap();
        assert!(file_mtime_ms(&path).unwrap().is_some());
    }
}
