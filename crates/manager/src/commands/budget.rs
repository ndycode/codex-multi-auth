//! Port of `lib/codex-manager/commands/budget.ts`.
//!
//! `budget limit|check|list` — local budget guard limits over the usage
//! ledger. `budget check` exit code equals the evaluation result in BOTH
//! output modes (spec 08 gotcha 14).

use cma_core::json_io::stringify_pretty2;
use cma_quota::budget_guard::{
    BudgetGuardStore, BudgetLimit, BudgetLimitInput, BudgetWindow, evaluate_budget_guard,
    get_budget_window_start, load_budget_guard_store, normalize_budget_key,
    save_budget_guard_store, upsert_budget_limit,
};
use cma_usage::ledger::summarize_usage_ledger;
use cma_usage::types::{UsageSummaryGroupBy, UsageSummaryQuery};
use serde_json::json;

use crate::dispatcher::{CliOut, js_number_string, js_parse_float};

fn print_budget_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth budget limit <key> --window <hour|day|week|month> [--requests N] [--tokens N] [--cost USD]",
            "  codex-multi-auth budget check <key> [--json]",
            "  codex-multi-auth budget list [--json]",
        ]
        .join("\n"),
    );
}

/// TS `parsePositiveNumber` — `parseFloat`, finite, `> 0`.
fn parse_positive_number(value: Option<&str>) -> Option<f64> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    let parsed = js_parse_float(value);
    if parsed.is_finite() && parsed > 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn format_cap(value: Option<f64>) -> String {
    match value {
        Some(v) => js_number_string(v),
        None => "none".to_string(),
    }
}

/// TS `runBudgetCommand(args, deps)`.
///
/// Deviation note: store-save / ledger-read IO failures (which would crash
/// the TS process) print the error on stderr and exit 1.
pub async fn run_budget_command(args: &[String], out: &mut CliOut) -> i32 {
    let command = args.first().map(String::as_str);
    let rest: Vec<String> = if args.len() > 1 {
        args[1..].to_vec()
    } else {
        Vec::new()
    };
    let Some(command) = command else {
        print_budget_usage(out);
        return 0;
    };
    if command == "--help" || command == "-h" {
        print_budget_usage(out);
        return 0;
    }
    let mut store: BudgetGuardStore = load_budget_guard_store().await;
    let now = cma_core::utils::now_ms();

    if command == "list" {
        let json = rest.iter().any(|arg| arg == "--json" || arg == "-j");
        let mut limits: Vec<&BudgetLimit> = store.iter().map(|(_, limit)| limit).collect();
        limits.sort_by(|a, b| a.key.cmp(&b.key));
        if json {
            out.info(stringify_pretty2(&json!({
                "command": "budget list",
                "limits": limits,
            })));
            return 0;
        }
        if limits.is_empty() {
            out.info("No budget limits configured.");
            return 0;
        }
        for limit in limits {
            out.info(format!(
                "{}: window={}, requests={}, tokens={}, cost={}",
                limit.key,
                limit.window.as_str(),
                format_cap(limit.max_requests),
                format_cap(limit.max_tokens),
                format_cap(limit.max_cost_usd),
            ));
        }
        return 0;
    }

    let key = normalize_budget_key(rest.first().map(String::as_str).unwrap_or(""));
    let Some(key) = key else {
        out.error("Budget key is required.");
        return 1;
    };

    if command == "limit" {
        let mut window: Option<BudgetWindow> = None;
        let mut max_requests: Option<f64> = None;
        let mut max_tokens: Option<f64> = None;
        let mut max_cost_usd: Option<f64> = None;
        let mut i = 1usize;
        while i < rest.len() {
            let arg = rest[i].as_str();
            let value = rest.get(i + 1).map(String::as_str);
            if arg == "--window" {
                let parsed = value.and_then(BudgetWindow::parse);
                let Some(parsed) = parsed else {
                    out.error("--window must be hour, day, week, or month.");
                    return 1;
                };
                window = Some(parsed);
                i += 2;
                continue;
            }
            if arg == "--requests" || arg == "--tokens" || arg == "--cost" {
                let Some(parsed) = parse_positive_number(value) else {
                    out.error(format!("{arg} requires a positive number."));
                    return 1;
                };
                match arg {
                    "--requests" => max_requests = Some(parsed),
                    "--tokens" => max_tokens = Some(parsed),
                    _ => max_cost_usd = Some(parsed),
                }
                i += 2;
                continue;
            }
            out.error(format!("Unknown budget limit option: {arg}"));
            return 1;
        }
        let Some(window) = window else {
            out.error("--window is required.");
            return 1;
        };
        if max_requests.is_none() && max_tokens.is_none() && max_cost_usd.is_none() {
            out.error("At least one of --requests, --tokens, or --cost is required.");
            return 1;
        }
        let limit = match upsert_budget_limit(
            &mut store,
            &BudgetLimitInput {
                key: key.clone(),
                window,
                max_requests,
                max_tokens,
                max_cost_usd,
            },
            now,
        ) {
            Ok(limit) => limit,
            Err(error) => {
                out.error(error.message().to_string());
                return 1;
            }
        };
        if let Err(error) = save_budget_guard_store(&store).await {
            out.error(error.to_string());
            return 1;
        }
        out.info(format!(
            "Saved budget limit {} ({}).",
            limit.key,
            limit.window.as_str()
        ));
        return 0;
    }

    if command == "check" {
        // rest[0] is the budget key; a missing or flag-like first token (e.g.
        // `budget check --json`) must not be consumed as the key name.
        let first = rest.first().map(String::as_str).unwrap_or("");
        if first.is_empty() || first.starts_with('-') {
            out.error("Missing budget key. Usage: codex-multi-auth budget check <key> [--json]");
            return 1;
        }
        let Some(limit) = store.get(&key).cloned() else {
            out.error(format!("Budget limit not found: {key}"));
            return 1;
        };
        let summary = match summarize_usage_ledger(&UsageSummaryQuery {
            since: Some(get_budget_window_start(limit.window, now) as f64),
            until: None,
            include_archives: false,
            by: Some(UsageSummaryGroupBy::Model),
        })
        .await
        {
            Ok(summary) => summary,
            Err(error) => {
                out.error(error.to_string());
                return 1;
            }
        };
        let evaluation = evaluate_budget_guard(&limit, &summary);
        if rest.iter().any(|arg| arg == "--json" || arg == "-j") {
            out.info(stringify_pretty2(&json!({
                "command": "budget check",
                "evaluation": evaluation,
            })));
            return if evaluation.allowed { 0 } else { 1 };
        }
        out.info(if evaluation.allowed {
            format!("Budget {key} allows usage.")
        } else {
            format!("Budget {key} blocked: {}", evaluation.reasons.join("; "))
        });
        return if evaluation.allowed { 0 } else { 1 };
    }

    out.error(format!("Unknown budget command: {command}"));
    print_budget_usage(out);
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    #[serial(env)]
    async fn no_command_prints_usage_and_exits_zero() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_budget_command(&[], &mut out).await;
        assert_eq!(code, 0);
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[tokio::test]
    #[serial(env)]
    async fn requires_a_budget_key() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["limit"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Budget key is required.");
    }

    #[tokio::test]
    #[serial(env)]
    async fn limit_flag_validation_matches_ts() {
        let _sandbox = EnvSandbox::new();

        let mut out = CliOut::capture();
        let code =
            run_budget_command(&args(&["limit", "team", "--window", "decade"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "--window must be hour, day, week, or month.");

        let mut out = CliOut::capture();
        let code = run_budget_command(
            &args(&["limit", "team", "--window", "day", "--requests", "0"]),
            &mut out,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "--requests requires a positive number.");

        let mut out = CliOut::capture();
        let code = run_budget_command(
            &args(&["limit", "team", "--window", "day", "--bogus"]),
            &mut out,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown budget limit option: --bogus");

        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["limit", "team", "--requests", "5"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "--window is required.");

        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["limit", "team", "--window", "day"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(
            out.error_text(),
            "At least one of --requests, --tokens, or --cost is required."
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn saves_lists_and_checks_a_limit() {
        let _sandbox = EnvSandbox::new();

        let mut out = CliOut::capture();
        let code = run_budget_command(
            &args(&["limit", "team", "--window", "day", "--requests", "5"]),
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Saved budget limit team (day).");

        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["list"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(
            out.info_text(),
            "team: window=day, requests=5, tokens=none, cost=none"
        );

        // No usage recorded → allowed, exit 0 in both modes.
        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["check", "team"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "Budget team allows usage.");

        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["check", "team", "--json"]), &mut out).await;
        assert_eq!(code, 0);
        let payload: serde_json::Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["command"], "budget check");
        assert_eq!(payload["evaluation"]["allowed"], true);
    }

    #[tokio::test]
    #[serial(env)]
    async fn check_guards_flag_like_and_missing_keys() {
        let _sandbox = EnvSandbox::new();

        // "--json" normalizes to a non-empty key, so the flag-like guard in
        // the check branch fires (spec 08 gotcha 14), not the key-required one.
        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["check", "--json"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(
            out.error_text(),
            "Missing budget key. Usage: codex-multi-auth budget check <key> [--json]"
        );

        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["check", "ghost"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Budget limit not found: ghost");
    }

    #[tokio::test]
    #[serial(env)]
    async fn unknown_command_prints_error_and_usage() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_budget_command(&args(&["explode", "team"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown budget command: explode");
        assert!(out.info_text().starts_with("Usage:"));
    }
}
