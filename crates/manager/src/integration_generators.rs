//! Port of `lib/integration-generators.ts` — static snippet generators
//! (opencode/openclaw/python/curl/env) for the local rotation-proxy bridge.
//!
//! Snippet bodies are BYTE-EXACT contracts: env/curl/python end with a
//! trailing newline; the two JSON snippets are bare `JSON.stringify(_, null,
//! 2)` output (no trailing newline). The TS `switch` fell through to the
//! OpenClaw snippet for unknown kinds; the Rust enum makes unknown kinds
//! unrepresentable, so OpenClaw is simply the final arm.

use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::DEFAULT_MODEL;
use serde_json::json;

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:1456/v1";
const DEFAULT_ENV_VAR: &str = "CODEX_MULTI_AUTH_LOCAL_KEY";

/// TS `IntegrationSnippetKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IntegrationSnippetKind {
    Opencode,
    Openclaw,
    Python,
    Curl,
    Env,
}

impl IntegrationSnippetKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            IntegrationSnippetKind::Opencode => "opencode",
            IntegrationSnippetKind::Openclaw => "openclaw",
            IntegrationSnippetKind::Python => "python",
            IntegrationSnippetKind::Curl => "curl",
            IntegrationSnippetKind::Env => "env",
        }
    }

    /// The TS union values (`"opencode" | "openclaw" | "python" | "curl" |
    /// "env"`); anything else is not a kind (the TS type system enforced the
    /// same).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "opencode" => Some(IntegrationSnippetKind::Opencode),
            "openclaw" => Some(IntegrationSnippetKind::Openclaw),
            "python" => Some(IntegrationSnippetKind::Python),
            "curl" => Some(IntegrationSnippetKind::Curl),
            "env" => Some(IntegrationSnippetKind::Env),
            _ => None,
        }
    }
}

/// TS default generation order.
pub const DEFAULT_INTEGRATION_SNIPPET_KINDS: [IntegrationSnippetKind; 5] = [
    IntegrationSnippetKind::Opencode,
    IntegrationSnippetKind::Openclaw,
    IntegrationSnippetKind::Python,
    IntegrationSnippetKind::Curl,
    IntegrationSnippetKind::Env,
];

/// TS `IntegrationSnippetInput`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IntegrationSnippetInput {
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub env_var: Option<String>,
}

/// TS `IntegrationSnippet` — serializes as `{kind, title, body}` for the
/// `integrations --json` output.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct IntegrationSnippet {
    pub kind: IntegrationSnippetKind,
    pub title: &'static str,
    pub body: String,
}

struct NormalizedInput {
    base_url: String,
    model: String,
    env_var: String,
}

/// TS `normalizeInput` — baseUrl: trim then strip ALL trailing `/`; each
/// field falls back to its default when empty after trimming.
fn normalize_input(input: &IntegrationSnippetInput) -> NormalizedInput {
    let base_url = input
        .base_url
        .as_deref()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let model = input
        .model
        .as_deref()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let env_var = input
        .env_var
        .as_deref()
        .map(|env_var| env_var.trim().to_string())
        .filter(|env_var| !env_var.is_empty())
        .unwrap_or_else(|| DEFAULT_ENV_VAR.to_string());
    NormalizedInput {
        base_url,
        model,
        env_var,
    }
}

/// TS `generateIntegrationSnippet(kind, input)` — byte-exact bodies.
pub fn generate_integration_snippet(
    kind: IntegrationSnippetKind,
    input: &IntegrationSnippetInput,
) -> IntegrationSnippet {
    let options = normalize_input(input);
    match kind {
        IntegrationSnippetKind::Env => IntegrationSnippet {
            kind,
            title: "Environment",
            body: format!(
                "{env_var}=cma_local_replace_me\nOPENAI_BASE_URL={base_url}\nOPENAI_API_KEY=${env_var}\n",
                env_var = options.env_var,
                base_url = options.base_url,
            ),
        },
        IntegrationSnippetKind::Curl => IntegrationSnippet {
            kind,
            title: "curl",
            body: [
                format!("curl {}/responses \\", options.base_url),
                format!("  -H \"Authorization: Bearer ${}\" \\", options.env_var),
                "  -H \"Content-Type: application/json\" \\".to_string(),
                format!(
                    "  -d '{{\"model\":\"{}\",\"input\":\"Say hello from the local bridge.\"}}'",
                    options.model
                ),
                String::new(),
            ]
            .join("\n"),
        },
        IntegrationSnippetKind::Python => IntegrationSnippet {
            kind,
            title: "Python",
            body: [
                "import os".to_string(),
                "from openai import OpenAI".to_string(),
                String::new(),
                "client = OpenAI(".to_string(),
                format!("    api_key=os.environ[\"{}\"],", options.env_var),
                format!("    base_url=\"{}\",", options.base_url),
                ")".to_string(),
                String::new(),
                "response = client.responses.create(".to_string(),
                format!("    model=\"{}\",", options.model),
                "    input=\"Say hello from the local bridge.\",".to_string(),
                ")".to_string(),
                "print(response.output_text)".to_string(),
                String::new(),
            ]
            .join("\n"),
        },
        IntegrationSnippetKind::Opencode => IntegrationSnippet {
            kind,
            title: "OpenCode",
            body: stringify_pretty2(&json!({
                "provider": {
                    "openai": {
                        "options": {
                            "apiKey": format!("${}", options.env_var),
                            "baseURL": options.base_url,
                        },
                        "models": {
                            (options.model.clone()): {
                                "name": format!("{} via codex-multi-auth", options.model),
                            },
                        },
                    },
                },
            })),
        },
        IntegrationSnippetKind::Openclaw => IntegrationSnippet {
            kind,
            title: "OpenClaw",
            body: stringify_pretty2(&json!({
                "providers": {
                    "openai": {
                        "apiKey": format!("${}", options.env_var),
                        "baseURL": options.base_url,
                        "defaultModel": options.model,
                    },
                },
            })),
        },
    }
}

/// TS `generateIntegrationSnippets(kinds?, input?)` — maps in order; `None`
/// kinds = the default 5-kind order.
pub fn generate_integration_snippets(
    kinds: Option<&[IntegrationSnippetKind]>,
    input: &IntegrationSnippetInput,
) -> Vec<IntegrationSnippet> {
    kinds
        .unwrap_or(&DEFAULT_INTEGRATION_SNIPPET_KINDS)
        .iter()
        .map(|kind| generate_integration_snippet(*kind, input))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/integration-generators.test.ts + byte-exact body pins.

    #[test]
    fn generates_deterministic_snippets_using_the_local_key() {
        let snippets = generate_integration_snippets(
            None,
            &IntegrationSnippetInput {
                base_url: Some("http://127.0.0.1:1456/v1/".to_string()),
                model: Some("gpt-5.3-codex".to_string()),
                env_var: None,
            },
        );
        let kinds: Vec<&str> = snippets.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds, vec!["opencode", "openclaw", "python", "curl", "env"]);
        let combined: String = snippets
            .iter()
            .map(|s| s.body.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(combined.contains("CODEX_MULTI_AUTH_LOCAL_KEY"));
        assert!(combined.contains("http://127.0.0.1:1456/v1"));
        // trailing slash stripped (the env snippet pins the exact base URL)
        assert!(combined.contains("OPENAI_BASE_URL=http://127.0.0.1:1456/v1\n"));
        assert!(!combined.contains("OPENAI_BASE_URL=http://127.0.0.1:1456/v1/"));
    }

    #[test]
    fn python_snippet_uses_responses_create() {
        let snippet =
            generate_integration_snippet(IntegrationSnippetKind::Python, &Default::default());
        assert!(snippet.body.contains("client.responses.create"));
        assert!(!snippet.body.contains("chat.completions"));
    }

    #[test]
    fn env_snippet_is_byte_exact() {
        let snippet =
            generate_integration_snippet(IntegrationSnippetKind::Env, &Default::default());
        assert_eq!(snippet.title, "Environment");
        assert_eq!(
            snippet.body,
            "CODEX_MULTI_AUTH_LOCAL_KEY=cma_local_replace_me\nOPENAI_BASE_URL=http://127.0.0.1:1456/v1\nOPENAI_API_KEY=$CODEX_MULTI_AUTH_LOCAL_KEY\n"
        );
    }

    #[test]
    fn curl_snippet_is_byte_exact() {
        let snippet =
            generate_integration_snippet(IntegrationSnippetKind::Curl, &Default::default());
        assert_eq!(snippet.title, "curl");
        assert_eq!(
            snippet.body,
            format!(
                "curl http://127.0.0.1:1456/v1/responses \\\n  -H \"Authorization: Bearer $CODEX_MULTI_AUTH_LOCAL_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{{\"model\":\"{DEFAULT_MODEL}\",\"input\":\"Say hello from the local bridge.\"}}'\n"
            )
        );
    }

    #[test]
    fn python_snippet_is_byte_exact() {
        let snippet =
            generate_integration_snippet(IntegrationSnippetKind::Python, &Default::default());
        assert_eq!(snippet.title, "Python");
        assert_eq!(
            snippet.body,
            format!(
                "import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    api_key=os.environ[\"CODEX_MULTI_AUTH_LOCAL_KEY\"],\n    base_url=\"http://127.0.0.1:1456/v1\",\n)\n\nresponse = client.responses.create(\n    model=\"{DEFAULT_MODEL}\",\n    input=\"Say hello from the local bridge.\",\n)\nprint(response.output_text)\n"
            )
        );
    }

    #[test]
    fn opencode_snippet_is_pretty_json_without_trailing_newline() {
        let snippet = generate_integration_snippet(
            IntegrationSnippetKind::Opencode,
            &IntegrationSnippetInput {
                base_url: None,
                model: Some("gpt-5.3-codex".to_string()),
                env_var: None,
            },
        );
        assert_eq!(snippet.title, "OpenCode");
        assert_eq!(
            snippet.body,
            "{\n  \"provider\": {\n    \"openai\": {\n      \"options\": {\n        \"apiKey\": \"$CODEX_MULTI_AUTH_LOCAL_KEY\",\n        \"baseURL\": \"http://127.0.0.1:1456/v1\"\n      },\n      \"models\": {\n        \"gpt-5.3-codex\": {\n          \"name\": \"gpt-5.3-codex via codex-multi-auth\"\n        }\n      }\n    }\n  }\n}"
        );
        assert!(!snippet.body.ends_with('\n'));
    }

    #[test]
    fn openclaw_snippet_is_pretty_json_without_trailing_newline() {
        let snippet = generate_integration_snippet(
            IntegrationSnippetKind::Openclaw,
            &IntegrationSnippetInput {
                base_url: None,
                model: Some("gpt-5.3-codex".to_string()),
                env_var: None,
            },
        );
        assert_eq!(snippet.title, "OpenClaw");
        assert_eq!(
            snippet.body,
            "{\n  \"providers\": {\n    \"openai\": {\n      \"apiKey\": \"$CODEX_MULTI_AUTH_LOCAL_KEY\",\n      \"baseURL\": \"http://127.0.0.1:1456/v1\",\n      \"defaultModel\": \"gpt-5.3-codex\"\n    }\n  }\n}"
        );
        assert!(!snippet.body.ends_with('\n'));
    }

    #[test]
    fn normalize_input_strips_all_trailing_slashes_and_falls_back_when_empty() {
        let snippet = generate_integration_snippet(
            IntegrationSnippetKind::Env,
            &IntegrationSnippetInput {
                base_url: Some("http://localhost:9999///".to_string()),
                model: Some("   ".to_string()),
                env_var: Some("  MY_KEY  ".to_string()),
            },
        );
        assert!(snippet.body.contains("OPENAI_BASE_URL=http://localhost:9999\n"));
        assert!(snippet.body.starts_with("MY_KEY="));
        assert!(snippet.body.contains("OPENAI_API_KEY=$MY_KEY\n"));
    }
}
