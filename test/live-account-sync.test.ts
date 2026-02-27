import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LiveAccountSync } from "../lib/live-account-sync.js";

describe("live-account-sync", () => {
	let workDir = "";
	let storagePath = "";

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-26T12:00:00.000Z"));
		workDir = join(tmpdir(), `codex-live-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		storagePath = join(workDir, "openai-codex-accounts.json");
		await fs.mkdir(workDir, { recursive: true });
		await fs.writeFile(storagePath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }), "utf-8");
	});

	afterEach(async () => {
		vi.useRealTimers();
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it("reloads when file changes are detected by polling", async () => {
		const reload = vi.fn(async () => undefined);
		const sync = new LiveAccountSync(reload, { pollIntervalMs: 500, debounceMs: 50 });

		await sync.syncToPath(storagePath);
		await fs.writeFile(storagePath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "a" }] }), "utf-8");
		const bumped = new Date(Date.now() + 1_000);
		await fs.utimes(storagePath, bumped, bumped);

		await vi.advanceTimersByTimeAsync(900);

		expect(reload).toHaveBeenCalled();
		const snapshot = sync.getSnapshot();
		expect(snapshot.reloadCount).toBeGreaterThan(0);
		expect(snapshot.lastSyncAt).not.toBeNull();
		sync.stop();
	});

	it("records errors when reload fails", async () => {
		const reload = vi.fn(async () => {
			throw new Error("reload failed");
		});
		const sync = new LiveAccountSync(reload, { pollIntervalMs: 500, debounceMs: 50 });

		await sync.syncToPath(storagePath);
		await fs.writeFile(storagePath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "b" }] }), "utf-8");
		const bumped = new Date(Date.now() + 2_000);
		await fs.utimes(storagePath, bumped, bumped);

		await vi.advanceTimersByTimeAsync(900);

		const snapshot = sync.getSnapshot();
		expect(snapshot.errorCount).toBeGreaterThan(0);
		expect(snapshot.reloadCount).toBe(0);
		sync.stop();
	});

	it("stops watching cleanly and prevents further reloads", async () => {
		const reload = vi.fn(async () => undefined);
		const sync = new LiveAccountSync(reload, { pollIntervalMs: 500, debounceMs: 50 });

		await sync.syncToPath(storagePath);
		sync.stop();
		await fs.writeFile(storagePath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "c" }] }), "utf-8");
		const bumped = new Date(Date.now() + 3_000);
		await fs.utimes(storagePath, bumped, bumped);

		await vi.advanceTimersByTimeAsync(1_200);

		expect(reload).not.toHaveBeenCalled();
		expect(sync.getSnapshot().running).toBe(false);
	});
});

