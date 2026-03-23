import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(
	process.cwd(),
	"scripts",
	"benchmark-render-dashboard.mjs",
);
const tempRoots: string[] = [];

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	const retryableCodes = new Set(["ENOTEMPTY", "EPERM", "EBUSY"]);
	const maxAttempts = 6;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await rm(targetPath, options);
			return;
		} catch (error) {
			const code =
				error &&
				typeof error === "object" &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: undefined;
			if (!code || !retryableCodes.has(code) || attempt === maxAttempts) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 50));
		}
	}
}

function createSummaryFixture() {
	return {
		meta: {
			generatedAt: "2026-03-22T00:00:00.000Z",
			preset: "codex-core",
			models: ["gpt-5-codex"],
			tasks: ["task-1"],
			modes: ["patch", "replace", "hashline", "hashline_v2"],
			runCount: 1,
			warmupCount: 0,
		},
		rows: [
			{
				modelId: "gpt-5-codex",
				displayName: "GPT-5 Codex",
				modes: {
					patch: {
						accuracyPct: 90,
						wallMsP50: 1000,
						tokensTotalP50: 100,
					},
					replace: {
						accuracyPct: 85,
						wallMsP50: 1100,
						tokensTotalP50: 90,
					},
					hashline: {
						accuracyPct: 88,
						wallMsP50: 1050,
						tokensTotalP50: 95,
					},
					hashline_v2: {
						accuracyPct: 92,
						wallMsP50: 980,
						tokensTotalP50: 80,
					},
				},
			},
		],
		failures: [],
	};
}

function createTempRoot(suffix = ""): string {
	const root = mkdtempSync(path.join(tmpdir(), `bench-render${suffix}-`));
	tempRoots.push(root);
	return root;
}

function writeSummary(inputPath: string): void {
	writeFileSync(inputPath, JSON.stringify(createSummaryFixture(), null, 2), "utf8");
}

function runRenderDashboard(args: string[]) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		encoding: "utf8",
		timeout: 10_000,
	});
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			await removeWithRetry(root, { recursive: true, force: true });
		}
	}
});

describe("benchmark render dashboard script", () => {
	it("renders HTML from a minimal summary file", () => {
		const root = createTempRoot();
		const inputPath = path.join(root, "summary.json");
		const outputPath = path.join(root, "dashboard.html");

		writeSummary(inputPath);

		const result = runRenderDashboard([
			`--input=${inputPath}`,
			`--output=${outputPath}`,
		]);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Dashboard written:");
		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("Code Edit Format Benchmark");
		expect(html).toContain("GPT-5 Codex");
	});

	it("renders HTML when input and output paths contain spaces", () => {
		const root = createTempRoot(" spaces");
		const spacedDir = path.join(root, "with spaces");
		mkdirSync(spacedDir, { recursive: true });
		const inputPath = path.join(spacedDir, "summary file.json");
		const outputPath = path.join(spacedDir, "dashboard output.html");

		writeSummary(inputPath);

		const result = runRenderDashboard([
			`--input=${inputPath}`,
			`--output=${outputPath}`,
		]);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Dashboard written:");
		expect(readFileSync(outputPath, "utf8")).toContain("GPT-5 Codex");
	});

	it("fails with stderr when the input file is missing", () => {
		const root = createTempRoot();
		const inputPath = path.join(root, "missing-summary.json");
		const outputPath = path.join(root, "dashboard.html");

		const result = runRenderDashboard([
			`--input=${inputPath}`,
			`--output=${outputPath}`,
		]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Render failed:");
		expect(result.stderr.toLowerCase()).toContain("no such file");
		expect(result.stdout).not.toContain("Dashboard written:");
	});

	it("fails with stderr when the summary json is malformed", () => {
		const root = createTempRoot();
		const inputPath = path.join(root, "summary.json");
		const outputPath = path.join(root, "dashboard.html");

		writeFileSync(inputPath, "{ not-valid-json", "utf8");

		const result = runRenderDashboard([
			`--input=${inputPath}`,
			`--output=${outputPath}`,
		]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Render failed:");
		expect(result.stderr.toLowerCase()).toContain("json");
		expect(result.stdout).not.toContain("Dashboard written:");
	});

	it("fails with stderr when the output directory does not exist", () => {
		const root = createTempRoot();
		const inputPath = path.join(root, "summary.json");
		const outputPath = path.join(root, "missing", "dashboard.html");

		writeSummary(inputPath);

		const result = runRenderDashboard([
			`--input=${inputPath}`,
			`--output=${outputPath}`,
		]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Render failed:");
		expect(result.stdout).not.toContain("Dashboard written:");
	});
});
