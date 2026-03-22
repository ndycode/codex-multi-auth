import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACCOUNTS_BACKUP_SUFFIX,
	ACCOUNTS_WAL_SUFFIX,
	getAccountsBackupPath,
	getAccountsBackupRecoveryCandidates,
	getAccountsWalPath,
	getFlaggedAccountsPath,
	getIntentionalResetMarkerPath,
	RESET_MARKER_SUFFIX,
} from "../lib/storage/file-paths.js";

describe("storage file paths", () => {
	it("builds the primary backup, wal, and reset marker paths", () => {
		const storagePath = "/tmp/openai-codex-accounts.json";

		expect(getAccountsBackupPath(storagePath)).toBe(
			`${storagePath}${ACCOUNTS_BACKUP_SUFFIX}`,
		);
		expect(getAccountsWalPath(storagePath)).toBe(
			`${storagePath}${ACCOUNTS_WAL_SUFFIX}`,
		);
		expect(getIntentionalResetMarkerPath(storagePath)).toBe(
			`${storagePath}${RESET_MARKER_SUFFIX}`,
		);
	});

	it("returns backup recovery candidates for the base backup and history slots", () => {
		const storagePath = "/tmp/openai-codex-accounts.json";

		expect(getAccountsBackupRecoveryCandidates(storagePath)).toEqual([
			`${storagePath}.bak`,
			`${storagePath}.bak.1`,
			`${storagePath}.bak.2`,
		]);
	});

	it("builds flagged storage paths next to the active storage file", () => {
		const storagePath = "/tmp/config/openai-codex-accounts.json";
		const fileName = "openai-codex-flagged-accounts.json";

		expect(getFlaggedAccountsPath(storagePath, fileName)).toBe(
			join(dirname(storagePath), fileName),
		);
	});

	it("uses dirname/join semantics consistently for windows-like storage paths", () => {
		const storagePath = String.raw`C:\Users\user\.codex\openai-codex-accounts.json`;
		const fileName = "openai-codex-blocked-accounts.json";

		expect(getFlaggedAccountsPath(storagePath, fileName)).toBe(
			join(dirname(storagePath), fileName),
		);
	});
});
