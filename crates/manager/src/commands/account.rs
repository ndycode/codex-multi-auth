//! Port of `lib/codex-manager/commands/account.ts`.
//!
//! `account tag|untag|weight|pause|unpause|drain|undrain|note|policy list` —
//! per-account policy management over the shared (non-project) pool.

use cma_accounts::account_policy::{
    AccountPolicyStore, get_account_policy_key, load_account_policy_store,
    normalize_account_policy_tag, save_account_policy_store, upsert_account_policy,
};
use cma_core::json_io::stringify_pretty2;
use cma_core::schemas::account_storage::AccountStorageV3;
use serde_json::{Map, Value, json};

use crate::dispatcher::{CliOut, js_number, js_number_string, js_parse_float, js_slice_utf16};

fn print_account_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth account tag <index> <tag>",
            "  codex-multi-auth account untag <index> <tag>",
            "  codex-multi-auth account weight <index> <0..10>",
            "  codex-multi-auth account pause|unpause|drain|undrain <index>",
            "  codex-multi-auth account note <index> <text>",
            "  codex-multi-auth account policy list [--json]",
        ]
        .join("\n"),
    );
}

/// TS `parseAccountIndex` — `/^\d+$/`, parseInt, safe integer `> 0`,
/// converted to 0-based (spec 08 gotcha 13: `"1.5"`/`"2abc"` rejected).
pub fn parse_account_index(value: Option<&str>) -> Option<usize> {
    let value = value?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed: i64 = value.parse().ok()?;
    if parsed > 9_007_199_254_740_991 || parsed <= 0 {
        return None;
    }
    Some((parsed - 1) as usize)
}

/// TS `policySummary(store, storage)` — one JSON object per stored account
/// (key order: index, label, accountKey, tags, weight, paused, drained,
/// note).
pub fn policy_summary(store: &AccountPolicyStore, storage: Option<&AccountStorageV3>) -> Vec<Value> {
    let accounts = storage.map(|s| s.accounts.as_slice()).unwrap_or(&[]);
    accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let account_key = get_account_policy_key(account, index);
            let policy = store.get(&account_key);
            let mut object = Map::new();
            object.insert("index".to_string(), Value::from(index as i64 + 1));
            object.insert(
                "label".to_string(),
                Value::String(format!("Account {}", index + 1)),
            );
            object.insert("accountKey".to_string(), Value::String(account_key));
            object.insert(
                "tags".to_string(),
                Value::Array(
                    policy
                        .map(|p| p.tags.iter().map(|t| Value::String(t.clone())).collect())
                        .unwrap_or_default(),
                ),
            );
            object.insert(
                "weight".to_string(),
                js_number(policy.map(|p| p.weight).unwrap_or(1.0)),
            );
            object.insert(
                "paused".to_string(),
                Value::Bool(policy.map(|p| p.paused).unwrap_or(false)),
            );
            object.insert(
                "drained".to_string(),
                Value::Bool(policy.map(|p| p.drained).unwrap_or(false)),
            );
            object.insert(
                "note".to_string(),
                policy
                    .and_then(|p| p.note.clone())
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            Value::Object(object)
        })
        .collect()
}

/// Text line for one `account policy list` entry:
/// `"{index}. {label} | weight=N[ | paused][ | drained][ | tags=a,b][ | note]"`.
pub fn policy_list_line(entry: &Value) -> String {
    let mut markers: Vec<String> = Vec::new();
    let weight = entry["weight"].as_f64().unwrap_or(1.0);
    markers.push(format!("weight={}", js_number_string(weight)));
    if entry["paused"].as_bool() == Some(true) {
        markers.push("paused".to_string());
    }
    if entry["drained"].as_bool() == Some(true) {
        markers.push("drained".to_string());
    }
    let tags: Vec<&str> = entry["tags"]
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !tags.is_empty() {
        markers.push(format!("tags={}", tags.join(",")));
    }
    if entry["note"].as_str().is_some_and(|note| !note.is_empty()) {
        markers.push("note".to_string());
    }
    format!(
        "{}. {} | {}",
        entry["index"],
        entry["label"].as_str().unwrap_or(""),
        markers.join(" | ")
    )
}

/// TS `runAccountCommand(args, deps)`.
///
/// Deviation note: policy-store save failures (which would crash the TS
/// process) print the error on stderr and exit 1.
pub async fn run_account_command(args: &[String], out: &mut CliOut) -> i32 {
    // JS falsiness: TS gates the help path on `!command`, so an EMPTY-STRING
    // first argv token (`account ""`, e.g. a scripted empty expansion) prints
    // usage and exits 0 exactly like a missing subcommand.
    let command = args
        .first()
        .map(String::as_str)
        .filter(|command| !command.is_empty());
    let rest: Vec<String> = if args.len() > 1 {
        args[1..].to_vec()
    } else {
        Vec::new()
    };
    let Some(command) = command else {
        print_account_usage(out);
        return 0;
    };
    if command == "--help" || command == "-h" {
        print_account_usage(out);
        return 0;
    }

    cma_storage::facade::set_storage_path(None);
    let storage: Option<AccountStorageV3> = cma_storage::load::load_accounts()
        .await
        .map(|loaded| loaded.storage);
    let mut store = load_account_policy_store().await;

    if command == "policy" {
        let subcommand = rest.first().map(String::as_str);
        let policy_args: Vec<String> = if rest.len() > 1 {
            rest[1..].to_vec()
        } else {
            Vec::new()
        };
        if subcommand != Some("list") {
            out.error(format!(
                "Unknown account policy command: {}",
                subcommand.unwrap_or("(missing)")
            ));
            return 1;
        }
        if let Some(unknown) = policy_args
            .iter()
            .find(|arg| arg.as_str() != "--json" && arg.as_str() != "-j")
        {
            out.error(format!("Unknown account policy list option: {unknown}"));
            return 1;
        }
        let accounts = policy_summary(&store, storage.as_ref());
        if policy_args
            .iter()
            .any(|arg| arg == "--json" || arg == "-j")
        {
            out.info(stringify_pretty2(&json!({
                "command": "account policy list",
                "accounts": accounts,
            })));
            return 0;
        }
        if accounts.is_empty() {
            out.info("No accounts configured.");
            return 0;
        }
        for entry in &accounts {
            out.info(policy_list_line(entry));
        }
        return 0;
    }

    let account_index = parse_account_index(rest.first().map(String::as_str));
    let resolved = match (&storage, account_index) {
        (Some(storage), Some(index)) if index < storage.accounts.len() => {
            Some((index, &storage.accounts[index]))
        }
        _ => None,
    };
    let Some((index, account)) = resolved else {
        out.error("Account index is required and must reference a configured account.");
        return 1;
    };
    let account_key = get_account_policy_key(account, index);
    let now = cma_core::utils::now_ms();

    if command == "tag" || command == "untag" {
        let tag = normalize_account_policy_tag(rest.get(1).map(String::as_str).unwrap_or(""));
        let Some(tag) = tag else {
            out.error(format!("{command} requires a tag value."));
            return 1;
        };
        let is_tag = command == "tag";
        let policy = upsert_account_policy(
            &mut store,
            &account_key,
            |next| {
                if is_tag && !next.tags.contains(&tag) {
                    next.tags.push(tag.clone());
                }
                if !is_tag {
                    next.tags.retain(|existing| existing != &tag);
                }
            },
            now,
        );
        if let Err(error) = save_account_policy_store(&store).await {
            out.error(error.to_string());
            return 1;
        }
        let joined = policy.tags.join(",");
        out.info(format!(
            "{} account {}: {}",
            if is_tag { "Tagged" } else { "Removed tag from" },
            index + 1,
            if joined.is_empty() { "none" } else { &joined }
        ));
        return 0;
    }

    if command == "weight" {
        let weight = match rest.get(1) {
            Some(value) => js_parse_float(value),
            None => f64::NAN,
        };
        if !weight.is_finite() || !(0.0..=10.0).contains(&weight) {
            out.error("weight requires a number from 0 to 10.");
            return 1;
        }
        upsert_account_policy(
            &mut store,
            &account_key,
            |next| {
                next.weight = weight;
            },
            now,
        );
        if let Err(error) = save_account_policy_store(&store).await {
            out.error(error.to_string());
            return 1;
        }
        out.info(format!(
            "Set account {} weight to {}.",
            index + 1,
            js_number_string(weight)
        ));
        return 0;
    }

    if matches!(command, "pause" | "unpause" | "drain" | "undrain") {
        upsert_account_policy(
            &mut store,
            &account_key,
            |next| match command {
                "pause" => next.paused = true,
                "unpause" => next.paused = false,
                "drain" => next.drained = true,
                _ => next.drained = false,
            },
            now,
        );
        if let Err(error) = save_account_policy_store(&store).await {
            out.error(error.to_string());
            return 1;
        }
        out.info(format!("Updated account {}: {command}.", index + 1));
        return 0;
    }

    if command == "note" {
        let note = if rest.len() > 1 {
            rest[1..].join(" ").trim().to_string()
        } else {
            String::new()
        };
        upsert_account_policy(
            &mut store,
            &account_key,
            |next| {
                next.note = if note.is_empty() {
                    None
                } else {
                    Some(js_slice_utf16(&note, 500))
                };
            },
            now,
        );
        if let Err(error) = save_account_policy_store(&store).await {
            out.error(error.to_string());
            return 1;
        }
        out.info(format!("Updated account {} note.", index + 1));
        return 0;
    }

    out.error(format!("Unknown account command: {command}"));
    print_account_usage(out);
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn account(email: &str) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(format!("rt-{email}"), 1, 0);
        account.email = Some(email.to_string());
        account
    }

    async fn seed_two_accounts() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("a@example.com"));
        storage.accounts.push(account("b@example.com"));
        cma_storage::facade::set_storage_path(None);
        cma_storage::save::save_accounts(&storage).await.unwrap();
    }

    // Port of test/codex-manager-account-command.test.ts index validation.
    #[test]
    fn parse_account_index_is_digit_only_and_one_based() {
        assert_eq!(parse_account_index(Some("1")), Some(0));
        assert_eq!(parse_account_index(Some("12")), Some(11));
        assert_eq!(parse_account_index(Some("0")), None);
        assert_eq!(parse_account_index(Some("1.5")), None);
        assert_eq!(parse_account_index(Some("2abc")), None);
        assert_eq!(parse_account_index(Some("-1")), None);
        assert_eq!(parse_account_index(Some("")), None);
        assert_eq!(parse_account_index(None), None);
        assert_eq!(parse_account_index(Some("9007199254740993")), None);
    }

    #[tokio::test]
    #[serial(env)]
    async fn no_command_prints_usage() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_account_command(&[], &mut out).await;
        assert_eq!(code, 0);
        assert!(out.info_text().starts_with("Usage:"));

        // JS falsiness parity: `account ""` (empty argv expansion) is the
        // help path too — usage on stdout, exit 0, never the index error.
        let mut out = CliOut::capture();
        let code = run_account_command(&args(&[""]), &mut out).await;
        assert_eq!(code, 0);
        assert!(out.info_text().starts_with("Usage:"));
        assert!(out.error_text().is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn policy_list_rejects_unknown_subcommand_and_option() {
        let _sandbox = EnvSandbox::new();

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["policy", "show"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown account policy command: show");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["policy"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown account policy command: (missing)");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["policy", "list", "--bogus"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown account policy list option: --bogus");
    }

    #[tokio::test]
    #[serial(env)]
    async fn policy_list_reports_no_accounts() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["policy", "list"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "No accounts configured.");
    }

    #[tokio::test]
    #[serial(env)]
    async fn invalid_index_error_is_exact() {
        let _sandbox = EnvSandbox::new();
        for bad in [&["tag", "abc", "x"][..], &["tag", "0", "x"], &["tag", "9", "x"]] {
            let mut out = CliOut::capture();
            let code = run_account_command(&args(bad), &mut out).await;
            assert_eq!(code, 1);
            assert_eq!(
                out.error_text(),
                "Account index is required and must reference a configured account."
            );
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn tag_untag_weight_pause_note_flow() {
        let _sandbox = EnvSandbox::new();
        seed_two_accounts().await;

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["tag", "1", "fast"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Tagged account 1: fast");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["untag", "1", "fast"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Removed tag from account 1: none");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["tag", "1"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "tag requires a tag value.");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["weight", "1", "2.5"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Set account 1 weight to 2.5.");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["weight", "1", "11"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "weight requires a number from 0 to 10.");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["pause", "2"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Updated account 2: pause.");

        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["note", "1", "hello", "world"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Updated account 1 note.");

        // policy list reflects the mutations (weight 2.5 kept as float,
        // account 2 paused).
        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["policy", "list", "--json"]), &mut out).await;
        assert_eq!(code, 0);
        let payload: serde_json::Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["command"], "account policy list");
        assert_eq!(payload["accounts"][0]["weight"], 2.5);
        assert_eq!(payload["accounts"][0]["note"], "hello world");
        assert_eq!(payload["accounts"][1]["paused"], true);
        assert_eq!(payload["accounts"][1]["weight"], 1);
    }

    #[tokio::test]
    #[serial(env)]
    async fn unknown_command_prints_error_and_usage() {
        let _sandbox = EnvSandbox::new();
        seed_two_accounts().await;
        let mut out = CliOut::capture();
        let code = run_account_command(&args(&["boost", "1"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown account command: boost");
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[test]
    fn policy_list_line_matches_ts_marker_order() {
        let entry = serde_json::json!({
            "index": 3,
            "label": "Account 3",
            "accountKey": "sha256:x",
            "tags": ["fast", "eu"],
            "weight": 2.0,
            "paused": true,
            "drained": false,
            "note": "hi",
        });
        assert_eq!(
            policy_list_line(&entry),
            "3. Account 3 | weight=2 | paused | tags=fast,eu | note"
        );
    }
}
