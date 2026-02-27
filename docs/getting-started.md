# Getting Started

Install, sign in, and run your first healthy multi-account setup.

* * *

## Prerequisites

- Node.js `18+`
- Official Codex CLI package: `@openai/codex`
- This repository cloned locally

* * *

## Install (Source Workflow)

Bash:

```bash
npm install -g @openai/codex
git clone https://github.com/ndycode/codex-multi-auth.git
cd codex-multi-auth
npm install
npm run build
npm link
```

PowerShell:

```powershell
npm install -g @openai/codex
git clone https://github.com/ndycode/codex-multi-auth.git
Set-Location codex-multi-auth
npm install
npm run build
npm link
```

Verify command wiring:

```bash
codex --version
codex auth status
```

* * *

## Add Your First Account

```bash
codex auth login
```

Expected flow:

1. Dashboard opens.
2. Choose **Add New Account**.
3. OAuth page opens in browser.
4. After approval, return to terminal.
5. Your real email appears in the account list.

Check result:

```bash
codex auth list
```

* * *

## Add More Accounts

Run login again and add another account from the same dashboard.

```bash
codex auth login
```

After adding, run:

```bash
codex auth check
codex auth forecast --live
```

This confirms session health and shows the best next account.

* * *

## Day-1 Command Pack

```bash
codex auth list
codex auth switch 2
codex auth check
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix
codex auth report --live --json
```

* * *

## Optional: Plugin-Host Integration

`codex auth ...` works without any extra host config.

If you also run this project as a plugin-host integration, see the optional host config section in [configuration.md](configuration.md).

* * *

## Common First-Run Issues

If you see placeholder/demo email rows:

```bash
codex auth doctor --fix
codex auth list
```

If `codex auth` is not recognized:

```bash
where codex
codex multi auth status
```

If OAuth callback fails on port `1455`:

- Close other process using that port.
- Retry `codex auth login`.

* * *

## Next Steps

- [features.md](features.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
- [upgrade.md](upgrade.md)
