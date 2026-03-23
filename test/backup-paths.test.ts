import { describe, expect, it } from "vitest";
import {
	getAccountsBackupPath,
	getAccountsBackupPathAtIndex,
	getAccountsBackupRecoveryCandidates,
	getAccountsWalPath,
	getIntentionalResetMarkerPath,
} from "../lib/storage/backup-paths.js";

describe("backup path helpers", () => {
	it("builds backup paths, wal paths, and reset markers", () => {
		expect(getAccountsBackupPath("/tmp/accounts.json")).toBe(
			"/tmp/accounts.json.bak",
		);
		expect(getAccountsBackupPathAtIndex("/tmp/accounts.json", 2)).toBe(
			"/tmp/accounts.json.bak.2",
		);
		expect(getAccountsWalPath("/tmp/accounts.json")).toBe(
			"/tmp/accounts.json.wal",
		);
		expect(getIntentionalResetMarkerPath("/tmp/accounts.json")).toBe(
			"/tmp/accounts.json.reset-intent",
		);
	});

	it("builds backup recovery candidate list for configured depth", () => {
		expect(
			getAccountsBackupRecoveryCandidates("/tmp/accounts.json", 3),
		).toEqual([
			"/tmp/accounts.json.bak",
			"/tmp/accounts.json.bak.1",
			"/tmp/accounts.json.bak.2",
		]);
	});
});
