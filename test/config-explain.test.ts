import { afterEach, describe, expect, it } from "vitest";
import { getPluginConfigExplainReport } from "../lib/config.js";

describe("getPluginConfigExplainReport", () => {
	afterEach(() => {
		delete process.env.CODEX_MODE;
	});

	it("treats empty env vars as non-env sources", () => {
		process.env.CODEX_MODE = "   ";
		const report = getPluginConfigExplainReport();
		const entry = report.entries.find((item) => item.key === "codexMode");
		expect(entry?.source).not.toBe("env");
	});
});
