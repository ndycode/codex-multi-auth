//! Port of `lib/prompts/codex-host-bridge.ts` — the static Codex host-bridge
//! prompt (spec 06 §0 cross-module imports; consumed by the request
//! transformer's `add_codex_bridge_message`).
//!
//! The text bridges Codex CLI instructions to the host runtime environment:
//! tool mappings, available-tools list, substitution rules, and the
//! verification checklist (~450 tokens, ~90% smaller than the full host
//! prompt).
//!
//! The bytes are FROZEN: `assets/codex-host-bridge.txt` was extracted verbatim
//! from the TS template literal (escape sequences resolved). Do not edit the
//! asset by hand — regenerate it from the TS source if upstream changes.

/// TS `CODEX_HOST_BRIDGE` — byte-identical to the TS export.
pub const CODEX_HOST_BRIDGE: &str = include_str!("../../assets/codex-host-bridge.txt");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_prompt_matches_frozen_shape() {
        assert!(CODEX_HOST_BRIDGE.starts_with("# Codex Host Bridge\n"));
        // Resolved escapes from the TS template literal must be present.
        assert!(CODEX_HOST_BRIDGE.contains("(e.g. `${TARGET_SNIPPET}`)"));
        assert!(
            CODEX_HOST_BRIDGE.contains("UPDATE_PLAN DOES NOT EXIST -> USE \"todowrite\" INSTEAD")
        );
        assert!(CODEX_HOST_BRIDGE
            .contains("`request_user_input` is Plan-mode only; do not call it in Default mode."));
        // No trailing newline: the TS literal ends right after the final ")."
        assert!(CODEX_HOST_BRIDGE.ends_with("then delete with `bash`)."));
        // Byte budget sanity (extraction produced 7418 UTF-8 bytes).
        assert_eq!(CODEX_HOST_BRIDGE.len(), 7418);
    }
}
