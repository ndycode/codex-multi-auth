//! Port of `scripts/codex-routing.js` plus the forwarded-arg scanning helpers
//! from `scripts/codex.js` (auth-family classification and runtime-routing
//! decisions). Pure functions only — no I/O, no env reads.
//!
//! Spec: 14-docs-tests.md §2.1 (wrapper behavior contract).

/// TS `AUTH_SUBCOMMANDS` — the account-manager command families the wrapper
/// treats as "auth" (handled locally instead of forwarded to official Codex).
pub const AUTH_SUBCOMMANDS: &[&str] = &[
    "login",
    "list",
    "status",
    "switch",
    "unpin",
    "workspace",
    "best",
    "check",
    "features",
    "usage",
    "verify-flagged",
    "verify",
    "forecast",
    "report",
    "fix",
    "doctor",
    "uninstall",
    "account",
    "budget",
    "bridge",
    "integrations",
    "models",
    "monitor",
    "rotation",
    "why-selected",
    "history",
    "config",
    "init-config",
    "debug",
];

/// Membership test over [`AUTH_SUBCOMMANDS`].
pub fn is_auth_subcommand(name: &str) -> bool {
    AUTH_SUBCOMMANDS.contains(&name)
}

/// TS `normalizeAuthAlias(args)` — rewrites the compatibility spellings
/// `codex multi auth …`, `codex multi-auth …`, `codex multiauth …` into
/// `auth …`.
pub fn normalize_auth_alias(args: &[String]) -> Vec<String> {
    if args.len() >= 2 && args[0] == "multi" && args[1] == "auth" {
        let mut out = Vec::with_capacity(args.len() - 1);
        out.push("auth".to_string());
        out.extend(args[2..].iter().cloned());
        return out;
    }
    if !args.is_empty() && (args[0] == "multi-auth" || args[0] == "multiauth") {
        let mut out = Vec::with_capacity(args.len());
        out.push("auth".to_string());
        out.extend(args[1..].iter().cloned());
        return out;
    }
    args.to_vec()
}

/// TS `shouldHandleMultiAuthAuth(args)` — true when the (normalized) args are
/// an auth-family invocation the local manager should handle:
/// `auth` alone, `auth -<flag>…`, or `auth <known subcommand>`.
pub fn should_handle_multi_auth_auth(args: &[String]) -> bool {
    if args.first().map(String::as_str) != Some("auth") {
        return false;
    }
    if args.len() == 1 {
        return true;
    }
    let subcommand = &args[1];
    if subcommand.starts_with('-') {
        return true;
    }
    is_auth_subcommand(subcommand)
}

/// TS `isPureHelpOrVersionArgs(rawArgs)` — non-empty and EVERY arg is one of
/// `--help`, `-h`, `--version`, `-V`.
pub fn is_pure_help_or_version_args(raw_args: &[String]) -> bool {
    if raw_args.is_empty() {
        return false;
    }
    raw_args
        .iter()
        .all(|arg| matches!(arg.as_str(), "--help" | "-h" | "--version" | "-V"))
}

/// TS `consumesNextArg(arg)` — flags of official Codex that take a following
/// value (so the forwarded-command scan can skip it).
pub fn consumes_next_arg(arg: &str) -> bool {
    matches!(
        arg,
        "-c" | "--config"
            | "--enable"
            | "--disable"
            | "--listen"
            | "--remote"
            | "--remote-auth-token-env"
            | "--ws-auth"
            | "--ws-token-file"
            | "--ws-token-sha256"
            | "--ws-shared-secret-file"
            | "--ws-issuer"
            | "--ws-audience"
            | "--ws-max-clock-skew-seconds"
            | "--download-url"
            | "-i"
            | "--image"
            | "-m"
            | "--model"
            | "--local-provider"
            | "-p"
            | "--profile"
            | "-s"
            | "--sandbox"
            | "-a"
            | "--ask-for-approval"
            | "-C"
            | "--cd"
            | "--add-dir"
            | "--output-schema"
            | "--color"
            | "-o"
            | "--output-last-message"
    )
}

/// Result of [`find_forwarded_command`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardedCommand {
    pub command: String,
    pub index: usize,
}

/// TS `findForwardedCommand(rawArgs)` — first positional token (skipping
/// value-consuming flags); `--` promotes the NEXT token to the command.
pub fn find_forwarded_command(raw_args: &[String]) -> Option<ForwardedCommand> {
    if raw_args.is_empty() {
        return None;
    }
    let mut i = 0usize;
    while i < raw_args.len() {
        let arg = raw_args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        if arg == "--" {
            return if i + 1 < raw_args.len() {
                Some(ForwardedCommand {
                    command: raw_args[i + 1].clone(),
                    index: i + 1,
                })
            } else {
                None
            };
        }
        if arg.starts_with("--config=") {
            i += 1;
            continue;
        }
        if arg.starts_with("--") || (arg.starts_with('-') && arg != "-") {
            if consumes_next_arg(arg) {
                i += 1;
            }
            i += 1;
            continue;
        }
        return Some(ForwardedCommand {
            command: arg.to_string(),
            index: i,
        });
    }
    None
}

/// TS `findForwardedSubcommand(rawArgs, commandIndex)`.
pub fn find_forwarded_subcommand(raw_args: &[String], command_index: usize) -> Option<String> {
    let mut i = command_index + 1;
    while i < raw_args.len() {
        let arg = raw_args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        if arg == "--" {
            return if i + 1 < raw_args.len() {
                Some(raw_args[i + 1].clone())
            } else {
                None
            };
        }
        if arg.starts_with("--config=") {
            i += 1;
            continue;
        }
        if arg.starts_with("--") || (arg.starts_with('-') && arg != "-") {
            if consumes_next_arg(arg) {
                i += 1;
            }
            i += 1;
            continue;
        }
        return Some(arg.to_string());
    }
    None
}

/// TS `hasHelpFlagAfterCommand(rawArgs, commandIndex)`.
pub fn has_help_flag_after_command(raw_args: &[String], command_index: usize) -> bool {
    let mut i = command_index + 1;
    while i < raw_args.len() {
        let arg = raw_args[i].as_str();
        if arg == "--" {
            return false;
        }
        if arg == "--help" || arg == "-h" || arg == "help" {
            return true;
        }
        if consumes_next_arg(arg) {
            i += 1;
        }
        i += 1;
    }
    false
}

/// TS `isCodexAppCommand(rawArgs)`.
pub fn is_codex_app_command(raw_args: &[String]) -> bool {
    find_forwarded_command(raw_args).is_some_and(|c| c.command == "app")
}

/// TS `isCodexAppServerCommand(rawArgs)`.
pub fn is_codex_app_server_command(raw_args: &[String]) -> bool {
    find_forwarded_command(raw_args).is_some_and(|c| c.command == "app-server")
}

/// TS `isCodexInteractiveTuiCommand(rawArgs)` — no positional command at all.
pub fn is_codex_interactive_tui_command(raw_args: &[String]) -> bool {
    find_forwarded_command(raw_args).is_none()
}

/// TS `shouldUseRuntimeRoutingForForwardedArgs(rawArgs)` — decides whether the
/// runtime rotation proxy applies to this forwarded invocation.
pub fn should_use_runtime_routing_for_forwarded_args(raw_args: &[String]) -> bool {
    if raw_args.is_empty() {
        return true;
    }
    if is_pure_help_or_version_args(raw_args) {
        return false;
    }

    let Some(command) = find_forwarded_command(raw_args) else {
        return true;
    };

    if command.command == "app-server" {
        if has_help_flag_after_command(raw_args, command.index) {
            return false;
        }
        let subcommand = find_forwarded_subcommand(raw_args, command.index);
        return !matches!(
            subcommand.as_deref(),
            Some("help") | Some("generate-ts") | Some("generate-json-schema")
        );
    }

    if command.command == "app" && has_help_flag_after_command(raw_args, command.index) {
        return false;
    }
    // Request-shaped commands route through the proxy.
    if matches!(
        command.command.as_str(),
        "exec" | "review" | "resume" | "fork" | "app"
    ) {
        return true;
    }
    // Non-request commands never need it.
    if matches!(
        command.command.as_str(),
        "help"
            | "completion"
            | "login"
            | "logout"
            | "mcp"
            | "mcp-server"
            | "sandbox"
            | "debug"
            | "apply"
            | "cloud"
            | "features"
            | "auth"
    ) {
        return false;
    }
    true
}

/// TS `shouldTrackForwardedRuntimeObservability(rawArgs)` — same predicate.
pub fn should_track_forwarded_runtime_observability(raw_args: &[String]) -> bool {
    should_use_runtime_routing_for_forwarded_args(raw_args)
}

/// TS `isRotationEnableCommand(args)` — `auth rotation enable` (post-normalize).
pub fn is_rotation_enable_command(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("auth")
        && args.get(1).map(String::as_str) == Some("rotation")
        && args.get(2).map(String::as_str) == Some("enable")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn normalize_auth_alias_rewrites_multi_auth_forms() {
        assert_eq!(
            normalize_auth_alias(&v(&["multi", "auth", "status"])),
            v(&["auth", "status"])
        );
        assert_eq!(
            normalize_auth_alias(&v(&["multi-auth", "login"])),
            v(&["auth", "login"])
        );
        assert_eq!(normalize_auth_alias(&v(&["multiauth"])), v(&["auth"]));
        // "multi" alone is NOT an alias.
        assert_eq!(normalize_auth_alias(&v(&["multi"])), v(&["multi"]));
        // untouched otherwise
        assert_eq!(normalize_auth_alias(&v(&["exec", "hi"])), v(&["exec", "hi"]));
    }

    #[test]
    fn should_handle_auth_family_detection() {
        assert!(should_handle_multi_auth_auth(&v(&["auth"])));
        assert!(should_handle_multi_auth_auth(&v(&["auth", "--json"])));
        assert!(should_handle_multi_auth_auth(&v(&["auth", "login"])));
        assert!(should_handle_multi_auth_auth(&v(&["auth", "rotation", "enable"])));
        // unknown subcommand forwards to official codex (`codex auth ...` upstream surface)
        assert!(!should_handle_multi_auth_auth(&v(&["auth", "whoami"])));
        assert!(!should_handle_multi_auth_auth(&v(&["exec"])));
        assert!(!should_handle_multi_auth_auth(&v(&[])));
    }

    #[test]
    fn auth_subcommand_set_has_29_entries() {
        assert_eq!(AUTH_SUBCOMMANDS.len(), 29);
        assert!(is_auth_subcommand("why-selected"));
        assert!(!is_auth_subcommand("app"));
    }

    #[test]
    fn pure_help_or_version() {
        assert!(is_pure_help_or_version_args(&v(&["--help"])));
        assert!(is_pure_help_or_version_args(&v(&["-V", "--version"])));
        assert!(!is_pure_help_or_version_args(&v(&[])));
        assert!(!is_pure_help_or_version_args(&v(&["--help", "exec"])));
    }

    #[test]
    fn find_forwarded_command_skips_flag_values() {
        assert_eq!(
            find_forwarded_command(&v(&["-m", "gpt-5.5", "exec", "task"])),
            Some(ForwardedCommand {
                command: "exec".into(),
                index: 2
            })
        );
        assert_eq!(
            find_forwarded_command(&v(&["--config=a=b", "review"])),
            Some(ForwardedCommand {
                command: "review".into(),
                index: 1
            })
        );
        assert_eq!(
            find_forwarded_command(&v(&["--", "exec"])),
            Some(ForwardedCommand {
                command: "exec".into(),
                index: 1
            })
        );
        assert_eq!(find_forwarded_command(&v(&["--"])), None);
        assert_eq!(find_forwarded_command(&v(&["-m", "gpt"])), None);
        assert_eq!(find_forwarded_command(&v(&[])), None);
    }

    #[test]
    fn runtime_routing_decisions() {
        // interactive TUI (no positional) routes
        assert!(should_use_runtime_routing_for_forwarded_args(&v(&[])));
        assert!(should_use_runtime_routing_for_forwarded_args(&v(&["-m", "gpt-5.5"])));
        // help/version never route
        assert!(!should_use_runtime_routing_for_forwarded_args(&v(&["--help"])));
        // request commands route
        for cmd in ["exec", "review", "resume", "fork", "app"] {
            assert!(should_use_runtime_routing_for_forwarded_args(&v(&[cmd])), "{cmd}");
        }
        // non-request commands do not
        for cmd in [
            "help",
            "completion",
            "login",
            "logout",
            "mcp",
            "mcp-server",
            "sandbox",
            "debug",
            "apply",
            "cloud",
            "features",
            "auth",
        ] {
            assert!(!should_use_runtime_routing_for_forwarded_args(&v(&[cmd])), "{cmd}");
        }
        // unknown commands default to routing
        assert!(should_use_runtime_routing_for_forwarded_args(&v(&["something-new"])));
        // app-server special cases
        assert!(should_use_runtime_routing_for_forwarded_args(&v(&["app-server"])));
        assert!(!should_use_runtime_routing_for_forwarded_args(&v(&[
            "app-server",
            "generate-ts"
        ])));
        assert!(!should_use_runtime_routing_for_forwarded_args(&v(&[
            "app-server",
            "generate-json-schema"
        ])));
        assert!(!should_use_runtime_routing_for_forwarded_args(&v(&["app-server", "help"])));
        assert!(!should_use_runtime_routing_for_forwarded_args(&v(&["app-server", "--help"])));
        // app --help does not route
        assert!(!should_use_runtime_routing_for_forwarded_args(&v(&["app", "--help"])));
    }

    #[test]
    fn app_command_detection() {
        assert!(is_codex_app_command(&v(&["app"])));
        assert!(is_codex_app_server_command(&v(&["app-server"])));
        assert!(!is_codex_app_command(&v(&["exec"])));
        assert!(is_codex_interactive_tui_command(&v(&["-m", "x"])));
        assert!(!is_codex_interactive_tui_command(&v(&["exec"])));
    }

    #[test]
    fn rotation_enable_detection() {
        assert!(is_rotation_enable_command(&v(&["auth", "rotation", "enable"])));
        assert!(!is_rotation_enable_command(&v(&["auth", "rotation", "disable"])));
        assert!(!is_rotation_enable_command(&v(&["rotation", "enable"])));
    }
}
