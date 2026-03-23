import { describe, expect, it } from "vitest";
import { buildRestoreAssessment } from "../lib/storage/restore-assessment.js";
import type { BackupMetadata } from "../lib/storage.js";

function createBackupMetadata(
	overrides?: Partial<BackupMetadata>,
): BackupMetadata {
	return {
		accounts: {
			storagePath: "/tmp/accounts.json",
			latestValidPath: "/tmp/accounts.json.bak",
			snapshotCount: 2,
			validSnapshotCount: 1,
			snapshots: [
				{
					kind: "accounts-primary",
					path: "/tmp/accounts.json",
					exists: true,
					valid: true,
					accountCount: 1,
				},
				{
					kind: "accounts-backup",
					path: "/tmp/accounts.json.bak",
					exists: true,
					valid: true,
					accountCount: 2,
				},
			],
		},
		flaggedAccounts: {
			storagePath: "/tmp/flagged.json",
			snapshotCount: 0,
			validSnapshotCount: 0,
			snapshots: [],
		},
		...overrides,
	};
}

describe("restore assessment helper", () => {
	it("marks intentional reset as not restorable", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "/tmp/accounts.json",
			backupMetadata: createBackupMetadata(),
			hasResetMarker: true,
		});

		expect(assessment.restoreEligible).toBe(false);
		expect(assessment.restoreReason).toBe("intentional-reset");
	});

	it("marks missing primary storage as restorable from latest snapshot", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "/tmp/accounts.json",
			backupMetadata: createBackupMetadata({
				accounts: {
					storagePath: "/tmp/accounts.json",
					latestValidPath: "/tmp/accounts.json.bak",
					snapshotCount: 2,
					validSnapshotCount: 1,
					snapshots: [
						{
							kind: "accounts-primary",
							path: "/tmp/accounts.json",
							exists: false,
							valid: false,
						},
						{
							kind: "accounts-backup",
							path: "/tmp/accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 2,
						},
					],
				},
			}),
			hasResetMarker: false,
		});

		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("missing-storage");
		expect(assessment.latestSnapshot?.path).toBe("/tmp/accounts.json.bak");
	});

	it("marks empty primary storage as restorable from primary snapshot", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "/tmp/accounts.json",
			backupMetadata: createBackupMetadata({
				accounts: {
					storagePath: "/tmp/accounts.json",
					latestValidPath: "/tmp/accounts.json",
					snapshotCount: 1,
					validSnapshotCount: 1,
					snapshots: [
						{
							kind: "accounts-primary",
							path: "/tmp/accounts.json",
							exists: true,
							valid: true,
							accountCount: 0,
						},
					],
				},
			}),
			hasResetMarker: false,
		});

		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("empty-storage");
		expect(assessment.latestSnapshot?.kind).toBe("accounts-primary");
	});
});
