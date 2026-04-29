# Local Governance Decisions

## Accepted Ideas

| Decision | Rationale |
| --- | --- |
| Local JSONL usage ledger | Matches the CLI-first, local-state architecture and avoids remote telemetry. |
| Redacted usage metadata only | Keeps storage useful for governance without storing prompts, tokens, raw emails, or sensitive identifiers. |
| Local API-key style bridge tokens | Enables local integrations while preserving bearer-token auth on loopback endpoints. |
| Model/account availability views | Builds on existing quota, entitlement, and capability surfaces instead of duplicating them. |
| Deterministic client snippets | Helps users connect local tools without adding hosted service behavior. |

## Rejected Ideas

| Decision | Rationale |
| --- | --- |
| Hosted dashboard | Out of scope for a local CLI-first account manager. |
| Docker, Kubernetes, or Helm deployment assets | Would imply server/gateway operation beyond the requested local bridge. |
| PostgreSQL-backed storage | Conflicts with local file-backed storage conventions. |
| Remote gateway behavior | Increases trust and network scope beyond loopback-only requirements. |
| TOTP auth for local bridge | Too heavy for loopback-only local integration; hashed bearer tokens are sufficient for this release scope. |
| Broad OpenAI-compatible proxy endpoints | The bridge scope is limited to health, models, and Responses API compatibility. |

## Implementation Decisions

- Use `getCodexMultiAuthDir()` for global local governance files.
- Use existing project identity helpers for project-aware data.
- Use temp-file plus rename writes with Windows retry behavior following
  existing storage/runtime patterns.
- Keep runtime enforcement out of core data-model PRs until
  `feat/runtime-policy-integration`.
- Filter runtime account candidates before selection, then pass safe boosts
  through existing scoring paths.
- Append usage rows once per completed or failed runtime request after policy
  integration lands.

