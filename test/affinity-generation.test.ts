import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpStorageAffinityGeneration } from "../lib/storage.js";

function tempStoragePath(): string {
	return join(mkdtempSync(join(tmpdir(), "cma-affinity-")), "accounts.json");
}

describe("bumpStorageAffinityGeneration", () => {
	it("increments the in-memory counter when nothing is on disk yet", () => {
		const storage = { affinityGeneration: 4 };

		expect(bumpStorageAffinityGeneration(storage, tempStoragePath())).toBe(5);
		expect(storage.affinityGeneration).toBe(5);
	});

	it("starts at 1 when the counter was never set", () => {
		const storage: { affinityGeneration?: number } = {};

		expect(bumpStorageAffinityGeneration(storage, tempStoragePath())).toBe(1);
	});

	it("takes the max of the in-memory and on-disk counters", () => {
		const path = tempStoragePath();
		// Another CLI process advanced the counter after this one loaded storage.
		// Incrementing the stale in-memory value would hand back 5 and silently
		// undo that process's invalidation, so a live proxy would keep its
		// stale session→index bindings.
		writeFileSync(path, JSON.stringify({ affinityGeneration: 9 }));
		const storage = { affinityGeneration: 4 };

		expect(bumpStorageAffinityGeneration(storage, path)).toBe(10);
	});

	it("still bumps when the on-disk counter is unreadable", () => {
		const path = tempStoragePath();
		writeFileSync(path, "not json at all");
		const storage = { affinityGeneration: 2 };

		expect(bumpStorageAffinityGeneration(storage, path)).toBe(3);
	});

	it("never moves the counter backwards for a lower on-disk value", () => {
		const path = tempStoragePath();
		writeFileSync(path, JSON.stringify({ affinityGeneration: 1 }));
		const storage = { affinityGeneration: 7 };

		expect(bumpStorageAffinityGeneration(storage, path)).toBe(8);
	});
});
