import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";
import {
	autoSyncActiveAccountToCodex,
	resetActiveAccountSyncMetaForTests,
} from "../lib/codex-manager/active-account-sync.js";

/**
 * Real-filesystem tests for the pre/post-forward sync short-circuit in
 * lib/codex-manager/active-account-sync.ts. The wrapper calls
 * autoSyncActiveAccountToCodex() before AND after every forwarded Codex
 * command; the fingerprint cache must only skip the second pass when BOTH the
 * canonical accounts file AND the mirror files we produced are untouched.
 *
 * `queuedRefresh` is mocked (no network). `setCodexCliActiveSelection` is the
 * real writer wrapped in a spy so tests can observe mirror writes and inject
 * a "concurrent process" mutation exactly mid-pass.
 */
const harness = vi.hoisted(() => ({
	queuedRefreshMock: vi.fn(),
	setSelectionCalls: [] as Array<Record<string, unknown>>,
	// Deterministic injection points for a cross-process mutation landing
	// mid-pass: `preWriteHook` fires after this pass's loadAccounts() but before
	// the mirror write; `postWriteHook` fires between the mirror write and the
	// fingerprint record — the two halves of the race window.
	preWriteHook: null as null | (() => void | Promise<void>),
	postWriteHook: null as null | (() => void | Promise<void>),
}));

vi.mock("../lib/refresh-queue.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/refresh-queue.js")>(
		"../lib/refresh-queue.js",
	);
	return {
		...actual,
		queuedRefresh: (...args: unknown[]) => harness.queuedRefreshMock(...args),
	};
});

vi.mock("../lib/codex-cli/writer.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/codex-cli/writer.js")>(
		"../lib/codex-cli/writer.js",
	);
	return {
		...actual,
		setCodexCliActiveSelection: async (
			selection: Parameters<typeof actual.setCodexCliActiveSelection>[0],
		) => {
			harness.setSelectionCalls.push(selection as Record<string, unknown>);
			await harness.preWriteHook?.();
			const result = await actual.setCodexCliActiveSelection(selection);
			await harness.postWriteHook?.();
			return result;
		},
	};
});

const ENV_KEYS = [
	"CODEX_MULTI_AUTH_DIR",
	"CODEX_CLI_AUTH_PATH",
	"CODEX_CLI_ACCOUNTS_PATH",
	"CODEX_CLI_CONFIG_PATH",
	"CODEX_MULTI_AUTH_SYNC_CODEX_CLI",
	"CODEX_AUTH_SYNC_CODEX_CLI",
	"CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE",
] as const;

const RETRYABLE_REMOVE_CODES = new Set([
	"EBUSY",
	"EPERM",
	"ENOTEMPTY",
	"EACCES",
	"ETIMEDOUT",
]);

function removeWithRetry(targetPath: string): void {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			rmSync(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) throw error;
		}
	}
}

function makeAccount(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		email: "a@example.com",
		accountId: "acc_a",
		refreshToken: "refresh-a",
		accessToken: "access-a",
		expiresAt: now + 3_600_000,
		addedAt: now - 1_000,
		lastUsed: now - 1_000,
		enabled: true,
		...overrides,
	};
}

function makeStorage(
	accounts: Array<ReturnType<typeof makeAccount>>,
	activeIndex: number,
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex,
		activeIndexByFamily: { codex: activeIndex },
		accounts,
	} as AccountStorageV3;
}

describe("autoSyncActiveAccountToCodex fingerprint short-circuit", () => {
	let tempDir = "";
	let multiAuthDir = "";
	let codexHome = "";
	let accountsFile = "";
	let authPath = "";
	let cliAccountsPath = "";
	let configPath = "";
	let savedEnv: Record<string, string | undefined> = {};

	const writeStorageFile = (storage: AccountStorageV3) => {
		writeFileSync(accountsFile, JSON.stringify(storage, null, 2), "utf8");
	};
	const readAuthJson = (): Record<string, unknown> =>
		JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
	const authTokens = () =>
		(readAuthJson().tokens ?? {}) as Record<string, unknown>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "cma-active-sync-"));
		multiAuthDir = join(tempDir, "multi-auth");
		codexHome = join(tempDir, "codex-home");
		mkdirSync(multiAuthDir, { recursive: true });
		mkdirSync(codexHome, { recursive: true });
		accountsFile = join(multiAuthDir, "openai-codex-accounts.json");
		authPath = join(codexHome, "auth.json");
		cliAccountsPath = join(codexHome, "accounts.json");
		configPath = join(codexHome, "config.toml");

		savedEnv = Object.fromEntries(
			ENV_KEYS.map((key) => [key, process.env[key]]),
		);
		process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_ACCOUNTS_PATH = cliAccountsPath;
		process.env.CODEX_CLI_CONFIG_PATH = configPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		delete process.env.CODEX_AUTH_SYNC_CODEX_CLI;

		resetActiveAccountSyncMetaForTests();
		harness.queuedRefreshMock.mockReset();
		harness.setSelectionCalls.length = 0;
		harness.preWriteHook = null;
		harness.postWriteHook = null;
	});

	afterEach(() => {
		resetActiveAccountSyncMetaForTests();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		removeWithRetry(tempDir);
	});

	it("re-mirrors the canonical selection after a forwarded login rewrites auth.json", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		// Pre-forward call: syncs and records fingerprints for input + outputs.
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(authTokens().access_token).toBe("access-a");
		expect(harness.setSelectionCalls).toHaveLength(1);

		// The forwarded `codex login` rewrites the official CLI auth state with a
		// different account and flips the credential store back to the keychain —
		// without touching the multi-auth accounts file.
		writeFileSync(
			authPath,
			JSON.stringify({
				auth_mode: "chatgpt",
				email: "other@example.com",
				tokens: {
					access_token: "other-access",
					refresh_token: "other-refresh",
					account_id: "acc_other",
					id_token: "other-id",
				},
			}),
			"utf8",
		);
		writeFileSync(
			configPath,
			'cli_auth_credentials_store = "keychain"\n',
			"utf8",
		);

		// Post-forward call must not trust the unchanged accounts file: it has to
		// see the mirror drift and re-assert the canonical selection.
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(2);
		expect(authTokens().access_token).toBe("access-a");
		expect(authTokens().refresh_token).toBe("refresh-a");
		expect(authTokens().account_id).toBe("acc_a");
		expect(readAuthJson().email).toBe("a@example.com");
		expect(readFileSync(configPath, "utf8")).toContain(
			'cli_auth_credentials_store = "file"',
		);
	});

	it("re-creates auth.json when a forwarded logout deleted it between calls", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(existsSync(authPath)).toBe(true);

		// `codex logout` removes the official auth state entirely.
		rmSync(authPath, { force: true });

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(existsSync(authPath)).toBe(true);
		expect(authTokens().access_token).toBe("access-a");
	});

	it("skips the mirror write entirely when nothing changed between calls", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(1);
		const authBytes = readFileSync(authPath, "utf8");

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(1);
		expect(readFileSync(authPath, "utf8")).toBe(authBytes);
	});

	it("recorrects the mirror when the accounts file itself changed between calls", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));
		expect(await autoSyncActiveAccountToCodex()).toBe(true);

		// Another process switched the canonical selection (accounts file
		// rewritten) but its mirror write raced behind ours earlier — the mirror
		// may be stale and must be resynced from the new file content.
		writeStorageFile(
			makeStorage(
				[
					makeAccount(),
					makeAccount({
						email: "b@example.com",
						accountId: "acc_b",
						refreshToken: "refresh-b",
						accessToken: "access-b",
					}),
				],
				1,
			),
		);

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(authTokens().access_token).toBe("access-b");
		expect(authTokens().account_id).toBe("acc_b");
	});

	it("does not cache a fingerprint for file content the mirror never saw (mid-pass switch)", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		// Another process switches the canonical selection after our load but
		// before our fingerprint record: the mirror we then write is the stale
		// account, and the record must NOT bless the new file content as synced.
		// (Storage object is built once — regenerating inside the hook would
		// change bytes via fresh timestamps and keep the race alive forever.)
		const switched = makeStorage(
			[
				makeAccount(),
				makeAccount({
					email: "b@example.com",
					accountId: "acc_b",
					refreshToken: "refresh-b",
					accessToken: "access-b",
				}),
			],
			1,
		);
		harness.preWriteHook = () => {
			writeStorageFile(switched);
			harness.preWriteHook = null;
		};

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(1);
		expect(authTokens().access_token).toBe("access-a");

		// The post-forward call must re-read and correct — with the buggy cache
		// this returned early and left the mirror on acc_a forever.
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(2);
		expect(harness.setSelectionCalls[1]).toMatchObject({
			accountId: "acc_b",
			accessToken: "access-b",
		});
		expect(authTokens().access_token).toBe("access-b");
		expect(authTokens().account_id).toBe("acc_b");

		// Once converged the fast path engages again: a third call writes nothing.
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(2);
	});

	it("aborts the mirror write when the selection drifts during a refresh", async () => {
		const stale = makeAccount({ accessToken: "access-a-old", expiresAt: Date.now() - 60_000 });
		writeStorageFile(makeStorage([stale], 0));

		const switched = makeStorage(
			[
				makeAccount(),
				makeAccount({
					email: "b@example.com",
					accountId: "acc_b",
					refreshToken: "refresh-b",
					accessToken: "access-b",
				}),
			],
			1,
		);
		harness.queuedRefreshMock.mockImplementation(async () => {
			// A concurrent switch lands while the refresh is in flight: the
			// under-lock reload inside the storage transaction sees the new
			// selection, keeps the token update, but the stale mirror write must
			// be skipped.
			writeStorageFile(switched);
			return {
				type: "success",
				access: "access-a-next",
				refresh: "refresh-a-next",
				expires: Date.now() + 3_600_000,
			};
		});

		expect(await autoSyncActiveAccountToCodex()).toBe(false);
		expect(harness.setSelectionCalls).toHaveLength(0);
		expect(existsSync(authPath)).toBe(false);

		// The refreshed tokens still landed in storage under the new selection.
		const persisted = JSON.parse(
			readFileSync(accountsFile, "utf8"),
		) as AccountStorageV3;
		expect(persisted.activeIndexByFamily?.codex).toBe(1);
		expect(persisted.accounts[0]?.refreshToken).toBe("refresh-a-next");

		// The next call mirrors the selection that won the race.
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(authTokens().access_token).toBe("access-b");
		expect(authTokens().account_id).toBe("acc_b");
	});

	it("does not poison the cache when the switch lands after the mirror write", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		// Same race, second half of the window: the accounts file flips after
		// our mirror write but before the fingerprint record — the record still
		// must not describe the new bytes as synced.
		const switched = makeStorage(
			[
				makeAccount(),
				makeAccount({
					email: "b@example.com",
					accountId: "acc_b",
					refreshToken: "refresh-b",
					accessToken: "access-b",
				}),
			],
			1,
		);
		harness.postWriteHook = () => {
			writeStorageFile(switched);
			harness.postWriteHook = null;
		};

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(authTokens().access_token).toBe("access-a");

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(authTokens().access_token).toBe("access-b");
		expect(authTokens().account_id).toBe("acc_b");
	});

	it("treats a mirror file torn down mid-pass as unsynced", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		// auth.json exists from a previous session, then a concurrent `codex
		// logout` deletes it right after our mirror write — the cache must not
		// record "outputs absent" as the synced state for this file.
		writeFileSync(authPath, JSON.stringify({ tokens: {} }), "utf8");
		harness.postWriteHook = () => {
			rmSync(authPath, { force: true });
			harness.postWriteHook = null;
		};

		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(existsSync(authPath)).toBe(false);

		// Because nothing was cached, the post-forward call re-runs the mirror
		// write instead of trusting a "still absent" entry.
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(existsSync(authPath)).toBe(true);
		expect(authTokens().access_token).toBe("access-a");
	});

	it("retries a failed refresh on the next call instead of caching", async () => {
		const stale = makeAccount({
			accessToken: "access-a-old",
			expiresAt: Date.now() - 60_000,
		});
		writeStorageFile(makeStorage([stale], 0));

		harness.queuedRefreshMock.mockResolvedValueOnce({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "expired",
		});
		expect(await autoSyncActiveAccountToCodex()).toBe(false);
		expect(harness.setSelectionCalls).toHaveLength(0);

		harness.queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-a-next",
			refresh: "refresh-a-next",
			expires: Date.now() + 3_600_000,
		});
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.queuedRefreshMock).toHaveBeenCalledTimes(2);
		expect(authTokens().access_token).toBe("access-a-next");
	});

	it("supports concurrent in-process calls without corrupting the cache", async () => {
		writeStorageFile(makeStorage([makeAccount()], 0));

		const results = await Promise.all([
			autoSyncActiveAccountToCodex(),
			autoSyncActiveAccountToCodex(),
		]);
		expect(results).toEqual([true, true]);
		expect(authTokens().access_token).toBe("access-a");

		// The cache state must be coherent: the next call takes the fast path
		// and performs no further mirror write.
		const writesBefore = harness.setSelectionCalls.length;
		expect(await autoSyncActiveAccountToCodex()).toBe(true);
		expect(harness.setSelectionCalls).toHaveLength(writesBefore);
	});
});
