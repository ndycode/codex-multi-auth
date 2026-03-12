# Getting Started

Install `codex-multi-auth`, add an account, and confirm that `codex auth ...` is working.

---

## Prerequisites

- Node.js `18+`
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

Verify that the wrapper is active:

```bash
codex --version
codex auth status
```

---

## First Login

```bash
codex auth login
```

Expected flow:

1. The dashboard opens in the terminal.
2. Choose `Add New Account`.
3. Complete the official OAuth flow in your browser.
4. Return to the terminal when the browser step completes.
5. Confirm the account appears in the saved account list.

If you have named backups in `~/.codex/multi-auth/backups/` and no active accounts, the login flow can prompt you to restore before opening OAuth. Confirm to open `Restore From Backup`, review the recoverable backup list, and restore the entries you want. Skip the prompt to continue with a fresh login.

Verify the new account:

```bash
codex auth list
codex auth check
```

---

## Add More Accounts

Repeat `codex auth login` for each account you want to manage.

When you are done, choose the best account for the next session:

```bash
codex auth forecast --live
```

---

## Restore Or Start Fresh

Use the restore path when you already have named backup files and want to recover account state before creating new OAuth sessions.

- Automatic path: run `codex auth login`, then confirm the startup restore prompt when it appears
- Manual path: run `codex auth login`, then choose `Restore From Backup`
- Backup location: `~/.codex/multi-auth/backups/<name>.json`

The restore manager shows each backup name, account count, freshness, and whether the restore would exceed the account limit before it lets you apply anything.

If you already have an OpenCode pool on the same machine, choose `Import OpenCode Accounts` from the login dashboard recovery section to preview and import `~/.opencode/openai-codex-accounts.json` before creating new OAuth sessions.

---

## Sync And Settings

The settings flow is split into two productized sections:

- `Everyday Settings` for list appearance, details line, results and refresh behavior, and colors
- `Advanced & Operator` for `Codex CLI Sync` and backend tuning

Use `Codex CLI Sync` when you want to preview one-way sync from official Codex CLI account files before applying it. The sync screen shows source and target paths, preview summary, destination-only preservation, and backup rollback paths before apply.

---

## Day-1 Command Pack

```bash
codex auth status
codex auth list
codex auth switch 2
codex auth check
codex auth forecast --live
codex auth report --live --json
codex auth fix --dry-run
codex auth doctor --fix
```

---

## Project-Scoped Accounts

By default, account data lives under `~/.codex/multi-auth`.

If project-level account pools are enabled, `codex-multi-auth` stores them under:

`~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

Linked Git worktrees share the same repo identity so you do not need separate account pools per worktree path.

---

## First-Run Problems

If `codex auth` is not recognized:

```bash
where codex
```

Then continue with [troubleshooting.md](troubleshooting.md#verify-install-and-routing).

If the OAuth callback on port `1455` fails:

- stop the process using port `1455`
- rerun `codex auth login`

If account state looks stale:

```bash
codex auth doctor --fix
codex auth check
```

If you need a broader diagnostics snapshot:

```bash
codex auth report --live --json
```

---

## Next

- [faq.md](faq.md)
- [architecture.md](architecture.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
