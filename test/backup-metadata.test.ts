import { describe, expect, it } from "vitest";
import {
	buildMetadataSection,
	latestValidSnapshot,
	type BackupSnapshotMetadata,
} from "../lib/storage/backup-metadata.js";

function createSnapshot(
	overrides: Partial<BackupSnapshotMetadata>,
): BackupSnapshotMetadata {
	return {
		kind: "accounts-backup",
		path: "/tmp/openai-codex-accounts.json.bak",
		exists: true,
		valid: true,
		...overrides,
	};
}

describe("backup metadata helpers", () => {
	it("returns undefined when every snapshot is invalid", () => {
		const snapshots = [
			createSnapshot({ path: "/tmp/a.bak", valid: false }),
			createSnapshot({ path: "/tmp/b.bak", valid: false, mtimeMs: 10 }),
		];

		expect(latestValidSnapshot(snapshots)).toBeUndefined();
	});

	it("keeps the first valid snapshot when mtimes tie", () => {
		const first = createSnapshot({ path: "/tmp/first.bak", mtimeMs: 50 });
		const second = createSnapshot({
			path: "/tmp/second.bak",
			kind: "accounts-backup-history",
			mtimeMs: 50,
		});

		expect(latestValidSnapshot([first, second])).toEqual(first);
	});

	it("treats missing mtimes as zero when choosing the latest valid snapshot", () => {
		const first = createSnapshot({ path: "/tmp/first.bak" });
		const second = createSnapshot({
			path: "/tmp/second.bak",
			kind: "accounts-discovered-backup",
		});

		expect(latestValidSnapshot([first, second])).toEqual(first);
	});

	it("builds section counts and omits latestValidPath when no valid snapshots exist", () => {
		const snapshots = [
			createSnapshot({ path: "/tmp/invalid-a.bak", valid: false }),
			createSnapshot({
				path: "/tmp/invalid-b.bak",
				kind: "accounts-backup-history",
				valid: false,
			}),
		];

		expect(buildMetadataSection("/tmp/openai-codex-accounts.json", snapshots)).toEqual(
			{
				storagePath: "/tmp/openai-codex-accounts.json",
				latestValidPath: undefined,
				snapshotCount: 2,
				validSnapshotCount: 0,
				snapshots,
			},
		);
	});
});
