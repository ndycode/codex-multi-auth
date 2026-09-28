//! Port of `lib/codex-manager/commands/usage.ts`.
//!
//! Behavior source: spec 08 §4.20 (+ gotcha 15): `--json` includes raw rows
//! (read + summarize rows); text/CSV summarize the ledger directly.
//! `--json`+`--csv` conflict. CSV with zero buckets emits one row from
//! totals. The `--out` confirmation line prints only in text mode.

use std::path::{Path, PathBuf};

use cma_core::json_io::stringify_compact;
use cma_core::utils::now_ms;
use cma_usage::ledger::{
    read_usage_ledger_rows, rotate_usage_ledger, summarize_usage_ledger, summarize_usage_rows,
    RotateUsageLedgerOptions,
};
use cma_usage::types::{
    UsageLedgerQuery, UsageLedgerRow, UsageSummary, UsageSummaryBucket, UsageSummaryGroupBy,
    UsageSummaryQuery,
};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{default_write_file, BoxFuture};

#[derive(Clone, Debug, PartialEq)]
struct UsageCliOptions {
    since: Option<f64>,
    by: UsageSummaryGroupBy,
    json: bool,
    csv: bool,
    out_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct UsageRotateOptions {
    json: bool,
    if_larger_than_bytes: Option<u64>,
}

enum Parsed<T> {
    Ok(T),
    Err(String),
}

/// TS `UsageCommandDeps` (log sinks live on [`CliOut`]).
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct UsageCommandDeps {
    pub summarize_usage:
        Box<dyn Fn(UsageSummaryQuery) -> BoxFuture<std::io::Result<UsageSummary>> + Send + Sync>,
    pub read_rows:
        Box<dyn Fn(UsageLedgerQuery) -> BoxFuture<std::io::Result<Vec<UsageLedgerRow>>> + Send + Sync>,
    pub summarize_rows:
        Box<dyn Fn(&[UsageLedgerRow], &UsageSummaryQuery) -> UsageSummary + Send + Sync>,
    pub rotate_ledger:
        Box<dyn Fn(RotateUsageLedgerOptions) -> BoxFuture<std::io::Result<Option<PathBuf>>> + Send + Sync>,
    pub get_cwd: Box<dyn Fn() -> PathBuf + Send + Sync>,
    pub write_file:
        Box<dyn Fn(PathBuf, String) -> BoxFuture<std::io::Result<()>> + Send + Sync>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
}

impl Default for UsageCommandDeps {
    fn default() -> Self {
        UsageCommandDeps {
            summarize_usage: Box::new(|query| {
                Box::pin(async move { summarize_usage_ledger(&query).await })
            }),
            read_rows: Box::new(|query| {
                Box::pin(async move { read_usage_ledger_rows(&query).await })
            }),
            summarize_rows: Box::new(summarize_usage_rows),
            rotate_ledger: Box::new(|options| {
                Box::pin(async move { rotate_usage_ledger(&options).await })
            }),
            get_cwd: Box::new(|| std::env::current_dir().unwrap_or_default()),
            write_file: Box::new(|path, contents| {
                Box::pin(async move { default_write_file(&path, &contents).await })
            }),
            get_now: None,
        }
    }
}

fn parse_positive_integer(raw_value: &str) -> Option<u64> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let parsed: u64 = trimmed.parse().ok()?;
    // JS Number.isSafeInteger + parsed > 0.
    if parsed == 0 || parsed > 9_007_199_254_740_991 {
        return None;
    }
    Some(parsed)
}

/// TS `parseSinceValue(value)` — relative durations (`24h`, `7d`, `2w`,
/// `30m`), all-digit epoch ms, else an ISO date string. The TS ledger runs
/// strings through `Date.parse`; the Rust ledger query is epoch-ms only, so
/// the date-string subset (`YYYY-MM-DD` and RFC3339-style timestamps) is
/// parsed here. Unparseable strings behave like `Date.parse` returning NaN:
/// no `since` filter is applied.
fn parse_since_value(value: &str, now: i64) -> Option<f64> {
    let trimmed = value.trim();
    if let Some(ms) = parse_relative_duration(trimmed, now) {
        return Some(ms);
    }
    if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return trimmed.parse::<f64>().ok();
    }
    parse_date_string_ms(trimmed)
}

fn parse_relative_duration(trimmed: &str, now: i64) -> Option<f64> {
    if trimmed.len() < 2 {
        return None;
    }
    let (digits, unit) = trimmed.split_at(trimmed.len() - 1);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let amount: f64 = digits.parse().ok()?;
    let multiplier = match unit.chars().next()?.to_ascii_lowercase() {
        'm' => 60_000.0,
        'h' => 3_600_000.0,
        'd' => 86_400_000.0,
        'w' => 604_800_000.0,
        _ => return None,
    };
    Some(now as f64 - amount * multiplier)
}

/// Howard Hinnant's days-from-civil (same algorithm the usage ledger uses
/// for day bucketing) — parse `YYYY-MM-DD[THH:MM[:SS[.sss]]][Z]` as UTC.
fn parse_date_string_ms(value: &str) -> Option<f64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0i64, 0i64, 0i64, 0i64);
    if bytes.len() > 10 {
        if bytes[10] != b'T' && bytes[10] != b' ' {
            return None;
        }
        let time = value.get(11..)?.trim_end_matches('Z');
        let mut parts = time.splitn(3, ':');
        hour = parts.next()?.parse().ok()?;
        minute = parts.next().unwrap_or("0").parse().ok()?;
        if let Some(rest) = parts.next() {
            let mut sec_parts = rest.splitn(2, '.');
            second = sec_parts.next()?.parse().ok()?;
            if let Some(frac) = sec_parts.next() {
                let frac3: String = frac.chars().take(3).collect();
                millis = format!("{frac3:0<3}").parse().ok()?;
            }
        }
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis) as f64)
}

fn print_usage_command_help(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth usage [--since <time|duration>] [--by <model|account|project|outcome|day>] [--json|--csv] [--out <path>]",
            "  codex-multi-auth usage rotate [--if-larger-than-bytes <bytes>] [--json]",
            "",
            "Options:",
            "  --since            Filter rows by timestamp, ISO date, or relative duration like 24h, 7d, 2w",
            "  --by               Group summary output (default: model)",
            "  --json, -j         Print machine-readable JSON output",
            "  --csv              Print or write CSV bucket output",
            "  --out              Write output to a file path",
            "",
            "Notes:",
            "  - Usage rows contain local metadata only, not prompts, tokens, auth headers, raw emails, or raw account ids.",
        ]
        .join("\n"),
    );
}

fn parse_usage_args(args: &[String], now: i64) -> Parsed<UsageCliOptions> {
    let mut options = UsageCliOptions {
        since: None,
        by: UsageSummaryGroupBy::Model,
        json: false,
        csv: false,
        out_path: None,
    };

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        if arg == "--json" || arg == "-j" {
            options.json = true;
            i += 1;
            continue;
        }
        if arg == "--csv" {
            options.csv = true;
            i += 1;
            continue;
        }
        if arg == "--since" {
            let Some(value) = args.get(i + 1) else {
                return Parsed::Err("Missing value for --since".to_string());
            };
            options.since = parse_since_value(value, now);
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--since=") {
            let value = value.trim();
            if value.is_empty() {
                return Parsed::Err("Missing value for --since".to_string());
            }
            options.since = parse_since_value(value, now);
            i += 1;
            continue;
        }
        if arg == "--by" {
            let Some(value) = args.get(i + 1) else {
                return Parsed::Err("Missing value for --by".to_string());
            };
            let Some(by) = UsageSummaryGroupBy::parse(value) else {
                return Parsed::Err(format!("Unknown --by value: {value}"));
            };
            options.by = by;
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--by=") {
            let value = value.trim();
            let Some(by) = UsageSummaryGroupBy::parse(value) else {
                return Parsed::Err(format!("Unknown --by value: {value}"));
            };
            options.by = by;
            i += 1;
            continue;
        }
        if arg == "--out" {
            let Some(value) = args.get(i + 1) else {
                return Parsed::Err("Missing value for --out".to_string());
            };
            options.out_path = Some(value.clone());
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--out=") {
            let value = value.trim();
            if value.is_empty() {
                return Parsed::Err("Missing value for --out".to_string());
            }
            options.out_path = Some(value.to_string());
            i += 1;
            continue;
        }
        return Parsed::Err(format!("Unknown usage option: {arg}"));
    }

    if options.json && options.csv {
        return Parsed::Err("Cannot combine --json and --csv".to_string());
    }
    Parsed::Ok(options)
}

fn parse_rotate_args(args: &[String]) -> Parsed<UsageRotateOptions> {
    let mut options = UsageRotateOptions {
        json: false,
        if_larger_than_bytes: None,
    };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        if arg == "--json" || arg == "-j" {
            options.json = true;
            i += 1;
            continue;
        }
        if arg == "--if-larger-than-bytes" {
            let Some(value) = args.get(i + 1) else {
                return Parsed::Err("Missing value for --if-larger-than-bytes".to_string());
            };
            let Some(parsed) = parse_positive_integer(value) else {
                return Parsed::Err(
                    "--if-larger-than-bytes must be a positive integer".to_string(),
                );
            };
            options.if_larger_than_bytes = Some(parsed);
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--if-larger-than-bytes=") {
            let Some(parsed) = parse_positive_integer(value) else {
                return Parsed::Err(
                    "--if-larger-than-bytes must be a positive integer".to_string(),
                );
            };
            options.if_larger_than_bytes = Some(parsed);
            i += 1;
            continue;
        }
        return Parsed::Err(format!("Unknown usage rotate option: {arg}"));
    }
    Parsed::Ok(options)
}

fn format_currency(value: f64) -> String {
    format!("${value:.6}")
}

fn format_text_summary(summary: &UsageSummary) -> String {
    let mut lines = vec![
        format!("Usage summary by {}", summary.by.as_str()),
        format!(
            "Requests: {} ({} success, {} failed, {} blocked, {} cancelled)",
            summary.totals.requests,
            summary.totals.successes,
            summary.totals.failures,
            summary.totals.blocked,
            summary.totals.cancelled
        ),
        format!(
            "Tokens: {} total ({} input, {} output, {} cached, {} reasoning)",
            summary.totals.total_tokens,
            summary.totals.input_tokens,
            summary.totals.output_tokens,
            summary.totals.cached_input_tokens,
            summary.totals.reasoning_tokens
        ),
        format!("Estimated cost: {}", format_currency(summary.totals.cost_usd)),
    ];
    if summary.buckets.is_empty() {
        lines.push("No usage rows found.".to_string());
        return lines.join("\n");
    }
    lines.push(String::new());
    for bucket in &summary.buckets {
        lines.push(format!(
            "{}: {} request(s), {} token(s), {}",
            bucket.key,
            bucket.requests,
            bucket.total_tokens,
            format_currency(bucket.cost_usd)
        ));
    }
    lines.join("\n")
}

fn csv_escape(text: &str) -> String {
    if text.contains('"') || text.contains(',') || text.contains('\r') || text.contains('\n') {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

fn bucket_to_csv_row(bucket: &UsageSummaryBucket) -> String {
    [
        bucket.key.clone(),
        bucket.requests.to_string(),
        bucket.successes.to_string(),
        bucket.failures.to_string(),
        bucket.blocked.to_string(),
        bucket.cancelled.to_string(),
        bucket.input_tokens.to_string(),
        bucket.output_tokens.to_string(),
        bucket.cached_input_tokens.to_string(),
        bucket.reasoning_tokens.to_string(),
        bucket.total_tokens.to_string(),
        format!("{:.8}", bucket.cost_usd),
    ]
    .iter()
    .map(|value| csv_escape(value))
    .collect::<Vec<_>>()
    .join(",")
}

fn format_csv_summary(summary: &UsageSummary) -> String {
    let mut lines = vec![
        "key,requests,successes,failures,blocked,cancelled,inputTokens,outputTokens,cachedInputTokens,reasoningTokens,totalTokens,costUsd"
            .to_string(),
    ];
    lines.extend(summary.buckets.iter().map(bucket_to_csv_row));
    if summary.buckets.is_empty() {
        lines.push(bucket_to_csv_row(&summary.totals));
    }
    lines.join("\n")
}

fn rows_to_json_payload(summary: &UsageSummary, rows: &[UsageLedgerRow]) -> String {
    let mut payload = Map::new();
    payload.insert("command".into(), Value::from("usage"));
    payload.insert(
        "summary".into(),
        serde_json::to_value(summary).unwrap_or(Value::Null),
    );
    payload.insert(
        "rows".into(),
        serde_json::to_value(rows).unwrap_or(Value::Array(Vec::new())),
    );
    cma_core::json_io::stringify_pretty2(&Value::Object(payload))
}

/// Production entry.
pub async fn run_usage_command(args: &[String], out: &mut CliOut) -> i32 {
    run_usage_command_with(args, &UsageCommandDeps::default(), out).await
}

/// TS `runUsageCommand(args, deps)`.
pub async fn run_usage_command_with(
    args: &[String],
    deps: &UsageCommandDeps,
    out: &mut CliOut,
) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_usage_command_help(out);
        return 0;
    }

    if args.first().map(String::as_str) == Some("rotate") {
        let parsed = match parse_rotate_args(&args[1..]) {
            Parsed::Ok(options) => options,
            Parsed::Err(message) => {
                out.error(message);
                return 1;
            }
        };
        let rotated_path = match (deps.rotate_ledger)(RotateUsageLedgerOptions {
            if_larger_than_bytes: parsed.if_larger_than_bytes,
            ..Default::default()
        })
        .await
        {
            Ok(path) => path,
            Err(error) => {
                out.error(format!("Failed to rotate usage ledger: {error}"));
                return 1;
            }
        };
        if parsed.json {
            let mut payload = Map::new();
            payload.insert("command".into(), Value::from("usage rotate"));
            payload.insert("rotated".into(), Value::from(rotated_path.is_some()));
            payload.insert(
                "path".into(),
                rotated_path
                    .as_ref()
                    .map(|path| Value::from(path.to_string_lossy().into_owned()))
                    .unwrap_or(Value::Null),
            );
            out.info(stringify_compact(&Value::Object(payload)));
        } else {
            out.info(match &rotated_path {
                Some(path) => format!("Usage ledger rotated: {}", path.display()),
                None => "Usage ledger rotation skipped.".to_string(),
            });
        }
        return 0;
    }

    let now = deps.get_now.as_ref().map(|f| f()).unwrap_or_else(now_ms);
    let options = match parse_usage_args(args, now) {
        Parsed::Ok(options) => options,
        Parsed::Err(message) => {
            out.error(message);
            print_usage_command_help(out);
            return 1;
        }
    };
    let summary_query = UsageSummaryQuery {
        since: options.since,
        until: None,
        include_archives: false,
        by: Some(options.by),
    };
    let mut rows: Vec<UsageLedgerRow> = Vec::new();
    let summary = if options.json {
        let read = (deps.read_rows)(summary_query.ledger_query()).await;
        match read {
            Ok(read_rows) => {
                rows = read_rows;
                (deps.summarize_rows)(&rows, &summary_query)
            }
            Err(error) => {
                out.error(format!("Failed to read usage ledger: {error}"));
                return 1;
            }
        }
    } else {
        match (deps.summarize_usage)(summary_query).await {
            Ok(summary) => summary,
            Err(error) => {
                out.error(format!("Failed to read usage ledger: {error}"));
                return 1;
            }
        }
    };
    let rendered = if options.json {
        rows_to_json_payload(&summary, &rows)
    } else if options.csv {
        format_csv_summary(&summary)
    } else {
        format_text_summary(&summary)
    };

    if let Some(out_path) = &options.out_path {
        let output_path = resolve_from_cwd(&(deps.get_cwd)(), out_path);
        if let Err(error) = (deps.write_file)(output_path.clone(), format!("{rendered}\n")).await {
            out.error(format!("Failed to write usage report: {error}"));
            return 1;
        }
        if !options.json && !options.csv {
            out.info(format!("Usage report written: {}", output_path.display()));
        }
        return 0;
    }

    out.info(rendered);
    0
}

/// Node `path.resolve(cwd, value)`.
pub(crate) fn resolve_from_cwd(cwd: &Path, value: &str) -> PathBuf {
    let candidate = Path::new(value);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        cwd.join(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn empty_bucket(key: &str) -> UsageSummaryBucket {
        UsageSummaryBucket {
            key: key.to_string(),
            requests: 0,
            successes: 0,
            failures: 0,
            blocked: 0,
            cancelled: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_input_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
            cost_usd: 0.0,
        }
    }

    fn summary_with(buckets: Vec<UsageSummaryBucket>) -> UsageSummary {
        let mut totals = empty_bucket("total");
        totals.requests = 3;
        totals.successes = 2;
        totals.failures = 1;
        totals.input_tokens = 100;
        totals.output_tokens = 50;
        totals.total_tokens = 150;
        totals.cost_usd = 0.5;
        UsageSummary {
            since: None,
            until: None,
            by: UsageSummaryGroupBy::Model,
            totals,
            buckets,
        }
    }

    struct Harness {
        deps: UsageCommandDeps,
        written: Arc<Mutex<Option<(PathBuf, String)>>>,
    }

    fn harness(summary: UsageSummary, rotate_result: Option<PathBuf>) -> Harness {
        let written: Arc<Mutex<Option<(PathBuf, String)>>> = Arc::new(Mutex::new(None));
        let written_clone = Arc::clone(&written);
        let summary_for_rows = summary.clone();
        let deps = UsageCommandDeps {
            summarize_usage: Box::new(move |query| {
                let mut summary = summary.clone();
                summary.by = query.by.unwrap_or_default();
                summary.since = query.since;
                Box::pin(async move { Ok(summary) })
            }),
            read_rows: Box::new(|_query| Box::pin(async { Ok(Vec::new()) })),
            summarize_rows: Box::new(move |_rows, query| {
                let mut summary = summary_for_rows.clone();
                summary.by = query.by.unwrap_or_default();
                summary
            }),
            rotate_ledger: Box::new(move |_options| {
                let rotate_result = rotate_result.clone();
                Box::pin(async move { Ok(rotate_result) })
            }),
            get_cwd: Box::new(|| PathBuf::from("/work")),
            write_file: Box::new(move |path, contents| {
                let written = Arc::clone(&written_clone);
                Box::pin(async move {
                    *written.lock().unwrap() = Some((path, contents));
                    Ok(())
                })
            }),
            get_now: Some(Box::new(|| 1_000_000)),
        };
        Harness { deps, written }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn since_parsing_relative_epoch_and_iso() {
        assert_eq!(parse_since_value("24h", 100_000_000), Some(100_000_000.0 - 86_400_000.0));
        assert_eq!(parse_since_value("30m", 10_000_000), Some(10_000_000.0 - 1_800_000.0));
        assert_eq!(parse_since_value("2w", 2_000_000_000), Some(2_000_000_000.0 - 1_209_600_000.0));
        assert_eq!(parse_since_value("12345", 0), Some(12345.0));
        // 1970-01-02 UTC midnight.
        assert_eq!(parse_since_value("1970-01-02", 0), Some(86_400_000.0));
        // Unparseable → no filter (Date.parse NaN).
        assert_eq!(parse_since_value("not-a-date", 0), None);
    }

    #[tokio::test]
    async fn json_and_csv_conflict() {
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_usage_command_with(&args(&["--json", "--csv"]), &h.deps, &mut out).await,
            1
        );
        assert!(out.error_text().starts_with("Cannot combine --json and --csv"));
    }

    #[tokio::test]
    async fn unknown_by_value_rejected() {
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_usage_command_with(&args(&["--by", "bogus"]), &h.deps, &mut out).await,
            1
        );
        assert!(out.error_text().starts_with("Unknown --by value: bogus"));
    }

    #[tokio::test]
    async fn text_summary_shape() {
        let mut bucket = empty_bucket("gpt-5.5");
        bucket.requests = 2;
        bucket.total_tokens = 120;
        bucket.cost_usd = 0.25;
        let h = harness(summary_with(vec![bucket]), None);
        let mut out = CliOut::capture();
        assert_eq!(run_usage_command_with(&[], &h.deps, &mut out).await, 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "Usage summary by model");
        assert_eq!(lines[1], "Requests: 3 (2 success, 1 failed, 0 blocked, 0 cancelled)");
        assert_eq!(lines[2], "Tokens: 150 total (100 input, 50 output, 0 cached, 0 reasoning)");
        assert_eq!(lines[3], "Estimated cost: $0.500000");
        assert_eq!(lines[4], "");
        assert_eq!(lines[5], "gpt-5.5: 2 request(s), 120 token(s), $0.250000");
    }

    #[tokio::test]
    async fn csv_zero_buckets_emits_totals_row() {
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(run_usage_command_with(&args(&["--csv"]), &h.deps, &mut out).await, 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(
            lines[0],
            "key,requests,successes,failures,blocked,cancelled,inputTokens,outputTokens,cachedInputTokens,reasoningTokens,totalTokens,costUsd"
        );
        assert_eq!(lines[1], "total,3,2,1,0,0,100,50,0,0,150,0.50000000");
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn csv_escapes_quotes_and_commas() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[tokio::test]
    async fn json_mode_includes_rows() {
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(run_usage_command_with(&args(&["--json"]), &h.deps, &mut out).await, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["command"], Value::from("usage"));
        assert!(payload["summary"].is_object());
        assert!(payload["rows"].is_array());
    }

    #[tokio::test]
    async fn out_writes_file_and_confirms_in_text_mode_only() {
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_usage_command_with(&args(&["--out", "report.txt"]), &h.deps, &mut out).await,
            0
        );
        let (path, contents) = h.written.lock().unwrap().clone().expect("written");
        assert!(contents.ends_with('\n'));
        assert!(path.ends_with("report.txt"));
        assert!(out.info_text().starts_with("Usage report written: "));

        // CSV mode: no confirmation line.
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_usage_command_with(&args(&["--csv", "--out", "report.csv"]), &h.deps, &mut out)
                .await,
            0
        );
        assert!(out.info_text().is_empty());
    }

    #[tokio::test]
    async fn rotate_json_is_compact() {
        let h = harness(summary_with(vec![]), Some(PathBuf::from("/ledger/usage-ledger.1.jsonl")));
        let mut out = CliOut::capture();
        assert_eq!(
            run_usage_command_with(&args(&["rotate", "--json"]), &h.deps, &mut out).await,
            0
        );
        let text = out.info_text();
        assert!(!text.contains('\n'));
        let payload: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(payload["command"], Value::from("usage rotate"));
        assert_eq!(payload["rotated"], Value::from(true));
    }

    #[tokio::test]
    async fn rotate_skipped_message() {
        let h = harness(summary_with(vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(run_usage_command_with(&args(&["rotate"]), &h.deps, &mut out).await, 0);
        assert_eq!(out.info_text(), "Usage ledger rotation skipped.");
    }

    #[tokio::test]
    async fn rotate_rejects_non_positive_threshold() {
        let h = harness(summary_with(vec![]), None);
        for bad in ["0", "abc", "1.5"] {
            let mut out = CliOut::capture();
            assert_eq!(
                run_usage_command_with(
                    &args(&["rotate", "--if-larger-than-bytes", bad]),
                    &h.deps,
                    &mut out
                )
                .await,
                1,
                "value {bad:?}"
            );
            assert_eq!(out.error_text(), "--if-larger-than-bytes must be a positive integer");
        }
    }
}
