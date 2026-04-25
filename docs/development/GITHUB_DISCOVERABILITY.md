# GitHub Discoverability Guide

GitHub-facing audit and recommended presentation for `codex-multi-auth`.

---

## Product Summary

- Purpose: add a local multi-account OAuth manager, `codex auth ...` workflow, and default-on runtime Responses rotation proxy to the official `@openai/codex` CLI
- Target users: individual developers using the Codex CLI who want explicit account switching, health checks, local recovery tooling, optional project-scoped account pools, and live runtime rotation
- Not the target: commercial multi-user services, generic API users, or teams looking for a hosted auth layer

---

## Natural Search Terms

Developers looking for a tool like this are likely to search for:

- codex cli multi account
- codex auth manager
- chatgpt oauth codex cli
- codex account switching
- codex cli auth recovery
- codex cli terminal dashboard
- codex runtime rotation
- codex responses proxy
- codex multi account oauth
- project scoped codex accounts

These terms belong naturally in the README intro, feature list, and package metadata. They should not be stuffed into every heading.

---

## Recommended Repository Description

Use this as the GitHub repository description:

`Multi-account OAuth manager and codex auth wrapper for the official @openai/codex CLI, with switching, health checks, runtime rotation, and recovery tools`

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
- a simple visual of `codex auth login -> list -> switch -> rotation status`
- terminal-inspired styling rather than abstract marketing graphics

The image should immediately communicate:

- this is a CLI tool
- it works with the official Codex CLI
- it helps manage multiple accounts and can optionally rotate runtime requests

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

- README opens with what the project is, why it exists, and how to start quickly
- the wrapper-plus-manager use case is primary, runtime rotation is default-on with explicit opt-out, and plugin-host mode is clearly positioned as optional
- public docs have a simpler path from install to FAQ to architecture to troubleshooting
- release and metadata guidance is explicit and current
