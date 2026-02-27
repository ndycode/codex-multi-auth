# Config Templates

These files are example model/provider templates for `codex-multi-auth`.

## Files

| File | Purpose |
| --- | --- |
| [`opencode-modern.json`](./opencode-modern.json) | Modern variant-based template |
| [`opencode-legacy.json`](./opencode-legacy.json) | Legacy explicit-model template |
| [`minimal-opencode.json`](./minimal-opencode.json) | Minimal debug template |

## Notes

- Template filenames are kept for backward compatibility.
- These templates are optional for the OAuth account manager flow.
- Core auth commands use `codex auth login`.

## Defaults Included

- GPT-5.x Codex model families
- `store: false`
- `include: ["reasoning.encrypted_content"]`
- Sensible fallback behavior for unsupported model entitlements

## Related Docs

- [`../docs/configuration.md`](../docs/configuration.md)
- [`../docs/getting-started.md`](../docs/getting-started.md)
- [`../docs/reference/settings.md`](../docs/reference/settings.md)
