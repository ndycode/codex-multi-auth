# Getting Started With codex-multi-auth

Install the Codex CLI multi-account OAuth manager, add your first ChatGPT-authenticated account, and confirm that `codex-multi-auth ...` account switching, health checks, and diagnostics work locally.

---

## Prerequisites

- Node.js `18.17+`
- The official `@openai/codex` CLI
- A ChatGPT plan with access to the models you want to use

---

## Install

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
```

If you previously installed the old scoped prerelease package:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

Verify both installed surfaces:

- `codex --version` checks the official `@openai/codex` CLI that the manager can pair with.
- `codex-multi-auth --version` checks the installed manager package version.

```bash
codex --version
codex-multi-auth --version
codex-multi-auth status
```

---

## First Login

```bash
codex-multi-auth login
```

Expected flow:

1. If no accounts are saved yet, the terminal opens directly to the sign-in menu.
2. Choose `Open Browser (Easy)` for the normal OAuth flow.
3. Complete the official OAuth flow and return to the terminal.
4. Confirm the new account appears in the saved account list.

Verify the new account:

```bash
codex-multi-auth status
codex-multi-auth list
codex-multi-auth check
```

Choose the next account for your next session:

```bash
codex-multi-auth forecast --live
```

## Alternate Login Paths

Use these only when the normal browser-first flow is unavailable.

### Device auth login

For remote, SSH, container, or other headless shells, prefer the device-code flow:

```bash
codex-multi-auth login --device-auth
```

Open `https://auth.openai.com/codex/device` in any browser, enter the printed code, and keep the terminal running until login completes. The code expires after 15 minutes; rerun `codex-multi-auth login --device-auth` if it times out. This path does not open a local browser and does not start the local OAuth callback server.

`--device-auth` starts a new login directly. If you want to recover a saved backup first, run plain `codex-multi-auth login` so the onboarding restore menu can appear.

### Manual or no-browser login

If device auth is unavailable or you want to handle the callback manually:

```bash
codex-multi-auth login --manual
CODEX_AUTH_NO_BROWSER=1 codex-multi-auth login --manual
```

In non-TTY/manual shells, provide the full redirect URL on stdin:

```bash
echo "http://127.0.0.1:1455/auth/callback?code=..." | codex-multi-auth login --manual
```

`codex-multi-auth login` remains browser-first by default.

### Restore a saved backup during onboarding

Backup restore appears as `Restore Saved Backup` under the `Recover saved accounts` heading in the onboarding menu.

Use it when the current pool is empty and at least one valid named backup exists under `~/.codex/multi-auth/backups` by default, or under `%CODEX_MULTI_AUTH_DIR%\backups` if you override the storage root with `CODEX_MULTI_AUTH_DIR`.

When you choose `Restore Saved Backup`, the next menu lets you either:

- load the newest valid backup automatically
- pick a specific backup from a newest-first list

Empty, unreadable, or non-JSON backup sidecar files are skipped, so the menu entry appears only when at least one backup parses successfully and contains at least one account.

If you load a backup, the selected backup is restored, its active account is synced back into Codex CLI auth, and the login flow continues with that restored pool.

See upgrade note: [onboarding restore behavior](upgrade.md#onboarding-restore-note).

---

## Add More Accounts

Repeat `codex-multi-auth login` for each account you want to manage.

When you are done, choose the best account for the next session:

```bash
codex-multi-auth forecast --live
```

---

## Day-1 Command Pack

```bash
codex-multi-auth status
codex-multi-auth list
codex-multi-auth switch 2
codex-multi-auth check
codex-multi-auth forecast --live
```

---

## Runtime Rotation

Runtime rotation is enabled by default for request-bearing sessions launched through `codex-multi-auth-codex ...` or a configured app bind. The local Responses proxy can rotate managed accounts between forwarded official Codex CLI/app requests. Inspect it before relying on rotation for live sessions:

```bash
codex-multi-auth rotation status
```

To turn it off and restore the packaged app bind if one was installed:

```bash
codex-multi-auth rotation disable
```

---

## Project-Scoped Accounts

By default, account data lives under `~/.codex/multi-auth`.

If project-level account pools are enabled, `codex-multi-auth` stores them under:

`~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

Linked Git worktrees share the same repo identity so you do not need separate account pools per worktree path.

---

## First-Run Problems

If `codex-multi-auth` is not recognized:

```bash
where codex-multi-auth
```

Then continue with [troubleshooting.md](troubleshooting.md#verify-install-and-routing).

If the OAuth callback on port `1455` fails:

- stop the process using port `1455`
- rerun `codex-multi-auth login`
- if browser launch is unavailable, prefer `codex-multi-auth login --device-auth`
- if device auth is unavailable, rerun `codex-multi-auth login --manual`

If account state looks stale:

```bash
codex-multi-auth doctor --fix
codex-multi-auth check
```

---

## Next

- [index.md](index.md)
- [faq.md](faq.md)
- [architecture.md](architecture.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
