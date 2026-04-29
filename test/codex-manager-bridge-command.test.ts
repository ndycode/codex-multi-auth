import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBridgeCommand } from "../lib/codex-manager/commands/bridge.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("bridge command", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-bridge-command-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("creates and lists token metadata while showing plaintext only on create", async () => {
		const logInfo = vi.fn();
		const exitCode = await runBridgeCommand(
			["token", "create", "--label", "OpenCode"],
			{ logInfo, logError: vi.fn() },
		);
		expect(exitCode).toBe(0);
		const createOutput = logInfo.mock.calls.map((call) => String(call[0])).join("\n");
		expect(createOutput).toContain("Token:");
		const token = createOutput.match(/Token: (cma_local_[^\s]+)/)?.[1];
		expect(token).toBeTruthy();

		logInfo.mockClear();
		expect(
			await runBridgeCommand(["token", "list"], {
				logInfo,
				logError: vi.fn(),
			}),
		).toBe(0);
		const listOutput = logInfo.mock.calls.map((call) => String(call[0])).join("\n");
		expect(listOutput).toContain("OpenCode active");
		expect(listOutput).not.toContain(token);
	});
});
