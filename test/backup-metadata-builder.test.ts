import { describe, expect, it, vi } from "vitest";
import { buildBackupMetadata } from "../lib/storage/backup-metadata-builder.js";
import { buildMetadataSection } from "../lib/storage/metadata-section.js";

describe("backup metadata builder", () => {
	it("builds account and flagged metadata sections from discovered snapshots", async () => {
		const buildMetadataSection = vi.fn(
			(storagePath: string, snapshots: Array<{ path: string }>) => ({
				storagePath,
				latestValidPath: snapshots.at(-1)?.path,
				snapshotCount: snapshots.length,
				validSnapshotCount: snapshots.length,
				snapshots,
			}),
		);

		const result = await buildBackupMetadata({
			storagePath: "/tmp/accounts.json",
			flaggedPath: "/tmp/flagged.json",
			walPath: "/tmp/accounts.json.wal",
			getAccountsBackupRecoveryCandidatesWithDiscovery: async (path) =>
				path.includes("flagged")
					? ["/tmp/flagged.json.bak"]
					: ["/tmp/accounts.json.bak"],
			describeAccountSnapshot: async (path, kind, index) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
			}),
			describeAccountsWalSnapshot: async (path) => ({
				path,
				kind: "accounts-wal",
				exists: true,
				valid: true,
			}),
			describeFlaggedSnapshot: async (path, kind, index) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
			}),
			buildMetadataSection,
		});

		expect(buildMetadataSection).toHaveBeenCalledTimes(2);
		expect(result.accounts.snapshotCount).toBe(3);
		expect(result.flaggedAccounts.snapshotCount).toBe(2);
	});

	it("prefers discovered account backups over WAL when selecting latestValidPath", async () => {
		const storagePath = "/tmp/accounts.json";
		const walPath = `${storagePath}.wal`;
		const backupPath = `${storagePath}.bak`;
		const manualPath = `${storagePath}.manual-checkpoint`;

		const result = await buildBackupMetadata({
			storagePath,
			flaggedPath: "/tmp/flagged.json",
			walPath,
			getAccountsBackupRecoveryCandidatesWithDiscovery: async (path) =>
				path.includes("flagged") ? [] : [backupPath, manualPath],
			describeAccountSnapshot: async (path, kind, index) => ({
				path,
				kind,
				index,
				exists: true,
				valid: kind !== "accounts-primary",
				mtimeMs:
					path === manualPath
						? 100
						: path === backupPath
							? 100
						: path === walPath
							? 200
							: 50,
			}),
			describeAccountsWalSnapshot: async (path) => ({
				path,
				kind: "accounts-wal",
				exists: true,
				valid: true,
				mtimeMs: 200,
			}),
			describeFlaggedSnapshot: async (path, kind, index) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
				mtimeMs: 10,
			}),
			buildMetadataSection,
		});

		expect(result.accounts.latestValidPath).toBe(manualPath);
	});
});
