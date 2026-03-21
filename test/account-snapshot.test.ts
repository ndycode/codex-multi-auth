import { describe, expect, it, vi } from "vitest";
import { describeAccountSnapshot, statSnapshot } from "../lib/storage/account-snapshot.js";

describe("statSnapshot", () => {
	it("returns size and mtime for accessible snapshots", async () => {
		await expect(
			statSnapshot("accounts.json", {
				stat: vi.fn(async () => ({ size: 1234, mtimeMs: 5678 })),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({ exists: true, bytes: 1234, mtimeMs: 5678 });
	});

	it("returns missing metadata for ENOENT", async () => {
		await expect(
			statSnapshot("missing.json", {
				stat: vi.fn(async () => {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				}),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({ exists: false });
	});

	it("logs and returns missing metadata for non-ENOENT stat failures", async () => {
		const logWarn = vi.fn();
		await expect(
			statSnapshot("denied.json", {
				stat: vi.fn(async () => {
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				}),
				logWarn,
			}),
		).resolves.toEqual({ exists: false });
		expect(logWarn).toHaveBeenCalledWith(
			"Failed to stat backup candidate",
			expect.objectContaining({ path: "denied.json" }),
		);
	});
	it("treats locked snapshots as existing when stat returns EBUSY", async () => {
		const logWarn = vi.fn();
		await expect(
			statSnapshot("locked.json", {
				stat: vi.fn(async () => {
					throw Object.assign(new Error("busy"), { code: "EBUSY" });
				}),
				logWarn,
			}),
		).resolves.toEqual({ exists: true });
		expect(logWarn).toHaveBeenCalledWith(
			"Backup candidate is locked",
			expect.objectContaining({ path: "locked.json" }),
		);
	});

	it("treats locked snapshots as existing when stat returns EPERM", async () => {
		const logWarn = vi.fn();
		await expect(
			statSnapshot("locked.json", {
				stat: vi.fn(async () => {
					throw Object.assign(new Error("perm"), { code: "EPERM" });
				}),
				logWarn,
			}),
		).resolves.toEqual({ exists: true });
		expect(logWarn).toHaveBeenCalledWith(
			"Backup candidate is locked",
			expect.objectContaining({ path: "locked.json" }),
		);
	});

});

describe("describeAccountSnapshot", () => {
	it("marks schema-error snapshots valid while preserving schema errors in metadata", async () => {
		await expect(
			describeAccountSnapshot("accounts.json", "accounts-primary", {
				index: 0,
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadAccountsFromPath: vi.fn(async () => ({ normalized: { accounts: [{ id: 1 }] }, schemaErrors: ["bad"], storedVersion: 3 })),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "accounts.json",
			index: 0,
			exists: true,
			valid: true,
			bytes: 12,
			mtimeMs: 34,
			version: 3,
			accountCount: 1,
			schemaErrors: ["bad"],
		});
	});

	it("marks null-normalized snapshots invalid while preserving metadata", async () => {
		await expect(
			describeAccountSnapshot("accounts.json", "accounts-primary", {
				index: 0,
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadAccountsFromPath: vi.fn(async () => ({ normalized: null, schemaErrors: [], storedVersion: 3 })),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "accounts.json",
			index: 0,
			exists: true,
			valid: false,
			bytes: 12,
			mtimeMs: 34,
			version: 3,
			accountCount: undefined,
			schemaErrors: undefined,
		});
	});

	it("returns metadata for valid snapshots", async () => {
		await expect(
			describeAccountSnapshot("accounts.json", "accounts-primary", {
				index: 0,
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadAccountsFromPath: vi.fn(async () => ({
					normalized: { accounts: [{ id: 1 }, { id: 2 }] },
					schemaErrors: [],
					storedVersion: 3,
				})),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "accounts.json",
			index: 0,
			exists: true,
			valid: true,
			bytes: 12,
			mtimeMs: 34,
			version: 3,
			accountCount: 2,
		});
	});

	it("refreshes snapshot metadata after a transient stat lock", async () => {
		const statSnapshot = vi
			.fn()
			.mockResolvedValueOnce({ exists: true })
			.mockResolvedValueOnce({ exists: true, bytes: 12, mtimeMs: 34 });

		await expect(
			describeAccountSnapshot("accounts.json", "accounts-primary", {
				index: 0,
				statSnapshot,
				loadAccountsFromPath: vi.fn(async () => ({
					normalized: { accounts: [{ id: 1 }] },
					schemaErrors: [],
					storedVersion: 3,
				})),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "accounts.json",
			index: 0,
			exists: true,
			valid: true,
			bytes: 12,
			mtimeMs: 34,
			version: 3,
			accountCount: 1,
		});

		expect(statSnapshot).toHaveBeenCalledTimes(2);
	});

	it("falls back to zeroed metadata after repeated stat locks", async () => {
		const statSnapshot = vi
			.fn()
			.mockResolvedValueOnce({ exists: true })
			.mockResolvedValueOnce({ exists: true })
			.mockResolvedValueOnce({ exists: true });

		await expect(
			describeAccountSnapshot("accounts.json", "accounts-primary", {
				index: 0,
				statSnapshot,
				loadAccountsFromPath: vi.fn(async () => ({
					normalized: { accounts: [{ id: 1 }] },
					schemaErrors: [],
					storedVersion: 3,
				})),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "accounts.json",
			index: 0,
			exists: true,
			valid: true,
			bytes: 0,
			mtimeMs: 0,
			version: 3,
			accountCount: 1,
		});

		expect(statSnapshot).toHaveBeenCalledTimes(3);
	});

	it("returns invalid metadata when the loader fails", async () => {
		const logWarn = vi.fn();
		await expect(
			describeAccountSnapshot("accounts.json", "accounts-primary", {
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadAccountsFromPath: vi.fn(async () => {
					throw Object.assign(new Error("boom"), { code: "EACCES" });
				}),
				logWarn,
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "accounts.json",
			index: undefined,
			exists: true,
			valid: false,
			bytes: 12,
			mtimeMs: 34,
		});
		expect(logWarn).toHaveBeenCalledWith(
			"Failed to inspect account snapshot",
			expect.objectContaining({ path: "accounts.json" }),
		);
	});

	it("returns missing metadata when stat reports the snapshot missing", async () => {
		await expect(
			describeAccountSnapshot("missing.json", "accounts-primary", {
				index: 2,
				statSnapshot: vi.fn(async () => ({ exists: false })),
				loadAccountsFromPath: vi.fn(),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "missing.json",
			index: 2,
			exists: false,
			valid: false,
		});
	});

	it("treats ENOENT during load as an invalid existing snapshot", async () => {
		await expect(
			describeAccountSnapshot("gone.json", "accounts-primary", {
				index: 1,
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadAccountsFromPath: vi.fn(async () => {
					throw Object.assign(new Error("gone"), { code: "ENOENT" });
				}),
				logWarn: vi.fn(),
			}),
		).resolves.toEqual({
			kind: "accounts-primary",
			path: "gone.json",
			index: 1,
			exists: true,
			valid: false,
			bytes: 12,
			mtimeMs: 34,
		});
	});
});
