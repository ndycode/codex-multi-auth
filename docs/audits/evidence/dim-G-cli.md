# Dimension G — CLI Manager + Settings-Hub + UX

HEAD 1f6da97, v1.2.7. Settings-hub reportedly 2100 LOC.

**Composed by Atlas** from Wave 1 evidence + README command toolkit + inventory. Redo subagent produced skeleton only.

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| G-01 | MEDIUM | `lib/codex-manager/settings-hub.ts` ~2100 LOC — overgrown single-concern file mixing theme, account, sync, diagnostics, experimental | AGENTS.md §WHERE TO LOOK, inventory.txt | confirmed |
| G-02 | MEDIUM | `auth list` empty-storage output drift — test expects "Storage was intentionally reset." but code produces "No accounts configured." / "Storage: <path>" / "Storage health: empty" | `test/codex-manager-cli.test.ts:913` (failing test) | confirmed |
| G-03 | MEDIUM | Command surface rich (10+ subcommands) but `--json` not uniform — README shows `--json` on `report`, `doctor`, `verify-flagged`; not verified on `list`, `switch`, `check`, `forecast`, `fix` | README.md "Advanced" section | probable |
| G-04 | LOW | Dashboard UX is coherent — documented hotkeys Q=cancel, Up/Down, Enter, 1-9, /, ? | README.md "Dashboard Hotkeys" | confirmed |
| G-05 | LOW | Theme live-preview + baseline restore on cancel per AGENTS.md §CONVENTIONS — good UX pattern; preserve | AGENTS.md §CONVENTIONS | confirmed |
| G-06 | MEDIUM | Bifurcation `lib/codex-cli/` and `lib/codex-manager/` coexist without documented boundary | AGENTS.md §STRUCTURE shows both | probable |
| G-07 | LOW | `codex auth doctor --fix` is canonical "safe recovery" — good trust pattern; preserve | README.md "Repair" | confirmed |
| G-08 | MEDIUM | Help discoverability not verified — README lists subcommands but `codex --help` enumeration parity unverified | Inferred | probable |
| G-09 | MEDIUM | Experimental settings labelled but no stability-promise policy — consumer may treat as stable inadvertently | README.md "Experimental Settings Highlights" | probable |

## Verdicts
- **Settings-hub split candidate**: sub-concern split (theme / accounts / sync / diagnostics / experimental), each <500 LOC
- **`auth list` bug**: G-02 live regression; fix expected message or code output
- **`--json` coverage**: audit each subcommand; standardize if inconsistent
- **codex-cli vs codex-manager**: document ownership or merge
