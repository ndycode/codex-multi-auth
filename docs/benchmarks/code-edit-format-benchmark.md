# Code Edit Format Benchmark

Benchmark guide for edit format quality and reliability.

## Purpose

Compare edit formats across Codex-family models using the same tasks and validators.

Formats tested:

- `patch`
- `replace`
- `hashline`
- `hashline_v2` (benchmark-only experimental mode)

## Output Layout

Each run writes to `.tmp-bench/<label>/`:

| Path | Content |
| --- | --- |
| `results/summary.json` | Structured metrics |
| `results/report.md` | Markdown summary |
| `results/dashboard.html` | Visual dashboard |
| `logs/*.ndjson` | Per-run logs and failures |
| `workspaces/*` | Temporary run workspaces |

## Quick Start

Smoke test:

```bash
node scripts/benchmark-edit-formats.mjs --smoke --models=openai/gpt-5-codex
```

Preset run:

```bash
node scripts/benchmark-edit-formats.mjs --preset=codex-core --warmup-runs=1 --measured-runs=5
```

Use explicit home path if needed:

```bash
node scripts/benchmark-edit-formats.mjs --home="C:\\Users\\<you>"
```

## Dashboard Re-Render

```bash
node scripts/benchmark-render-dashboard.mjs --input=.tmp-bench/<label>/results/summary.json
```

## Format Semantics

| Mode | Expected behavior |
| --- | --- |
| `patch` | diff/patch-style tool usage |
| `replace` | deterministic `oldString/newString` edits |
| `hashline` | hashline anchored edit workflow |
| `hashline_v2` | single structured JSON edit output |

If a model/tooling combination cannot satisfy a mode, run is marked unsupported for that mode.

## Cleanup

Linux/macOS:

```bash
rm -rf .tmp-bench
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force .tmp-bench
```

## Related

- Script entrypoint: `scripts/benchmark-edit-formats.mjs`
- Dashboard renderer: `scripts/benchmark-render-dashboard.mjs`
- Task corpus helpers: `scripts/bench-format/`
