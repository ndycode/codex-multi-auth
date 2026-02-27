import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefreshLeaseCoordinator } from "../lib/refresh-lease.js";

const sampleSuccessResult = {
	type: "success" as const,
	access: "access-token",
	refresh: "refresh-token-next",
	expires: Date.now() + 60_000,
};

describe("RefreshLeaseCoordinator", () => {
	let leaseDir = "";

	beforeEach(async () => {
		leaseDir = await mkdtemp(join(tmpdir(), "codex-refresh-lease-"));
	});

	afterEach(() => {
		leaseDir = "";
	});

	it("returns owner then follower with shared result", async () => {
		const coordinator = new RefreshLeaseCoordinator({
			enabled: true,
			leaseDir,
			leaseTtlMs: 5_000,
			waitTimeoutMs: 500,
			pollIntervalMs: 25,
			resultTtlMs: 2_000,
		});

		const owner = await coordinator.acquire("token-a");
		expect(owner.role).toBe("owner");
		await owner.release(sampleSuccessResult);

		const follower = await coordinator.acquire("token-a");
		expect(follower.role).toBe("follower");
		expect(follower.result).toEqual(sampleSuccessResult);
	});

	it("recovers from stale lock payload", async () => {
		const coordinator = new RefreshLeaseCoordinator({
			enabled: true,
			leaseDir,
			leaseTtlMs: 2_000,
			waitTimeoutMs: 300,
			pollIntervalMs: 20,
		});

		const tokenHash = "7f4a7c15f6f8c0f98d95c58f18f6f31e4f55cc4c52f8f4de4fd4d95a88e4866c";
		await mkdir(leaseDir, { recursive: true });
		await writeFile(
			join(leaseDir, `${tokenHash}.lock`),
			JSON.stringify({
				tokenHash,
				pid: 9999,
				acquiredAt: Date.now() - 10_000,
				expiresAt: Date.now() - 1_000,
			}),
			"utf8",
		);

		const handle = await coordinator.acquire("token-stale");
		expect(handle.role).toBe("owner");
		await handle.release(sampleSuccessResult);
	});

	it("supports bypass mode", async () => {
		const coordinator = new RefreshLeaseCoordinator({
			enabled: false,
			leaseDir,
		});
		const handle = await coordinator.acquire("token-b");
		expect(handle.role).toBe("bypass");
		await handle.release(sampleSuccessResult);
	});
});
