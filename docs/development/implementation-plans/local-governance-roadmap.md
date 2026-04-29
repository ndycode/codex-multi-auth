# Local Governance Roadmap

Generated: 2026-04-29
Base: `origin/main` at `4308b56a14c132c5df9584a7b611a02b64891b2c`
Package version: `2.0.2`

This roadmap tracks the local governance work planned for `codex-multi-auth`.
The goal is to add local-only usage visibility, account policy controls,
project-aware routing profiles, budget guards, model availability views, and
an optional loopback bridge without changing the product into a hosted gateway
or dashboard service.

## Release Targets

### v2.1.0 Local Usage Governance

1. `chore/roadmap-local-governance`
   - Add this roadmap, status tracker, decision log, open issue log, PR template,
     and handoff scaffold.
2. `feat/usage-ledger-core`
   - Add a JSONL usage ledger under the local multi-auth storage root.
   - Store only redacted, non-prompt usage metadata.
   - Include local pricing, summaries, and rotation helpers.
3. `feat/usage-command`
   - Add `codex auth usage`.
   - Support `--since`, `--by`, `--json`, `--out`, CSV export, and ledger
     rotation.
4. `feat/account-policy-controls`
   - Add account policy storage and account policy commands for tags, weights,
     pause, drain, and local notes.
5. `feat/routing-profiles-core`
   - Add project-aware routing profiles using existing project identity helpers.
   - Do not enforce profiles at runtime in this PR.
6. `feat/budget-guard`
   - Add time windows, local limit commands, and budget evaluation.
   - Runtime blocking waits for the policy integration PR.
7. `feat/model-capability-matrix`
   - Build on existing model profiles, entitlement cache, capability policies,
     quota probes, and `test:model-matrix:smoke`.
8. `feat/runtime-policy-integration`
   - Enforce profiles, account policies, model capability, and budgets before
     account selection in runtime proxy and plugin-host paths.
   - Append exactly-once usage rows after completion or failure.
9. `feat/monitor-command`
   - Add `codex auth monitor` aggregating runtime observability, usage,
     policies, profiles, model matrix, quota cache, and current project context.

### v2.2.0 Local Bridge and Integrations

10. `feat/local-bridge-core`
    - Add an optional loopback-only bridge for `/health`, `/v1/models`, and
      `/v1/responses`.
11. `feat/local-client-tokens`
    - Store only SHA-256 token hashes and prefix metadata.
    - Show plain token only once when created or rotated.
12. `feat/integration-generators`
    - Add deterministic snippets for OpenCode, OpenClaw, Python, curl, and env.
    - Use `CODEX_MULTI_AUTH_LOCAL_KEY`.
13. `docs/release-local-governance`
    - Final README, changelog, storage, privacy, and testing documentation pass.

## Scope Guardrails

- Keep all governance data local by default.
- Keep runtime rotation default behavior aligned with current release docs.
- Do not add remote telemetry, hosted dashboard behavior, PostgreSQL, Docker,
  Kubernetes, Helm, TOTP auth, broad proxy endpoints, chat completions, audio,
  image, transcription, daemon install, or public-network binding by default.
- Do not store prompts, tokens, auth headers, raw account emails, or raw
  sensitive account identifiers in usage rows.
- Preserve loopback-only runtime proxy invariants and per-process client auth.
- Use existing storage roots and project identity helpers instead of inventing
  new path rules.

## Validation Policy

Baseline before feature branches:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Each implementation PR must run its targeted tests plus `npm run build`.
The runtime policy integration PR must additionally run runtime proxy,
plugin-host retry, failure policy, request transformer, and stream failover
tests. The final documentation PR must run:

```bash
npm run lint
npm run typecheck
npm test -- test/documentation.test.ts
npm test
npm run build
npm run clean:repo:check
```

