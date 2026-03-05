import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { promises as fs } from "node:fs";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const scriptPath = path.resolve(process.cwd(), "scripts", "retention-cleanup.js");

function runRetentionCleanup(root: string, extraArgs: string[] = []) {
	return spawnSync(process.execPath, [scriptPath, ...extraArgs], {
		encoding: "utf8",
		env: {
			...process.env,
			CODEX_MULTI_AUTH_DIR: root,
		},
	});
}

function parseJsonStdout(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

describe("retention-cleanup script", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
	});

	it("handles target directory churn (ENOTDIR) gracefully", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "retention-churn-"));
		fixtures.push(root);
		await fs.writeFile(path.join(root, "logs"), "not-a-dir", "utf8");

		const result = runRetentionCleanup(root, ["--days=1"]);
		expect(result.status).toBe(0);
		const payload = parseJsonStdout(result.stdout);
		expect(payload.status).toBe("pass");
		expect(payload.failedFiles).toBe(0);
	});

	it.skipIf(process.platform === "win32")("exits non-zero when deletions fail", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "retention-fail-"));
		fixtures.push(root);
		const logsDir = path.join(root, "logs");
		await fs.mkdir(logsDir, { recursive: true });
		const stalePath = path.join(logsDir, "stale.log");
		await fs.writeFile(stalePath, "stale\n", "utf8");
		const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		utimesSync(stalePath, staleDate, staleDate);

		chmodSync(logsDir, 0o500);
		let result: SpawnSyncReturns<string>;
		try {
			result = runRetentionCleanup(root, ["--days=1"]);
		} finally {
			chmodSync(logsDir, 0o700);
		}

		expect(result.status).toBe(1);
		const payload = parseJsonStdout(result.stdout);
		expect(payload.status).toBe("partial");
		expect((payload.failedFiles as number) > 0).toBe(true);
	});
});
