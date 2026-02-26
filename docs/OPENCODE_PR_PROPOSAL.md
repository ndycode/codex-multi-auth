# OpenCode Upstream Proposal: Merge Auth Methods Across Plugins

This proposal requests an OpenCode core change so multiple plugins can contribute auth methods for the same provider.

## Problem

Current provider auth matching is first-hit only (`find(...)`). If a built-in plugin already owns a provider (for example `openai`), external plugin auth methods for that same provider are hidden.

Impact:

- external plugins cannot extend provider auth menu options
- users cannot choose between built-in and external auth variants in one place

## Desired Behavior

For a selected provider:

1. collect all plugins where `plugin.auth?.provider === provider`
2. sort deterministically before selecting primary
3. merge and dedupe `auth.methods`
4. call `handlePluginAuth(...)` once with merged methods and deterministic primary loader

## Proposed Runtime Helpers

Introduce helper functions in OpenCode auth discovery path:

- `collectAuthPluginsForProvider(provider)`
- `mergeAuthMethods(plugins)`
- `choosePrimaryAuthPlugin(plugins)`

These keep behavior explicit and testable.
Status: proposal only, pending OpenCode acceptance and implementation. These helpers do not exist in this repository today.

## Proposed Code Pattern

Current behavior:

```ts
const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider));
if (plugin?.auth) {
  const handled = await handlePluginAuth({ auth: plugin.auth }, provider);
  if (handled) return;
}
```

Proposed deterministic merge behavior:

```ts
const matchingPlugins = await Plugin.list()
  .then((plugins) =>
    plugins
      .filter((p) => p.auth?.provider === provider)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" })),
  );

if (matchingPlugins.length === 0) {
  // fall through to existing built-in/default provider flow
  return;
}

const primary = matchingPlugins[0];
if (!primary?.auth) {
  return;
}

const mergedMethods = matchingPlugins
  .flatMap((p) => p.auth?.methods ?? [])
  .filter(Boolean)
  .filter((method, index, arr) => {
    const key = `${method.id ?? ""}::${method.label ?? ""}`.toLowerCase();
    return arr.findIndex((m) => `${m.id ?? ""}::${m.label ?? ""}`.toLowerCase() === key) === index;
  });

if (mergedMethods.length === 0) {
  // no valid methods after merge/dedupe
  return;
}

try {
  const handled = await handlePluginAuth(
    {
      auth: {
        ...primary.auth,
        methods: mergedMethods,
      },
    },
    provider,
  );
  if (handled) return;
} catch (error) {
  // log and continue fallback behavior safely
}
```

Apply the same helper logic to both default-provider and custom-provider auth paths.

## Deterministic Precedence Policy

Proposed policy for `codex-multi-auth` coexistence:

- sort plugins alphabetically by `plugin.name` (case-insensitive)
- `plugins[0]` is primary loader
- merged methods are deduped by `id + label`

If OpenCode later introduces explicit plugin priority metadata, these helpers are the place to switch policy.

## Compatibility Matrix

| Case | Result |
| --- | --- |
| Zero plugins for provider | Fall through to OpenCode built-in/default behavior or explicit provider-not-configured error |
| One plugin for provider | Same behavior as today |
| Multiple plugins for provider | Merged/deduped auth methods shown in one menu |
| Duplicate method ids/labels across plugins | Dedupe keeps first method in deterministic sorted order |
| Conflicting loader implementations | First plugin after deterministic sort is primary loader |
| Windows vs Unix plugin ordering | Case-insensitive `localeCompare` keeps stable ordering across platforms |

## Acceptance Tests (Proposed For OpenCode)

1. Built-in-only scenario:
   - one plugin for `openai`
   - behavior unchanged
2. Built-in + external scenario:
   - two plugins for `openai`
   - both methods visible after dedupe
3. Method selection scenario:
   - each method completes auth flow successfully
4. Empty/invalid methods scenario:
   - null/undefined/empty methods filtered safely
5. Duplicate methods scenario:
   - duplicate `id/label` entries deduped deterministically
6. Platform ordering scenario:
   - plugin names with path/case differences produce same effective ordering on Windows and Unix
7. Parallel auth-flow scenario:
   - concurrent auth attempts do not race/crash during method merge path

## Test Plan (Concrete)

Add tests in OpenCode auth/plugin tests after proposal acceptance (example targets):

- `test/index.test.ts` for plugin discovery merge path
- `test/auth.test.ts` for method selection and handler delegation

Required checks:

- deterministic sorting
- dedupe behavior
- `mergedMethods.length === 0` guard
- `primary.auth` null guard
- `handlePluginAuth` try/catch fallback path
- parallel auth safety with `Promise.all(...)` over repeated provider auth calls
- simulated `handlePluginAuth` throws are isolated per call and do not mutate shared `mergedMethods` state

Note: this `codex-multi-auth` PR is documentation-only; no runtime helper code or OpenCode test files are changed here.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicate methods create ambiguous menu entries | Implement immediate dedupe in `mergeAuthMethods()` by `id+label` |
| Nondeterministic primary selection | Enforce deterministic sort in `collectAuthPluginsForProvider()` and select first in `choosePrimaryAuthPlugin()` |
| Loader conflicts between plugins | Keep one authoritative primary loader and document precedence policy |
| Drift between runtime and docs | Document sort/dedupe policy in `docs/configuration.md` and this proposal |

## Why This Matters for `codex-multi-auth`

`codex-multi-auth` extends OpenAI auth workflows with multi-account operations. Without provider-level auth method merging, users cannot discover the external method naturally in the same provider login flow.
