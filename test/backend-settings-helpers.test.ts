import { describe, expect, it } from "vitest";
import {
	backendSettingsEqual,
	backendSettingsSnapshot,
	buildBackendConfigPatch,
	buildBackendSettingsPreview,
	clampBackendNumberForTests,
	cloneBackendPluginConfig,
	formatBackendNumberValue,
} from "../lib/codex-manager/backend-settings-helpers.js";

describe("backend settings helpers", () => {
	it("clones fallback chains defensively", () => {
		const cloned = cloneBackendPluginConfig({ unsupportedCodexFallbackChain: { a: ["b"] } } as never);
		expect(cloned.unsupportedCodexFallbackChain).toEqual({ a: ["b"] });
		expect(cloned.unsupportedCodexFallbackChain).not.toBe((({ unsupportedCodexFallbackChain: { a: ["b"] } } as never).unsupportedCodexFallbackChain));
	});

	it("formats and clamps backend numeric values", () => {
		expect(formatBackendNumberValue({ unit: "percent" } as never, 4.6)).toBe("5%");
		expect(formatBackendNumberValue({ unit: "count" } as never, 2.2)).toBe("2");
		expect(clampBackendNumberForTests("fetchTimeoutMs", 10)).toBeGreaterThanOrEqual(1000);
	});

	it("builds snapshots, equality, preview and patches", () => {
		const left = { fetchTimeoutMs: 60000, streamStallTimeoutMs: 45000, liveAccountSync: true, sessionAffinity: true, preemptiveQuotaEnabled: true, preemptiveQuotaRemainingPercent5h: 5, preemptiveQuotaRemainingPercent7d: 5 } as never;
		const right = { ...left } as never;
		expect(backendSettingsSnapshot(left)).toEqual(backendSettingsSnapshot(right));
		expect(backendSettingsEqual(left, right)).toBe(true);
		const preview = buildBackendSettingsPreview(left, { theme: {} } as never, "fetchTimeoutMs", { highlightPreviewToken: (text) => `[${text}]` });
		expect(preview.label).toContain("live sync");
		expect(preview.hint).toContain("timeouts");
		expect(buildBackendConfigPatch({ ...left, fetchTimeoutMs: 10 } as never)).toHaveProperty("fetchTimeoutMs");
	});
});
