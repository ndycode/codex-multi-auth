import { describe, expect, it } from "vitest";
import {
	restoreTopLevelModelProvider,
	restoreTopLevelResponseStorage,
} from "../lib/runtime/config-toml.js";

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
