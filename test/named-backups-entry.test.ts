import { describe, expect, it, vi } from "vitest";
import { getNamedBackupsEntry } from "../lib/storage/named-backups-entry.js";

describe("named backups entry", () => {
	it("passes storage path and dependencies through to named backup collection", async () => {
		const collectNamedBackups = vi.fn(async () => []);
		const loadAccountsFromPath = vi.fn(async () => ({ normalized: null }));
		const logDebug = vi.fn();

		const result = await getNamedBackupsEntry({
			getStoragePath: () => "/tmp/accounts.json",
			collectNamedBackups,
			loadAccountsFromPath,
			logDebug,
		});

		expect(collectNamedBackups).toHaveBeenCalledWith("/tmp/accounts.json", {
			loadAccountsFromPath,
			logDebug,
		});
		expect(result).toEqual([]);
	});
});
