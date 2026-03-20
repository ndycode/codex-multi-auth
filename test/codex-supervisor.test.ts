import { EventEmitter } from "node:events";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testOnly as supervisorTestApi } from "../scripts/codex-supervisor.js";

const createdDirs: string[] = [];

async function removeDirectoryWithRetry(dir: string): Promise<void> {
	const retryableCodes = new Set(["ENOTEMPTY", "EPERM", "EBUSY"]);
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? `${error.code ?? ""}`
					: "";
			if (!retryableCodes.has(code) || attempt === 6) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 50));
		}
	}
}

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-supervisor-test-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.useRealTimers();
	for (const dir of createdDirs.splice(0, createdDirs.length).reverse()) {
		await removeDirectoryWithRetry(dir);
	}
});

describe("codex supervisor", () => {
	it("finds session metadata when it lands on the 200th non-empty line", async () => {
		expect(supervisorTestApi).toBeDefined();
		const dir = createTempDir();
		const filePath = join(dir, "boundary.jsonl");
		const preamble = Array.from({ length: 199 }, (_unused, index) =>
			JSON.stringify({ type: "event", seq: index + 1 }),
		);
		await fs.writeFile(
			filePath,
			[
				...preamble,
				JSON.stringify({
					session_meta: {
						payload: { id: "boundary-session", cwd: dir },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi?.extractSessionMeta(filePath)).resolves.toEqual({
			sessionId: "boundary-session",
			cwd: dir,
		});
	});

	it("misses session metadata beyond the 200-line scan limit", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "over-limit.jsonl");
		const preamble = Array.from({ length: 200 }, (_unused, index) =>
			JSON.stringify({ type: "event", seq: index + 1 }),
		);
		await fs.writeFile(
			filePath,
			[
				...preamble,
				JSON.stringify({
					session_meta: {
						payload: { id: "missed-session", cwd: dir },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi?.extractSessionMeta(filePath)).resolves.toBeNull();
	});

	it("interrupts child restart waits when the abort signal fires", async () => {
		vi.useFakeTimers();
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const child = new FakeChild();
		const controller = new AbortController();
		const pending = supervisorTestApi?.requestChildRestart(
			child,
			"win32",
			controller.signal,
		);

		controller.abort();
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toBeUndefined();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});
});
