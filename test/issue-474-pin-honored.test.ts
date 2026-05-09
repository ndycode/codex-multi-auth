import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import {
	chooseAccount,
	readPinnedAccountIndexFromDisk,
	resetPinCacheForTesting,
} from "../lib/runtime-rotation-proxy.js";
import { resetTrackers } from "../lib/rotation.js";
import {
	runSwitchCommand,
	type SwitchCommandDeps,
} from "../lib/codex-manager/commands/switch.js";
import {
	runUnpinCommand,
	type UnpinCommandDeps,
} from "../lib/codex-manager/commands/unpin.js";
import {
	runBestCommand,
	type BestCommandDeps,
	type BestCliOptions,
} from "../lib/codex-manager/commands/best.js";
import { runStatusCommand } from "../lib/codex-manager/commands/status.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(
	now: number,
	count = 3,
	pinnedAccountIndex?: number,
): AccountStorageV3 {
	const storage: AccountStorageV3 = {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (count - index) * 60_000,
			enabled: true,
		})),
	};
	if (typeof pinnedAccountIndex === "number") {
		storage.pinnedAccountIndex = pinnedAccountIndex;
	}
	return storage;
}

const tmpDirs: string[] = [];

function makeTmpStoragePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "issue-474-"));
	tmpDirs.push(dir);
	return join(dir, "openai-codex-accounts.json");
}

function writeStorageFile(path: string, storage: AccountStorageV3): void {
	writeFileSync(path, JSON.stringify(storage), "utf8");
}

function bumpMtime(path: string): void {
	const st = statSync(path);
	const newTime = (st.mtimeMs + 1000) / 1000;
	utimesSync(path, newTime, newTime);
}

beforeEach(() => {
	resetTrackers();
	clearCircuitBreakers();
	resetPinCacheForTesting();
});

afterEach(() => {
	resetPinCacheForTesting();
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("issue #474 — manual pin honored by runtime proxy", () => {
	describe("switch command", () => {
		it("writes pinnedAccountIndex via persistAndSyncSelectedAccount with setPin: true", async () => {
			const persist = vi.fn(async () => ({ synced: true, wasDisabled: false }));
			const deps: SwitchCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => createStorage(Date.now())),
				persistAndSyncSelectedAccount: persist,
				logError: vi.fn(),
				logWarn: vi.fn(),
				logInfo: vi.fn(),
			};

			const exit = await runSwitchCommand(["2"], deps);

			expect(exit).toBe(0);
			expect(persist).toHaveBeenCalledWith(
				expect.objectContaining({
					targetIndex: 1,
					switchReason: "manual",
					setPin: true,
				}),
			);
			expect(deps.logInfo).toHaveBeenCalledWith(
				expect.stringContaining("(pinned for runtime routing)"),
			);
		});
	});

	describe("best command", () => {
		it("clears the pin via clearPin: true and reports it when a prior pin was set", async () => {
			const persist = vi.fn(async () => ({ synced: true, wasDisabled: false }));
			const logInfo = vi.fn();
			const storage = createStorage(Date.now(), 2, 0);
			storage.activeIndex = 0;
			const deps: BestCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts: vi.fn(async () => undefined),
				parseBestArgs: vi.fn(
					() =>
						({
							ok: true as const,
							options: {
								live: false,
								json: false,
								model: "gpt-5-codex",
								modelProvided: false,
							} satisfies BestCliOptions,
						}) as ReturnType<BestCommandDeps["parseBestArgs"]>,
				),
				printBestUsage: vi.fn(),
				resolveActiveIndex: vi.fn(() => 0),
				hasUsableAccessToken: vi.fn(() => true),
				queuedRefresh: vi.fn(async () => ({
					type: "success",
					access: "a",
					refresh: "r",
					expires: Date.now() + 60_000,
				})),
				normalizeFailureDetail: vi.fn((m) => m ?? "unknown"),
				extractAccountId: vi.fn(() => "acc"),
				extractAccountEmail: vi.fn(() => "e@example.com"),
				sanitizeEmail: vi.fn((e) => e),
				formatAccountLabel: vi.fn(
					(_a, i) => `${i + 1}. account-${i + 1}@example.com`,
				),
				fetchCodexQuotaSnapshot: vi.fn(async () => ({
					status: 200,
					model: "gpt-5-codex",
					primary: {},
					secondary: {},
				})),
				evaluateForecastAccounts: vi.fn(() => []),
				recommendForecastAccount: vi.fn(() => ({
					recommendedIndex: 1,
					reason: "lowest risk",
				})),
				persistAndSyncSelectedAccount: persist,
				setCodexCliActiveSelection: vi.fn(async () => true),
				logInfo,
				logWarn: vi.fn(),
				logError: vi.fn(),
				getNow: vi.fn(() => Date.now()),
			};

			const exit = await runBestCommand([], deps);

			expect(exit).toBe(0);
			expect(persist).toHaveBeenCalledWith(
				expect.objectContaining({
					targetIndex: 1,
					switchReason: "best",
					clearPin: true,
				}),
			);
			expect(
				logInfo.mock.calls.some(([msg]) =>
					String(msg).includes("manual pin cleared"),
				),
			).toBe(true);
		});

		it("does not announce pin cleared when no prior pin existed", async () => {
			const persist = vi.fn(async () => ({ synced: true, wasDisabled: false }));
			const logInfo = vi.fn();
			const storage = createStorage(Date.now(), 2);
			const deps: BestCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts: vi.fn(async () => undefined),
				parseBestArgs: vi.fn(
					() =>
						({
							ok: true as const,
							options: {
								live: false,
								json: false,
								model: "gpt-5-codex",
								modelProvided: false,
							} satisfies BestCliOptions,
						}) as ReturnType<BestCommandDeps["parseBestArgs"]>,
				),
				printBestUsage: vi.fn(),
				resolveActiveIndex: vi.fn(() => 0),
				hasUsableAccessToken: vi.fn(() => true),
				queuedRefresh: vi.fn(async () => ({
					type: "success",
					access: "a",
					refresh: "r",
					expires: Date.now() + 60_000,
				})),
				normalizeFailureDetail: vi.fn((m) => m ?? "unknown"),
				extractAccountId: vi.fn(() => "acc"),
				extractAccountEmail: vi.fn(() => "e@example.com"),
				sanitizeEmail: vi.fn((e) => e),
				formatAccountLabel: vi.fn(
					(_a, i) => `${i + 1}. account-${i + 1}@example.com`,
				),
				fetchCodexQuotaSnapshot: vi.fn(async () => ({
					status: 200,
					model: "gpt-5-codex",
					primary: {},
					secondary: {},
				})),
				evaluateForecastAccounts: vi.fn(() => []),
				recommendForecastAccount: vi.fn(() => ({
					recommendedIndex: 1,
					reason: "lowest risk",
				})),
				persistAndSyncSelectedAccount: persist,
				setCodexCliActiveSelection: vi.fn(async () => true),
				logInfo,
				logWarn: vi.fn(),
				logError: vi.fn(),
				getNow: vi.fn(() => Date.now()),
			};

			await runBestCommand([], deps);
			expect(
				logInfo.mock.calls.some(([msg]) =>
					String(msg).includes("manual pin cleared"),
				),
			).toBe(false);
		});
	});

	describe("unpin command", () => {
		it("clears pinnedAccountIndex from storage", async () => {
			const storage = createStorage(Date.now(), 2, 1);
			const saveAccounts = vi.fn(async () => undefined);
			const logInfo = vi.fn();
			const deps: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts,
				logInfo,
				logError: vi.fn(),
			};

			const exit = await runUnpinCommand(deps);

			expect(exit).toBe(0);
			expect(storage.pinnedAccountIndex).toBeUndefined();
			expect(saveAccounts).toHaveBeenCalledWith(storage);
			expect(logInfo).toHaveBeenCalledWith(
				expect.stringContaining("Cleared manual pin"),
			);
		});

		it("is idempotent when no pin is set", async () => {
			const storage = createStorage(Date.now(), 2);
			const saveAccounts = vi.fn(async () => undefined);
			const logInfo = vi.fn();
			const deps: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts,
				logInfo,
				logError: vi.fn(),
			};

			const exit = await runUnpinCommand(deps);

			expect(exit).toBe(0);
			expect(saveAccounts).not.toHaveBeenCalled();
			expect(logInfo).toHaveBeenCalledWith("No pin to clear.");
		});
	});

	describe("chooseAccount with pinnedIndex", () => {
		it("returns the pinned account regardless of hybrid scoring", () => {
			const now = Date.now();
			const storage = createStorage(now, 3);
			const accountManager = new AccountManager(undefined, storage);
			const hybridSpy = vi.spyOn(
				accountManager,
				"getCurrentOrNextForFamilyHybrid",
			);
			const markSwitchedSpy = vi.spyOn(accountManager, "markSwitched");

			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: null,
				pinnedIndex: 2,
			});

			expect(result?.index).toBe(2);
			expect(hybridSpy).not.toHaveBeenCalled();
			expect(markSwitchedSpy).not.toHaveBeenCalled();
		});

		it("returns null when the pinned account is rate-limited (and does not fall through)", () => {
			const now = Date.now();
			const storage = createStorage(now, 3);
			const accountManager = new AccountManager(undefined, storage);
			const pinned = accountManager.getAccountByIndex(1);
			expect(pinned).not.toBeNull();
			if (!pinned) throw new Error("setup failed");
			accountManager.markRateLimitedWithReason(
				pinned,
				60_000,
				"codex",
				"quota",
			);

			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: null,
				pinnedIndex: 1,
			});

			expect(result).toBeNull();
		});

		it("returns null when the pinned account is cooling down", () => {
			const now = Date.now();
			const storage = createStorage(now, 3);
			const accountManager = new AccountManager(undefined, storage);
			const pinned = accountManager.getAccountByIndex(0);
			if (!pinned) throw new Error("setup failed");
			accountManager.markAccountCoolingDown(pinned, 60_000, "auth-failure");

			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: null,
				pinnedIndex: 0,
			});

			expect(result).toBeNull();
		});

		it("returns null when the pinned account is disabled", () => {
			const now = Date.now();
			const storage = createStorage(now, 3);
			const accountManager = new AccountManager(undefined, storage);
			accountManager.setAccountEnabled(2, false);

			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: null,
				pinnedIndex: 2,
			});

			expect(result).toBeNull();
		});

		it("returns null when policy blocks the pinned account", () => {
			const now = Date.now();
			const storage = createStorage(now, 3);
			const accountManager = new AccountManager(undefined, storage);

			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: {
					allowed: true,
					statusCode: 200,
					reasons: [],
					errorCode: null,
					projectKey: null,
					blockedAccountIndexes: new Set([1]),
					scoreBoostByAccount: {},
					budgetEvaluations: [],
				},
				pinnedIndex: 1,
			});

			expect(result).toBeNull();
		});

		it("returns null when the pinned index is out of range", () => {
			const now = Date.now();
			const storage = createStorage(now, 2);
			const accountManager = new AccountManager(undefined, storage);

			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: null,
				pinnedIndex: 5,
			});

			expect(result).toBeNull();
		});

		it("does NOT call markSwitched when returning the pinned account", () => {
			const now = Date.now();
			const storage = createStorage(now, 3);
			const accountManager = new AccountManager(undefined, storage);
			const markSwitched = vi.spyOn(accountManager, "markSwitched");
			const result = chooseAccount({
				accountManager,
				sessionAffinityStore: null,
				sessionKey: null,
				family: "codex",
				model: null,
				attemptedIndexes: new Set(),
				now,
				policy: null,
				pinnedIndex: 0,
			});
			expect(result?.index).toBe(0);
			expect(markSwitched).not.toHaveBeenCalled();
		});
	});

	describe("readPinnedAccountIndexFromDisk", () => {
		it("returns the pinnedAccountIndex written to disk", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(path, createStorage(Date.now(), 2, 1));
			expect(readPinnedAccountIndexFromDisk(path)).toBe(1);
		});

		it("returns null when the file does not exist", () => {
			const path = makeTmpStoragePath();
			expect(readPinnedAccountIndexFromDisk(path)).toBeNull();
		});

		it("returns null when no pin is set", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(path, createStorage(Date.now(), 2));
			expect(readPinnedAccountIndexFromDisk(path)).toBeNull();
		});

		it("re-reads on mtime change (mtime cache invalidation)", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(path, createStorage(Date.now(), 3, 0));
			expect(readPinnedAccountIndexFromDisk(path)).toBe(0);

			writeStorageFile(path, createStorage(Date.now(), 3, 2));
			bumpMtime(path);
			expect(readPinnedAccountIndexFromDisk(path)).toBe(2);
		});

		it("returns the cached value while mtime is unchanged", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(path, createStorage(Date.now(), 3, 1));
			expect(readPinnedAccountIndexFromDisk(path)).toBe(1);
			// Overwrite same file content but do not bump mtime explicitly. The
			// cache is keyed by mtime so the stale value should be returned until
			// mtime changes.
			expect(readPinnedAccountIndexFromDisk(path)).toBe(1);
		});

		it("returns null on malformed JSON without throwing", () => {
			const path = makeTmpStoragePath();
			writeFileSync(path, "{not json", "utf8");
			expect(readPinnedAccountIndexFromDisk(path)).toBeNull();
		});
	});

	describe("status command", () => {
		it("logs the pinned account when one is set", async () => {
			const storage = createStorage(Date.now(), 3, 1);
			const logInfo = vi.fn();
			const exit = await runStatusCommand({
				setStoragePath: vi.fn(),
				getStoragePath: vi.fn(() => "/tmp/accounts.json"),
				loadAccounts: vi.fn(async () => storage),
				resolveActiveIndex: vi.fn(() => 0),
				formatRateLimitEntry: vi.fn(() => null),
				logInfo,
			});

			expect(exit).toBe(0);
			expect(
				logInfo.mock.calls.some(([msg]) =>
					String(msg).includes("Pinned: account 2"),
				),
			).toBe(true);
		});

		it("does not log a pin line when no pin is set", async () => {
			const storage = createStorage(Date.now(), 3);
			const logInfo = vi.fn();
			await runStatusCommand({
				setStoragePath: vi.fn(),
				getStoragePath: vi.fn(() => "/tmp/accounts.json"),
				loadAccounts: vi.fn(async () => storage),
				resolveActiveIndex: vi.fn(() => 0),
				formatRateLimitEntry: vi.fn(() => null),
				logInfo,
			});
			expect(
				logInfo.mock.calls.some(([msg]) =>
					String(msg).includes("Pinned: account"),
				),
			).toBe(false);
		});
	});
});

