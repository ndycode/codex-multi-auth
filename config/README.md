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

- Current documented OpenAI/Codex model families: GPT-6.1 Sol (`gpt-6.1-sol`, the default), GPT-6.1 Terra (`gpt-6.1-terra`), GPT-6 Astra (`gpt-6-astra`), GPT-6 Sol (`gpt-6-sol`) and GPT-6 Luna (`gpt-6-luna`), then `gpt-5.6-sol`/`terra`/`luna`. Retired models (`gpt-5.5`/`gpt-5.5-pro`, `gpt-5.4*`, `gpt-5.3-codex` and older, plus the leaked `gpt-6-astra-aeon` slug) were removed from the picker; their ids still resolve to a replacement, see `docs/configuration.md`
- The GPT-6 entries carry `limit.context: 272000`, the `context_window` in the upstream Codex catalog, except GPT-6.1 Terra, whose catalog entry and picker entries use `500000`. The GPT-5.6 entries still carry the pre-cut `372000` and were left alone here; change them only alongside a deliberate review, since the value feeds a picker rather than the context budget guard (which refuses to estimate either family)
- The Daybreak cyber models resolve at the code level but are deliberately absent from these templates, matching their hidden visibility in the upstream Codex picker
- `store: false`
- `include: ["reasoning.encrypted_content"]`
- Sensible fallback behavior for unsupported model entitlements

## Related Docs

- [`../docs/configuration.md`](../docs/configuration.md)
- [`../docs/getting-started.md`](../docs/getting-started.md)
- [`../docs/reference/settings.md`](../docs/reference/settings.md)
