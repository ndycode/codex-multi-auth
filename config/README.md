# Configuration

This directory contains the official OpenCode config templates for the ChatGPT Codex OAuth plugin.

## Required: choose the right config file

| File | OpenCode version | Description |
|------|------------------|-------------|
| [`opencode-modern.json`](./opencode-modern.json) | **v1.0.210+** | Variant-based config: 6 base models with 27 total presets |
| [`opencode-legacy.json`](./opencode-legacy.json) | **v1.0.209 and below** | Legacy explicit entries: 22 individual model definitions |

## Quick pick

If your OpenCode version is v1.0.210 or newer:

```bash
cp config/opencode-modern.json ~/.config/opencode/opencode.json
```

If your OpenCode version is v1.0.209 or older:

```bash
cp config/opencode-legacy.json ~/.config/opencode/opencode.json
```

Check your version with:

```bash
opencode --version
```

## Why there are two templates

OpenCode v1.0.210+ added model `variants`, so one model entry can expose multiple reasoning levels. That keeps modern config much smaller while preserving the same effective presets.

Both templates include:
- GPT-5.2, GPT-5 Codex, GPT-5.1, GPT-5.1 Codex, GPT-5.1 Codex Max, GPT-5.1 Codex Mini
- Reasoning variants per model family
- `store: false` and `include: ["reasoning.encrypted_content"]`
- Context metadata (272k context / 128k output)

## Spark model note

The templates intentionally do **not** include `gpt-5.3-codex-spark` by default. Spark is often entitlement-gated at the account/workspace level, so shipping it by default causes avoidable startup failures for many users.

If your workspace is entitled, you can add Spark model IDs manually.

## Usage examples

Modern template (v1.0.210+):

```bash
opencode run "task" --model=openai/gpt-5.2 --variant=medium
opencode run "task" --model=openai/gpt-5-codex --variant=high
```

Legacy template (v1.0.209 and below):

```bash
opencode run "task" --model=openai/gpt-5.2-medium
opencode run "task" --model=openai/gpt-5-codex-high
```

## Minimal config (advanced)

A barebones debug template is available at [`minimal-opencode.json`](./minimal-opencode.json). It omits the full preset catalog.

## Unsupported-model behavior

Current defaults are strict entitlement handling:
- `unsupportedCodexPolicy: "strict"` returns entitlement errors directly
- set `unsupportedCodexPolicy: "fallback"` (or `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback`) to enable automatic fallback retries
- `fallbackToGpt52OnUnsupportedGpt53: true` keeps the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge inside fallback mode
- `unsupportedCodexFallbackChain` lets you override fallback order per model
- Spark entitlement failures (`gpt-5.3-codex-spark`) force fallback immediately, even with strict policy, to support non-entitled workspaces

Default fallback chain (when policy is `fallback`):
- `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
- `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (only relevant if Spark IDs are added manually)
- `gpt-5.2-codex -> gpt-5-codex`
- `gpt-5.1-codex -> gpt-5-codex`

## Additional docs

- Main config reference: [`docs/configuration.md`](../docs/configuration.md)
- Getting started: [`docs/getting-started.md`](../docs/getting-started.md)
- Troubleshooting: [`docs/troubleshooting.md`](../docs/troubleshooting.md)
