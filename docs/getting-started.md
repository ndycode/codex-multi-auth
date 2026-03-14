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

If interactive `codex auth login` starts with zero saved accounts and recoverable named backups in your `backups/` directory, the login flow will prompt you to restore before opening OAuth. Confirm to launch the existing restore manager; skip to proceed with a fresh login. The prompt is suppressed in non-interactive/fallback flows and after same-session `fresh` or `reset` actions.

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

---

## Next

- [faq.md](faq.md)
- [architecture.md](architecture.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
