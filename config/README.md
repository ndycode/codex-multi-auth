# Config Templates

These files are optional model/provider templates for host/plugin configurations that still load `codex-multi-auth` directly. The normal account-manager workflow uses `codex-multi-auth ...` and does not require these templates.

## Primary (Codex-named)

| File | Purpose |
| --- | --- |
| [`codex-modern.json`](./codex-modern.json) | Modern variant-based template |
| [`codex-legacy.json`](./codex-legacy.json) | Legacy explicit-model template |
| [`minimal-codex.json`](./minimal-codex.json) | Minimal debug template |

## Notes

- These templates are optional for the OAuth account manager flow and the runtime rotation proxy.
- Core account-manager commands use `codex-multi-auth login`.

## Defaults Included

- Current documented OpenAI/Codex model families (`gpt-5.6-sol`/`terra`/`luna`, `gpt-5.5`, `gpt-5.4`, and `gpt-5.3-codex`)
- `store: false`
- `include: ["reasoning.encrypted_content"]`
- Sensible fallback behavior for unsupported model entitlements

## Related Docs

- [`../docs/configuration.md`](../docs/configuration.md)
- [`../docs/getting-started.md`](../docs/getting-started.md)
- [`../docs/reference/settings.md`](../docs/reference/settings.md)
