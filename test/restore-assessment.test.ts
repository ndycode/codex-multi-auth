import { describe, expect, it } from "vitest";
import { buildRestoreAssessment } from "../lib/storage/restore-assessment.js";

describe("buildRestoreAssessment", () => {
	it("prefers the latest valid backup over an empty primary", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "C:/repo/accounts.json",
			resetMarkerExists: false,
			backupMetadata: {
				accounts: {
					path: "C:/repo/accounts.json",
					latestValidPath: "C:/repo/accounts.json.bak",
					snapshots: [
						{ kind: "accounts-primary", path: "C:/repo/accounts.json", exists: true, valid: true, accountCount: 0 },
						{ kind: "accounts-backup", path: "C:/repo/accounts.json.bak", exists: true, valid: true, accountCount: 2 },
					],
				},
				flaggedAccounts: { path: "C:/repo/flagged.json", latestValidPath: undefined, snapshots: [] },
			},
		});
		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("empty-storage");
		expect(assessment.latestSnapshot?.path).toBe("C:/repo/accounts.json.bak");
	});

	it("matches latest valid snapshot paths across path separators", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "C:/repo/accounts.json",
			resetMarkerExists: false,
			backupMetadata: {
				accounts: {
					path: "C:/repo/accounts.json",
					latestValidPath: "C:\\repo\\accounts.json.bak",
					snapshots: [
						{ kind: "accounts-primary", path: "C:/repo/accounts.json", exists: false, valid: false },
						{ kind: "accounts-backup", path: "C:/repo/accounts.json.bak", exists: true, valid: true, accountCount: 1 },
					],
				},
				flaggedAccounts: { path: "C:/repo/flagged.json", latestValidPath: undefined, snapshots: [] },
			},
		});
		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("missing-storage");
		expect(assessment.latestSnapshot?.path).toBe("C:/repo/accounts.json.bak");
	});
});
