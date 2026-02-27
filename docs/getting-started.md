# Getting Started

Install, sign in, and run your first healthy multi-account setup.

---

## Prerequisites

- Node.js `18+`
- Official Codex CLI package: `@openai/codex`

---

## Install (npm)

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
```

If you previously installed the scoped prerelease package, remove it first:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

Verify command wiring:

```bash
codex --version
codex auth status
```

---

## Add Your First Account

```bash
codex auth login
```

Expected flow:

1. Dashboard opens.
2. Choose **Add New Account**.
3. Complete OAuth in browser.
4. Return to terminal.
5. Your real email appears in account list.

Check result:

```bash
codex auth list
```

---

## Add More Accounts

```bash
codex auth login
codex auth check
codex auth forecast --live
```

---

## Day-1 Commands

```bash
codex auth list
codex auth switch 2
codex auth check
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix
codex auth report --live --json
```

---

## First-Run Problems

If `codex auth` is not recognized:

```bash
where codex
codex multi auth status
```

If OAuth callback on `1455` fails:

- Close conflicting process on port `1455`
- Retry `codex auth login`

---

## Next

- [features.md](features.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
- [upgrade.md](upgrade.md)
