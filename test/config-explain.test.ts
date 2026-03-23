import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const loadUnifiedPluginConfigSyncMock = vi.fn(() => null);

vi.mock("../lib/unified-settings.js", () => ({
	getUnifiedSettingsPath: () => "/mock/unified-settings.json",
	loadUnifiedPluginConfigSync: loadUnifiedPluginConfigSyncMock,
	saveUnifiedPluginConfig: vi.fn(),
}));

let tempConfigCounter = 0;
const tempConfigPaths = new Set<string>();

function nextConfigPath(label: string): string {
	tempConfigCounter += 1;
	const configPath = join(
		tmpdir(),
		`config-explain-${label}-${tempConfigCounter}.json`,
	);
	tempConfigPaths.add(configPath);
	return configPath;
}

function expectEntry(
	report: { entries: Array<{ key: string }> },
	key: string,
) {
	const entry = report.entries.find((item) => item.key === key);
	expect(entry).toBeDefined();
	return entry;
}

describe("getPluginConfigExplainReport", () => {
	afterEach(async () => {
		delete process.env.CODEX_MODE;
		delete process.env.CODEX_AUTH_FAST_SESSION_STRATEGY;
		delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;
		for (const configPath of tempConfigPaths) {
			await removeWithRetry(configPath, { force: true }).catch(() => {});
		}
		tempConfigPaths.clear();
		loadUnifiedPluginConfigSyncMock.mockReset();
		loadUnifiedPluginConfigSyncMock.mockReturnValue(null);
		vi.resetModules();
	});

	it('marks entries sourced from unified settings as "unified"', async () => {
		loadUnifiedPluginConfigSyncMock.mockReturnValue({
			unsupportedCodexPolicy: "fallback",
		});
		const { getPluginConfigExplainReport } = await import("../lib/config.js");

		const report = getPluginConfigExplainReport();
		const entry = report.entries.find(
			(item) => item.key === "unsupportedCodexPolicy",
		);

		expect(report.storageKind).toBe("unified");
		expect(entry).toBeDefined();
		expect(entry?.source).toBe("unified");
	});

	it("treats invalid string env values as non-env sources", async () => {
		process.env.CODEX_AUTH_FAST_SESSION_STRATEGY = "bogus";
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const entry = report.entries.find(
			(item) => item.key === "fastSessionStrategy",
		);
		expect(entry).toBeDefined();
		expect(entry?.source).not.toBe("env");
	});

	it("attributes alias-backed fallback policy values to stored config", async () => {
		const configPath = nextConfigPath("alias");
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
		await fs.writeFile(
			configPath,
			JSON.stringify({ fallbackOnUnsupportedCodexModel: true }, null, 2),
			"utf-8",
		);
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const policy = expectEntry(report, "unsupportedCodexPolicy");
		const fallback = expectEntry(report, "fallbackOnUnsupportedCodexModel");
		expect(policy?.source).toBe("file");
		expect(fallback?.source).toBe("file");
	});

	it("reports missing config files as none", async () => {
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = nextConfigPath("missing");
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const entry = expectEntry(report, "codexMode");
		expect(report.storageKind).toBe("none");
		expect(entry?.source).toBe("default");
	});

	it("attributes stored single-key defaults to file config", async () => {
		const configPath = nextConfigPath("single-key-default");
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
		await fs.writeFile(
			configPath,
			JSON.stringify({ codexMode: true }, null, 2),
			"utf-8",
		);
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const entry = expectEntry(report, "codexMode");
		expect(report.storageKind).toBe("file");
		expect(entry?.source).toBe("file");
	});

	it("reports unreadable config files consistently", async () => {
		const configPath = nextConfigPath("malformed");
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
		await fs.writeFile(configPath, "{ malformed-json", "utf-8");
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const policy = expectEntry(report, "unsupportedCodexPolicy");
		const fallback = expectEntry(report, "fallbackOnUnsupportedCodexModel");
		expect(report.storageKind).toBe("unreadable");
		expect(policy?.source).not.toBe("file");
		expect(fallback?.source).not.toBe("file");
	});

	it("normalizes non-finite values for json-safe output", async () => {
		const { getPluginConfigExplainReport } = await import("../lib/config.js");
		const report = getPluginConfigExplainReport();
		const entry = expectEntry(report, "retryAllAccountsMaxRetries");
		expect(entry?.value).toBe("Infinity");
		expect(entry?.defaultValue).toBe("Infinity");
		const serialized = JSON.parse(JSON.stringify(report)) as {
			entries: Array<{ key: string; value: unknown; defaultValue: unknown }>;
		};
		const serializedEntry = serialized.entries.find(
			(item) => item.key === "retryAllAccountsMaxRetries",
		);
		expect(serializedEntry).toMatchObject({
			value: "Infinity",
			defaultValue: "Infinity",
		});
	});

	it("reports default and env sources", async () => {
		const mod = await import("../lib/config.js");
		let report = mod.getPluginConfigExplainReport();
		let entry = report.entries.find((item) => item.key === "codexMode");
		expect(entry).toBeDefined();
		expect(entry?.source).toBe("default");
		expect(report.storageKind).toBe("none");
		vi.resetModules();

		process.env.CODEX_AUTH_FAST_SESSION_STRATEGY = "always";
		const modWithEnv = await import("../lib/config.js");
		report = modWithEnv.getPluginConfigExplainReport();
		entry = report.entries.find((item) => item.key === "fastSessionStrategy");
		expect(entry).toBeDefined();
		expect(entry?.source).toBe("env");
	});
});
