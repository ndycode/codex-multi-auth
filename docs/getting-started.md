# Getting Started

Install `codex-multi-auth`, add accounts, and verify healthy routing.

---

## Prerequisites

- Node.js `18+`
- Official Codex CLI package: `@openai/codex`
- Active ChatGPT plan with the models you intend to use

---

## Install

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
```

If you previously used the scoped prerelease package:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

Validate command wiring:

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

1. Dashboard opens.
2. Select `Add New Account`.
3. Complete OAuth in browser.
4. Return to terminal.
5. Account appears in `Saved Accounts`.

Verify storage and active selection:

```bash
codex auth list
codex auth check
```

---

## Add More Accounts

Repeat login, then run a readiness check:

```bash
codex auth login
codex auth forecast --live
```

---

## Day-1 Command Pack

```bash
codex auth list
codex auth switch 2
codex auth check
codex auth forecast --live
codex auth fix --dry-run
codex auth fix --live --model gpt-5-codex
codex auth doctor --fix
codex auth report --live --json
```

---

## First-Run Issues

If `codex auth` is not recognized:

```bash
where codex
```

Then continue with [troubleshooting.md](troubleshooting.md#verify-install-and-routing) for routing fallback commands.

If OAuth callback on `1455` fails:

- Stop the process using port `1455`.
- Retry `codex auth login`.

If account data appears stale:

```bash
codex auth doctor --fix
codex auth check
```

---

## Next

- [features.md](features.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
