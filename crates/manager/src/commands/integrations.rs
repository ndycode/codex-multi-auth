//! Port of `lib/codex-manager/commands/integrations.ts`.
//!
//! `integrations [--kind <name>] [--base-url <url>] [--model <model>]
//! [--json]` — prints copy/paste integration snippets for the local bridge.

use cma_core::json_io::stringify_pretty2;
use serde_json::json;

use crate::dispatcher::CliOut;
use crate::integration_generators::{
    IntegrationSnippetInput, IntegrationSnippetKind, generate_integration_snippets,
};

fn print_integrations_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth integrations [--kind <name>] [--base-url <url>] [--model <model>] [--json]",
            "",
            "Kinds: opencode, openclaw, python, curl, env",
        ]
        .join("\n"),
    );
}

/// TS `runIntegrationsCommand(args, deps)` (sync).
pub fn run_integrations_command(args: &[String], out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_integrations_usage(out);
        return 0;
    }
    let mut kinds: Vec<IntegrationSnippetKind> = Vec::new();
    let mut base_url: Option<String> = None;
    let mut model: Option<String> = None;
    let mut json = false;
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--json" || arg == "-j" {
            json = true;
            i += 1;
            continue;
        }
        if arg == "--kind" {
            let value = args.get(i + 1).and_then(|v| IntegrationSnippetKind::parse(v));
            let Some(kind) = value else {
                out.error("Missing or invalid value for --kind");
                return 1;
            };
            kinds.push(kind);
            i += 2;
            continue;
        }
        if arg == "--base-url" {
            let Some(value) = args.get(i + 1).filter(|v| !v.is_empty()) else {
                out.error("Missing value for --base-url");
                return 1;
            };
            base_url = Some(value.clone());
            i += 2;
            continue;
        }
        if arg == "--model" {
            let value = args.get(i + 1).map(|v| v.trim().to_string());
            match value {
                Some(v) if !v.is_empty() && !v.starts_with('-') => {
                    model = Some(v);
                    i += 2;
                    continue;
                }
                _ => {
                    out.error("Missing value for --model");
                    return 1;
                }
            }
        }
        out.error(format!("Unknown integrations option: {arg}"));
        return 1;
    }
    let snippets = generate_integration_snippets(
        if kinds.is_empty() {
            None
        } else {
            Some(kinds.as_slice())
        },
        &IntegrationSnippetInput {
            base_url,
            model,
            env_var: None,
        },
    );
    if json {
        out.info(stringify_pretty2(&json!({
            "command": "integrations",
            "snippets": snippets,
        })));
        return 0;
    }
    for snippet in &snippets {
        out.info(format!("# {}", snippet.title));
        out.info(snippet.body.clone());
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // Port of test/codex-manager-integrations-command.test.ts option errors.
    #[test]
    fn rejects_unknown_option() {
        let mut out = CliOut::capture();
        let code = run_integrations_command(&args(&["--bogus"]), &mut out);
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown integrations option: --bogus");
    }

    #[test]
    fn rejects_missing_or_invalid_kind() {
        let mut out = CliOut::capture();
        assert_eq!(run_integrations_command(&args(&["--kind"]), &mut out), 1);
        assert_eq!(out.error_text(), "Missing or invalid value for --kind");

        let mut out = CliOut::capture();
        assert_eq!(
            run_integrations_command(&args(&["--kind", "bogus"]), &mut out),
            1
        );
        assert_eq!(out.error_text(), "Missing or invalid value for --kind");
    }

    #[test]
    fn rejects_missing_base_url_and_model_values() {
        let mut out = CliOut::capture();
        assert_eq!(run_integrations_command(&args(&["--base-url"]), &mut out), 1);
        assert_eq!(out.error_text(), "Missing value for --base-url");

        let mut out = CliOut::capture();
        assert_eq!(
            run_integrations_command(&args(&["--model", "--json"]), &mut out),
            1
        );
        assert_eq!(out.error_text(), "Missing value for --model");
    }

    #[test]
    fn help_prints_usage_and_exits_zero() {
        let mut out = CliOut::capture();
        assert_eq!(run_integrations_command(&args(&["--help"]), &mut out), 0);
        assert!(out.info_text().contains("Kinds: opencode, openclaw, python, curl, env"));
    }
}
