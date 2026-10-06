# codex-multi-auth Documentation Portal

The complete documentation set for `codex-multi-auth`, the multi-account OAuth manager for the official Codex CLI. New here? Read [index.md](index.md) for what the product does at runtime, then [getting-started.md](getting-started.md) to install and sign in.

## Start here

| Document | Purpose |
| --- | --- |
| [index.md](index.md) | Product overview — what it does at runtime and who needs it |
| [getting-started.md](getting-started.md) | Install, first login, device-auth and manual login, day-1 commands |
| [faq.md](faq.md) | Short answers to common adoption questions |
| [troubleshooting.md](troubleshooting.md) | Recovery playbooks for install, login, routing, and storage problems |

## Using the product

| Document | Purpose |
| --- | --- |
| [features.md](features.md) | Capability tour: account pool, runtime rotation, governance, bridge, dashboard |
| [architecture.md](architecture.md) | Components, request flow, and trust boundaries |
| [configuration.md](configuration.md) | Settings, precedence, and environment overrides |
| [upgrade.md](upgrade.md) | Version upgrades and legacy-package migration |
| [privacy.md](privacy.md) | Data handling and local storage behavior |

## Reference

| Document | Purpose |
| --- | --- |
| [reference/commands.md](reference/commands.md) | Every command, flag, and dashboard hotkey |
| [reference/settings.md](reference/settings.md) | Dashboard and runtime settings |
| [reference/storage-paths.md](reference/storage-paths.md) | Canonical and compatibility storage paths |
| [reference/public-api.md](reference/public-api.md) | Public API stability tiers and semver contract |
| [reference/error-contracts.md](reference/error-contracts.md) | CLI, JSON, and helper error semantics |
| [reference/image-routes.md](reference/image-routes.md) | Image generation/edit transport through the runtime proxy |
| [reference/imagegen-provider-compatibility.md](reference/imagegen-provider-compatibility.md) | Built-in `image_gen` provider compatibility |
| [Release history](#release-history) | Stable, previous, and archived release notes |

## Maintainer docs

| Document | Purpose |
| --- | --- |
| [DOCUMENTATION.md](DOCUMENTATION.md) | Documentation governance contract |
| [STYLE_GUIDE.md](STYLE_GUIDE.md) | Docs voice, naming, and alias rules |
| [development/ARCHITECTURE.md](development/ARCHITECTURE.md) | Internals: selection order, security boundaries, invariants |
| [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md) | Complete field and environment inventory |
| [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md) | Configuration resolution flow |
| [development/REPOSITORY_SCOPE.md](development/REPOSITORY_SCOPE.md) | Ownership map by repository path |
| [development/TESTING.md](development/TESTING.md) | Validation gates and test matrix |
| [development/TUI_PARITY_CHECKLIST.md](development/TUI_PARITY_CHECKLIST.md) | Dashboard UX parity checklist |
| [development/GITHUB_DISCOVERABILITY.md](development/GITHUB_DISCOVERABILITY.md) | GitHub-facing metadata and presentation guidance |
| [benchmarks/code-edit-format-benchmark.md](benchmarks/code-edit-format-benchmark.md) | Benchmark methodology and outputs |

### Runbooks

Prefer the `*_SAFELY` / manager-command runbooks for new work; the earlier short-name runbooks remain for continuity.

| Document | Purpose |
| --- | --- |
| [development/RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md](development/RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md) | Add a new `codex-multi-auth ...` command |
| [development/RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md](development/RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md) | Introduce a new config/settings field |
| [development/RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md](development/RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md) | Change routing or account-selection policy |
| [development/RUNBOOK_ADD_AUTH_COMMAND.md](development/RUNBOOK_ADD_AUTH_COMMAND.md) | Earlier notes for adding an auth-manager command |
| [development/RUNBOOK_ADD_CONFIG_FIELD.md](development/RUNBOOK_ADD_CONFIG_FIELD.md) | Earlier notes for introducing a config field |
| [development/RUNBOOK_CHANGE_ROUTING_POLICY.md](development/RUNBOOK_CHANGE_ROUTING_POLICY.md) | Earlier notes for changing routing/retry/fallback policy |

### Historical archive

Snapshot material kept for provenance — prefer current `development/` and `reference/` docs over these.

| Document | Purpose |
| --- | --- |
| [audits/README.md](audits/README.md) | Audit archive policy |
| [audits/MASTER_AUDIT.md](audits/MASTER_AUDIT.md) | Historical v1.2.7 audit snapshot |
| [audits/AUDIT_2026-06-10.md](audits/AUDIT_2026-06-10.md) | Repository audit, June 2026 |
| [audits/evidence/](audits/evidence/) | Audit evidence files |
| [development/implementation-plans/](development/implementation-plans/) | Local-governance implementation plans and subagent handoffs |
| [development/IA_FINDABILITY_AUDIT_2026-03-01.md](development/IA_FINDABILITY_AUDIT_2026-03-01.md) | IA and findability baseline audit |
| [development/DEEP_AUDIT_2026-03-01.md](development/DEEP_AUDIT_2026-03-01.md) | Deep audit baseline |
| [development/CLI_UI_DEEPSEARCH_AUDIT.md](development/CLI_UI_DEEPSEARCH_AUDIT.md) | CLI/UI audit notes |
| [development/CONTEXT_BUDGET_GUARD_PLAN.md](development/CONTEXT_BUDGET_GUARD_PLAN.md) | Context budget guard design plan |
| [design/earned-reset-credits.md](design/earned-reset-credits.md) | Earned reset credits design |
| [design/model-route-pools.md](design/model-route-pools.md) | Model route pools design |
| [design/model-route-pools-release.md](design/model-route-pools-release.md) | Model route pools release notes design |
| [design/model-route-pools-review.md](design/model-route-pools-review.md) | Model route pools design review |

## Release History

Current stable: [v2.19.1](releases/v2.19.1.md) (`npm i -g codex-multi-auth`). The `2.x` line is the current release line; earlier lines are kept as archives.

### 2.x

- **2.19.x** — [v2.19.1](releases/v2.19.1.md) · [v2.19.0](releases/v2.19.0.md)
- **2.18.x** — [v2.18.0](releases/v2.18.0.md)
- **2.17.x** — [v2.17.3](releases/v2.17.3.md) · [v2.17.2](releases/v2.17.2.md) · [v2.17.1](releases/v2.17.1.md) · [v2.17.0](releases/v2.17.0.md)
- **2.10 – 2.16** — [v2.16.0](releases/v2.16.0.md) · [v2.15.0](releases/v2.15.0.md) · [v2.14.0](releases/v2.14.0.md) · [v2.13.0](releases/v2.13.0.md) · [v2.12.0](releases/v2.12.0.md) · [v2.11.0](releases/v2.11.0.md) · [v2.10.0](releases/v2.10.0.md)
- **2.9.x** — [v2.9.2](releases/v2.9.2.md) · [v2.9.1](releases/v2.9.1.md) · [v2.9.0](releases/v2.9.0.md)
- **2.8.x** — [v2.8.7](releases/v2.8.7.md) · [v2.8.6](releases/v2.8.6.md) · [v2.8.5](releases/v2.8.5.md) · [v2.8.4](releases/v2.8.4.md) · [v2.8.3](releases/v2.8.3.md) · [v2.8.2](releases/v2.8.2.md) · [v2.8.1](releases/v2.8.1.md) · [v2.8.0](releases/v2.8.0.md)
- **2.7.x** — [v2.7.1](releases/v2.7.1.md) · [v2.7.0](releases/v2.7.0.md)
- **2.6.x** — [v2.6.1](releases/v2.6.1.md) · [v2.6.0](releases/v2.6.0.md)
- **2.5.x** — [v2.5.0](releases/v2.5.0.md)
- **2.4.x** — [v2.4.0](releases/v2.4.0.md)
- **2.3.x** — [v2.3.3](releases/v2.3.3.md) · [v2.3.2](releases/v2.3.2.md) · [v2.3.1](releases/v2.3.1.md) · [v2.3.0](releases/v2.3.0.md) · [v2.3.0-beta.3](releases/v2.3.0-beta.3.md) · [v2.3.0-beta.2](releases/v2.3.0-beta.2.md) · [v2.3.0-beta.1](releases/v2.3.0-beta.1.md) · [v2.3.0-beta.0](releases/v2.3.0-beta.0.md)
- **2.2.x** — [v2.2.2](releases/v2.2.2.md) · [v2.2.1](releases/v2.2.1.md) · [v2.2.0](releases/v2.2.0.md)
- **2.1.x** — [v2.1.13-beta.2](releases/v2.1.13-beta.2.md) · [v2.1.13-beta.1](releases/v2.1.13-beta.1.md) · [v2.1.13-beta.0](releases/v2.1.13-beta.0.md) · [v2.1.12](releases/v2.1.12.md) · [v2.1.11](releases/v2.1.11.md) · [v2.1.10](releases/v2.1.10.md) · [v2.1.9](releases/v2.1.9.md) · [v2.1.8](releases/v2.1.8.md) · [v2.1.7](releases/v2.1.7.md) · [v2.1.6](releases/v2.1.6.md) · [v2.1.5](releases/v2.1.5.md) · [v2.1.4](releases/v2.1.4.md) · [v2.1.3](releases/v2.1.3.md) · [v2.1.2](releases/v2.1.2.md) · [v2.1.1](releases/v2.1.1.md) · [v2.1.0](releases/v2.1.0.md)
- **2.0.x** — [v2.0.2](releases/v2.0.2.md) · [v2.0.1](releases/v2.0.1.md) · [v2.0.0](releases/v2.0.0.md)

### 1.x archive

- **1.3.x** — [v1.3.2](releases/v1.3.2.md) · [v1.3.1](releases/v1.3.1.md) · [v1.3.0](releases/v1.3.0.md)
- **1.2.x** — [v1.2.7](releases/v1.2.7.md) · [v1.2.6](releases/v1.2.6.md) · [v1.2.5](releases/v1.2.5.md) · [v1.2.4](releases/v1.2.4.md) · [v1.2.3](releases/v1.2.3.md) · [v1.2.2](releases/v1.2.2.md) · [v1.2.1](releases/v1.2.1.md) · [v1.2.0](releases/v1.2.0.md)
- **1.1.x** — [v1.1.11](releases/v1.1.11.md) · [v1.1.10](releases/v1.1.10.md)

### Pre-1.0 archive

- **0.1.x** — [v0.1.9](releases/v0.1.9.md) · [v0.1.8](releases/v0.1.8.md) · [v0.1.7](releases/v0.1.7.md) · [v0.1.6](releases/v0.1.6.md) · [v0.1.5](releases/v0.1.5.md) · [v0.1.4](releases/v0.1.4.md) · [v0.1.3](releases/v0.1.3.md) · [v0.1.2](releases/v0.1.2.md) · [v0.1.1](releases/v0.1.1.md) · [v0.1.0](releases/v0.1.0.md) · [v0.1.0-beta.0](releases/v0.1.0-beta.0.md)
- **Pre-0.1** — [legacy-pre-0.1-history.md](releases/legacy-pre-0.1-history.md) — archived pre-0.1 changelog history

## Project governance

- Project entry: [../README.md](../README.md)
- Changelog: [../CHANGELOG.md](../CHANGELOG.md)
- Contribution policy: [../CONTRIBUTING.md](../CONTRIBUTING.md)
- Code of conduct: [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
- Security policy: [../SECURITY.md](../SECURITY.md)
- License: [../LICENSE](../LICENSE)
