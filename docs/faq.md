# codex-multi-auth FAQ

Short answers for developers evaluating Codex CLI multi-account OAuth, account switching, local diagnostics, runtime rotation, governance, and recovery workflows in `codex-multi-auth`.

---

## Does this replace `@openai/codex`?

No. `codex-multi-auth` does not replace the official Codex CLI and does **not** publish a global `codex` binary. The official install path keeps owning `codex`. Use `codex-multi-auth ...` for account management, and use `codex-multi-auth-codex ...` or `mcodex ...` only when you intentionally want this package's forwarding wrapper.

---

## What problem does it solve?

It makes Codex CLI multi-account OAuth state visible and operable. Instead of relying on one hidden local auth state, you can sign into multiple ChatGPT-authenticated accounts, switch explicitly, run health checks, forecast account readiness, apply local pause/drain policies, and repair local storage issues.

---

## How is it different from the official Codex CLI alone?

The official Codex CLI owns the core coding experience and the `codex` binary. `codex-multi-auth` adds a separate local management layer for multiple OAuth accounts: account pool storage, explicit switching, health checks, forecasts, reports, repair commands, default-on runtime rotation for wrapper-launched sessions, local governance, and an optional loopback bridge.

---

## When should I use each binary?

| Binary | Use when |
| --- | --- |
| `codex-multi-auth` | Managing accounts: login, list, switch, check, forecast, rotation, usage, doctor, and other local commands |
| `codex-multi-auth-codex` | You want this package to forward official Codex commands with optional runtime rotation and shadow `CODEX_HOME` |
| `mcodex` | You want a short convenience launcher over the wrapper, with optional `--monitor` or `--tmux` / `-t` |
| `codex-multi-auth-app-launcher` | You need user-level desktop shortcut / macOS wrapper routing helpers |
| Official `codex` | You want the stock Codex CLI without this package's wrapper |

---

## What is `mcodex`?

`mcodex` is a convenience entrypoint over `codex-multi-auth-codex` (`scripts/codex.js`).

- Default: forward remaining args to the wrapper.
- `--monitor`: live-refresh `codex-multi-auth list` via `watch` (requires `watch` on PATH).
- `--tmux` / `-t`: open a tmux session running the wrapper (optional `--live-accounts`).

It does not replace the account manager; use `codex-multi-auth ...` for management commands.

---

## Do I need an OpenAI Platform API key?

Not for the ChatGPT-authenticated multi-account workflow in this repository. If you are building production applications or API integrations, use the OpenAI Platform API instead.

---

## Is the plugin runtime required?

No. Most users only need `codex-multi-auth ...` plus optional wrapper launches (`codex-multi-auth-codex` / `mcodex`). The plugin-host runtime is optional and uses the same account pool for advanced host request handling.

---

## Is runtime rotation required? Is it on by default?

Runtime rotation is **enabled by default** for request-bearing forwarded Codex CLI/app sessions launched through this package's wrapper or app bind. Disable it with `codex-multi-auth rotation disable`, `codexRuntimeRotationProxy=false`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` when you need plain official Codex forwarding without the local proxy.

---

## Does runtime rotation patch the Codex app?

No. The packaged app bind updates user-level Codex config and startup/router metadata and keeps a backup for restore. Official app binaries are not patched.

---

## Are pause and drain actually enforced?

Yes, on the runtime path. `codex-multi-auth account pause|drain <index>` updates local policy storage, and `evaluateRuntimePolicy` blocks paused or drained accounts during account selection in the runtime rotation proxy (and plugin-host path). They are not cosmetic dashboard labels.

---

## Where is account data stored?

By default, under `~/.codex/multi-auth`. Project-scoped account pools can also live under `~/.codex/multi-auth/projects/<project-key>/...`. Override the root with `CODEX_MULTI_AUTH_DIR` when needed. Credentials stay local on your machine.

---

## How do I force one account for a single Codex run?

Use the wrapper force-pin (ephemeral; does not change the persisted `switch` pin):

```bash
codex-multi-auth-codex --account 2 exec "…"
```

Or set `CODEX_MULTI_AUTH_FORCE_ACCOUNT`. The pin is fail-hard and requires the runtime rotation proxy to be active for that command.

---

## How do I recover quickly if something looks wrong?

```bash
codex-multi-auth doctor --fix
codex-multi-auth check
codex-multi-auth forecast --live
```

Then rerun `codex-multi-auth login` if the affected account still looks stale. For storage-only issues, prefer `codex-multi-auth fix --dry-run` before applying repairs.

---

## Who is this for?

This project is aimed at individual developers using the official Codex CLI who want more control over local account state, account switching, diagnostics, quota visibility, runtime rotation, local budgets/policies, and recovery.

---

## Is this intended for commercial multi-user services?

No. The repository is positioned for personal development workflows with your own accounts.

---

## Where should I start after this page?

- [getting-started.md](getting-started.md)
- [architecture.md](architecture.md)
- [features.md](features.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
