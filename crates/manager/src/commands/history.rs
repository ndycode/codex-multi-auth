//! Port of `lib/codex-manager/commands/history.ts`.
//!
//! `history [list|show <id>] [--json]` — provider-agnostic local session
//! browser over `~/.codex/sessions` rollout files (issue #612: bypasses
//! `/resume` provider filtering). Read-only; no network; tolerant of
//! malformed JSONL lines and partially-written rollouts.

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use cma_core::json_io::stringify_pretty2;
use serde::Serialize;
use serde_json::{Value, json};

use crate::dispatcher::{CliOut, js_len_utf16, js_slice_utf16};

pub const DEFAULT_PREVIEW_MESSAGE_COUNT: usize = 3;
pub const MAX_THREAD_NAME_LENGTH: usize = 80;

/// TS `HistorySessionSummary` (list JSON key order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HistorySessionSummary {
    pub id: String,
    #[serde(rename = "threadName")]
    pub thread_name: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub provider: Option<String>,
    pub originator: Option<String>,
    pub cwd: Option<String>,
    pub path: String,
}

/// TS `HistorySessionDetail` (show JSON key order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HistorySessionDetail {
    pub id: String,
    #[serde(rename = "threadName")]
    pub thread_name: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub provider: Option<String>,
    pub originator: Option<String>,
    pub cwd: Option<String>,
    #[serde(rename = "cliVersion")]
    pub cli_version: Option<String>,
    pub messages: Vec<String>,
    pub path: String,
}

impl HistorySessionDetail {
    fn to_summary(&self) -> HistorySessionSummary {
        HistorySessionSummary {
            id: self.id.clone(),
            thread_name: self.thread_name.clone(),
            updated_at: self.updated_at.clone(),
            provider: self.provider.clone(),
            originator: self.originator.clone(),
            cwd: self.cwd.clone(),
            path: self.path.clone(),
        }
    }
}

/// `getCodexHome` seam.
pub type GetCodexHomeFn = Box<dyn Fn() -> String>;
/// `readDirRecursive` seam.
pub type ReadDirRecursiveFn = Box<dyn Fn(&str) -> Vec<String>>;
/// `readFile` / `statMtime` seams (mtime as an ISO-8601 string).
pub type ReadFileFn = Box<dyn Fn(&str) -> Result<String, String>>;

/// Injectable IO (the TS `HistoryCommandDeps`); `None` fields use the real
/// filesystem.
#[derive(Default)]
pub struct HistoryCommandDeps {
    pub get_codex_home: Option<GetCodexHomeFn>,
    pub read_dir_recursive: Option<ReadDirRecursiveFn>,
    pub read_file: Option<ReadFileFn>,
    /// Returns the file mtime as an ISO-8601 string.
    pub stat_mtime_iso: Option<ReadFileFn>,
}

/// TS `ROLLOUT_FILENAME_PATTERN` (case-insensitive), hand-rolled — returns
/// the captured session UUID (original casing) or `None`.
pub fn rollout_session_id(file_name: &str) -> Option<String> {
    // rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-<uuid 8-4-4-4-12>.jsonl
    const TOTAL_LEN: usize = 8 + 10 + 1 + 8 + 1 + 36 + 6;
    if file_name.len() != TOTAL_LEN || !file_name.is_ascii() {
        return None;
    }
    let bytes = file_name.as_bytes();
    let lower = file_name.to_ascii_lowercase();
    if !lower.starts_with("rollout-") {
        return None;
    }
    let digit = |i: usize| bytes[i].is_ascii_digit();
    let dash = |i: usize| bytes[i] == b'-';
    // date: positions 8..18 = dddd-dd-dd
    for i in 8..12 {
        if !digit(i) {
            return None;
        }
    }
    if !dash(12) || !digit(13) || !digit(14) || !dash(15) || !digit(16) || !digit(17) {
        return None;
    }
    // 'T' (case-insensitive) at 18; time dd-dd-dd at 19..27
    if lower.as_bytes()[18] != b't' {
        return None;
    }
    for (start, sep) in [(19usize, 21usize), (22, 24), (25, 27)] {
        if !digit(start) || !digit(start + 1) {
            return None;
        }
        if sep < 27 && !dash(sep) {
            return None;
        }
    }
    if !dash(27) {
        return None;
    }
    // uuid at 28..64: 8-4-4-4-12 lowercase-or-uppercase hex
    let uuid = &file_name[28..64];
    let uuid_lower = &lower[28..64];
    let groups = [8usize, 4, 4, 4, 12];
    let mut cursor = 0usize;
    for (group_index, group_len) in groups.iter().enumerate() {
        for _ in 0..*group_len {
            let b = uuid_lower.as_bytes()[cursor];
            if !b.is_ascii_hexdigit() || b.is_ascii_uppercase() {
                return None;
            }
            cursor += 1;
        }
        if group_index < groups.len() - 1 {
            if uuid_lower.as_bytes()[cursor] != b'-' {
                return None;
            }
            cursor += 1;
        }
    }
    if &lower[64..] != ".jsonl" {
        return None;
    }
    Some(uuid.to_string())
}

/// Separator-agnostic basename (rollout paths may carry Windows separators
/// even on POSIX).
fn base_name_of(file_path: &str) -> &str {
    file_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(file_path)
}

fn read_string_field(record: Option<&Value>, key: &str) -> Option<String> {
    let value = record?.get(key)?.as_str()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `parseRollout` — parse one rollout JSONL file into a session detail.
/// Returns `None` for unreadable files, non-rollout names, or files without
/// a `session_meta` record.
pub fn parse_rollout(
    rollout_path: &str,
    read_file: &dyn Fn(&str) -> Result<String, String>,
    stat_mtime_iso: &dyn Fn(&str) -> Result<String, String>,
    preview_limit: usize,
) -> Option<HistorySessionDetail> {
    let id_from_name = rollout_session_id(base_name_of(rollout_path))?;
    let content = read_file(rollout_path).ok()?;

    let mut id = id_from_name;
    let mut thread_name = String::new();
    let mut updated_at: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut originator: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut cli_version: Option<String> = None;
    let mut has_session_meta = false;
    let mut messages: Vec<String> = Vec::new();

    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() {
            continue;
        }
        // Tolerate malformed/partial lines; a single bad line must not drop
        // the whole session from the listing.
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
            updated_at = Some(timestamp.to_string());
        }

        let record_type = record.get("type").and_then(Value::as_str);
        let payload = record.get("payload");

        if record_type == Some("session_meta") {
            if let Some(meta_id) = read_string_field(payload, "id") {
                id = meta_id;
            }
            provider = read_string_field(payload, "model_provider").or(provider);
            originator = read_string_field(payload, "originator").or(originator);
            cwd = read_string_field(payload, "cwd").or(cwd);
            cli_version = read_string_field(payload, "cli_version").or(cli_version);
            has_session_meta = true;
        }

        if record_type == Some("event_msg") {
            let payload_type = read_string_field(payload, "type");
            if thread_name.is_empty()
                && payload_type.is_some()
                && let Some(message) = read_string_field(payload, "message")
            {
                thread_name = message;
            }
            if payload_type.as_deref() == Some("user_message")
                && messages.len() < preview_limit
                && let Some(message) = read_string_field(payload, "message")
            {
                messages.push(message);
            }
        }
    }

    if !has_session_meta {
        return None;
    }

    let updated_at = updated_at.unwrap_or_else(|| {
        stat_mtime_iso(rollout_path)
            .unwrap_or_else(|_| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
    });

    if thread_name.is_empty() {
        thread_name = "Codex session".to_string();
    }
    if js_len_utf16(&thread_name) > MAX_THREAD_NAME_LENGTH {
        thread_name = format!(
            "{}...",
            js_slice_utf16(&thread_name, MAX_THREAD_NAME_LENGTH - 3)
        );
    }

    Some(HistorySessionDetail {
        id,
        thread_name,
        updated_at,
        provider,
        originator,
        cwd,
        cli_version,
        messages,
        path: rollout_path.to_string(),
    })
}

fn default_read_dir_recursive(dir: &str) -> Vec<String> {
    let mut results: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return results;
    };
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let file_type = entry.file_type();
        if file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false) {
            results.extend(default_read_dir_recursive(&entry_path.to_string_lossy()));
            continue;
        }
        if file_type.map(|t| t.is_file()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if rollout_session_id(&name).is_some() {
                results.push(entry_path.to_string_lossy().into_owned());
            }
        }
    }
    results
}

struct ResolvedDeps<'a> {
    get_codex_home: &'a dyn Fn() -> String,
    read_dir_recursive: &'a dyn Fn(&str) -> Vec<String>,
    read_file: &'a dyn Fn(&str) -> Result<String, String>,
    stat_mtime_iso: &'a dyn Fn(&str) -> Result<String, String>,
}

fn sessions_dir(resolved: &ResolvedDeps<'_>) -> String {
    Path::new(&(resolved.get_codex_home)())
        .join("sessions")
        .to_string_lossy()
        .into_owned()
}

fn collect_sessions(resolved: &ResolvedDeps<'_>, preview_limit: usize) -> Vec<HistorySessionDetail> {
    let dir = sessions_dir(resolved);
    // A missing or unreadable sessions directory is a normal "no history
    // yet" state, not an error.
    let files = (resolved.read_dir_recursive)(&dir);
    let mut sessions: Vec<HistorySessionDetail> = files
        .iter()
        .filter_map(|file| {
            parse_rollout(file, resolved.read_file, resolved.stat_mtime_iso, preview_limit)
        })
        .collect();
    // Most-recent first, matching how /resume presents threads.
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

fn print_history_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage: codex-multi-auth history <list|show> [options]",
            "",
            "  list [--json]            List every local session across all providers",
            "  show <id> [--json]       Show provider metadata and first messages for a session",
            "",
            "Lists rollout files under <codex-home>/sessions (default",
            "~/.codex/sessions, honoring CODEX_HOME) directly, so sessions",
            "created under a different model provider (e.g. while runtime rotation",
            "or app bind is active) remain visible even when `codex resume` hides",
            "them. See docs/troubleshooting.md for background.",
        ]
        .join("\n"),
    );
}

fn run_history_list(args: &[String], resolved: &ResolvedDeps<'_>, out: &mut CliOut) -> i32 {
    let json = args.iter().any(|arg| arg == "--json" || arg == "-j");
    let sessions = collect_sessions(resolved, DEFAULT_PREVIEW_MESSAGE_COUNT);

    if json {
        out.info(stringify_pretty2(&json!({
            "count": sessions.len(),
            "sessions": sessions.iter().map(HistorySessionDetail::to_summary).collect::<Vec<_>>(),
        })));
        return 0;
    }

    if sessions.is_empty() {
        out.info(format!(
            "No local Codex sessions found under {}.",
            sessions_dir(resolved)
        ));
        return 0;
    }

    out.info(format!(
        "Local Codex sessions ({}) — all providers, bypassing /resume provider filtering:",
        sessions.len()
    ));
    out.info("");
    for session in &sessions {
        let provider = session.provider.as_deref().unwrap_or("unknown-provider");
        out.info(format!("  {}  [{}]", session.updated_at, provider));
        out.info(format!("    id:     {}", session.id));
        out.info(format!("    thread: {}", session.thread_name));
        if let Some(cwd) = &session.cwd {
            out.info(format!("    cwd:    {cwd}"));
        }
    }
    out.info("");
    out.info("Resume any session with: codex resume <id>  (or `codex resume` for the picker).");
    0
}

fn run_history_show(args: &[String], resolved: &ResolvedDeps<'_>, out: &mut CliOut) -> i32 {
    let json = args.iter().any(|arg| arg == "--json" || arg == "-j");
    let session_id = args.iter().find(|arg| !arg.starts_with('-'));
    let Some(session_id) = session_id else {
        out.error(
            "Missing session id. Usage: codex-multi-auth history show <session-id> [--json]",
        );
        return 1;
    };

    let sessions = collect_sessions(resolved, DEFAULT_PREVIEW_MESSAGE_COUNT);
    let Some(session) = sessions.iter().find(|session| &session.id == session_id) else {
        out.error(format!("Session not found: {session_id}"));
        return 1;
    };

    if json {
        out.info(stringify_pretty2(session));
        return 0;
    }

    out.info(format!("Session {}", session.id));
    out.info(format!(
        "  provider:   {}",
        session.provider.as_deref().unwrap_or("unknown")
    ));
    out.info(format!(
        "  originator: {}",
        session.originator.as_deref().unwrap_or("unknown")
    ));
    out.info(format!("  updated:    {}", session.updated_at));
    if let Some(cli_version) = &session.cli_version {
        out.info(format!("  cli:        {cli_version}"));
    }
    if let Some(cwd) = &session.cwd {
        out.info(format!("  cwd:        {cwd}"));
    }
    out.info(format!("  file:       {}", session.path));
    out.info("");
    if session.messages.is_empty() {
        out.info("  (no user messages recorded)");
    } else {
        out.info("  First messages:");
        for message in &session.messages {
            let first_line = message
                .split('\n')
                .next()
                .map(|line| line.strip_suffix('\r').unwrap_or(line))
                .unwrap_or("");
            let preview = if js_len_utf16(first_line) > 120 {
                format!("{}...", js_slice_utf16(first_line, 117))
            } else {
                first_line.to_string()
            };
            out.info(format!("    - {preview}"));
        }
    }
    out.info("");
    out.info(format!("Resume with: codex resume {}", session.id));
    0
}

/// Deps-injectable core (the TS `runHistoryCommand(args, deps)`).
pub fn run_history_command_with(
    args: &[String],
    deps: &HistoryCommandDeps,
    out: &mut CliOut,
) -> i32 {
    let default_home = || {
        cma_core::runtime_paths::get_codex_home_dir()
            .to_string_lossy()
            .into_owned()
    };
    let default_read_dir = |dir: &str| default_read_dir_recursive(dir);
    let default_read_file =
        |path: &str| std::fs::read_to_string(path).map_err(|error| error.to_string());
    let default_stat = |path: &str| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .map(|mtime| {
                chrono::DateTime::<Utc>::from(mtime).to_rfc3339_opts(SecondsFormat::Millis, true)
            })
            .map_err(|error| error.to_string())
    };
    let resolved = ResolvedDeps {
        get_codex_home: deps
            .get_codex_home
            .as_deref()
            .unwrap_or(&default_home),
        read_dir_recursive: deps
            .read_dir_recursive
            .as_deref()
            .unwrap_or(&default_read_dir),
        read_file: deps.read_file.as_deref().unwrap_or(&default_read_file),
        stat_mtime_iso: deps
            .stat_mtime_iso
            .as_deref()
            .unwrap_or(&default_stat),
    };

    let subcommand = args.first().map(String::as_str);
    let rest: Vec<String> = if args.len() > 1 {
        args[1..].to_vec()
    } else {
        Vec::new()
    };

    if subcommand == Some("--help") || subcommand == Some("-h") {
        print_history_usage(out);
        return 0;
    }

    // Default to `list` when no subcommand is given; a leading flag is
    // forwarded as a list argument (`history --json` works).
    match subcommand {
        None | Some("list") => run_history_list(&rest, &resolved, out),
        Some(sub) if sub.starts_with('-') => {
            let mut list_args = vec![sub.to_string()];
            list_args.extend(rest);
            run_history_list(&list_args, &resolved, out)
        }
        Some("show") => run_history_show(&rest, &resolved, out),
        Some(sub) => {
            out.error(format!("Unknown history command: {sub}"));
            print_history_usage(out);
            1
        }
    }
}

/// Production entry (real filesystem).
pub fn run_history_command(args: &[String], out: &mut CliOut) -> i32 {
    run_history_command_with(args, &HistoryCommandDeps::default(), out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const DIR: &str = "/home/user/.codex/sessions";

    fn meta_line(overrides: &[(&str, &str)], timestamp: &str) -> String {
        let mut payload = serde_json::json!({
            "id": "019e9836-5001-7821-a9c2-3ffd26a1199b",
            "timestamp": timestamp,
            "cwd": "C:\\work\\project",
            "originator": "Codex Desktop",
            "cli_version": "0.140.0",
            "model_provider": "openai",
        });
        for (key, value) in overrides {
            payload[*key] = serde_json::json!(value);
        }
        serde_json::json!({
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": payload,
        })
        .to_string()
    }

    fn user_message_line(message: &str) -> String {
        serde_json::json!({
            "timestamp": "2026-06-05T14:36:25.000Z",
            "type": "event_msg",
            "payload": { "type": "user_message", "message": message },
        })
        .to_string()
    }

    fn rollout_path(id: &str) -> String {
        format!("{DIR}/2026/06/05/rollout-2026-06-05T22-35-56-{id}.jsonl")
    }

    fn deps_for(files: &[(&str, String)]) -> HistoryCommandDeps {
        let by_path: HashMap<String, String> = files
            .iter()
            .map(|(id, content)| (rollout_path(id), content.clone()))
            .collect();
        let paths: Vec<String> = by_path.keys().cloned().collect();
        let read_map = by_path.clone();
        HistoryCommandDeps {
            get_codex_home: Some(Box::new(|| "/home/user/.codex".to_string())),
            read_dir_recursive: Some(Box::new(move |_dir| paths.clone())),
            read_file: Some(Box::new(move |path| {
                read_map
                    .get(path)
                    .cloned()
                    .ok_or_else(|| format!("ENOENT: {path}"))
            })),
            stat_mtime_iso: Some(Box::new(|_path| Ok("2026-01-01T00:00:00.000Z".to_string()))),
        }
    }

    // Port of test/codex-manager-history-command.test.ts.

    #[test]
    fn lists_sessions_from_every_provider() {
        let deps = deps_for(&[
            (
                "019e9836-5001-7821-a9c2-3ffd26a1199b",
                [
                    meta_line(
                        &[("id", "019e9836-5001-7821-a9c2-3ffd26a1199b"), ("model_provider", "openai")],
                        "2026-06-05T10:00:00.000Z",
                    ),
                    user_message_line("first openai task"),
                ]
                .join("\n"),
            ),
            (
                "0190abcd-1234-7821-a9c2-3ffd26a11000",
                [
                    meta_line(
                        &[
                            ("id", "0190abcd-1234-7821-a9c2-3ffd26a11000"),
                            ("model_provider", "codex-multi-auth-runtime-proxy"),
                        ],
                        "2026-06-05T12:00:00.000Z",
                    ),
                    user_message_line("a rotated session"),
                ]
                .join("\n"),
            ),
        ]);
        let mut out = CliOut::capture();
        let code = run_history_command_with(&["list".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        let output = out.info_text();
        assert!(output.contains("openai"));
        assert!(output.contains("codex-multi-auth-runtime-proxy"));
        assert!(output.contains("019e9836-5001-7821-a9c2-3ffd26a1199b"));
        assert!(output.contains("0190abcd-1234-7821-a9c2-3ffd26a11000"));
    }

    #[test]
    fn defaults_to_list_when_no_subcommand() {
        let deps = deps_for(&[(
            "019e9836-5001-7821-a9c2-3ffd26a1199b",
            meta_line(&[], "2026-06-05T14:36:20.000Z"),
        )]);
        let mut out = CliOut::capture();
        let code = run_history_command_with(&[], &deps, &mut out);
        assert_eq!(code, 0);
        assert!(out.info_text().contains("019e9836-5001-7821-a9c2-3ffd26a1199b"));
    }

    #[test]
    fn sorts_most_recent_first() {
        let deps = deps_for(&[
            (
                "00000000-0000-7821-a9c2-00000000aaaa",
                meta_line(
                    &[("id", "00000000-0000-7821-a9c2-00000000aaaa")],
                    "2026-06-01T00:00:00.000Z",
                ),
            ),
            (
                "11111111-1111-7821-a9c2-11111111bbbb",
                meta_line(
                    &[("id", "11111111-1111-7821-a9c2-11111111bbbb")],
                    "2026-06-10T00:00:00.000Z",
                ),
            ),
        ]);
        let mut out = CliOut::capture();
        let code =
            run_history_command_with(&["list".to_string(), "--json".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["count"], 2);
        assert_eq!(payload["sessions"][0]["id"], "11111111-1111-7821-a9c2-11111111bbbb");
        assert_eq!(payload["sessions"][1]["id"], "00000000-0000-7821-a9c2-00000000aaaa");
    }

    #[test]
    fn json_summaries_omit_detail_fields() {
        let deps = deps_for(&[(
            "019e9836-5001-7821-a9c2-3ffd26a1199b",
            meta_line(
                &[("model_provider", "codex-multi-auth-runtime-proxy")],
                "2026-06-05T14:36:20.000Z",
            ),
        )]);
        let mut out = CliOut::capture();
        let code =
            run_history_command_with(&["list".to_string(), "--json".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["count"], 1);
        assert_eq!(
            payload["sessions"][0]["provider"],
            "codex-multi-auth-runtime-proxy"
        );
        assert!(payload["sessions"][0].get("messages").is_none());
        assert!(payload["sessions"][0].get("cliVersion").is_none());
    }

    #[test]
    fn empty_listing_without_error_when_dir_missing() {
        let deps = HistoryCommandDeps {
            get_codex_home: Some(Box::new(|| "/home/user/.codex".to_string())),
            read_dir_recursive: Some(Box::new(|_dir| Vec::new())),
            read_file: Some(Box::new(|path| Err(format!("ENOENT: {path}")))),
            stat_mtime_iso: Some(Box::new(|_path| Ok("2026-01-01T00:00:00.000Z".to_string()))),
        };
        let mut out = CliOut::capture();
        let code = run_history_command_with(&["list".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        assert!(out.info_text().contains("No local Codex sessions found"));
    }

    #[test]
    fn treats_leading_flag_as_list_arg() {
        let deps = deps_for(&[(
            "019e9836-5001-7821-a9c2-3ffd26a1199b",
            meta_line(&[], "2026-06-05T14:36:20.000Z"),
        )]);
        let mut out = CliOut::capture();
        let code = run_history_command_with(&["--json".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["count"], 1);
    }

    #[test]
    fn malformed_lines_are_skipped_and_meta_required() {
        let deps = deps_for(&[
            (
                "019e9836-5001-7821-a9c2-3ffd26a1199b",
                [
                    "{not json".to_string(),
                    meta_line(&[], "2026-06-05T14:36:20.000Z"),
                    "".to_string(),
                    user_message_line("kept"),
                ]
                .join("\n"),
            ),
            (
                // No session_meta → skipped entirely.
                "0190abcd-1234-7821-a9c2-3ffd26a11000",
                user_message_line("orphan"),
            ),
        ]);
        let mut out = CliOut::capture();
        let code =
            run_history_command_with(&["list".to_string(), "--json".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["count"], 1);
    }

    #[test]
    fn show_prints_detail_and_errors() {
        let deps = deps_for(&[(
            "019e9836-5001-7821-a9c2-3ffd26a1199b",
            [
                meta_line(&[], "2026-06-05T14:36:20.000Z"),
                user_message_line("hello there"),
            ]
            .join("\n"),
        )]);

        let mut out = CliOut::capture();
        let code = run_history_command_with(&["show".to_string()], &deps, &mut out);
        assert_eq!(code, 1);
        assert_eq!(
            out.error_text(),
            "Missing session id. Usage: codex-multi-auth history show <session-id> [--json]"
        );

        let mut out = CliOut::capture();
        let code = run_history_command_with(
            &["show".to_string(), "missing-id".to_string()],
            &deps,
            &mut out,
        );
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Session not found: missing-id");

        let mut out = CliOut::capture();
        let code = run_history_command_with(
            &[
                "show".to_string(),
                "019e9836-5001-7821-a9c2-3ffd26a1199b".to_string(),
            ],
            &deps,
            &mut out,
        );
        assert_eq!(code, 0);
        let text = out.info_text();
        assert!(text.starts_with("Session 019e9836-5001-7821-a9c2-3ffd26a1199b"));
        assert!(text.contains("  provider:   openai"));
        assert!(text.contains("  originator: Codex Desktop"));
        assert!(text.contains("  cli:        0.140.0"));
        assert!(text.contains("    - hello there"));
        assert!(text.ends_with("Resume with: codex resume 019e9836-5001-7821-a9c2-3ffd26a1199b"));
    }

    #[test]
    fn unknown_subcommand_errors_with_usage() {
        let deps = deps_for(&[]);
        let mut out = CliOut::capture();
        let code = run_history_command_with(&["prune".to_string()], &deps, &mut out);
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown history command: prune");
        assert!(out.info_text().starts_with("Usage: codex-multi-auth history"));
    }

    #[test]
    fn rollout_filename_pattern_matches_ts_regex() {
        assert_eq!(
            rollout_session_id("rollout-2026-06-05T22-35-56-019e9836-5001-7821-a9c2-3ffd26a1199b.jsonl"),
            Some("019e9836-5001-7821-a9c2-3ffd26a1199b".to_string())
        );
        // Case-insensitive flag on the TS regex.
        assert_eq!(
            rollout_session_id("ROLLOUT-2026-06-05T22-35-56-019E9836-5001-7821-A9C2-3FFD26A1199B.JSONL"),
            Some("019E9836-5001-7821-A9C2-3FFD26A1199B".to_string())
        );
        assert_eq!(rollout_session_id("rollout-2026-06-05.jsonl"), None);
        assert_eq!(
            rollout_session_id("rollout-2026-06-05T22-35-56-not-a-uuid.jsonl"),
            None
        );
        assert_eq!(
            rollout_session_id("prefix-rollout-2026-06-05T22-35-56-019e9836-5001-7821-a9c2-3ffd26a1199b.jsonl"),
            None
        );
    }

    #[test]
    fn thread_name_truncates_at_80_utf16_units() {
        let long = "x".repeat(100);
        let deps = deps_for(&[(
            "019e9836-5001-7821-a9c2-3ffd26a1199b",
            [
                meta_line(&[], "2026-06-05T14:36:20.000Z"),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "agent_message", "message": long },
                })
                .to_string(),
            ]
            .join("\n"),
        )]);
        let mut out = CliOut::capture();
        let code =
            run_history_command_with(&["list".to_string(), "--json".to_string()], &deps, &mut out);
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).unwrap();
        let thread = payload["sessions"][0]["threadName"].as_str().unwrap();
        assert_eq!(thread.len(), 80);
        assert!(thread.ends_with("..."));
    }
}
