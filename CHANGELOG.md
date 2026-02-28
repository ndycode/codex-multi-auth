# Changelog

All notable changes to this project are documented in this file.
Dates use ISO format (`YYYY-MM-DD`).

This repository's canonical public release line is currently `0.x`.

## [0.1.1] - 2026-03-01

### Fixed

- OAuth callback host canonicalized to `127.0.0.1:1455` across auth constants and user-facing guidance (prevents localhost DNS mismatch).
- Account email dedup is now case-insensitive via `normalizeEmailKey()` (trim + lowercase).
- `codex` bin wrapper lazy-loads auth runtime so clean/global installs avoid early module-load failures.
- Per-project account storage shared across linked Git worktrees via `resolveProjectStorageIdentityRoot`.
- Legacy worktree-keyed accounts auto-migrated to canonical repo-shared storage; legacy files retained on persist failure.
- Windows filesystem safety: `removeWithRetry` with EBUSY/EPERM/ENOTEMPTY backoff added to `scripts/repo-hygiene.js` and test cleanup.
- Stream failover tests use fake timers for deterministic assertions (no real timeout flake).
- Coverage gate stabilized by excluding integration-heavy files and adding targeted branch tests.

### Changed

- CLI settings hub extracted from `lib/codex-manager.ts` into `lib/codex-manager/settings-hub.ts` (~2100 lines).
- Settings panel Q hotkey changed from save+back to cancel without save; theme live-preview restores baseline on cancel.
- Documentation architecture updated to dual-track navigation (operator and maintainer paths).
- Command, settings, storage, privacy, and troubleshooting references aligned for stronger runtime parity.
- Governance templates upgraded for production-grade issue and PR hygiene.
- `auth fix` help text now shows `--live` and `--model` flags.

### Added

- `scripts/repo-hygiene.js`: deterministic repo cleanup (`clean --mode aggressive`) and hygiene check (`check`), CI-gated.
- `lib/storage/paths.ts`: worktree identity resolution with commondir/gitdir validation, forged pointer rejection, Windows UNC support.
- Archived pre-`0.1.0` historical changelog in `docs/releases/legacy-pre-0.1-history.md`.
- `docs/development/CLI_UI_DEEPSEARCH_AUDIT.md`: settings extraction audit trail.
- PR template, modernized issue templates.
- 87 test files, 2071 tests (up from 85 files, 2002 tests).

## [0.1.0] - 2026-02-27

### Added

- Stable Codex-first multi-account OAuth workflow.
- Unified `codex auth ...` command family for login, switching, diagnostics, and reporting.
- Dashboard settings hub and backend reliability controls.
- Rotation and resilience modules for refresh, quota deferral, and failover.

### Validation

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Legacy History

Historical entries from pre-`0.1.0` internal iteration cycles are preserved in:

- `docs/releases/legacy-pre-0.1-history.md`

---

[0.1.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.0
[0.1.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.1