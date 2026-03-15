# Advanced Plugin Install

Use this guide only when you need more than the default local `codex auth ...` account-manager flow.

---

## When To Use This Path

Choose this advanced path when you explicitly need one of these:

- the official Codex host/runtime alongside `codex-multi-auth`
- forwarded non-auth `codex` commands
- the optional plugin runtime described in [architecture.md](architecture.md)

If you only need account login, switching, checks, and diagnostics, stop at [getting-started.md](getting-started.md).

---

## Safety Notes

> [!CAUTION]
> This installer edits global Codex config, creates a backup, and clears the Codex plugin cache.
> It should be treated as an operator action, not something an LLM agent runs automatically.

> [!NOTE]
> Browser-driven auth commands such as `codex auth login` still require a human to complete the OAuth step.

---

## What The Installer Changes

`scripts/install-codex-auth.js` does all of the following:

- writes or updates the global Codex config
- ensures `plugin: ["codex-multi-auth"]` is present
- backs up an existing config before replacing it
- clears the cached plugin install unless `--no-cache-clear` is used

The default target is `~/.config/Codex/Codex.json`.

---

## Prerequisites

- Node.js `18+`
- `codex-multi-auth` installed or checked out locally
- the official Codex host/runtime already available on the machine

---

## Source Checkout Flow

From a local checkout of this repository:

```bash
node scripts/install-codex-auth.js --modern
```

Legacy Codex versions can use:

```bash
node scripts/install-codex-auth.js --legacy
```

---

## Installed Package Flow

If you installed the package globally and need the packaged installer script, first locate the global package root and then run the script from there.

POSIX shells:

```bash
node "$(npm root -g)/codex-multi-auth/scripts/install-codex-auth.js" --modern
```

PowerShell:

```powershell
node (Join-Path (npm root -g) "codex-multi-auth/scripts/install-codex-auth.js") --modern
```

---

## Verify The Setup

After the installer finishes:

```bash
codex auth status
codex auth check
codex auth forecast --live
```

If you are debugging command routing, use the shell-appropriate lookup command:

```bash
where codex
which codex
```

Use whichever one exists on your shell.

---

## Related

- [getting-started.md](getting-started.md)
- [architecture.md](architecture.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
