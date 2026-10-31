import { describe, expect, it } from "vitest";
import {
	rewriteConfigTomlForRuntimeRotationProvider,
	configHasRuntimeRotationProvider,
	configHasTopLevelRealtimeSidebandBaseUrl,
	restoreConfigTomlFromRuntimeRotationProvider,
	restoreConfigTomlFromRuntimeRotationProviderWithoutBackup,
	restoreTopLevelModelProvider,
	restoreTopLevelResponseStorage,
} from "../lib/runtime/config-toml.js";

it("exposes image capability while preserving local bearer and static catalog", () => {
	const config = rewriteConfigTomlForRuntimeRotationProvider('model_catalog_json = "C:/models-static.json"\n', "http://127.0.0.1:9999", "local-test-secret");
	expect(config).toContain('name = "codex-multi-auth"');
	expect(config).toContain('requires_openai_auth = false');
	expect(config).toContain('experimental_bearer_token = "local-test-secret"');
	expect(config).toContain('base_url = "http://127.0.0.1:9999"');
	expect(config).toContain('model_catalog_json = "C:/models-static.json"');
	expect(config).toContain('"x-openai-actor-authorization" = "codex-multi-auth-local"');
});

describe("restoreTopLevelModelProvider", () => {
	it("rewrites the runtime rotation provider line back to the original", () => {
		const original = 'model_provider = "openai"\n[profiles.default]\nmodel = "gpt-5"\n';
		const current = 'model_provider = "codex-multi-auth-runtime-proxy"\n[profiles.default]\nmodel = "gpt-5"\n';
		const restored = restoreTopLevelModelProvider(current, original);
		expect(restored).toBe(original);
	});

	it("splices the original line before the first section when current omits it", () => {
		// Bind wrote `model_provider = "<runtime-rotation>"` and a downstream
		// tool stripped that line entirely. On unbind we must put the original
		// line back into the root table — a naive append would land it inside
		// the last section and produce invalid TOML.
		const original = 'model_provider = "openai"\n[profiles.default]\nmodel = "gpt-5"\n';
		const current = '[profiles.default]\nmodel = "gpt-5"\n';
		const restored = restoreTopLevelModelProvider(current, original);

		const lines = restored.split(/\r?\n/);
		const providerIdx = lines.findIndex((l) => /^\s*model_provider\s*=/.test(l));
		const sectionIdx = lines.findIndex((l) => /^\s*\[/.test(l));

		expect(providerIdx).toBeGreaterThanOrEqual(0);
		expect(sectionIdx).toBeGreaterThanOrEqual(0);
		expect(providerIdx).toBeLessThan(sectionIdx);
	});

	it("appends the original line at tail when no section header exists", () => {
		const original = 'model_provider = "openai"\n';
		const current = "# nothing here\n";
		const restored = restoreTopLevelModelProvider(current, original);
		expect(restored).toContain('model_provider = "openai"');
	});

	it("preserves CRLF line endings end-to-end on Windows-authored configs", () => {
		const original =
			'model_provider = "openai"\r\n[profiles.default]\r\nmodel = "gpt-5"\r\n';
		const current =
			'model_provider = "codex-multi-auth-runtime-proxy"\r\n[profiles.default]\r\nmodel = "gpt-5"\r\n';
		const restored = restoreTopLevelModelProvider(current, original);
		expect(restored).toBe(original);
		// No bare \n leaked into the output.
		expect(restored.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("leaves config untouched when neither side has the runtime line", () => {
		const original = '[profiles.default]\nmodel = "gpt-5"\n';
		const current = '[profiles.default]\nmodel = "gpt-5"\n';
		const restored = restoreTopLevelModelProvider(current, original);
		expect(restored).toBe(current);
	});
});

describe("restoreTopLevelResponseStorage", () => {
	it("restores the original disable_response_storage line when present", () => {
		const original = "disable_response_storage = true\n[profiles.default]\n";
		const current = "disable_response_storage = false\n[profiles.default]\n";
		const restored = restoreTopLevelResponseStorage(current, original);
		expect(restored).toBe(original);
	});

	it("drops bind-time disable_response_storage residue when original lacks it", () => {
		// bind wrote `disable_response_storage = false`; original config never
		// had this key. On unbind we must remove the residue rather than
		// leave it behind.
		const original = '[profiles.default]\nmodel = "gpt-5"\n';
		const current = 'disable_response_storage = false\n[profiles.default]\nmodel = "gpt-5"\n';
		const restored = restoreTopLevelResponseStorage(current, original);
		expect(restored).not.toContain("disable_response_storage");
		expect(restored).toContain("[profiles.default]");
	});

	it("splices the original line before the first section when current omits it", () => {
		// Bind wrote `disable_response_storage = false`; a downstream tool
		// then stripped that line entirely. On unbind, the user's original
		// setting must still come back into the root table — a naive
		// implementation without the post-loop `!handled && originalLine`
		// splice would silently lose the setting.
		const original = "disable_response_storage = true\n[profiles.default]\n";
		const current = "[profiles.default]\nmodel = \"gpt-5\"\n";
		const restored = restoreTopLevelResponseStorage(current, original);

		const lines = restored.split(/\r?\n/);
		const settingIdx = lines.findIndex((l) =>
			/^\s*disable_response_storage\s*=/.test(l),
		);
		const sectionIdx = lines.findIndex((l) => /^\s*\[/.test(l));

		expect(settingIdx).toBeGreaterThanOrEqual(0);
		expect(sectionIdx).toBeGreaterThanOrEqual(0);
		expect(settingIdx).toBeLessThan(sectionIdx);
		expect(restored).toContain("disable_response_storage = true");
	});

	it("appends the original line at tail when current has no section header", () => {
		const original = "disable_response_storage = true\n";
		const current = "# nothing here\n";
		const restored = restoreTopLevelResponseStorage(current, original);
		expect(restored).toContain("disable_response_storage = true");
	});

	it("does not strip a disable_response_storage written inside a section", () => {
		const original = '[profiles.default]\nmodel = "gpt-5"\n';
		const current =
			'[profiles.default]\ndisable_response_storage = false\nmodel = "gpt-5"\n';
		const restored = restoreTopLevelResponseStorage(current, original);
		// In-section setting should survive — only top-level residue is dropped.
		expect(restored).toContain("disable_response_storage = false");
	});
});

describe("configHasRuntimeRotationProvider", () => {
	it("detects a top-level model_provider bound to the proxy", () => {
		const config =
			'model_provider = "codex-multi-auth-runtime-proxy"\n[profiles.default]\nmodel = "gpt-5"\n';
		expect(configHasRuntimeRotationProvider(config)).toBe(true);
	});

	it("detects the proxy provider block even when model_provider is native", () => {
		const config =
			'model_provider = "openai"\n[model_providers.codex-multi-auth-runtime-proxy]\nname = "codex-multi-auth"\n';
		expect(configHasRuntimeRotationProvider(config)).toBe(true);
	});

	it("returns false for an unbound config", () => {
		const config = 'model_provider = "openai"\n[profiles.default]\nmodel = "gpt-5"\n';
		expect(configHasRuntimeRotationProvider(config)).toBe(false);
	});

	it("returns false for empty config", () => {
		expect(configHasRuntimeRotationProvider("")).toBe(false);
	});

	it("does not match a proxy id that only appears inside a non-provider section", () => {
		// A stray mention in some other section's value must not be treated as a
		// top-level bind (the top-level scan stops at the first table header).
		const config =
			'[profiles.default]\nnote = "codex-multi-auth-runtime-proxy"\n';
		expect(configHasRuntimeRotationProvider(config)).toBe(false);
	});
});

describe("restoreConfigTomlFromRuntimeRotationProviderWithoutBackup", () => {
	it("rewrites a bound model_provider to the default and strips the proxy block", () => {
		const bound = [
			'model_provider = "codex-multi-auth-runtime-proxy"',
			"[profiles.default]",
			'model = "gpt-5"',
			"",
			"[model_providers.codex-multi-auth-runtime-proxy]",
			'name = "codex-multi-auth"',
			'base_url = "http://127.0.0.1:51758"',
			"requires_openai_auth = false",
			'wire_api = "responses"',
			"",
		].join("\n");

		const restored =
			restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(bound);

		expect(restored).toContain('model_provider = "openai"');
		expect(restored).not.toContain("codex-multi-auth-runtime-proxy");
		expect(restored).toContain("[profiles.default]");
		expect(configHasRuntimeRotationProvider(restored)).toBe(false);
	});

	it("honors a custom default provider", () => {
		const bound = 'model_provider = "codex-multi-auth-runtime-proxy"\n';
		const restored = restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(
			bound,
			"my-provider",
		);
		expect(restored).toContain('model_provider = "my-provider"');
	});

	it("preserves CRLF endings when recovering", () => {
		const bound =
			'model_provider = "codex-multi-auth-runtime-proxy"\r\n[model_providers.codex-multi-auth-runtime-proxy]\r\nname = "codex-multi-auth"\r\n';
		const restored =
			restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(bound);
		expect(restored).toContain('model_provider = "openai"');
		expect(restored).not.toContain("codex-multi-auth-runtime-proxy");
		expect(restored.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("does not duplicate model_provider when the top-level line is already non-proxy (half-orphan)", () => {
		// The proxy *block* is present but the top-level model_provider already
		// points at a real provider. Recovery must strip the block and leave the
		// single existing line — inserting a second one is invalid TOML.
		const halfOrphan = [
			'model_provider = "openai"',
			"[profiles.default]",
			'model = "gpt-5"',
			"",
			"[model_providers.codex-multi-auth-runtime-proxy]",
			'name = "codex-multi-auth"',
			'base_url = "http://127.0.0.1:51758"',
			'wire_api = "responses"',
			"",
		].join("\n");

		const restored =
			restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(halfOrphan);

		const providerLines = (
			restored.match(/^\s*model_provider\s*=/gm) ?? []
		).length;
		expect(providerLines).toBe(1);
		expect(restored).toContain('model_provider = "openai"');
		expect(restored).not.toContain("codex-multi-auth-runtime-proxy");
		expect(restored).toContain("[profiles.default]");
	});

	it("drops bind-injected disable_response_storage during no-backup recovery", () => {
		// A full bind injects `disable_response_storage = false` at top level;
		// recovery with no backup must remove that residue.
		const bound = [
			'model_provider = "codex-multi-auth-runtime-proxy"',
			"disable_response_storage = false",
			"[profiles.default]",
			'model = "gpt-5"',
			"",
			"[model_providers.codex-multi-auth-runtime-proxy]",
			'name = "codex-multi-auth"',
			'wire_api = "responses"',
			"",
		].join("\n");

		const restored =
			restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(bound);

		expect(restored).toContain('model_provider = "openai"');
		expect(restored).not.toContain("disable_response_storage");
		expect(restored).not.toContain("codex-multi-auth-runtime-proxy");
	});
});

describe("realtime voice sideband URL (#750)", () => {
	const marker = "# codex-multi-auth realtime sideband";
	it("points the sideband at the proxy in the root table and removes it on restore", () => {
		const original = 'model = "gpt-5"\n[features]\nfoo = true\n';
		const bound = rewriteConfigTomlForRuntimeRotationProvider(original, "http://127.0.0.1:9999", "local-test-secret");
		const lines = bound.split("\n");
		const sideband = lines.findIndex((line) => line.startsWith("experimental_realtime_ws_base_url"));
		expect(lines[sideband]).toBe(`experimental_realtime_ws_base_url = "http://127.0.0.1:9999" ${marker}`);
		expect(sideband).toBeLessThan(lines.findIndex((line) => line.startsWith("[")));
		expect(bound).not.toContain("experimental_realtime_webrtc_call_base_url");
		expect(restoreConfigTomlFromRuntimeRotationProvider(bound, original)).toBe(original);
	});

	it("replaces its own line on rebind instead of duplicating it", () => {
		const first = rewriteConfigTomlForRuntimeRotationProvider("", "http://127.0.0.1:9999");
		const second = rewriteConfigTomlForRuntimeRotationProvider(first, "http://127.0.0.1:8888");
		expect(second.match(/experimental_realtime_ws_base_url/g)).toHaveLength(1);
		expect(second).toContain('experimental_realtime_ws_base_url = "http://127.0.0.1:8888"');
	});

	it("keeps a sideband URL the user configured and leaves it after restore", () => {
		const original = 'experimental_realtime_ws_base_url = "https://example.test/voice"\nmodel = "gpt-5"\n';
		const bound = rewriteConfigTomlForRuntimeRotationProvider(original, "http://127.0.0.1:9999");
		expect(bound.match(/experimental_realtime_ws_base_url/g)).toHaveLength(1);
		expect(bound).not.toContain(marker);
		expect(restoreConfigTomlFromRuntimeRotationProvider(bound, original)).toContain(
			'experimental_realtime_ws_base_url = "https://example.test/voice"',
		);
		expect(configHasTopLevelRealtimeSidebandBaseUrl(original)).toBe(true);
		expect(configHasTopLevelRealtimeSidebandBaseUrl('[x]\nexperimental_realtime_ws_base_url = "y"\n')).toBe(false);
	});

	it("strips the sideband line during no-backup recovery", () => {
		const bound = rewriteConfigTomlForRuntimeRotationProvider('model = "gpt-5"\n', "http://127.0.0.1:9999");
		expect(restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(bound)).not.toContain("experimental_realtime_ws_base_url");
	});

	it("preserves CRLF line endings", () => {
		const original = 'model = "gpt-5"\r\n[features]\r\nfoo = true\r\n';
		const bound = rewriteConfigTomlForRuntimeRotationProvider(original, "http://127.0.0.1:9999");
		expect(bound).toContain(`experimental_realtime_ws_base_url = "http://127.0.0.1:9999" ${marker}\r\n`);
		expect(bound.replace(/\r\n/g, "")).not.toContain("\n");
	});
});
