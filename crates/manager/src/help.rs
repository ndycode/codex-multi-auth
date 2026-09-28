//! Port of `lib/codex-manager/help.ts` — usage text + the `login`/`best`
//! flag parsers. All user-visible strings are copy-exact from the TS source
//! (clap never generates help/errors for this CLI — spec 08 / ARCHITECTURE
//! §6.15 clap policy).

use cma_core::model_family::DEFAULT_PROBE_MODEL;

use crate::dispatcher::CliOut;

/// TS `DEFAULT_LIVE_PROBE_MODEL = DEFAULT_PROBE_MODEL`.
pub const DEFAULT_LIVE_PROBE_MODEL: &str = DEFAULT_PROBE_MODEL;

/// The full `printUsage()` text (one string, joined with `\n`, exactly as the
/// TS single `console.log` call emits it).
pub fn usage_text() -> String {
    [
        "Codex Multi-Auth CLI",
        "",
        "Start here:",
        "  codex-multi-auth login [--device-auth|--manual|--no-browser] [--org <org_id>]",
        "  codex-multi-auth status [--json]   (list is the same command)",
        "  codex-multi-auth check            (always live-probes)",
        "",
        "Daily use:",
        "  codex-multi-auth list [--json]",
        "  codex-multi-auth switch <index>   (pins the account for runtime routing)",
        "  codex-multi-auth unpin            (clears the manual pin set by switch)",
        "  codex-multi-auth workspace <account> [workspace]   (list or switch an account's workspaces)",
        "  codex-multi-auth best [--live] [--json] [--model <model>]   (clears any manual pin set by switch)",
        "  codex-multi-auth forecast [--live] [--json] [--explain] [--model <model>] [--no-runtime-overlay]",
        "  codex-multi-auth account tag|untag|weight|pause|unpause|drain|undrain|note|policy list ...",
        "",
        "Repair:",
        "  codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]",
        "  codex-multi-auth verify-flagged [--dry-run|-n] [--json] [--no-restore]",
        "  codex-multi-auth verify [--paths | --flagged | --all] [--json]",
        "  codex-multi-auth fix [--dry-run|-n] [--json] [--live] [--model <model>]",
        "  codex-multi-auth doctor [--json] [--fix] [--dry-run|-n]   (--dry-run requires --fix)",
        "",
        "Diagnostics:",
        "  codex-multi-auth usage [--since <time|duration>] [--by <group>] [--json|--csv] [--out <path>]",
        "  codex-multi-auth usage rotate [--if-larger-than-bytes <n>] [--json]",
        "  codex-multi-auth budget limit <key> --window <hour|day|week|month> [--requests N] [--tokens N] [--cost USD]",
        "  codex-multi-auth budget check|list [--json]",
        "  codex-multi-auth bridge token create|list|rotate|revoke [--json]",
        "  codex-multi-auth integrations [--kind <name>] [--base-url <url>] [--model <model>] [--json]",
        "  codex-multi-auth models [--json] [--model <model>]",
        "  codex-multi-auth monitor [--json]",
        "  codex-multi-auth rotation <enable|disable|status|bind-app|unbind-app|reset-runtime>",
        "  codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
        "  codex-multi-auth why-selected [--now|-n | --last|-l] [--json]",
        "  codex-multi-auth history [list|show <id>] [--json]   (all local sessions, ignores /resume provider filtering)",
        "",
        "Advanced:",
        "  codex-multi-auth report [--live] [--json] [--explain] [--model <model>] [--max-accounts <n>] [--max-probes <n>] [--cached-only] [--out <path>]",
        "  codex-multi-auth config explain [--json]",
        "  codex-multi-auth config template|init-config [modern|legacy|minimal] [--write <path>] [--stdout]",
        "  codex-multi-auth debug bundle [--json]",
        "  codex-multi-auth features   (partial built-in checklist; see docs/features.md for the full product map)",
        "",
        "Notes:",
        "  - Uses ~/.codex/multi-auth/openai-codex-accounts.json",
        "  - Syncs active account into Codex CLI auth state",
    ]
    .join("\n")
        + "\n  - Default live probe model: "
        + DEFAULT_LIVE_PROBE_MODEL
        + "\n  - See docs/reference/commands.md for the full command and flag matrix"
}

/// TS `printUsage()` — a single stdout line-group.
pub fn print_usage(out: &mut CliOut) {
    out.info(usage_text());
}

/// TS `AuthLoginOptions`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuthLoginOptions {
    pub manual: bool,
    pub device_auth: bool,
    pub org: Option<String>,
}

/// TS `ParsedAuthLoginArgs` discriminated union.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedAuthLoginArgs {
    Ok(AuthLoginOptions),
    Help,
    Error(String),
}

/// TS `parseAuthLoginArgs(args)`.
pub fn parse_auth_login_args(args: &[String]) -> ParsedAuthLoginArgs {
    let mut options = AuthLoginOptions::default();
    let mut manual_flags: Vec<&str> = Vec::new();

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--manual" || arg == "--no-browser" {
            options.manual = true;
            if !manual_flags.contains(&arg) {
                manual_flags.push(if arg == "--manual" {
                    "--manual"
                } else {
                    "--no-browser"
                });
            }
            i += 1;
            continue;
        }
        if arg == "--device-auth" {
            options.device_auth = true;
            i += 1;
            continue;
        }
        if arg == "--org" || arg.starts_with("--org=") {
            // Bind this login to a specific workspace/org id (issue #491).
            let value: Option<String> = if arg == "--org" {
                let next = args.get(i + 1).cloned();
                i += 1;
                next
            } else {
                Some(arg["--org=".len()..].to_string())
            };
            let trimmed = value.as_deref().map(str::trim).unwrap_or("");
            if trimmed.is_empty() || trimmed.starts_with("--") {
                return ParsedAuthLoginArgs::Error(
                    "Missing value for --org. Usage: codex-multi-auth login --org <org_id>"
                        .to_string(),
                );
            }
            options.org = Some(trimmed.to_string());
            i += 1;
            continue;
        }
        if arg == "--help" || arg == "-h" {
            return ParsedAuthLoginArgs::Help;
        }
        return ParsedAuthLoginArgs::Error(format!("Unknown login option: {arg}"));
    }

    if options.device_auth && options.manual {
        let conflict = if manual_flags.is_empty() {
            "--manual".to_string()
        } else {
            manual_flags.join(" or ")
        };
        return ParsedAuthLoginArgs::Error(format!("Cannot combine --device-auth with {conflict}"));
    }

    ParsedAuthLoginArgs::Ok(options)
}

/// TS `BestCliOptions`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BestCliOptions {
    pub live: bool,
    pub json: bool,
    pub model: String,
    pub model_provided: bool,
}

impl Default for BestCliOptions {
    fn default() -> Self {
        BestCliOptions {
            live: false,
            json: false,
            model: DEFAULT_LIVE_PROBE_MODEL.to_string(),
            model_provided: false,
        }
    }
}

/// TS `ParsedBestArgs` discriminated union.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedBestArgs {
    Ok(BestCliOptions),
    Help,
    Error(String),
}

/// The `printBestUsage()` text (identical in help.ts and commands/best.ts).
pub fn best_usage_text() -> String {
    [
        "Usage:",
        "  codex-multi-auth best [--live] [--json] [--model <model>]",
        "",
        "Options:",
        "  --live, -l         Probe live quota headers via Codex backend before switching",
        "  --json, -j         Print machine-readable JSON output",
    ]
    .join("\n")
        + &format!("\n  --model, -m        Probe model for live mode (default: {DEFAULT_LIVE_PROBE_MODEL})")
        + "\n"
        + &[
            "",
            "Behavior:",
            "  - Chooses the healthiest account using forecast scoring",
            "  - Switches to the recommended account when it is not already active",
        ]
        .join("\n")
}

/// TS `printBestUsage()`.
pub fn print_best_usage(out: &mut CliOut) {
    out.info(best_usage_text());
}

/// TS help.ts `parseBestArgs(args)` — this variant treats `--help`/`-h` as a
/// first-class `Help` result (the copy in commands/best.ts does not; its
/// caller pre-checks `--help`).
pub fn parse_best_args(args: &[String]) -> ParsedBestArgs {
    let mut options = BestCliOptions::default();

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        if arg == "--help" || arg == "-h" {
            return ParsedBestArgs::Help;
        }
        if arg == "--live" || arg == "-l" {
            options.live = true;
            i += 1;
            continue;
        }
        if arg == "--json" || arg == "-j" {
            options.json = true;
            i += 1;
            continue;
        }
        if arg == "--model" || arg == "-m" {
            let value = args.get(i + 1).map(|v| v.trim().to_string());
            match value {
                Some(v) if !v.is_empty() && !v.starts_with('-') => {
                    options.model = v;
                    options.model_provided = true;
                    i += 2;
                    continue;
                }
                _ => return ParsedBestArgs::Error("Missing value for --model".to_string()),
            }
        }
        if let Some(raw) = arg.strip_prefix("--model=") {
            let value = raw.trim();
            if value.is_empty() || value.starts_with('-') {
                return ParsedBestArgs::Error("Missing value for --model".to_string());
            }
            options.model = value.to_string();
            options.model_provided = true;
            i += 1;
            continue;
        }
        return ParsedBestArgs::Error(format!("Unknown option: {arg}"));
    }

    ParsedBestArgs::Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // Port of test/codex-manager-help.test.ts.

    #[test]
    fn parses_login_flags() {
        assert_eq!(
            parse_auth_login_args(&args(&["--manual"])),
            ParsedAuthLoginArgs::Ok(AuthLoginOptions {
                manual: true,
                device_auth: false,
                org: None,
            })
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--no-browser"])),
            ParsedAuthLoginArgs::Ok(AuthLoginOptions {
                manual: true,
                device_auth: false,
                org: None,
            })
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--device-auth"])),
            ParsedAuthLoginArgs::Ok(AuthLoginOptions {
                manual: false,
                device_auth: true,
                org: None,
            })
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--help"])),
            ParsedAuthLoginArgs::Help
        );
    }

    #[test]
    fn parses_org_to_bind_a_workspace_491() {
        assert_eq!(
            parse_auth_login_args(&args(&["--org", "org-BBBB"])),
            ParsedAuthLoginArgs::Ok(AuthLoginOptions {
                manual: false,
                device_auth: false,
                org: Some("org-BBBB".to_string()),
            })
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--org=org-AAAA"])),
            ParsedAuthLoginArgs::Ok(AuthLoginOptions {
                manual: false,
                device_auth: false,
                org: Some("org-AAAA".to_string()),
            })
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--manual", "--org", "org-BBBB"])),
            ParsedAuthLoginArgs::Ok(AuthLoginOptions {
                manual: true,
                device_auth: false,
                org: Some("org-BBBB".to_string()),
            })
        );
    }

    #[test]
    fn reports_a_missing_org_value_491() {
        let expected = ParsedAuthLoginArgs::Error(
            "Missing value for --org. Usage: codex-multi-auth login --org <org_id>".to_string(),
        );
        assert_eq!(parse_auth_login_args(&args(&["--org"])), expected);
        assert_eq!(
            parse_auth_login_args(&args(&["--org", "--manual"])),
            expected
        );
    }

    #[test]
    fn reports_login_parser_errors_explicitly() {
        assert_eq!(
            parse_auth_login_args(&args(&["--bogus"])),
            ParsedAuthLoginArgs::Error("Unknown login option: --bogus".to_string())
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--device-auth", "--manual"])),
            ParsedAuthLoginArgs::Error("Cannot combine --device-auth with --manual".to_string())
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--no-browser", "--device-auth"])),
            ParsedAuthLoginArgs::Error(
                "Cannot combine --device-auth with --no-browser".to_string()
            )
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--device-auth", "--no-browser"])),
            ParsedAuthLoginArgs::Error(
                "Cannot combine --device-auth with --no-browser".to_string()
            )
        );
        assert_eq!(
            parse_auth_login_args(&args(&["--device-auth", "--manual", "--no-browser"])),
            ParsedAuthLoginArgs::Error(
                "Cannot combine --device-auth with --manual or --no-browser".to_string()
            )
        );
    }

    #[test]
    fn parses_best_args_and_treats_help_as_first_class() {
        assert_eq!(
            parse_best_args(&args(&[])),
            ParsedBestArgs::Ok(BestCliOptions {
                live: false,
                json: false,
                model: DEFAULT_PROBE_MODEL.to_string(),
                model_provided: false,
            })
        );
        assert_eq!(
            parse_best_args(&args(&["--live", "--json", "--model", "gpt-5"])),
            ParsedBestArgs::Ok(BestCliOptions {
                live: true,
                json: true,
                model: "gpt-5".to_string(),
                model_provided: true,
            })
        );
        assert_eq!(parse_best_args(&args(&["-h"])), ParsedBestArgs::Help);
    }

    #[test]
    fn renders_default_probe_model_in_best_usage() {
        assert!(best_usage_text().contains(&format!("(default: {DEFAULT_PROBE_MODEL})")));
    }

    #[test]
    fn reports_missing_model_values_and_unknown_flags() {
        assert_eq!(
            parse_best_args(&args(&["--model"])),
            ParsedBestArgs::Error("Missing value for --model".to_string())
        );
        assert_eq!(
            parse_best_args(&args(&["--bogus"])),
            ParsedBestArgs::Error("Unknown option: --bogus".to_string())
        );
    }

    #[test]
    fn rejects_flag_like_value_after_model_instead_of_consuming_it() {
        let missing = ParsedBestArgs::Error("Missing value for --model".to_string());
        assert_eq!(parse_best_args(&args(&["--model", "--json"])), missing);
        assert_eq!(parse_best_args(&args(&["--model", "--live"])), missing);
        assert_eq!(parse_best_args(&args(&["--model=--json"])), missing);
        assert_eq!(parse_best_args(&args(&["--model", "   "])), missing);
        assert_eq!(parse_best_args(&args(&["-m", "--json"])), missing);
        assert!(matches!(
            parse_best_args(&args(&["-m", "gpt-5.5"])),
            ParsedBestArgs::Ok(_)
        ));
    }

    #[test]
    fn usage_text_matches_frozen_lines() {
        let text = usage_text();
        assert!(text.starts_with("Codex Multi-Auth CLI\n"));
        assert!(text.contains("\n  - Default live probe model: gpt-5.6-sol\n"));
        assert!(
            text.ends_with("  - See docs/reference/commands.md for the full command and flag matrix")
        );
        assert!(text.contains(
            "  codex-multi-auth history [list|show <id>] [--json]   (all local sessions, ignores /resume provider filtering)"
        ));
    }
}
