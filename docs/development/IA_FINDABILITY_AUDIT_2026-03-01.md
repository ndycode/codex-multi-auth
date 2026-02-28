# Information Architecture: CLI + Docs Findability Audit (2026-03-01)

Scope: user-facing command taxonomy, runtime help labels, docs navigation hierarchy, and naming consistency.

Evidence sources:
- Runtime command/help surfaces: `lib/codex-manager.ts`, `scripts/codex-routing.js`
- Docs navigation/reference surfaces: `README.md`, `docs/README.md`, `docs/reference/commands.md`, `docs/troubleshooting.md`, `docs/getting-started.md`, `docs/releases/v0.1.1.md`
- Governance/test contracts: `docs/DOCUMENTATION.md`, `docs/STYLE_GUIDE.md`, `test/documentation.test.ts`

---

## Current Structure

### Runtime command taxonomy (current)

- `codex auth <subcommand>` (canonical)
  - Primary: `login`, `list`, `status`, `switch`, `check`, `features`
  - Advanced: `verify-flagged`, `forecast`, `report`, `fix`, `doctor`
- Compatibility aliases:
  - `codex multi auth ...`
  - `codex multi-auth ...`
  - `codex multiauth ...`
- Runtime usage labels before this audit mixed canonical and package-prefixed forms in help/error paths.
  - Prior `printUsage()` output in `lib/codex-manager.ts` used package-prefixed forms such as `codex-multi-auth auth fix [--dry-run] [--json] [--live] [--model <model>]`.
  - Prior `runSwitch()` error text in `lib/codex-manager.ts` used `Missing index. Usage: codex-multi-auth auth switch <index>`.
  - Post-fix regression baseline is now asserted in `test/documentation.test.ts` by checking canonical `codex auth ...` usage and switch-error strings.

### Docs hierarchy (current)

- Product entry
  - `README.md`
- Docs portal
  - `docs/README.md`
- User operations
  - `docs/index.md`
  - `docs/getting-started.md`
  - `docs/troubleshooting.md`
  - `docs/configuration.md`
  - `docs/features.md`
  - `docs/privacy.md`
  - `docs/upgrade.md`
- Reference
  - `docs/reference/commands.md`
  - `docs/reference/settings.md`
  - `docs/reference/storage-paths.md`
- Releases
  - `docs/releases/v0.1.1.md`
  - `docs/releases/v0.1.0.md`
  - `docs/releases/v0.1.0-beta.0.md`
  - `docs/releases/legacy-pre-0.1-history.md`

Hierarchy depth is 3 or fewer levels.

---

## Task-to-Location Mapping (Current)

Scoring rubric:
- `Match`: task is discoverable in the expected location within one navigation hop.
- `Near-miss`: task is discoverable but appears in unexpected locations or requires extra context-switch hops.
- `Lost`: task is not discoverable through expected navigation.

| User Task | Expected Location | Actual Location | Findability |
| --- | --- | --- | --- |
| Log in first account | `README.md` quick start / `docs/getting-started.md` | Match | Match |
| Find all auth commands and flags | `docs/reference/commands.md` | Match | Match |
| Understand alias availability | `docs/reference/commands.md` (or troubleshooting fallback) | Also shown in `README.md` and `docs/getting-started.md` | Near-miss |
| Interpret CLI usage output | Canonical `codex auth ...` labels | Mixed with `codex-multi-auth auth ...` in runtime usage strings | Near-miss |
| Check current stable release notes | `docs/releases/v0.1.1.md` via docs portal reference | `docs/README.md` reference table labeled `v0.1.0` as current stable | Near-miss |
| Find scoped legacy package guidance | Migration docs only (`docs/upgrade.md`, selected troubleshooting) | Also surfaced in stable release notes `docs/releases/v0.1.1.md` | Near-miss |

Findability score (core tasks): 2/6 clear first-attempt match.

Near-miss to remediation traceability:
- `Understand alias availability` -> resolved by scoping aliases to reference/troubleshooting/migration surfaces and removing alias examples from primary onboarding flows.
- `Interpret CLI usage output` -> resolved by canonicalizing runtime help and error usage strings to `codex auth ...` in `lib/codex-manager.ts`.
- `Check current stable release notes` -> resolved by updating docs portal stable pointer to `docs/releases/v0.1.1.md`.
- `Find scoped legacy package guidance` -> resolved by keeping scoped-package references in migration contexts and removing them from stable release notes.

---

## Naming Inconsistencies Found

| Concept | Variant A | Variant B | Recommended |
| --- | --- | --- | --- |
| Canonical command label | `codex auth ...` | `codex-multi-auth auth ...` | `codex auth ...` for all primary user-facing help text |
| Alias placement policy | Reference/troubleshooting intent | Also in primary README/getting-started command flows | Keep aliases in reference/troubleshooting/migration contexts only |
| Stable release pointer | `v0.1.1` in user guides | `v0.1.0` labeled current stable in docs reference table | Use `v0.1.1` as current stable consistently |
| Scoped legacy package mention | Migration-only contexts | Stable release notes mention | Keep scoped package guidance migration-only |

---

## Proposed Structure

### Navigation model

- Keep existing shallow hierarchy and layer model.
- Enforce one canonical location per task category:
  - "How to run commands": `docs/reference/commands.md`
  - "Fallback routing or alias recovery": `docs/troubleshooting.md`
  - "Migration from legacy package/path": `docs/upgrade.md`
  - "Current stable release": `docs/releases/v0.1.1.md`

### Labeling model

- Canonical command wording in runtime help/error text: `codex auth ...`
- Compatibility alias wording restricted to reference/troubleshooting/migration sections.
- Scoped legacy package guidance restricted to migration contexts.

---

## Migration Path

1. Canonicalize runtime usage/error strings to `codex auth ...`.
2. Remove alias examples from primary README/onboarding flows; keep fallback routing guidance in troubleshooting/reference.
3. Correct docs portal reference table to current stable release (`v0.1.1`).
4. Remove scoped package mention from stable release notes and point to upgrade guide for migration details.
5. Maintain deterministic regression checks in `test/documentation.test.ts`:
   - `uses scoped package only in explicit legacy migration notes` enforces scoped package boundaries.
   - `keeps compatibility command aliases scoped to reference, troubleshooting, or migration docs` enforces alias-visibility boundaries with explicit allowlist files.
   - `keeps canonical auth usage labels aligned across README, reference, and CLI usage text` enforces canonical runtime help/error wording.
   - Keep cross-platform verification requirements explicit: Windows-oriented validation patterns (for example HOME/USERPROFILE handling and Windows path guidance checks already exercised in the CODEX config precedence test block) must be extended whenever new shell-sensitive command rendering is introduced.

---

## Task-to-Location Mapping (Proposed)

| User Task | Location | Findability Improvement |
| --- | --- | --- |
| Run login/switch/check commands | `README.md` and `docs/getting-started.md` with canonical labels | Removes mixed labels in first-run paths |
| Discover full command/flag matrix | `docs/reference/commands.md` | Retains single authoritative command catalog |
| Recover from command routing problems | `docs/troubleshooting.md` | Alias fallback remains discoverable but contextual |
| Verify current stable release | `docs/README.md` -> `docs/releases/v0.1.1.md` | Eliminates stale stable-pointer ambiguity |
| Migrate from scoped legacy package | `docs/upgrade.md` | Prevents legacy naming bleed into stable operational docs |

Target findability score for core tasks after remediation: 6/6 first-attempt match.

---

## Out of Scope

- Visual design or formatting redesign.
- Runtime behavior changes to command routing/alias support.
- Internal module naming unrelated to user-facing findability.
