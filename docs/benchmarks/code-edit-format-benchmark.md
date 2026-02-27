# Code Edit Format Benchmark

Benchmark guide for comparing edit format performance and render behavior.

* * *

## Purpose

Use this benchmark to compare edit-format throughput and output quality for Codex-focused editing workloads.

* * *

## Quick Start

```bash
npm run bench:edit-formats
```

Smoke run:

```bash
npm run bench:edit-formats:smoke
```

Render dashboard output:

```bash
npm run bench:edit-formats:render
```

* * *

## Output Files

| Output | Location |
| --- | --- |
| Benchmark report JSON | `.tmp/edit-format-benchmark-*.json` |
| Render preview artifacts | `.tmp/edit-format-benchmark-render-*.txt` |

(Temporary benchmark artifacts are not source files.)

* * *

## Common Presets

| Preset | Goal |
| --- | --- |
| `codex-core` | Baseline Codex-oriented evaluation |
| `smoke` | Fast sanity check for CI/local validation |

* * *

## Interpretation Checklist

1. Compare latency per format.
2. Measure token/size overhead.
3. Review success/error rates.
4. Validate output consistency.
5. Confirm no regressions in editing fidelity.

* * *

## Cleanup

Bash:

```bash
rm -rf .tmp
```

PowerShell:

```powershell
Remove-Item ".tmp" -Recurse -Force -ErrorAction SilentlyContinue
```

* * *

## Related

- [../development/TESTING.md](../development/TESTING.md)
- [../development/ARCHITECTURE.md](../development/ARCHITECTURE.md)
