# Dimension F — Config / Settings / Precedence + Dual-Linter

HEAD 1f6da97, v1.2.7.

**Composed by Atlas** from Wave 1 evidence + README.md env table + repository inspection. Redo subagent produced skeleton only.

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| F-01 | HIGH | `loadPluginConfig()` does NOT prefer primary CONFIG_PATH over CODEX_HOME legacy path when both exist — test failure on current HEAD | `test/plugin-config.test.ts:417` (failing test, captured in `docs/audits/evidence/test-summary.txt`) | confirmed |
| F-02 | MEDIUM | Dual linter stack: `eslint.config.js` and `biome.jsonc` both present without documented scope separation | Repo root file listing; `package.json` scripts | confirmed |
| F-03 | MEDIUM | `prepare` script runs `husky` on every `npm install` — mutates `.git/hooks/` as install side-effect | `package.json` (`scripts.prepare`) | confirmed |
| F-04 | MEDIUM | Env var surface is substantial (11+ vars per README table) but no central env-validation schema — each consumer parses independently | README.md "Configuration" section lists `CODEX_MULTI_AUTH_DIR`, `CODEX_MULTI_AUTH_CONFIG_PATH`, `CODEX_MODE`, `CODEX_TUI_V2`, `CODEX_TUI_COLOR_PROFILE`, `CODEX_TUI_GLYPHS`, `CODEX_AUTH_BACKGROUND_RESPONSES`, `CODEX_AUTH_FETCH_TIMEOUT_MS`, `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS`, `CODEX_AUTH_NO_BROWSER` | probable |
| F-05 | MEDIUM | Settings writes use queued retry w/ EBUSY/EPERM/EAGAIN backoff (max 4 retries exponential) per AGENTS.md — verify retry ceiling is adequate for Windows antivirus lock scenarios | `lib/unified-settings.ts` per AGENTS.md §NOTES | probable |
| F-06 | LOW | Zod schema centralized in `lib/schemas.ts` (10 matches) — only one file defines schemas, while 59 raw `JSON.parse` calls exist in 31 files (cross-ref I-03 + I-04) | Cross-ref dim-I-types.md | confirmed |
| F-07 | LOW | README documents config precedence implicitly (runtime → file → env) but no formal precedence rule verified in `docs/reference/settings.md` | README.md + `docs/reference/settings.md` | probable |

## Verdicts
- **Precedence bug**: F-01 is confirmed HIGH regression needing fix before next release
- **Dual-linter**: adopt one, retire other OR document scope split (e.g., biome=format, eslint=correctness)
- **Env validation**: consider consolidating in `lib/schemas.ts` via `z.object(envSchema)` with `parse(process.env)` at startup
