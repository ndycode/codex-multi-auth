import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const loadUnifiedPluginConfigSyncMock = vi.fn(() => null);

vi.mock("../lib/unified-settings.js", () => ({
	getUnifiedSettingsPath: () => "/mock/unified-settings.json",
	loadUnifiedPluginConfigSync: loadUnifiedPluginConfigSyncMock,
	saveUnifiedPluginConfig: vi.fn(),
}));

describe("getPluginConfigExplainReport", () => {
	afterEach(async () => {
		delete process.env.CODEX_AUTH_FAST_SESSION_STRATEGY;
		delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;
		loadUnifiedPluginConfigSyncMock.mockReset();
		loadUnifiedPluginConfigSyncMock.mockReturnValue(null);
		vi.resetModules();
	});

	it("treats invalid string env values as non-env sources", async () => {
		process.env.CODEX_AUTH_FAST_SESSION_STRATEGY = "bogus";
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const entry = report.entries.find((item) => item.key === "fastSessionStrategy");
		expect(entry?.source).not.toBe("env");
	});

	it("attributes alias-backed fallback policy values to stored config", async () => {
		const configPath = join(tmpdir(), `config-explain-${Date.now()}.json`);
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
		await fs.writeFile(
			configPath,
			JSON.stringify({ fallbackOnUnsupportedCodexModel: true }, null, 2),
			"utf-8",
		);
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const policy = report.entries.find((item) => item.key === "unsupportedCodexPolicy");
		const fallback = report.entries.find((item) => item.key === "fallbackOnUnsupportedCodexModel");
		expect(policy?.source).toBe("file");
		expect(fallback?.source).toBe("file");
		await fs.unlink(configPath);
	});
});
