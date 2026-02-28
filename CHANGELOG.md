# Changelog

All notable changes to this project are documented in this file.
Dates use ISO format (`YYYY-MM-DD`).

This repository's canonical public release line is currently `0.x`.

## [Unreleased]

### Changed

- Documentation architecture updated to dual-track navigation (operator and maintainer paths).
- Command, settings, storage, privacy, and troubleshooting references aligned for stronger runtime parity.
- Governance templates upgraded for production-grade issue and PR hygiene.

### Added

- Archived pre-`0.1.0` historical changelog in `docs/releases/legacy-pre-0.1-history.md`.

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