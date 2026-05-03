# GitHub Discoverability Guide

GitHub-facing audit and recommended presentation for `codex-multi-auth`.

---

## Product Summary

- Purpose: provide a Codex CLI multi-account OAuth manager, `codex-multi-auth ...` workflow, explicit account switching, health checks, diagnostics, recovery tooling, and default-on runtime Responses rotation proxy for forwarded official `@openai/codex` CLI/app sessions
- Target users: individual developers using the Codex CLI who want visible local account state, explicit account switching, health checks, quota-aware forecasts, local recovery tooling, optional project-scoped account pools, and live runtime rotation
- Not the target: commercial multi-user services, generic API users, or teams looking for a hosted auth layer

---

## Natural Search Terms

Developers looking for a tool like this are likely to search for:

- codex cli multi account
- codex multi auth manager
- chatgpt oauth codex cli
- codex account switching
- codex cli auth recovery
- codex cli terminal dashboard
- codex runtime rotation
- codex responses proxy
- codex multi account oauth
- project scoped codex accounts
- codex cli health check
- codex cli diagnostics
- codex account recovery
- codex oauth manager

These terms belong naturally in the README intro, feature list, and package metadata. They should not be stuffed into every heading.

---

## Recommended Repository Description

Use this as the GitHub repository description:

`Codex CLI multi-account OAuth manager with account switching, health checks, runtime rotation, diagnostics, and recovery tools for @openai/codex`

## Recommended README Title

Use a descriptive H1 rather than a bare package name when possible:

`codex-multi-auth: multi-account OAuth for the official Codex CLI`

---

## Recommended Topics

- codex
- codex-cli
- openai
- chatgpt
- oauth
- oauth2
- pkce
- multi-account
- cli
- terminal-ui
- typescript
- nodejs
- developer-tools
- authentication
- account-switching
- runtime-rotation
- responses-api
- diagnostics
- recovery-tools
- account-health
- quota-management
- productivity

---

## Suggested Badges

Useful badges:

- npm version
- CI status
- license

Avoid vanity badges unless they add real trust or decision value.

---

## Social Preview Concept

Use a clean text-first image with:

- project name: `codex-multi-auth`
- tagline: `Multi-account OAuth for the official Codex CLI`
- a simple visual of `codex-multi-auth login -> list -> switch -> rotation status`
- terminal-inspired styling rather than abstract marketing graphics

The image should immediately communicate:

- this is a CLI tool
- it works with the official Codex CLI
- it helps manage multiple accounts and can optionally rotate runtime requests

---

## High-Confidence Wording Rules

- First paragraph: say what it is, who it is for, and how it relates to the official Codex CLI.
- Feature bullets: lead with outcomes such as account switching, health checks, recovery, diagnostics, quota visibility, and runtime rotation.
- Metadata: keep package keywords and GitHub topics aligned with natural search terms.
- Trust: explain local-only storage, loopback runtime rotation, reversible app bind, and the independent/non-official boundary.
- Do not claim guaranteed GitHub ranking. The repo can improve relevance and click confidence, not control search placement.

---

## What Makes A Developer Star The Repo

- They understand the value in one screen: it gives the official Codex CLI explicit multi-account management.
- The quick start is short and credible.
- The project sounds honest about what it is and what it is not.
- Recovery and troubleshooting commands are visible, which increases trust.
- Docs answer common adoption questions without sending the reader through maintainer-only material.

---

## What Makes A Developer Leave The Repo

- The README reads like a command dump before it explains the product.
- The wrapper, runtime rotation proxy, and optional plugin-host distinction is unclear.
- Stale release pointers make the repo look unmaintained.
- First-run instructions are longer than they need to be.
- Governance exists, but standard community files or links are missing.

---

## Files Added Or Tightened In This Pass

- `README.md`
- `docs/getting-started.md`
- `docs/README.md`
- `docs/index.md`
- `docs/features.md`
- `docs/troubleshooting.md`
- `docs/faq.md`
- `docs/architecture.md`
- `CODE_OF_CONDUCT.md`
- `CHANGELOG.md`

---

## Before Vs After

Before:

- README opened with operational detail before the product explanation
- plugin and wrapper roles were blurred
- release pointers were stale
- FAQ and short public architecture pages were missing

After:

- README opens with a descriptive title, what the project is, why it exists, and how to start quickly
- the wrapper-plus-manager use case is primary, runtime rotation is default-on with explicit opt-out, and plugin-host mode is clearly positioned as optional
- public docs have a simpler path from install to FAQ to architecture to troubleshooting
- release and metadata guidance is explicit and current
