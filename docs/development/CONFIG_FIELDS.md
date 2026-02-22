# Config Fields: Complete Guide

Understanding the difference between config key, `id`, and `name` fields in OpenCode model configuration.

## The Three Fields

```json
{
  "provider": {
    "openai": {
      "models": {
        "THIS-IS-THE-CONFIG-KEY": {
          "id": "this-is-the-id-field",
          "name": "This is the name field"
        }
      }
    }
  }
}
```

---

## What Each Field Controls

### Config Key (Property Name)

**Example:** `"gpt-5-codex-low"`

**Used For:**
- ✅ CLI `--model` flag: `--model=openai/gpt-5-codex-low`
- ✅ OpenCode internal lookups: `provider.info.models["gpt-5-codex-low"]`
- ✅ TUI persistence: Saved to `~/.opencode/tui` as `model_id = "gpt-5-codex-low"`
- ✅ Custom command frontmatter: `model: openai/gpt-5-codex-low`
- ✅ Agent configuration: `"model": "openai/gpt-5-codex-low"`
- ✅ **Plugin config lookup**: `userConfig.models["gpt-5-codex-low"]`
- ✅ Passed to custom loaders: `getModel(sdk, "gpt-5-codex-low")`

**This is the PRIMARY identifier throughout OpenCode!**

---

### `id` Field (Optional - NOT NEEDED for OpenAI)

**Example:** `"gpt-5-codex"`

**What it's used for:**
- ⚠️ **Other providers**: Some providers use this for `sdk.languageModel(id)`
- ⚠️ **Sorting**: Used for model priority sorting in OpenCode
- ⚠️ **Documentation**: Indicates the "canonical" model ID

**What it's NOT used for with OpenAI:**
- ❌ **NOT sent to AI SDK** (config key is sent instead)
- ❌ **NOT used by plugin** (plugin receives config key)
- ❌ **NOT required** (OpenCode defaults it to config key)

**Code Reference:** (`tmp/opencode/packages/opencode/src/provider/provider.ts:252`)
```typescript
const parsedModel: ModelsDev.Model = {
  id: model.id ?? modelID,  // ← Defaults to config key if omitted
  ...
}
```

**OpenAI Custom Loader:** (`tmp/opencode/packages/opencode/src/provider/provider.ts:58-65`)
```typescript
openai: async () => {
  return {
    async getModel(sdk: any, modelID: string) {
      return sdk.responses(modelID)  // ← Receives CONFIG KEY, not id field!
    }
  }
}
```

**Our plugin receives:** `body.model = "gpt-5-codex-low"` (config key, NOT id field)

**Recommendation:** **Omit the `id` field** for OpenAI provider - it's redundant and creates confusion. OpenCode will auto-set it to the config key.

---

### `name` Field (Optional)

**Example:** `"GPT 5 Codex Low (OAuth)"`

**Used For:**
- ✅ **TUI Model Picker**: Display name shown in the model selection UI
- ℹ️ **Documentation**: Human-friendly description

**Code Reference:** (`tmp/opencode/packages/opencode/src/provider/provider.ts:253`)
```typescript
const parsedModel: ModelsDev.Model = {
  name: model.name ?? existing?.name ?? modelID,  // Defaults to config key
  ...
}
```

**If omitted:** Falls back to config key for display

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    What Users See & Use                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CLI Usage:                                                     │
│  $ opencode run --model=openai/gpt-5-codex-low                 │
│                                 └──────┬──────┘                 │
│                                   CONFIG KEY                    │
│                                                                 │
│  TUI Display:                                                   │
│  ┌──────────────────────────────────┐                          │
│  │ Select Model:                    │                          │
│  │                                  │                          │
│  │ ○ GPT 5 Codex Low (OAuth) ←──────┼── name field            │
│  │ ○ GPT 5 Codex Medium (OAuth)     │                          │
│  │ ○ GPT 5 Codex High (OAuth)       │                          │
│  └──────────────────────────────────┘                          │
│                                                                 │
│  Config Lookup (Plugin):                                       │
│  userConfig.models["gpt-5-codex-low"].options                  │
│                     └──────┬──────┘                             │
│                       CONFIG KEY                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Internal Flow                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. User Selection                                              │
│     opencode run --model=openai/gpt-5-codex-low                │
│     OpenCode parses: providerID="openai"                        │
│                      modelID="gpt-5-codex-low" ← CONFIG KEY    │
│                                                                 │
│  2. OpenCode Provider Lookup                                    │
│     provider.info.models["gpt-5-codex-low"]                     │
│                          └──────┬──────┘                        │
│                            CONFIG KEY                           │
│                                                                 │
│  3. Custom Loader Call (OpenAI)                                 │
│     getModel(sdk, "gpt-5-codex-low")                            │
│                   └──────┬──────┘                               │
│                     CONFIG KEY                                  │
│                                                                 │
│  4. AI SDK Request Creation                                     │
│     { model: "gpt-5-codex-low", ... }                           │
│              └──────┬──────┘                                    │
│                CONFIG KEY                                       │
│                                                                 │
│  5. Custom fetch() (Our Plugin)                                 │
│     body.model = "gpt-5-codex-low"                              │
│                  └──────┬──────┘                                │
│                    CONFIG KEY                                   │
│                                                                 │
│  6. Plugin Config Lookup                                        │
│     userConfig.models["gpt-5-codex-low"].options                │
│                       └──────┬──────┘                           │
│                         CONFIG KEY                              │
│     Result: { reasoningEffort: "low", ... } ✅ FOUND           │
│                                                                 │
│  7. Plugin Normalization                                        │
│     normalizeModel("gpt-5-codex-low")                           │
│     Returns: "gpt-5-codex" ← SENT TO CODEX API                 │
│                                                                 │
│  8. TUI Persistence                                             │
│     ~/.opencode/tui:                                            │
│       provider_id = "openai"                                    │
│       model_id = "gpt-5-codex-low" ← CONFIG KEY persisted      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Field Purpose Summary

### Config Key: The Real Identifier

```json
"gpt-5-codex-low": { ... }
 └──────┬──────┘
   CONFIG KEY
```

**Purpose:**
- 🎯 **PRIMARY identifier** - used everywhere in OpenCode
- 🎯 **Plugin receives this** - what our plugin sees in `body.model`
- 🎯 **Config lookup key** - how plugin finds per-model options
- 🎯 **Persisted value** - saved in TUI state

**Best Practice:** Use Codex CLI preset names (`gpt-5-codex-low`, `gpt-5-high`, etc.)

---

### `id` Field: Documentation/Metadata

```json
"id": "gpt-5-codex"
       └─────┬─────┘
         ID FIELD
```

**Purpose:**
- 📝 **Documents** what base model this variant uses
- 📝 **Helps sorting** in model lists
- 📝 **Clarity** - shows relationship between variants

**Best Practice:** Set to the base API model name (`gpt-5-codex`, `gpt-5`, etc.)

**Note:** For OpenAI provider, this is NOT sent to the API! The plugin normalizes the config key instead.

---

### `name` Field: UI Display

```json
"name": "GPT 5 Codex Low (OAuth)"
         └──────────┬──────────┘
              NAME FIELD
```

**Purpose:**
- 🎨 **TUI display** - what users see in model picker
- 🎨 **User-friendly** - can be descriptive
- 🎨 **Differentiation** - helps distinguish from API key models

**Best Practice:** Human-friendly name with context (OAuth, API, subscription type, etc.)

---

## Real-World Examples

### Example 1: Our Current Config ✅

```json
{
  "gpt-5-codex-low": {
    "id": "gpt-5-codex",
    "name": "GPT 5 Codex Low (OAuth)",
    "options": { "reasoningEffort": "low" }
  }
}
```

**When user selects `openai/gpt-5-codex-low`:**
- CLI: Uses `"gpt-5-codex-low"` (config key)
- TUI: Shows `"GPT 5 Codex Low (OAuth)"` (name field)
- Plugin receives: `body.model = "gpt-5-codex-low"` (config key)
- Plugin looks up: `models["gpt-5-codex-low"]` ✅ Found
- Plugin sends to API: `"gpt-5-codex"` (normalized)

**Result:** ✅ Everything works perfectly!

---

### Example 2: Multiple Variants of Same Model ✅

```json
{
  "gpt-5-codex-low": {
    "id": "gpt-5-codex",
    "name": "GPT 5 Codex Low (OAuth)"
  },
  "gpt-5-codex-high": {
    "id": "gpt-5-codex",
    "name": "GPT 5 Codex High (OAuth)"
  }
}
```

**Why this works:**
- Config keys are different: `"gpt-5-codex-low"` vs `"gpt-5-codex-high"` ✅
- Same `id` is fine - it's just metadata
- Different `name` values help distinguish in TUI

**Result:** ✅ Two variants of same base model, different settings

---

### Example 3: If We Made Config Key = ID ❌

```json
{
  "gpt-5-codex": {
    "id": "gpt-5-codex",
    "name": "GPT 5 Codex Low (OAuth)",
    "options": { "reasoningEffort": "low" }
  },
  "gpt-5-codex": {  // ❌ DUPLICATE KEY ERROR!
    "id": "gpt-5-codex",
    "name": "GPT 5 Codex High (OAuth)",
    "options": { "reasoningEffort": "high" }
  }
}
```

**Problem:** JavaScript objects can't have duplicate keys!

**Result:** ❌ Can't have multiple variants

---

## Why We Need Different Config Keys

**Problem:** Need multiple configurations for the same API model

**Solution:** Different config keys → same `id`

```json
{
  "gpt-5-codex-low": {          // ← Unique config key #1
    "id": "gpt-5-codex",         // ← Same base model
    "options": { "reasoningEffort": "low" }
  },
  "gpt-5-codex-medium": {       // ← Unique config key #2
    "id": "gpt-5-codex",         // ← Same base model
    "options": { "reasoningEffort": "medium" }
  },
  "gpt-5-codex-high": {         // ← Unique config key #3
    "id": "gpt-5-codex",         // ← Same base model
    "options": { "reasoningEffort": "high" }
  }
}
```

**Result:**
- 3 selectable variants in TUI ✅
- Same API model (`gpt-5-codex`) ✅
- Different reasoning settings ✅
- Plugin correctly applies per-variant options ✅

---

## Backwards Compatibility

### Config Changes are Safe ✅

**Old Plugin + Old Config:**
```json
"GPT 5 Codex Low (ChatGPT Subscription)": {
  "id": "gpt-5-codex",
  "options": { "reasoningEffort": "low" }
}
```
**Result:** ❌ Per-model options broken (existing bug in old plugin)

**New Plugin + Old Config:**
```json
"GPT 5 Codex Low (ChatGPT Subscription)": {
  "id": "gpt-5-codex",
  "options": { "reasoningEffort": "low" }
}
```
**Result:** ✅ Per-model options work! (bug fixed)

**New Plugin + New Config:**
```json
"gpt-5-codex-low": {
  "id": "gpt-5-codex",
  "name": "GPT 5 Codex Low (OAuth)",
  "options": { "reasoningEffort": "low" }
}
```
**Result:** ✅ Per-model options work! (bug fixed + cleaner naming)

**Conclusion:**
- ✅ Existing configs continue to work
- ✅ New configs work better
- ✅ Users can migrate at their own pace

---

## Required Configuration Fields

### `store` Field: Critical for AI SDK 2.0.50+

**⚠️ Required as of AI SDK 2.0.50 (released Oct 12, 2025)**

```json
{
  "provider": {
    "openai": {
      "options": {
        "store": false
      }
    }
  }
}
```

**What it does:**
- `false` (required): Prevents AI SDK from using `item_reference` for conversation history
- `true` (default): Uses server-side storage with references (incompatible with Codex API)

**Why required:**
AI SDK 2.0.50 introduced automatic use of `item_reference` items to reduce payload size when `store: true`. However:
- Codex API requires `store: false` (stateless mode)
- `item_reference` items cannot be resolved without server-side storage
- Without this setting, multi-turn conversations fail with: `"Item with id 'fc_xxx' not found"`

**Where to set:**
```json
{
  "provider": {
    "openai": {
      "options": {
        "store": false  // ← Global: applies to all models
      },
      "models": {
        "gpt-5-codex-low": {
          "options": {
            "store": false  // ← Per-model: redundant but explicit
          }
        }
      }
    }
  }
}
```

**Recommendation:** Set in global `options` since it's required for all models using this plugin.

**Note:** The plugin also includes a `chat.params` hook that automatically injects `store: false`, but explicit configuration is recommended for clarity and forward compatibility.

---

## Recommended Structure

### Recommended: Config Key + Name ✅

```json
{
  "gpt-5-codex-low": {
    "name": "GPT 5 Codex Low (OAuth)",
    "options": { "reasoningEffort": "low" }
  }
}
```

**Benefits:**
- ✅ Clean config key: `gpt-5-codex-low` (matches Codex CLI presets)
- ✅ Friendly display: `"GPT 5 Codex Low (OAuth)"` (UX)
- ✅ No redundant fields
- ✅ OpenCode auto-sets `id` to config key

**Why no `id` field?**
- For OpenAI provider, the `id` field is NOT used (custom loader receives config key)
- OpenCode defaults `id` to config key if omitted
- Including it is redundant and creates confusion

---

### Minimal Structure (Works but less friendly)

```json
{
  "gpt-5-codex-low": {
    "options": { "reasoningEffort": "low" }
  }
}
```

**What happens:**
- `id` defaults to: `"gpt-5-codex-low"` (config key)
- `name` defaults to: `"gpt-5-codex-low"` (config key)
- TUI shows: `"gpt-5-codex-low"` (less friendly)
- Plugin normalizes: `"gpt-5-codex-low"` → `"gpt-5-codex"` for API
- **Works perfectly, just less user-friendly**

---

### With id Field (Redundant but Harmless)

```json
{
  "gpt-5-codex-low": {
    "id": "gpt-5-codex",
    "name": "GPT 5 Codex Low (OAuth)",
    "options": { "reasoningEffort": "low" }
  }
}
```

**What happens:**
- `id` field is stored but NOT used by OpenAI custom loader
- Adds documentation value but is technically redundant
- Works fine, just verbose

---

## Summary Table

| Use Case | Which Field? | Example Value |
|----------|-------------|---------------|
| **CLI `--model` flag** | Config Key | `openai/gpt-5-codex-low` |
| **Custom commands** | Config Key | `model: openai/gpt-5-codex-low` |
| **Agent config** | Config Key | `"model": "openai/gpt-5-codex-low"` |
| **TUI display** | `name` field | `"GPT 5 Codex Low (OAuth)"` |
| **Plugin config lookup** | Config Key | `models["gpt-5-codex-low"]` |
| **AI SDK receives** | Config Key | `body.model = "gpt-5-codex-low"` |
| **Plugin normalizes** | Transformed | `"gpt-5-codex"` (sent to API) |
| **TUI persistence** | Config Key | `model_id = "gpt-5-codex-low"` |
| **Documentation** | `id` field | `"gpt-5-codex"` (base model) |
| **Model sorting** | `id` field | Used for priority ranking |

---

## Key Insight for OpenAI Provider

```
CONFIG KEY is the real identifier! 👑
  ├─ Used for selection (CLI, TUI, commands)
  ├─ Used for persistence (saved to ~/.opencode/tui)
  ├─ Passed to custom loader (getModel receives this)
  ├─ Sent to AI SDK (body.model = this)
  └─ Received by plugin (our plugin sees this)

id field is metadata 📝
  ├─ Documents base model
  ├─ Used for sorting
  └─ NOT sent to AI SDK (custom loader uses config key)

name field is UI sugar 🎨
  └─ Makes TUI model picker user-friendly
```

---

## Why The Bug Happened

**Old Plugin Logic (Broken):**
```typescript
const normalizedModel = normalizeModel(body.model);  // "gpt-5-codex-low" → "gpt-5-codex"
const modelConfig = getModelConfig(normalizedModel, userConfig);  // Lookup "gpt-5-codex"
```

**Problem:**
- Plugin received: `"gpt-5-codex-low"` (config key)
- Plugin normalized first: `"gpt-5-codex"`
- Plugin looked up config: `models["gpt-5-codex"]` ❌ NOT FOUND
- Config key was: `models["gpt-5-codex-low"]`
- **Result:** Per-model options ignored!

**New Plugin Logic (Fixed):**
```typescript
const originalModel = body.model;  // "gpt-5-codex-low" (config key)
const normalizedModel = normalizeModel(body.model);  // "gpt-5-codex" (for API)
const modelConfig = getModelConfig(originalModel, userConfig);  // Lookup "gpt-5-codex-low" ✅
```

**Fix:**
- Use original value (config key) for config lookup ✅
- Normalize separately for API call ✅
- **Result:** Per-model options applied correctly!

---

## Testing the Understanding

### Test Case 1: Which model does plugin send to API?

**Config:**
```json
{
  "my-custom-name": {
    "id": "gpt-5-codex",
    "name": "My Custom Display Name",
    "options": { "reasoningEffort": "high" }
  }
}
```

**User runs:** `--model=openai/my-custom-name`

**Question:** What model does plugin send to Codex API?

**Answer:**
1. Plugin receives: `body.model = "my-custom-name"`
2. Plugin normalizes: `"my-custom-name"` → `"gpt-5-codex"` (contains "codex")
3. Plugin sends to API: `"gpt-5-codex"` ✅

**The `id` field is NOT used for this!**

---

### Test Case 2: How does TUI know what to display?

**Config:**
```json
{
  "ugly-key-123": {
    "id": "gpt-5",
    "name": "Beautiful Display Name"
  }
}
```

**Question:** What does TUI model picker show?

**Answer:** `"Beautiful Display Name"` (from `name` field)

**If `name` was omitted:** Would show `"ugly-key-123"` (config key)

---

### Test Case 3: How does plugin find config?

**Config:**
```json
{
  "gpt-5-codex-low": {
    "id": "gpt-5-codex",
    "options": { "reasoningEffort": "low" }
  }
}
```

**User selects:** `openai/gpt-5-codex-low`

**Question:** How does plugin find the options?

**Answer:**
1. Plugin receives: `body.model = "gpt-5-codex-low"`
2. Plugin looks up: `userConfig.models["gpt-5-codex-low"]` ✅
3. Plugin finds: `{ reasoningEffort: "low" }` ✅

**The lookup uses config key, NOT the `id` field!**

---

## Common Mistakes

### ❌ Using id as Config Key

```json
{
  "gpt-5-codex": {  // ❌ Can't have multiple variants
    "id": "gpt-5-codex"
  }
}
```

### ❌ Thinking id Controls Plugin Lookup

```json
{
  "my-model": {
    "id": "gpt-5-codex-low",  // ❌ Plugin won't look up by this!
    "options": { ... }
  }
}
```

**Plugin looks up by:** `"my-model"` (config key), not `"gpt-5-codex-low"` (id)

### ❌ Forgetting name Field

```json
{
  "gpt-5-codex-low": {
    "id": "gpt-5-codex"
    // Missing: "name" field
  }
}
```

**Result:** TUI shows `"gpt-5-codex-low"` (works but less friendly)

---

## See Also

- [CONFIG_FLOW.md](./CONFIG_FLOW.md) - Complete config system guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture
- [BUGS_FIXED.md](./BUGS_FIXED.md) - Bug fixes and testing
