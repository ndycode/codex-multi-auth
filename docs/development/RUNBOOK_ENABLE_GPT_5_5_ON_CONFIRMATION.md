# Runbook: Enable GPT-5.5 After Official Confirmation

Internal launch-day checklist for turning the GPT-5.5 readiness prep into real public support.

## Goal

Ship confirmed GPT-5.5 support as a narrow follow-up patch after OpenAI publishes the exact production contract.

## Required Proof From OpenAI

- Official models documentation lists the public GPT-5.5 model IDs.
- Official release notes or product documentation confirm that GPT-5.5 is publicly available.
- Official documentation confirms the prompt family or successor prompt asset that should back GPT-5.5 requests.
- Official documentation confirms default reasoning behavior and the allowed reasoning-effort values for each public GPT-5.5 variant.
- Official documentation confirms tool-search, computer-use, and compaction support for each public GPT-5.5 variant.
- Official documentation confirms any user-facing config/example names that should be exposed in shipped templates.

## Activation Files

- `lib/request/helpers/model-map.ts` - add confirmed GPT-5.5 aliases, profiles, prompt-family selection, and capability metadata.
- `test/model-map.test.ts` - lock the confirmed normalization and capability surface.
- `test/request-transformer.test.ts` - lock the confirmed reasoning coercion, text defaults, and tool sanitization behavior.
- `config/codex-legacy.json` - update the shipped legacy config example only after public IDs and reasoning variants are confirmed.
- User-visible docs only after confirmation:
  - `README.md`
  - `docs/getting-started.md`
  - `docs/features.md`
  - `docs/configuration.md`
  - `docs/troubleshooting.md`
  - relevant `docs/reference/*` pages if command, setting, or example text changes

## Safe Workflow

1. Record the official OpenAI source links in the PR description before editing code.
2. Update the exact GPT-5.5 aliases and profiles in `model-map.ts`; do not widen fallback heuristics unless the official contract requires it.
3. Keep unknown or unconfirmed GPT-5.5-style names on the stable fallback path until each new public ID is proven.
4. Update tests before advertising support in shipped config examples or public docs.
5. Update `config/codex-legacy.json` only for confirmed public IDs.
6. Update user-visible docs only after the runtime and tests already pass with the confirmed contract.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm test -- test/documentation.test.ts
npm run build
```

## Review Checklist

- official OpenAI source links are captured in the PR
- every new GPT-5.5 alias matches the official public ID exactly
- reasoning defaults and supported efforts match the official contract
- tool-search and computer-use assertions match the official contract
- shipped config examples expose only confirmed public GPT-5.5 entries
- user-visible docs remain unchanged until confirmation is complete
- rollback remains a clean revert of the activation patch
