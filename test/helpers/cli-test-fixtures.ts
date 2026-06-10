import { vi } from "vitest";
import type { MockInstance } from "vitest";
import type { AccountStorageV3 } from "../../lib/storage.js";

/**
 * Shared mock factories for the codex-manager CLI suites (audit roadmap
 * §4.4.2). The manager suites used to duplicate 40+ module-level `vi.fn()`
 * declarations plus near-identical `vi.mock()` module shapes for storage,
 * refresh-queue, quota probe/cache, runtime observability, app bind, the
 * Codex CLI state/writer and the select/confirm UI prompts. Each
 * `create*Mocks()` factory below returns the per-suite mock instances and the
 * matching `*ModuleMock()` builds the module shape for `vi.mock()`.
 *
 * Hoisting contract: `vi.mock()` calls are hoisted above imports, so the
 * factory passed to `vi.mock()` must not capture static import bindings of
 * this module at hoist time. The safe pattern (used by every migrated suite)
 * keeps the mock instances in a module-level const and resolves this helper
 * lazily inside the factory:
 *
 *	const storageMocks = createStorageMocks();
 *	vi.mock("../lib/storage.js", async () =>
 *		(await import("./helpers/cli-test-fixtures.js")).storageModuleMock(
 *			storageMocks,
 *		),
 *	);
 *
 * The factory body only runs when the mocked module is first imported (after
 * the test module finished evaluating), so both the dynamic import and the
 * `storageMocks` const are initialized by then.
 */

/** Pick a subset of a mock group so a suite only overrides what it used to. */
export function pickMocks<T extends object, K extends keyof T>(
	mocks: T,
	keys: readonly K[],
): Pick<T, K> {
	const picked = {} as Pick<T, K>;
	for (const key of keys) {
		picked[key] = mocks[key];
	}
	return picked;
}

// ---------------------------------------------------------------------------
// lib/storage.js
// ---------------------------------------------------------------------------

export function createStorageMocks() {
	return {
		loadAccounts: vi.fn(),
		loadFlaggedAccounts: vi.fn(),
		saveAccounts: vi.fn(),
		saveFlaggedAccounts: vi.fn(),
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/mock/openai-codex-accounts.json"),
		inspectStorageHealth: vi.fn(),
		getNamedBackups: vi.fn(),
		restoreAccountsFromBackup: vi.fn(),
		exportNamedBackup: vi.fn(),
		normalizeAccountStorage: vi.fn((value: unknown) => value),
		withAccountStorageTransaction: vi.fn(),
		withAccountAndFlaggedStorageTransaction: vi.fn(),
		withFlaggedStorageTransaction: vi.fn(),
	};
}

export type StorageMocks = ReturnType<typeof createStorageMocks>;

/**
 * Module shape for `vi.mock("../lib/storage.js", ...)`: the actual module
 * spread plus the given overrides (typically a `createStorageMocks()` result,
 * optionally narrowed via `pickMocks` or extended with wrapped functions).
 */
export async function storageModuleMock(
	overrides: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	// Resolved relative to test/helpers/ (this file), so it is "../../lib"
	// here while callers register vi.mock with "../lib" relative to test/.
	// Vitest canonicalises both to the same module; if this helper moves,
	// update these specifiers together with the doc comments above.
	const actual = await vi.importActual<Record<string, unknown>>(
		"../../lib/storage.js",
	);
	return { ...actual, ...overrides };
}

// ---------------------------------------------------------------------------
// lib/refresh-queue.js
// ---------------------------------------------------------------------------

export function createRefreshQueueMocks() {
	return {
		queuedRefresh: vi.fn(),
	};
}

export type RefreshQueueMocks = ReturnType<typeof createRefreshQueueMocks>;

export function refreshQueueModuleMock(
	mocks: RefreshQueueMocks,
): Record<string, unknown> {
	return { queuedRefresh: mocks.queuedRefresh };
}

// ---------------------------------------------------------------------------
// lib/quota-probe.js
// ---------------------------------------------------------------------------

export function createQuotaProbeMocks() {
	return {
		fetchCodexQuotaSnapshot: vi.fn(),
		formatQuotaSnapshotLine: vi.fn(() => "probe-ok"),
	};
}

export type QuotaProbeMocks = ReturnType<typeof createQuotaProbeMocks>;

/** Actual quota-probe module spread plus the given overrides. */
export async function quotaProbeModuleMock(
	overrides: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	// Same test/helpers/-relative resolution note as storageModuleMock above.
	const actual = await vi.importActual<Record<string, unknown>>(
		"../../lib/quota-probe.js",
	);
	return { ...actual, ...overrides };
}

// ---------------------------------------------------------------------------
// lib/quota-cache.js
// ---------------------------------------------------------------------------

export function createQuotaCacheMocks() {
	return {
		loadQuotaCache: vi.fn(),
		saveQuotaCache: vi.fn(),
	};
}

export type QuotaCacheMocks = ReturnType<typeof createQuotaCacheMocks>;

export function quotaCacheModuleMock(
	mocks: QuotaCacheMocks,
): Record<string, unknown> {
	return {
		loadQuotaCache: mocks.loadQuotaCache,
		saveQuotaCache: mocks.saveQuotaCache,
	};
}

// ---------------------------------------------------------------------------
// lib/runtime/runtime-observability.js
// ---------------------------------------------------------------------------

export function createRuntimeObservabilityMocks() {
	return {
		loadPersistedRuntimeObservabilitySnapshot: vi.fn(),
	};
}

export type RuntimeObservabilityMocks = ReturnType<
	typeof createRuntimeObservabilityMocks
>;

export function runtimeObservabilityModuleMock(
	mocks: RuntimeObservabilityMocks,
): Record<string, unknown> {
	return {
		loadPersistedRuntimeObservabilitySnapshot:
			mocks.loadPersistedRuntimeObservabilitySnapshot,
	};
}

// ---------------------------------------------------------------------------
// lib/runtime/app-bind.js
// ---------------------------------------------------------------------------

export function createAppBindMocks() {
	return {
		bindCodexAppRuntimeRotation: vi.fn(),
		getAppBindStatus: vi.fn(),
		unbindCodexAppRuntimeRotation: vi.fn(),
	};
}

export type AppBindMocks = ReturnType<typeof createAppBindMocks>;

export function appBindModuleMock(
	mocks: AppBindMocks,
): Record<string, unknown> {
	return {
		bindCodexAppRuntimeRotation: mocks.bindCodexAppRuntimeRotation,
		getAppBindStatus: mocks.getAppBindStatus,
		unbindCodexAppRuntimeRotation: mocks.unbindCodexAppRuntimeRotation,
	};
}

// ---------------------------------------------------------------------------
// lib/codex-cli/state.js
// ---------------------------------------------------------------------------

export function createCodexCliStateMocks(
	paths: { authPath?: string; configPath?: string } = {},
) {
	const authPath = paths.authPath ?? "/mock/.codex/auth.json";
	const configPath = paths.configPath ?? "/mock/.codex/config.toml";
	return {
		getCodexCliAuthPath: vi.fn(() => authPath),
		getCodexCliConfigPath: vi.fn(() => configPath),
		loadCodexCliState: vi.fn(),
	};
}

export type CodexCliStateMocks = ReturnType<typeof createCodexCliStateMocks>;

export function codexCliStateModuleMock(
	mocks: CodexCliStateMocks,
): Record<string, unknown> {
	return {
		getCodexCliAuthPath: mocks.getCodexCliAuthPath,
		getCodexCliConfigPath: mocks.getCodexCliConfigPath,
		loadCodexCliState: mocks.loadCodexCliState,
	};
}

// ---------------------------------------------------------------------------
// lib/codex-cli/writer.js
// ---------------------------------------------------------------------------

export function createCodexCliWriterMocks() {
	return {
		setCodexCliActiveSelection: vi.fn(),
	};
}

export type CodexCliWriterMocks = ReturnType<typeof createCodexCliWriterMocks>;

export function codexCliWriterModuleMock(
	mocks: CodexCliWriterMocks,
): Record<string, unknown> {
	return { setCodexCliActiveSelection: mocks.setCodexCliActiveSelection };
}

// ---------------------------------------------------------------------------
// lib/ui/select.js + lib/ui/confirm.js
// ---------------------------------------------------------------------------

export function createUiPromptMocks() {
	return {
		select: vi.fn(),
		confirm: vi.fn(async () => true),
	};
}

export type UiPromptMocks = ReturnType<typeof createUiPromptMocks>;

export function uiSelectModuleMock(
	mocks: UiPromptMocks,
): Record<string, unknown> {
	return { select: mocks.select };
}

export function uiConfirmModuleMock(
	mocks: UiPromptMocks,
): Record<string, unknown> {
	return { confirm: mocks.confirm };
}

// ---------------------------------------------------------------------------
// stdout/stderr capture
// ---------------------------------------------------------------------------

/**
 * Spy on a console method and silence it — the inline
 * `vi.spyOn(console, "log").mockImplementation(() => {})` pattern duplicated
 * across the manager suites. Restored by each suite's `vi.restoreAllMocks()`.
 */
export function silenceConsole(
	method: "log" | "error" | "warn",
): MockInstance<(...args: unknown[]) => void> {
	return vi.spyOn(console, method).mockImplementation(() => {});
}

// ---------------------------------------------------------------------------
// Minimal AccountStorageV3 fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal stored-account fixture. Only the fields a test cares about need to
 * be provided; pass the result through `accountStorageV3Fixture` (which uses
 * the repo's sanctioned `as never` minimal-fixture cast) where a full
 * `AccountStorageV3` is required.
 */
export function storageAccountFixture(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const now = Date.now();
	return {
		refreshToken: "refresh-test",
		addedAt: now,
		lastUsed: now,
		...overrides,
	};
}

/**
 * Minimal `AccountStorageV3` fixture builder. Accounts may be minimal
 * partials (see `storageAccountFixture`); the single `as never` cast below is
 * the repo's sanctioned escape hatch for minimal fixtures.
 */
export function accountStorageV3Fixture(
	accounts: ReadonlyArray<Record<string, unknown>> = [],
	overrides: Record<string, unknown> = {},
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts,
		...overrides,
	} as never;
}
