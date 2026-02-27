import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshLeaseCoordinator } from "../lib/refresh-lease.js";

const sampleSuccessResult = {
	type: "success" as const,
	access: "access-token",
	refresh: "refresh-token-next",
	expires: Date.now() + 60_000,
};

function hashToken(refreshToken: string): string {
	return createHash("sha256").update(refreshToken).digest("hex");
}

describe("RefreshLeaseCoordinator", () => {
	let leaseDir = "";

	beforeEach(async () => {
		leaseDir = await mkdtemp(join(tmpdir(), "codex-refresh-lease-"));
	});

	afterEach(() => {
		leaseDir = "";
		vi.restoreAllMocks();
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

	it("does not delete unreadable lock payloads", async () => {
		const refreshToken = "token-partial";
		const coordinator = new RefreshLeaseCoordinator({
			enabled: true,
			leaseDir,
			leaseTtlMs: 10_000,
			waitTimeoutMs: 120,
			pollIntervalMs: 25,
			resultTtlMs: 2_000,
		});
		await mkdir(leaseDir, { recursive: true });
		const tokenHash = hashToken(refreshToken);
		const lockPath = join(leaseDir, `${tokenHash}.lock`);
		await writeFile(lockPath, "{", "utf8");

		const handle = await coordinator.acquire(refreshToken);
		expect(handle.role).toBe("bypass");
		const lockContent = await readFile(lockPath, "utf8");
		expect(lockContent).toBe("{");
	});

	it("retries stale lock cleanup when unlink is temporarily busy", async () => {
		const refreshToken = "token-retry";
		const tokenHash = hashToken(refreshToken);
		let busyCount = 0;
		const originalUnlink = fsPromises.unlink.bind(fsPromises);
		const fsOps = {
			mkdir: fsPromises.mkdir.bind(fsPromises),
			open: fsPromises.open.bind(fsPromises),
			writeFile: fsPromises.writeFile.bind(fsPromises),
			rename: fsPromises.rename.bind(fsPromises),
			unlink: vi.fn(async (path: Parameters<typeof fsPromises.unlink>[0]) => {
				if (String(path).endsWith(".lock") && busyCount < 2) {
					busyCount += 1;
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
				return originalUnlink(path);
			}),
			readFile: fsPromises.readFile.bind(fsPromises),
			stat: fsPromises.stat.bind(fsPromises),
			readdir: fsPromises.readdir.bind(fsPromises),
		};

		const coordinator = new RefreshLeaseCoordinator({
			enabled: true,
			leaseDir,
			leaseTtlMs: 2_000,
			waitTimeoutMs: 400,
			pollIntervalMs: 20,
			resultTtlMs: 2_000,
			fsOps,
		});

		await mkdir(leaseDir, { recursive: true });
		const lockPath = join(leaseDir, `${tokenHash}.lock`);
		await writeFile(
			lockPath,
			JSON.stringify({
				tokenHash,
				pid: 1111,
				acquiredAt: Date.now() - 10_000,
				expiresAt: Date.now() - 5_000,
			}),
			"utf8",
		);

		const handle = await coordinator.acquire(refreshToken);
		expect(handle.role).toBe("owner");
		expect(fsOps.unlink).toHaveBeenCalled();
		expect(busyCount).toBe(2);
		await handle.release(sampleSuccessResult);
	});

	it("times out to bypass when stale lock cannot be deleted", async () => {
		const refreshToken = "token-timeout";
		const tokenHash = hashToken(refreshToken);
		const originalUnlink = fsPromises.unlink.bind(fsPromises);
		const fsOps = {
			mkdir: fsPromises.mkdir.bind(fsPromises),
			open: fsPromises.open.bind(fsPromises),
			writeFile: fsPromises.writeFile.bind(fsPromises),
			rename: fsPromises.rename.bind(fsPromises),
			unlink: vi.fn(async (path: Parameters<typeof fsPromises.unlink>[0]) => {
				if (String(path).endsWith(".lock")) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
				return originalUnlink(path);
			}),
			readFile: fsPromises.readFile.bind(fsPromises),
			stat: fsPromises.stat.bind(fsPromises),
			readdir: fsPromises.readdir.bind(fsPromises),
		};

		const coordinator = new RefreshLeaseCoordinator({
			enabled: true,
			leaseDir,
			leaseTtlMs: 2_000,
			waitTimeoutMs: 140,
			pollIntervalMs: 25,
			resultTtlMs: 2_000,
			fsOps,
		});

		await mkdir(leaseDir, { recursive: true });
		const lockPath = join(leaseDir, `${tokenHash}.lock`);
		await writeFile(
			lockPath,
			JSON.stringify({
				tokenHash,
				pid: 2222,
				acquiredAt: Date.now() - 10_000,
				expiresAt: Date.now() - 5_000,
			}),
			"utf8",
		);

		const handle = await coordinator.acquire(refreshToken);
		expect(handle.role).toBe("bypass");
		expect(fsOps.unlink).toHaveBeenCalled();
		await handle.release(sampleSuccessResult);
	});
});
