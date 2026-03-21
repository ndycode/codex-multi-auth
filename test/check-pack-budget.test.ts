import { describe, expect, it, vi } from "vitest";
import {
	parsePackMetadata,
	runPackBudgetCheck,
	validatePackMetadata,
} from "../scripts/check-pack-budget-lib.js";

describe("parsePackMetadata", () => {
	it("normalizes Windows-style paths from npm pack output", () => {
		const result = parsePackMetadata(
			JSON.stringify([
				{
					size: 123,
					files: [
						{ path: String.raw`dist\index.js` },
						{ path: String.raw`vendor\codex-ai-plugin\index.js` },
					],
				},
			]),
		);
		expect(result).toEqual({
			packageSize: 123,
			paths: ["dist/index.js", "vendor/codex-ai-plugin/index.js"],
		});
	});

	it("throws when npm pack returns no package metadata", () => {
		expect(() => parsePackMetadata("[]")).toThrow(/no package metadata/);
	});

	it("throws when npm pack reports a non-positive package size", () => {
		expect(() =>
			parsePackMetadata(JSON.stringify([{ size: 0, files: [] }])),
		).toThrow(/valid package size/);
	});
});

describe("validatePackMetadata", () => {

	it("rejects oversized tarballs", () => {
		expect(() =>
			validatePackMetadata({
				packageSize: 9 * 1024 * 1024,
				paths: [
					"dist/index.js",
					"assets/logo.svg",
					"config/default.json",
					"scripts/codex.js",
					"vendor/codex-ai-plugin/index.js",
					"vendor/codex-ai-sdk/index.js",
					"README.md",
					"LICENSE",
				],
			}),
		).toThrow(/too large/);
	});

	it("rejects missing required package content", () => {
		expect(() =>
			validatePackMetadata({
				packageSize: 123,
				paths: [
					"dist/index.js",
					"assets/logo.svg",
					"config/default.json",
					"scripts/codex.js",
					"vendor/codex-ai-plugin/index.js",
					"README.md",
					"LICENSE",
				],
			}),
		).toThrow(/vendor\/codex-ai-sdk/);
	});
	it("rejects forbidden lib sources in the packed file list", () => {		expect(() =>
			validatePackMetadata({
				packageSize: 123,
				paths: [
					"dist/index.js",
					"assets/logo.svg",
					"config/default.json",
					"scripts/codex.js",
					"vendor/codex-ai-plugin/index.js",
					"vendor/codex-ai-sdk/index.js",
					"README.md",
					"LICENSE",
					"lib/storage.js",
				],
			}),
		).toThrow(/Forbidden file leaked into package: lib\/storage\.js/);
	});
});

describe("runPackBudgetCheck", () => {
	it("logs the pack summary for valid metadata", async () => {
		const log = vi.fn();
		await expect(
			runPackBudgetCheck({
				execAsync: vi.fn(async () => ({
					stdout: JSON.stringify([
						{
							size: 321,
							files: [
								{ path: "dist/index.js" },
								{ path: "assets/logo.svg" },
								{ path: "config/default.json" },
								{ path: "scripts/codex.js" },
								{ path: "vendor/codex-ai-plugin/index.js" },
								{ path: "vendor/codex-ai-sdk/index.js" },
								{ path: "README.md" },
								{ path: "LICENSE" },
							],
						},
					]),
				})),
				log,
			}),
		).resolves.toBe("Pack budget ok: 321 bytes across 8 files");
		expect(log).toHaveBeenCalledWith("Pack budget ok: 321 bytes across 8 files");
	});
});
