# FAQ

Short answers for developers evaluating `codex-multi-auth`.

---

## Does this replace `@openai/codex`?

No. `codex-multi-auth` wraps the official `@openai/codex` CLI. It handles `codex auth ...` locally and forwards the rest of the `codex` workflow to the official CLI.

---

## What problem does it solve?

It makes multi-account OAuth state visible and operable. Instead of relying on one hidden local auth state, you can sign into multiple accounts, switch explicitly, run health checks, and repair local storage issues.

---

## Do I need an OpenAI Platform API key?

Not for the ChatGPT-authenticated multi-account workflow in this repository. If you are building production applications or API integrations, use the OpenAI Platform API instead.

---

## Is the plugin runtime required?

No. Many users only need the wrapper and `codex auth ...` commands. The plugin-host runtime is optional and uses the same account pool for advanced host request handling.

---

## Is runtime rotation required?

Runtime rotation is enabled by default for request-bearing forwarded Codex CLI/app sessions. Disable it with `codex auth rotation disable`, `codexRuntimeRotationProxy=false`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` when you need plain official Codex forwarding.

---

## Does runtime rotation patch the Codex app?

No. The packaged app bind updates user-level Codex config and startup/router metadata and keeps a backup for restore. Official app binaries are not patched.

---

## Who is this for?

This project is aimed at individual developers using the official Codex CLI who want more control over local account state, switching, diagnostics, and recovery.

---

## Is this intended for commercial multi-user services?

No. The repository is positioned for personal development workflows with your own accounts.

---

## Where is account data stored?

By default, under `~/.codex/multi-auth`. Project-scoped account pools can also live under `~/.codex/multi-auth/projects/<project-key>/...`.

---

## How do I recover quickly if something looks wrong?

Run:

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
```

Then rerun `codex auth login` if the affected account still looks stale.

---

## Where should I start after this page?

- [getting-started.md](getting-started.md)
- [architecture.md](architecture.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
