//! Port of `lib/codex-manager/commands/bridge.ts`.
//!
//! `bridge token create|list|rotate|revoke` — manages local bridge client
//! tokens. Public token records never expose the stored hash.

use cma_auth::local_client_tokens::{
    LocalClientTokenRecord, add_local_client_token, load_local_client_token_store,
    revoke_local_client_token, rotate_local_client_token,
};
use cma_core::json_io::stringify_pretty2;
use serde_json::{Value, json};

use crate::dispatcher::{CliOut, js_number};

fn print_bridge_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth bridge token create [--label <label>] [--json]",
            "  codex-multi-auth bridge token list [--json]",
            "  codex-multi-auth bridge token rotate <id> [--json]",
            "  codex-multi-auth bridge token revoke <id> [--json]",
        ]
        .join("\n"),
    );
}

/// TS `publicTokenRecord(token)` — hashes never leave the store. Key order
/// is the TS object literal order.
pub fn public_token_record(token: &LocalClientTokenRecord) -> Value {
    json!({
        "id": token.id,
        "label": token.label,
        "prefix": token.prefix,
        "createdAt": token.created_at,
        "lastUsedAt": token.last_used_at.map(|v| js_number(v as f64)),
        "revokedAt": token.revoked_at.map(|v| js_number(v as f64)),
        "state": if token.revoked_at.is_none() { "active" } else { "revoked" },
    })
}

fn consume_json_flag(args: &[String]) -> (bool, Vec<String>) {
    let json = args.iter().any(|arg| arg == "--json" || arg == "-j");
    let rest = args
        .iter()
        .filter(|arg| arg.as_str() != "--json" && arg.as_str() != "-j")
        .cloned()
        .collect();
    (json, rest)
}

/// TS `parseLabel(args)` for `bridge token create`.
fn parse_label(args: &[String]) -> Result<Option<String>, String> {
    let mut label: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--label" {
            match args.get(i + 1) {
                Some(value) if !value.is_empty() => {
                    label = Some(value.clone());
                    i += 2;
                    continue;
                }
                _ => return Err("Missing value for --label".to_string()),
            }
        }
        if let Some(value) = arg.strip_prefix("--label=") {
            label = Some(value.to_string());
            i += 1;
            continue;
        }
        return Err(format!("Unknown bridge token option: {arg}"));
    }
    Ok(label)
}

/// TS `runBridgeCommand(args, deps)`.
///
/// Deviation note: local-token store IO failures (which would crash the TS
/// process) print the error on stderr and exit 1.
pub async fn run_bridge_command(args: &[String], out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_bridge_usage(out);
        return 0;
    }
    let area = args.first().map(String::as_str);
    let action = args.get(1).map(String::as_str);
    let rest: Vec<String> = if args.len() > 2 {
        args[2..].to_vec()
    } else {
        Vec::new()
    };
    if area != Some("token") {
        out.error("Expected `codex-multi-auth bridge token ...`");
        return 1;
    }
    match action {
        Some("create") => {
            let (json, action_args) = consume_json_flag(&rest);
            let label = match parse_label(&action_args) {
                Ok(label) => label,
                Err(message) => {
                    out.error(message);
                    return 1;
                }
            };
            let created = match add_local_client_token(label.as_deref(), None).await {
                Ok(created) => created,
                Err(error) => {
                    out.error(error.to_string());
                    return 1;
                }
            };
            if json {
                out.info(stringify_pretty2(&json!({
                    "command": "bridge token create",
                    "token": public_token_record(&created.record),
                    "plainToken": created.plain_token,
                })));
                return 0;
            }
            out.info(format!("Token id: {}", created.record.id));
            out.info(format!("Token prefix: {}", created.record.prefix));
            out.info(format!("Token: {}", created.plain_token));
            0
        }
        Some("list") => {
            let (json, action_args) = consume_json_flag(&rest);
            if !action_args.is_empty() {
                out.error(format!(
                    "Unknown bridge token list option: {}",
                    action_args.first().map(String::as_str).unwrap_or("")
                ));
                return 1;
            }
            let store = load_local_client_token_store().await;
            if json {
                out.info(stringify_pretty2(&json!({
                    "command": "bridge token list",
                    "tokens": store.tokens.iter().map(public_token_record).collect::<Vec<_>>(),
                })));
                return 0;
            }
            if store.tokens.is_empty() {
                out.info("No local bridge tokens configured.");
                return 0;
            }
            for token in &store.tokens {
                let state = if token.revoked_at.is_none() {
                    "active"
                } else {
                    "revoked"
                };
                out.info(format!(
                    "{} {} {} {}",
                    token.id, token.prefix, token.label, state
                ));
            }
            0
        }
        Some("rotate") => {
            let (json, action_args) = consume_json_flag(&rest);
            let Some(id) = action_args.first().filter(|id| !id.is_empty()) else {
                out.error("Missing token id");
                return 1;
            };
            if action_args.len() > 1 {
                out.error(format!(
                    "Unknown bridge token rotate option: {}",
                    action_args.get(1).map(String::as_str).unwrap_or("")
                ));
                return 1;
            }
            let rotated = match rotate_local_client_token(id, None, None).await {
                Ok(rotated) => rotated,
                Err(error) => {
                    out.error(error.to_string());
                    return 1;
                }
            };
            let Some(rotated) = rotated else {
                out.error("Token not found or already revoked.");
                return 1;
            };
            if json {
                out.info(stringify_pretty2(&json!({
                    "command": "bridge token rotate",
                    "token": public_token_record(&rotated.record),
                    "plainToken": rotated.plain_token,
                })));
                return 0;
            }
            out.info(format!("Token id: {}", rotated.record.id));
            out.info(format!("Token prefix: {}", rotated.record.prefix));
            out.info(format!("Token: {}", rotated.plain_token));
            0
        }
        Some("revoke") => {
            let (json, action_args) = consume_json_flag(&rest);
            let Some(id) = action_args.first().filter(|id| !id.is_empty()) else {
                out.error("Missing token id");
                return 1;
            };
            if action_args.len() > 1 {
                out.error(format!(
                    "Unknown bridge token revoke option: {}",
                    action_args.get(1).map(String::as_str).unwrap_or("")
                ));
                return 1;
            }
            let revoked = match revoke_local_client_token(id, None).await {
                Ok(revoked) => revoked,
                Err(error) => {
                    out.error(error.to_string());
                    return 1;
                }
            };
            if !revoked {
                out.error("Token not found or already revoked.");
                return 1;
            }
            if json {
                out.info(stringify_pretty2(&json!({
                    "command": "bridge token revoke",
                    "id": id,
                    "revoked": true,
                })));
                return 0;
            }
            out.info("Token revoked.");
            0
        }
        other => {
            out.error(format!(
                "Unknown bridge token action: {}",
                other.unwrap_or("")
            ));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn public_token_record_never_exposes_the_hash() {
        let record = LocalClientTokenRecord {
            id: "id-1".to_string(),
            label: "default".to_string(),
            prefix: "cma_local_abc".to_string(),
            token_hash: "sha256:deadbeef".to_string(),
            created_at: 5,
            last_used_at: None,
            revoked_at: None,
        };
        let value = public_token_record(&record);
        let text = serde_json::to_string(&value).unwrap();
        assert!(!text.contains("deadbeef"));
        assert!(!text.contains("tokenHash"));
        assert_eq!(value["state"], "active");
        assert_eq!(value["lastUsedAt"], serde_json::Value::Null);
        assert_eq!(value["revokedAt"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn requires_the_token_area() {
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["nope"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Expected `codex-multi-auth bridge token ...`");
    }

    #[tokio::test]
    async fn rejects_unknown_create_option_and_missing_label_value() {
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "create", "--bogus"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown bridge token option: --bogus");

        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "create", "--label"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Missing value for --label");
    }

    #[tokio::test]
    async fn rejects_missing_ids_and_unknown_action() {
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "rotate"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Missing token id");

        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "revoke"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Missing token id");

        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "smash"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown bridge token action: smash");

        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown bridge token action: ");
    }

    #[tokio::test]
    #[serial(env)]
    async fn create_list_rotate_revoke_round_trip() {
        let _sandbox = EnvSandbox::new();

        // Empty list first.
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "list"]), &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "No local bridge tokens configured.");

        // Create with a label.
        let mut out = CliOut::capture();
        let code = run_bridge_command(
            &args(&["token", "create", "--label", "ci", "--json"]),
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        let payload: serde_json::Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["command"], "bridge token create");
        assert_eq!(payload["token"]["label"], "ci");
        assert_eq!(payload["token"]["state"], "active");
        let plain = payload["plainToken"].as_str().unwrap().to_string();
        assert!(plain.starts_with("cma_local"));
        let id = payload["token"]["id"].as_str().unwrap().to_string();

        // Rotate it.
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "rotate", &id]), &mut out).await;
        assert_eq!(code, 0);
        assert!(out.info_text().starts_with("Token id: "));

        // Rotating the (now revoked) old id again fails.
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "rotate", &id]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Token not found or already revoked.");

        // Revoke unknown id fails with the same message.
        let mut out = CliOut::capture();
        let code = run_bridge_command(&args(&["token", "revoke", "nope"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Token not found or already revoked.");
    }
}
