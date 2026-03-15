# Config Templates

These files are example model/provider templates for `codex-multi-auth`.

## Primary (Codex-named)

| File | Purpose |
| --- | --- |
| [`codex-modern.json`](./codex-modern.json) | Modern variant-based template |
| [`codex-legacy.json`](./codex-legacy.json) | Legacy explicit-model template |
| [`minimal-codex.json`](./minimal-codex.json) | Minimal debug template |

## Notes

- These templates are optional for the OAuth account manager flow.
- Core auth commands use `codex auth login`.
- They become relevant when you are setting up the optional plugin-host runtime via [../docs/advanced-plugin-install.md](../docs/advanced-plugin-install.md).

## Defaults Included

- GPT-5.x Codex model families
- `store: false`
- `include: ["reasoning.encrypted_content"]`
- Sensible fallback behavior for unsupported model entitlements

## Related Docs

- [`../docs/configuration.md`](../docs/configuration.md)
- [`../docs/advanced-plugin-install.md`](../docs/advanced-plugin-install.md)
- [`../docs/getting-started.md`](../docs/getting-started.md)
- [`../docs/reference/settings.md`](../docs/reference/settings.md)

