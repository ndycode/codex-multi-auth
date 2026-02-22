# OpenCode PR: Merge Auth Methods from Multiple Plugins

## Problem

When multiple plugins register for the same provider (e.g., `openai`), only the first plugin's auth methods are shown. This is because `auth.ts:310` uses `.find()` which returns the first match:

```typescript
const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
```

Since internal plugins (like `CodexAuthPlugin`) load before external plugins, external plugins can never add auth methods to providers that have internal plugins.

## Use Case

Multi-account authentication plugins need to add their auth methods alongside built-in options. For example:
- Built-in: "ChatGPT Pro/Plus" 
- External: "ChatGPT Pro/Plus (Multi-Account)"

Users should see both options when selecting OpenAI provider.

## Proposed Solution

Change `auth.ts` to collect and merge auth methods from ALL plugins that register for the same provider:

### Current Code (auth.ts lines 310-314)

```typescript
const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
if (plugin && plugin.auth) {
  const handled = await handlePluginAuth({ auth: plugin.auth }, provider)
  if (handled) return
}
```

### Proposed Code

```typescript
// Collect auth methods from ALL plugins that register for this provider
const matchingPlugins = await Plugin.list().then((x) => 
  x.filter((x) => x.auth?.provider === provider)
)

if (matchingPlugins.length > 0) {
  // Merge methods from all matching plugins
  const mergedMethods = matchingPlugins.flatMap((p) => p.auth?.methods ?? [])
  
  // Use the first plugin's loader (internal plugins take precedence)
  const primaryPlugin = matchingPlugins[0]
  
  const handled = await handlePluginAuth(
    { 
      auth: {
        ...primaryPlugin.auth!,
        methods: mergedMethods,
      }
    }, 
    provider
  )
  if (handled) return
}
```

### Also update lines 326-330 (custom provider handling)

```typescript
// Same pattern for custom providers
const customPlugins = await Plugin.list().then((x) => 
  x.filter((x) => x.auth?.provider === provider)
)
if (customPlugins.length > 0) {
  const mergedMethods = customPlugins.flatMap((p) => p.auth?.methods ?? [])
  const primaryPlugin = customPlugins[0]
  const handled = await handlePluginAuth(
    { auth: { ...primaryPlugin.auth!, methods: mergedMethods } }, 
    provider
  )
  if (handled) return
}
```

## Benefits

1. **Backward Compatible**: Existing behavior unchanged for providers with single plugin
2. **Extensible**: External plugins can add auth methods to any provider
3. **Priority Preserved**: Internal plugins' loaders still take precedence
4. **Minimal Change**: ~10 lines changed, no new dependencies

## Testing

1. Install an external plugin that registers for `openai` provider
2. Run `opencode auth login` → select "OpenAI"
3. Verify both internal and external auth methods appear in the list

## Alternative Considered

Have external plugins use different provider IDs (e.g., `openai-multi`), but this requires users to manually type the provider ID via "Other", which is poor UX.
