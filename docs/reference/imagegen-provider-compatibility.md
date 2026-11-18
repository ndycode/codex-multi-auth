# Built-in image_gen provider compatibility

Codex 0.154.0 gates its built-in image extension using provider metadata. Its tool planner additionally checks actor authorization or native ChatGPT authentication, so merely naming a custom provider OpenAI is not sufficient for all gates.

Generated runtime provider configuration supplies the non-secret local marker:

```toml
http_headers = { "x-openai-actor-authorization" = "codex-multi-auth-local" }
```

This compatibility shim satisfies the client's actor-authorization capability predicate. It is NOT an actor credential, not an authentication bypass, and does not confer upstream access. The runtime proxy removes this header, case-insensitively, before forwarding; the selected managed account's normal OAuth bearer and account ID remain authoritative. The local client bearer remains mandatory.

The provider name remains `codex-multi-auth`, `requires_openai_auth = false`, and the base URL stays local. Existing bearer configuration and `model_catalog_json` are preserved. Both generated TOML and canonical-home CLI overrides receive the marker. No official Codex binary is modified.

Image route support is a separate prerequisite for successful generation. Client image capability/model-catalog requirements and subscription entitlements also still apply. This is a version-sensitive compatibility shim, not a documented general capability API; replace it if Codex exposes a supported provider capability setting.

## Activation, upgrades, and rollback

Fresh wrapper-launched sessions receive the marker automatically in their generated runtime provider configuration. For the packaged desktop app, regenerate the persistent provider configuration with the existing supported command:

```bash
codex-multi-auth rotation bind-app
```

If an older bind is already active after upgrading the package, use the normal reversible flow to force regeneration from the newly installed version:

```bash
codex-multi-auth rotation unbind-app
codex-multi-auth rotation bind-app
```

`codex-multi-auth rotation reset-runtime` is also supported when the intent is to clear volatile rotation state and restart the app bind; it is not required solely to add this marker. No new npm script is introduced or required for image-generation compatibility. Normal package upgrades keep using the existing install/update workflow, and package install/update may self-heal the app bind when runtime rotation is enabled and the desktop app is detected.

Start a fresh Codex session after provider configuration is regenerated so the client re-evaluates its provider capability gates. No account migration or reauthentication is needed.

To remove the shim, revert this change and regenerate provider configuration through the same wrapper/app-bind flow. For the packaged app, `codex-multi-auth rotation unbind-app` restores the backed-up Codex configuration; re-binding after reverting regenerates the provider without the marker. Do not enable native authentication as a substitute.
