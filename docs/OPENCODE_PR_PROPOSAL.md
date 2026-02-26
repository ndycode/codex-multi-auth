# OpenCode Upstream Proposal: Merge Auth Methods Across Plugins

This document proposes an OpenCode core change so multiple plugins can contribute auth methods for the same provider.

## Problem

Current OpenCode auth provider matching uses first-hit behavior (single plugin selected). When internal plugin auth exists for a provider (for example `openai`), external plugin auth methods for that provider are hidden.

Impact:

- External plugins cannot add alternate auth flows for built-in providers.
- Users do not see all available auth methods in one menu.

## Desired Behavior

For a selected provider:

1. Collect all plugins that declare `auth.provider === <provider>`.
2. Merge all `auth.methods` arrays.
3. Keep existing loader precedence (first plugin remains primary loader unless OpenCode adds a stricter policy).

## Proposed Code Pattern

Current behavior (single match):

```ts
const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider));
```

Proposed behavior (multi-merge):

```ts
const matchingPlugins = await Plugin.list().then((x) =>
  x.filter((p) => p.auth?.provider === provider)
);

if (matchingPlugins.length > 0) {
  const mergedMethods = matchingPlugins.flatMap((p) => p.auth?.methods ?? []);
  const primary = matchingPlugins[0];

  const handled = await handlePluginAuth(
    {
      auth: {
        ...primary.auth!,
        methods: mergedMethods,
      },
    },
    provider,
  );

  if (handled) return;
}
```

Apply equivalent logic in both default-provider and custom-provider auth paths.

## Compatibility

| Case | Result |
| --- | --- |
| One plugin for provider | No behavior change |
| Multiple plugins for provider | Methods become visible in one merged menu |
| Existing loader assumptions | Preserved by keeping first plugin as primary |

## Acceptance Tests

1. Install OpenCode with built-in OpenAI auth only.
   - Expected: unchanged behavior.
2. Add external plugin with additional OpenAI auth method.
   - Expected: both built-in and external methods appear.
3. Select each method and verify auth flow still completes.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicate method labels | OpenCode can dedupe by id/label in a later patch |
| Conflicting loaders | Keep current first-plugin precedence for initial rollout |
| Unexpected plugin ordering | Document deterministic ordering or sort policy |

## Why This Matters for `codex-multi-auth`

`codex-multi-auth` extends account workflows for OpenAI/Codex use cases. Without merged auth methods, users must use awkward workarounds instead of seeing all provider auth options in one place.
