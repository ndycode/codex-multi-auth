# Contributing Guidelines

Thanks for contributing to `codex-multi-auth`.

This project prioritizes: policy-compliant OAuth usage, predictable CLI behavior, strong regression coverage, and documentation parity.

---

## Scope and Compliance

All contributions must remain within this scope:

- Official OAuth authentication flows only.
- No token scraping, cookie extraction, or auth bypasses.
- No rate-limit circumvention techniques.
- No commercial multi-user resale features.

If a proposal conflicts with OpenAI policy boundaries, it will be declined.

---

## Local Setup

```bash
npm run doctor:dev
npm run setup:dev
```

Node requirement: `>=18`.

---

## Development Standards

Code quality requirements:

- TypeScript strict mode.
- No `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Keep behavior-focused tests for all user-visible changes.
- Keep docs aligned when commands, flags, paths, or defaults change.

Documentation requirements for behavior changes:

- `README.md`
- `docs/getting-started.md`
- `docs/features.md`
- affected `docs/reference/*` files

---

## Pull Request Process

1. Create a focused branch from `main`.
2. Keep commits atomic and reviewable.
3. Run full local gate:
   - `npm run doctor:dev`
   - `npm run setup:dev`
   - `npm run test -- test/documentation.test.ts`
4. If triaging failures, run component gates directly:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run build`
5. Include command output evidence in the PR description.
6. Document behavior changes and migration notes when needed.
7. Ensure no secrets or local runtime data are committed.

Use `.github/pull_request_template.md` when opening the PR.

---

## Issue and Feature Requests

Before opening issues:

- Search existing issues and PRs.
- Reproduce on latest `main` when possible.
- Include exact commands, output, and environment data.

For bug reports, include:

- `codex --version`
- `codex auth status`
- `codex auth report --json`
- `npm ls -g codex-multi-auth`

For feature requests, include:

- user impact
- policy/compliance consideration
- alternatives considered

---

## Security Reporting

Do not open public issues for vulnerabilities.
Follow [SECURITY.md](SECURITY.md) for private disclosure.

---

## Code of Conduct

Expected behavior:

- respectful, constructive communication
- technically grounded discussions
- clear reproduction and evidence when reporting issues

Unacceptable behavior:

- requests to violate policy boundaries
- credential sharing or unsafe guidance
- abusive or hostile communication

---

## License

By contributing, you agree contributions are licensed under the project license in [LICENSE](LICENSE).
