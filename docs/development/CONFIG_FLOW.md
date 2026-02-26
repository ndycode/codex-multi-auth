# Configuration Flow

How configuration is resolved from files and environment variables into effective runtime behavior.

## 1) Plugin Runtime Config Path Resolution

`loadPluginConfig()` resolves config in this order:

1. `CODEX_MULTI_AUTH_CONFIG_PATH`
2. `~/.opencode/codex-multi-auth-config.json`
3. `~/.opencode/openai-codex-auth-config.json` (legacy)
4. Built-in defaults

Later sources in this list are only used if earlier ones are missing.

## 2) Runtime Value Precedence

For each setting:

1. Environment variable override (highest)
2. Config file value
3. Default from `DEFAULT_CONFIG`

## 3) OpenCode Provider Config Flow

OpenCode passes provider data into plugin loader:

```text
provider.openai.options  -> userConfig.global
provider.openai.models   -> userConfig.models
```

Request-time merge:

1. Start with `userConfig.global`
2. Overlay model-specific options by selected model key
3. Overlay request body/providerOptions values

## 4) Model Resolution Flow

```text
Incoming model id (e.g. gpt-5-codex-high)
  -> lookup MODEL_MAP exact/case-insensitive aliases
  -> fallback string-pattern normalization
  -> canonical backend model (e.g. gpt-5-codex)
```

Per-model config lookup uses original model key; backend call uses normalized model.

## 5) Request Transformation Invariants

`transformRequestBody()` enforces:

- `store = false`
- `stream = true`
- strip all input item IDs
- remove `item_reference` items
- include `reasoning.encrypted_content` unless overridden

Optional fast-session mode can trim histories and lower reasoning/verbosity.

## 6) Account Storage Path Flow

- If project root is detected and `perProjectAccounts=true`:
  - `~/.opencode/projects/<project-key>/openai-codex-accounts.json`
- Otherwise:
  - `~/.opencode/openai-codex-accounts.json`

Storage writes are atomic and protected by lock + backup + WAL recovery.

## 7) Unsupported Model Handling Flow

Policy selection order:

1. `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY`
2. `unsupportedCodexPolicy`
3. Legacy fallback toggles
4. Default `strict`

If effective policy is `fallback`, fallback chain is resolved from:

1. `unsupportedCodexFallbackChain` custom map
2. built-in fallback chain

## 8) Session-Time Dynamic Flows

- Live account sync watches storage changes and reloads manager state.
- Session affinity keeps the same account for a session when healthy.
- Refresh guardian refreshes near-expiry tokens in background.

These mechanisms reduce manual restarts and account churn.

## 9) Debugging Effective Config

Recommended commands:

```bash
codex auth report --json
codex auth doctor --json
```

Optional verbose logging:

```bash
DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1
```

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)

