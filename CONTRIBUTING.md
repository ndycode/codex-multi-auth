# Contributing Guidelines

Thanks for contributing to `codex-multi-auth`.

This project prioritizes policy-compliant OAuth usage, predictable CLI behavior, strong regression coverage, and documentation parity.

---

## Scope And Compliance

All contributions must remain within this scope:

- official OAuth authentication flows only
- no token scraping, cookie extraction, or auth bypasses
- no rate-limit circumvention techniques
- no commercial multi-user resale features

If a proposal conflicts with OpenAI policy boundaries, it will be declined.

---

## Local Setup

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Node requirement: `>=18`.

---

## Development Standards

- TypeScript strict mode
- no `as any`, `@ts-ignore`, or `@ts-expect-error`
- behavior-focused tests for all user-visible changes
- docs updated when commands, flags, paths, defaults, or onboarding behavior change

For user-facing behavior changes, review these files at minimum:

- `README.md`
- `docs/getting-started.md`
- `docs/features.md`
- affected `docs/reference/*` files

---

## Tooling Stack

### Dual-Linter Scope (Biome + ESLint)

This repo runs **both** Biome and ESLint, each owning a different slice:

- **Biome (`biome.jsonc`)** — formatting + fast style checks. Pre-commit
  hook (via `lint-staged`) applies Biome formatting automatically on
  every staged change; that is why commits can touch adjacent lines for
  trailing-comma / wrap normalization.
- **ESLint (`eslint.config.js`)** — correctness rules: `no-explicit-any`,
  unused-var hygiene (`_` prefix), TypeScript-specific checks. Enforced
  in CI via `npm run lint`.

If the two tools disagree, Biome wins on formatting and ESLint wins on
correctness. Do not disable either one to silence conflicts — surface
the conflict in a PR so it can be resolved intentionally.

### `prepare` Hook Installs Husky On Every `npm install`

`package.json` `scripts.prepare` runs `husky` at install time to wire
the pre-commit hook. This is an install-time side effect: running
`npm install` or `npm ci` mutates `.git/hooks/`. That is intentional
for the `lint-staged` flow, but contributors should be aware:

- cloning the repo then running `npm install` will overwrite any
  custom pre-commit hook you had set locally
- running `npm install` in a CI container also runs `prepare`, which
  is why CI workflows often set `HUSKY=0` to disable it

Set `HUSKY=0` in environments where the hook install is undesirable.

---

## Pull Request Process

1. Create a focused branch from `main`.
2. Keep commits atomic and reviewable.
3. Run the full local gate:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run build`
4. Include command output evidence in the PR description.
5. Document behavior changes and migration notes when needed.
6. Ensure no secrets or local runtime data are committed.

Use `.github/pull_request_template.md` when opening the PR.

---

## Issues And Feature Requests

Before opening issues:

- search existing issues and PRs
- reproduce on the latest `main` when possible
- include exact commands, output, and environment data

For bug reports, include:

- `codex --version`
- `codex auth status`
- `codex auth report --json`
- `npm ls -g codex-multi-auth`

For feature requests, include:

- the user impact
- policy and compliance considerations
- alternatives considered

---

## Security Reporting

Do not open public issues for vulnerabilities.
Follow [SECURITY.md](SECURITY.md) for private disclosure.

---

## Code Of Conduct

This project expects respectful, evidence-based collaboration.
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## License

By contributing, you agree contributions are licensed under the project license in [LICENSE](LICENSE).
