import { describe, expect, it } from "vitest";
import {
	buildMetadataSection,
	latestValidSnapshot,
} from "../lib/storage/metadata-section.js";

describe("metadata section helpers", () => {
	it("returns the newest valid snapshot by mtime", () => {
		const snapshots = [
			{ path: "a", valid: true, mtimeMs: 10 },
			{ path: "b", valid: false, mtimeMs: 20 },
			{ path: "c", valid: true, mtimeMs: 30 },
		];

		expect(latestValidSnapshot(snapshots)?.path).toBe("c");
	});

	it("builds metadata section counts and latest path", () => {
		const snapshots = [
			{ path: "a", valid: true, mtimeMs: 10 },
			{ path: "b", valid: false, mtimeMs: 20 },
		];

		expect(buildMetadataSection("/tmp/accounts.json", snapshots)).toEqual({
			storagePath: "/tmp/accounts.json",
			latestValidPath: "a",
			snapshotCount: 2,
			validSnapshotCount: 1,
			snapshots,
		});
	});
});
