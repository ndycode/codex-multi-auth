# Getting Started With codex-multi-auth

`codex-multi-auth` manages several ChatGPT-signed-in Codex accounts on one machine. It keeps a local account pool, switches the active account, checks quota and health, and — when you run Codex through its wrapper — rotates between accounts on each request.

---

## What You Need

| Requirement | Notes |
| --- | --- |
| Node.js `22.19+` | Any current LTS works |
| Official Codex CLI | `npm i -g @openai/codex`, or another install that puts `codex` on `PATH` |
| A ChatGPT plan | Each account you add signs in with its own ChatGPT credentials |

---

## Install

```bash
npm i -g codex-multi-auth
```

Verify the install:

```bash
codex-multi-auth --version
codex-multi-auth status
```

Upgrading from the old prerelease package? See [the legacy note in upgrade.md](upgrade.md#migrate-from-the-legacy-package).

---

## The Commands

| Command | What it does |
| --- | --- |
| `codex-multi-auth` | The account manager: login, list, switch, check, forecast, doctor, and other local commands |
| `codex-multi-auth-codex` | Forwards commands to the official Codex CLI, with account rotation on by default |
| `mcodex` | Short launcher for the wrapper; same forwarding plus `--monitor` and `--tmux` / `-t` extras |
| `codex` | Still the official CLI. This package never installs a `codex` binary |

---

## What Happens On First Run

The first `codex-multi-auth` command from a global install performs one-time setup, then writes a marker at `~/.codex/multi-auth/first-run-setup.json` so it never runs again:

- binds a detected Codex desktop app to the local rotation router (reversible; no app files are patched)
- installs user-level app launcher routing where supported
- makes sure the official CLI reads credentials from its file store

All of it is best-effort — a failure never blocks the command. `npx` runs, project-local installs, and CI environments skip this setup entirely.

To opt out, set these before the first run:

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_APP_BIND=0` or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` | Skip the packaged-app bind |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` | Skip launcher routing install |

---

## Log In

```bash
codex-multi-auth login
```

The default flow is browser OAuth with PKCE:

1. The login opens a sign-in menu; choose the browser option.
2. A browser tab opens to OpenAI's sign-in page.
3. After you approve, the browser redirects to `http://localhost:1455/auth/callback`, where a temporary local listener captures the code. The listener binds both `127.0.0.1` and `::1`; if anything already holds the port on either, it reports the conflict instead of half-listening.
4. The account lands in the pool and the menu returns.

If a browser can't reach the callback — headless shell, SSH, container, or the port is taken — use the device-code flow, which binds no local port:

```bash
codex-multi-auth login --device-auth
```

It prints `https://auth.openai.com/codex/device` and a one-time code. Enter the code in any browser and leave the terminal running until login completes; the code is valid for 15 minutes.

If device auth is unavailable, paste the callback URL by hand:

```bash
codex-multi-auth login --manual
```

Once the pool has accounts, plain `codex-multi-auth login` opens a dashboard instead — add accounts, re-auth a stale one, check health, or restore a named backup.

---

## Add Accounts And Manage The Pool

Run `codex-multi-auth login` once per account (the pool holds up to 20). To bind a login to a specific org or workspace:

```bash
codex-multi-auth login --org <org_id>
```

Day-one commands:

```bash
codex-multi-auth list              # the pool, quota, and flags
codex-multi-auth switch 2          # pin account #2 as active
codex-multi-auth unpin             # drop the pin, resume automatic selection
codex-multi-auth check             # health plus quota windows
codex-multi-auth forecast --live   # best account for the next session (live probes)
codex-multi-auth status            # pool, rotation state, runtime markers
```

To re-authenticate one account without disturbing the rest:

```bash
codex-multi-auth login --account <index|email|id>
```

---

## Run Codex With Rotation

Launch Codex through the wrapper and the runtime rotation proxy picks a managed account for each request:

```bash
codex-multi-auth-codex
# or
mcodex
```

The proxy is on by default and listens only on loopback. It selects a healthy account, refreshes its token when needed, forwards the request upstream, and rotates to another account on rate limits, auth failures, or server errors — before response bytes stream back.

Force one account for a single run (ephemeral; does not change the `switch` pin):

```bash
codex-multi-auth-codex --account 2
```

Inspect and control rotation:

```bash
codex-multi-auth rotation status     # enabled? bound? per-account state
codex-multi-auth rotation disable    # turn it off and remove the app bind
codex-multi-auth rotation enable     # turn it back on
```

---

## Where Your Data Lives

| Data | Path |
| --- | --- |
| Account pool (V3 format, mode `0600`) | `~/.codex/multi-auth/openai-codex-accounts.json` |
| Per-project pools | `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json` |
| Settings, quota cache, usage ledger, policies, backups | `~/.codex/multi-auth/` |
| Official Codex state | `~/.codex/auth.json`, `~/.codex/accounts.json`, `~/.codex/config.toml` |

`CODEX_MULTI_AUTH_DIR` moves the whole multi-auth root. Linked git worktrees share their repository's project pool, so a worktree never needs its own login. Credentials stay on your machine — see [privacy.md](privacy.md).

---

## If Something Breaks

```bash
codex-multi-auth doctor --fix
codex-multi-auth check
```

That diagnoses and repairs the common local problems. For specific symptoms — port `1455` conflicts, token errors, rotation failures, uninstall cleanup — see [troubleshooting.md](troubleshooting.md).

---

## Next

- [features.md](features.md) — the full capability map
- [faq.md](faq.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
