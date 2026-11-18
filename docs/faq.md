# codex-multi-auth FAQ

Short answers for anyone evaluating `codex-multi-auth` or getting started with multi-account Codex CLI use.

---

## Does this replace the Codex CLI?

No. `codex-multi-auth` never installs a `codex` binary — that name belongs to the official install (`@openai/codex`). This package adds a local account manager plus an optional wrapper that forwards commands to the official CLI.

---

## Which command do I run?

| Command | Use it to |
| --- | --- |
| `codex-multi-auth …` | Manage accounts: login, list, switch, check, forecast, doctor, budgets |
| `codex-multi-auth-codex …` | Run Codex through the wrapper, with account rotation on by default |
| `mcodex …` | Same wrapper, shorter name; adds `--monitor` and `--tmux` / `-t` |
| `codex …` | Plain official CLI, no wrapper |

`mcodex` is a launcher only — it forwards to `codex-multi-auth-codex` and does no account management of its own.

---

## How does login work?

Browser OAuth with PKCE by default. `codex-multi-auth login` opens a sign-in tab; after you approve, the browser redirects to a temporary listener on `localhost:1455` that captures the code and exchanges it for tokens.

No usable browser or callback? Two fallbacks:

- `codex-multi-auth login --device-auth` prints `https://auth.openai.com/codex/device` and a one-time code (valid 15 minutes) — approve it in any browser; nothing binds a local port.
- `codex-multi-auth login --manual` lets you paste the full redirect URL.

Repeat per account; the pool holds up to 20.

---

## How does rotation work?

Request-bearing Codex sessions launched through the wrapper route through a loopback-only proxy that picks a managed account per request. It honors a pin first, otherwise scores accounts by health, quota headroom, and time since last use. On a rate limit, auth failure, or server error it rotates to another account before response bytes stream back.

Rotation is **on by default**. Turn it off with `codex-multi-auth rotation disable` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`; check it with `codex-multi-auth rotation status`.

---

## Where is my data?

Under `~/.codex/multi-auth/` — the account pool (`openai-codex-accounts.json`, mode `0600`), settings, quota cache, usage ledger, policies, and backups. Per-repo pools live under `projects/<project-key>/`. `CODEX_MULTI_AUTH_DIR` moves the whole root. The official CLI's own files stay under `~/.codex/`.

Nothing leaves the machine except the OAuth and backend calls themselves. See [privacy.md](privacy.md).

---

## Do I need an OpenAI Platform API key?

No. Accounts sign in with ChatGPT OAuth, exactly like the official CLI's own login. API keys are only relevant for the optional `login --api` credential path and unrelated to normal multi-account use.

---

## Does it patch the Codex desktop app?

No. The optional app bind edits user-level config and installs a local router — reversible with `codex-multi-auth rotation unbind-app`. Official app binaries are never modified.

---

## Can I force one account?

- Per run: `codex-multi-auth-codex --account <index|email|id>` — ephemeral pin for that invocation only.
- Persistently: `codex-multi-auth switch <index>` — stays pinned until `codex-multi-auth unpin`.

---

## Are pause and drain real?

Yes. `codex-multi-auth account pause <index>` and `drain <index>` write to the local policy store, and the rotation path enforces them — a paused or drained account is skipped during selection. They are not cosmetic labels.

---

## Do pause/drain and budgets affect plain `codex`?

No. Policies are enforced on the rotation path — sessions launched through `codex-multi-auth-codex`, `mcodex`, or the app bind. A direct `codex` launch uses whatever account is synced to `~/.codex/auth.json`.

---

## Something looks broken — where do I start?

```bash
codex-multi-auth doctor --fix
codex-multi-auth check
```

If a specific account stays stale, re-login it with `codex-multi-auth login --account <index|email|id>`. For named symptoms, go to [troubleshooting.md](troubleshooting.md).

---

## Is this for teams or hosted services?

No. It targets individual developers running the official Codex CLI with their own accounts. All state is local; there is no multi-user surface.

---

## How does the vocabulary map to `oc-codex-multi-auth`?

The sibling project [oc-codex-multi-auth](https://github.com/ndycode/oc-codex-multi-auth) is an OpenCode plugin rather than a Codex CLI manager. Where the same idea has a different name there:

| Here | oc-codex-multi-auth |
| --- | --- |
| `check --prime`, `account auto-prime` — start windows on unused subscriptions | `codex-warm` / `warm` — open every enabled account's usage window |
| Earned reset credits (`resets`) | Banked reset credits (`codex-reset`) |
| Flagged (sidelined) account | Flagged (quarantined) account |
| Quota window | Usage window / quota window |
| `debug bundle` | `codex-diag` — redacted diagnostic snapshot |
| `check` — live health probe | `codex-health` / `health` — local health summary |

---

## Related

- [getting-started.md](getting-started.md)
- [features.md](features.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
