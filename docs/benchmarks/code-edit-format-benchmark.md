# Code Edit Format Benchmark

This benchmark compares code edit formats across Codex models using the same task corpus and validators.

Formats:
- `patch`
- `replace`
- `hashline`
- `hashline_v2` (benchmark-only experimental mode based on the PinEdit-style workflow)

Default model preset:
- `codex-core` (stable named `openai/*codex*` models discovered from local `opencode models`)

## Outputs

Each run writes artifacts under `.tmp-bench/<label>/`:
- `results/summary.json`
- `results/report.md`
- `results/dashboard.html`
- `logs/*.ndjson` (measured runs and failures by default)
- `workspaces/*` (per-run temp workspaces)

This keeps benchmark artifacts easy to delete later.

## Quick start

Smoke run (few tasks, 1 measured run, no warmup):

```bash
node scripts/benchmark-edit-formats.mjs --smoke --models=openai/gpt-5-codex
```

Fuller run on Codex core preset:

```bash
node scripts/benchmark-edit-formats.mjs --preset=codex-core --warmup-runs=1 --measured-runs=5
```

Use your existing provider config/home when required:

```bash
node scripts/benchmark-edit-formats.mjs --home="C:\\Users\\Administrator"
```

## Re-render dashboard from summary

```bash
node scripts/benchmark-render-dashboard.mjs --input=.tmp-bench/<label>/results/summary.json
```

## Notes on mode behavior

- `patch` mode expects filesystem patch/edit tools (for example `filesystem_edit_file`). If the model uses another tool family, the run is marked unsupported for patch-mode scoring.
- `replace` mode expects plugin edit payloads with `oldString/newString`.
- `hashline` mode expects `hashline_read` followed by a hash-anchored edit (`lineRef`).
- `hashline_v2` expects no tools and a single JSON edit call response in the benchmark-only PinEdit-style schema.

## Cleanup

Delete all benchmark artifacts:

```bash
rm -rf .tmp-bench
```

PowerShell:

```powershell
Remove-Item -Recurse -Force .tmp-bench
```
