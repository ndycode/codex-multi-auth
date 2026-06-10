import { describe, expect, it, vi } from "vitest";
import { describeAccountsWalSnapshot } from "../lib/storage/snapshot-inspectors.js";
import type { SnapshotStats } from "../lib/storage/backup-metadata.js";
import { isRecord } from "../lib/utils.js";

type WalDeps = Parameters<typeof describeAccountsWalSnapshot>[1];

const STATS: SnapshotStats = { exists: true, bytes: 64, mtimeMs: 1_111 };

function fakeSha256(content: string): string {
	return `sha:${content.length}:${content.slice(0, 8)}`;
}

function makeInnerStorage(): string {
	return JSON.stringify({
		version: 3,
		accounts: [
			{
				email: "wal@example.com",
				accountId: "acc_wal",
				refreshToken: "refresh-wal",
				addedAt: 1,
				lastUsed: 1,
			},
		],
		activeIndex: 0,
	});
}

function makeJournalEntry(content: string, checksum = fakeSha256(content)): string {
	return JSON.stringify({ version: 1, createdAt: 5, content, checksum });
}

function createDeps(overrides: Partial<WalDeps> = {}): WalDeps {
	return {
		statSnapshot: vi.fn(async () => STATS),
		readFile: vi.fn(async () =>
			makeJournalEntry(makeInnerStorage()),
		) as unknown as WalDeps["readFile"],
		isRecord,
		computeSha256: fakeSha256,
		parseAndNormalizeStorage: vi.fn((data: unknown) => ({
			normalized: { accounts: (data as { accounts: unknown[] }).accounts },
			storedVersion: (data as { version: unknown }).version,
			schemaErrors: [] as string[],
		})),
		...overrides,
	};
}

describe("describeAccountsWalSnapshot", () => {
	it("returns a non-existing snapshot without touching the file", async () => {
		const deps = createDeps({
			statSnapshot: vi.fn(async () => ({ exists: false })),
		});
		await expect(
			describeAccountsWalSnapshot("wal.json", deps),
		).resolves.toEqual({
			kind: "accounts-wal",
			path: "wal.json",
			exists: false,
			valid: false,
		});
		expect(deps.readFile).not.toHaveBeenCalled();
	});

	it("marks malformed journal JSON invalid but keeps the stat metadata", async () => {
		const deps = createDeps({
			readFile: vi.fn(async () => "{not json") as unknown as WalDeps["readFile"],
		});
		await expect(
			describeAccountsWalSnapshot("wal.json", deps),
		).resolves.toEqual({
			kind: "accounts-wal",
			path: "wal.json",
			exists: true,
			valid: false,
			bytes: 64,
			mtimeMs: 1_111,
		});
		expect(deps.parseAndNormalizeStorage).not.toHaveBeenCalled();
	});

	it("rejects journal entries that fail the WAL schema (missing checksum)", async () => {
		const deps = createDeps({
			readFile: vi.fn(async () =>
				JSON.stringify({ version: 1, content: makeInnerStorage() }),
			) as unknown as WalDeps["readFile"],
		});
		const result = await describeAccountsWalSnapshot("wal.json", deps);
		expect(result.valid).toBe(false);
		expect(deps.parseAndNormalizeStorage).not.toHaveBeenCalled();
	});

	it("rejects entries whose checksum does not match the content hash", async () => {
		const deps = createDeps({
			readFile: vi.fn(async () =>
				makeJournalEntry(makeInnerStorage(), "sha:forged"),
			) as unknown as WalDeps["readFile"],
		});
		const result = await describeAccountsWalSnapshot("wal.json", deps);
		expect(result).toMatchObject({
			exists: true,
			valid: false,
			bytes: 64,
			mtimeMs: 1_111,
		});
		expect(deps.parseAndNormalizeStorage).not.toHaveBeenCalled();
	});

	it("describes a checksum-verified, schema-valid WAL snapshot", async () => {
		const deps = createDeps();
		await expect(
			describeAccountsWalSnapshot("wal.json", deps),
		).resolves.toEqual({
			kind: "accounts-wal",
			path: "wal.json",
			exists: true,
			valid: true,
			bytes: 64,
			mtimeMs: 1_111,
			version: 3,
			accountCount: 1,
			schemaErrors: undefined,
		});
		expect(deps.parseAndNormalizeStorage).toHaveBeenCalledWith(
			expect.objectContaining({ version: 3, activeIndex: 0 }),
		);
	});

	it("falls back to raw JSON for schema-unknown content and surfaces schema errors", async () => {
		// version 99 fails AnyAccountStorageSchema, so the inspector must hand the
		// raw JSON.parse result to parseAndNormalizeStorage (legacy-shape path).
		const legacyContent = JSON.stringify({ version: 99, accounts: [] });
		const parseAndNormalizeStorage = vi.fn(() => ({
			normalized: null,
			storedVersion: "ninety-nine",
			schemaErrors: ["unsupported version"],
		}));
		const deps = createDeps({
			readFile: vi.fn(async () =>
				makeJournalEntry(legacyContent),
			) as unknown as WalDeps["readFile"],
			parseAndNormalizeStorage,
		});
		await expect(
			describeAccountsWalSnapshot("wal.json", deps),
		).resolves.toEqual({
			kind: "accounts-wal",
			path: "wal.json",
			exists: true,
			valid: false,
			bytes: 64,
			mtimeMs: 1_111,
			// non-numeric storedVersion must not leak into the metadata
			version: undefined,
			accountCount: undefined,
			schemaErrors: ["unsupported version"],
		});
		expect(parseAndNormalizeStorage).toHaveBeenCalledWith({
			version: 99,
			accounts: [],
		});
	});

	it("marks entries invalid when the checksummed content is not JSON at all", async () => {
		const content = "definitely-not-json";
		const deps = createDeps({
			readFile: vi.fn(async () =>
				makeJournalEntry(content),
			) as unknown as WalDeps["readFile"],
		});
		await expect(
			describeAccountsWalSnapshot("wal.json", deps),
		).resolves.toEqual({
			kind: "accounts-wal",
			path: "wal.json",
			exists: true,
			valid: false,
			bytes: 64,
			mtimeMs: 1_111,
		});
		expect(deps.parseAndNormalizeStorage).not.toHaveBeenCalled();
	});

	it("treats read failures (EACCES) as an existing-but-invalid snapshot", async () => {
		const deps = createDeps({
			readFile: vi.fn(async () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			}) as unknown as WalDeps["readFile"],
		});
		await expect(
			describeAccountsWalSnapshot("wal.json", deps),
		).resolves.toEqual({
			kind: "accounts-wal",
			path: "wal.json",
			exists: true,
			valid: false,
			bytes: 64,
			mtimeMs: 1_111,
		});
	});
});
