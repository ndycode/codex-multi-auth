import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../lib/dashboard-settings.js";
import type { PluginConfig } from "../lib/types.js";
import {
	getUiRuntimeOptions,
	resetUiRuntimeOptions,
	setUiRuntimeOptions,
} from "../lib/ui/runtime.js";
import type { MenuItem } from "../lib/ui/select.js";

type SettingsHubTestApi = {
	buildSyncCenterOverview: (
		preview: {
			status: "ready" | "noop" | "disabled" | "unavailable" | "error";
			statusDetail: string;
			sourcePath: string | null;
			targetPath: string;
			summary: {
				addedAccountCount: number;
				updatedAccountCount: number;
				destinationOnlyPreservedCount: number;
				targetAccountCountAfter: number;
				selectionChanged: boolean;
			};
			backup: {
				enabled: boolean;
				rollbackPaths: string[];
			};
			lastSync: {
				outcome: "changed" | "noop" | "disabled" | "unavailable" | "error";
				runAt: number;
				message?: string;
			} | null;
		},
		context?: {
			accountsPath: string;
			authPath: string;
			configPath: string;
			state: {
				accounts: unknown[];
			} | null;
			liveSync: {
				path: string | null;
				running: boolean;
				lastKnownMtimeMs: number | null;
				lastSyncAt: number | null;
				reloadCount: number;
				errorCount: number;
			};
			syncEnabled: boolean;
		},
	) => Array<{ label: string; hint?: string }>;
	clampBackendNumber: (settingKey: string, value: number) => number;
	formatMenuLayoutMode: (mode: "compact-details" | "expanded-rows") => string;
	cloneDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => DashboardDisplaySettings;
	withQueuedRetry: <T>(pathKey: string, task: () => Promise<T>) => Promise<T>;
	loadExperimentalSyncTarget: () => Promise<
		| { kind: "blocked-ambiguous"; detection: unknown }
		| { kind: "blocked-none"; detection: unknown }
		| { kind: "error"; message: string }
		| { kind: "target"; detection: unknown; destination: unknown }
	>;
	persistDashboardSettingsSelection: (
		selected: DashboardDisplaySettings,
		keys: ReadonlyArray<string>,
		scope: string,
	) => Promise<DashboardDisplaySettings>;
	persistBackendConfigSelection: (
		selected: PluginConfig,
		scope: string,
	) => Promise<PluginConfig>;
	buildAccountListPreview: (
		settings: DashboardDisplaySettings,
		ui: UiRuntimeOptions,
		focus?: DashboardStatuslineField | string | null,
	) => { label: string; hint: string };
	buildSummaryPreviewText: (
		settings: DashboardDisplaySettings,
		ui: UiRuntimeOptions,
		focus?: DashboardStatuslineField | string | null,
	) => string;
	normalizeStatuslineFields: (value: unknown) => DashboardStatuslineField[];
	reorderField: (
		fields: DashboardStatuslineField[],
		key: DashboardStatuslineField,
		direction: -1 | 1,
	) => DashboardStatuslineField[];
	promptDashboardDisplaySettings: (
		initial: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings | null>;
	promptStatuslineSettings: (
		initial: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings | null>;
	promptBehaviorSettings: (
		initial: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings | null>;
	promptThemeSettings: (
		initial: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings | null>;
	promptBackendSettings: (
		initial: PluginConfig,
	) => Promise<PluginConfig | null>;
	promptExperimentalSettings: (
		initial: PluginConfig,
	) => Promise<PluginConfig | null>;
};

type UiRuntimeOptions = ReturnType<typeof getUiRuntimeOptions>;

let selectQueue: unknown[] = [];
let selectHandler: (
	items: MenuItem<unknown>[],
	options: unknown,
) => Promise<unknown> = async () => {
	throw new Error("Select handler not configured");
};

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(
	process.stdin,
	"isTTY",
);
const originalStdoutDescriptor = Object.getOwnPropertyDescriptor(
	process.stdout,
	"isTTY",
);

function setStreamIsTTY(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	value: boolean | undefined,
): void {
	Object.defineProperty(stream, "isTTY", {
		configurable: true,
		value,
	});
}

function restoreStreamIsTTY(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(stream, "isTTY", descriptor);
		return;
	}

	delete (stream as any).isTTY;
}

function queueSelectResults(...results: unknown[]): void {
	selectQueue.push(...results);
}

vi.mock("../lib/ui/select.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/ui/select.js")>(
		"../lib/ui/select.js",
	);
	return {
		...actual,
		select: (items: MenuItem<unknown>[], options: unknown) =>
			selectHandler(items, options),
	};
});

let tempRoot = "";
const originalCodeHome = process.env.CODEX_HOME;
const originalCodeMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
const originalConfigPath = process.env.CODEX_MULTI_AUTH_CONFIG_PATH;

async function loadSettingsHubTestApi(): Promise<SettingsHubTestApi> {
	const module = await import("../lib/codex-manager/settings-hub.js");
	return module.__testOnly as SettingsHubTestApi;
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "codex-settings-hub-test-"));
	process.env.CODEX_HOME = tempRoot;
	process.env.CODEX_MULTI_AUTH_DIR = tempRoot;
	process.env.CODEX_MULTI_AUTH_CONFIG_PATH = join(
		tempRoot,
		"plugin-config.json",
	);
	vi.resetModules();
	selectQueue = [];
	selectHandler = async () => {
		const next = selectQueue.shift();
		if (next === undefined) {
			throw new Error("No select result queued");
		}
		return next;
	};
	setStreamIsTTY(process.stdin, true);
	setStreamIsTTY(process.stdout, true);
	resetUiRuntimeOptions();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
	if (tempRoot.length > 0) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	if (originalCodeHome === undefined) {
		delete process.env.CODEX_HOME;
	} else {
		process.env.CODEX_HOME = originalCodeHome;
	}
	if (originalCodeMultiAuthDir === undefined) {
		delete process.env.CODEX_MULTI_AUTH_DIR;
	} else {
		process.env.CODEX_MULTI_AUTH_DIR = originalCodeMultiAuthDir;
	}
	if (originalConfigPath === undefined) {
		delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;
	} else {
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = originalConfigPath;
	}
	restoreStreamIsTTY(process.stdin, originalStdinDescriptor);
	restoreStreamIsTTY(process.stdout, originalStdoutDescriptor);
});

describe("settings-hub utility coverage", () => {
	it("clamps backend numeric settings by option bounds", async () => {
		const api = await loadSettingsHubTestApi();
		expect(api.clampBackendNumber("liveAccountSyncDebounceMs", 1)).toBe(50);
		expect(api.clampBackendNumber("sessionAffinityMaxEntries", 9_999)).toBe(
			4_096,
		);
		expect(
			api.clampBackendNumber("preemptiveQuotaRemainingPercent5h", -5),
		).toBe(0);
		expect(api.clampBackendNumber("tokenRefreshSkewMs", 999_999)).toBe(600_000);
		expect(api.clampBackendNumber("parallelProbingMaxConcurrency", 0)).toBe(1);
		expect(api.clampBackendNumber("fetchTimeoutMs", 250)).toBe(1_000);
		expect(api.clampBackendNumber("fetchTimeoutMs", 999_999)).toBe(600_000);
		expect(() => api.clampBackendNumber("unknown-setting", 5)).toThrow(
			"Unknown backend numeric setting key",
		);
	});

	it("builds sync-center overview text with preservation and rollback details", async () => {
		const api = await loadSettingsHubTestApi();
		const overview = api.buildSyncCenterOverview(
			{
				status: "ready",
				statusDetail: "Preview ready",
				sourcePath: "/tmp/source/accounts.json",
				targetPath: "/tmp/target/openai-codex-accounts.json",
				summary: {
					addedAccountCount: 1,
					updatedAccountCount: 2,
					destinationOnlyPreservedCount: 3,
					targetAccountCountAfter: 6,
					selectionChanged: true,
				},
				backup: {
					enabled: true,
					rollbackPaths: [
						"/tmp/target/openai-codex-accounts.json.bak",
						"/tmp/target/openai-codex-accounts.json.wal",
					],
				},
				lastSync: {
					outcome: "changed",
					runAt: Date.parse("2026-03-01T00:00:00.000Z"),
				},
			},
			{
				accountsPath: "/tmp/source/accounts.json",
				authPath: "/tmp/source/auth.json",
				configPath: "/tmp/source/config.toml",
				state: { accounts: [{}] },
				liveSync: {
					path: "/tmp/target/openai-codex-accounts.json",
					running: true,
					lastKnownMtimeMs: Date.parse("2026-03-01T00:01:00.000Z"),
					lastSyncAt: Date.parse("2026-03-01T00:02:00.000Z"),
					reloadCount: 2,
					errorCount: 0,
				},
				syncEnabled: true,
			},
		);

		expect(overview[0]?.label).toContain("Status: ready");
		expect(overview[1]?.hint).toContain("/tmp/source/accounts.json");
		expect(overview[2]?.hint).toContain("/tmp/source/auth.json");
		expect(overview[2]?.hint).toContain("/tmp/source/config.toml");
		expect(overview[3]?.label).toContain("Live watcher: running");
		expect(overview[4]?.label).toContain("Preview mode: read-only until apply");
		expect(overview[5]?.label).toContain(
			"add 1 | update 2 | preserve 3 | after 6",
		);
		expect(overview[6]?.hint).toContain("activeAccountId first");
		expect(overview[7]?.hint).toContain("never deletes");
		expect(overview[8]?.hint).toContain(".bak");
		expect(overview[8]?.hint).toContain(".wal");
	});

	it("matches windows-style source paths when labeling the active sync source", async () => {
		const api = await loadSettingsHubTestApi();
		const overview = api.buildSyncCenterOverview(
			{
				status: "ready",
				statusDetail: "Preview ready",
				sourcePath: "C:\\Users\\Neil\\.codex\\Accounts.json",
				targetPath: "C:\\Users\\Neil\\.codex\\openai-codex-accounts.json",
				summary: {
					addedAccountCount: 0,
					updatedAccountCount: 0,
					destinationOnlyPreservedCount: 1,
					targetAccountCountAfter: 1,
					selectionChanged: false,
				},
				backup: {
					enabled: true,
					rollbackPaths: [
						"C:\\Users\\Neil\\.codex\\openai-codex-accounts.json.bak",
					],
				},
				lastSync: null,
			},
			{
				accountsPath: "c:/users/neil/.codex/accounts.json",
				authPath: "c:/users/neil/.codex/auth.json",
				configPath: "c:/users/neil/.codex/config.toml",
				state: { accounts: [{}] },
				liveSync: {
					path: null,
					running: false,
					lastKnownMtimeMs: null,
					lastSyncAt: null,
					reloadCount: 0,
					errorCount: 0,
				},
				syncEnabled: true,
			},
		);

		expect(overview[2]?.label).toContain("accounts.json active");
	});

	it("formats layout mode labels", async () => {
		const api = await loadSettingsHubTestApi();
		expect(api.formatMenuLayoutMode("expanded-rows")).toBe("Expanded Rows");
		expect(api.formatMenuLayoutMode("compact-details")).toBe(
			"Compact + Details Pane",
		);
	});

	it("clones dashboard settings and protects array references", async () => {
		const api = await loadSettingsHubTestApi();
		const dashboard = await import("../lib/dashboard-settings.js");
		const original = await dashboard.loadDashboardDisplaySettings();
		const clone = api.cloneDashboardSettings(original);
		const originalLength = original.menuStatuslineFields?.length ?? 0;
		const cloneFields = clone.menuStatuslineFields ?? [];
		if (!clone.menuStatuslineFields) {
			clone.menuStatuslineFields = cloneFields;
		}
		cloneFields.push("status");
		expect(clone.menuStatuslineFields?.length).toBe(originalLength + 1);
		expect(clone.menuStatuslineFields).not.toBe(original.menuStatuslineFields);
	});

	it("retries queued writes for retryable filesystem errors", async () => {
		const api = await loadSettingsHubTestApi();
		let attempts = 0;
		const result = await api.withQueuedRetry("settings-path", async () => {
			attempts += 1;
			if (attempts < 3) {
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = attempts === 1 ? "EBUSY" : "EPERM";
				throw error;
			}
			return "ok";
		});
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("retries queued writes for EAGAIN filesystem errors", async () => {
		const api = await loadSettingsHubTestApi();
		let attempts = 0;
		const result = await api.withQueuedRetry(
			"settings-path-eagain",
			async () => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EAGAIN";
					throw error;
				}
				return "ok";
			},
		);
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it.each([
		"ENOTEMPTY",
		"EACCES",
	] as const)("retries queued writes for %s filesystem errors", async (code) => {
		const api = await loadSettingsHubTestApi();
		let attempts = 0;
		const result = await api.withQueuedRetry(
			`settings-path-${code.toLowerCase()}`,
			async () => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				return "ok";
			},
		);
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("propagates non-retryable filesystem errors immediately", async () => {
		const api = await loadSettingsHubTestApi();
		let attempts = 0;
		await expect(
			api.withQueuedRetry("settings-path-enoent", async () => {
				attempts += 1;
				const error = new Error("not found") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}),
		).rejects.toThrow("not found");
		expect(attempts).toBe(1);
	});

	it("serializes concurrent writes for the same path key", async () => {
		const api = await loadSettingsHubTestApi();
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = api.withQueuedRetry("same-key", async () => {
			order.push("first:start");
			await firstGate;
			order.push("first:end");
			return "first-ok";
		});

		const second = api.withQueuedRetry("same-key", async () => {
			order.push("second:start");
			order.push("second:end");
			return "second-ok";
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);

		releaseFirst?.();

		await expect(first).resolves.toBe("first-ok");
		await expect(second).resolves.toBe("second-ok");
		expect(order).toEqual([
			"first:start",
			"first:end",
			"second:start",
			"second:end",
		]);
	});

	it("allows concurrent writes for different path keys", async () => {
		const api = await loadSettingsHubTestApi();
		const order: string[] = [];
		let releaseA: (() => void) | undefined;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const taskA = api.withQueuedRetry("key-a", async () => {
			order.push("a:start");
			await gateA;
			order.push("a:end");
			return "a";
		});

		const taskB = api.withQueuedRetry("key-b", async () => {
			order.push("b:start");
			order.push("b:end");
			return "b";
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(order).toContain("b:start");

		releaseA?.();
		await expect(taskA).resolves.toBe("a");
		await expect(taskB).resolves.toBe("b");
	});

	it("retries queued writes for HTTP 429 using retryAfterMs delay", async () => {
		const api = await loadSettingsHubTestApi();
		vi.useFakeTimers();
		try {
			let attempts = 0;
			const retryAfterMs = 120;
			const resultPromise = api.withQueuedRetry(
				"settings-path-429",
				async () => {
					attempts += 1;
					if (attempts === 1) {
						const error = new Error("rate limited") as Error & {
							status: number;
							retryAfterMs: number;
						};
						error.status = 429;
						error.retryAfterMs = retryAfterMs;
						throw error;
					}
					return "ok";
				},
			);

			await Promise.resolve();
			await Promise.resolve();
			expect(attempts).toBe(1);

			await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
			expect(attempts).toBe(1);

			await vi.advanceTimersByTimeAsync(1);
			const result = await resultPromise;
			expect(result).toBe("ok");
			expect(attempts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists selected dashboard keys through retry-aware save", async () => {
		const api = await loadSettingsHubTestApi();
		const dashboard = await import("../lib/dashboard-settings.js");
		const base = await dashboard.loadDashboardDisplaySettings();
		const selected = api.cloneDashboardSettings(base);
		selected.menuShowStatusBadge = false;

		const saved = await api.persistDashboardSettingsSelection(
			selected,
			["menuShowStatusBadge"],
			"account-list",
		);
		expect(saved.menuShowStatusBadge).toBe(false);

		const reloaded = await dashboard.loadDashboardDisplaySettings();
		expect(reloaded.menuShowStatusBadge).toBe(false);
	});

	it("persists backend config selection", async () => {
		const api = await loadSettingsHubTestApi();
		const configModule = await import("../lib/config.js");
		const selected = configModule.getDefaultPluginConfig();
		selected.fetchTimeoutMs = 12_345;
		selected.streamStallTimeoutMs = 23_456;

		const saved = await api.persistBackendConfigSelection(selected, "backend");
		expect(saved.fetchTimeoutMs).toBe(12_345);
		expect(saved.streamStallTimeoutMs).toBe(23_456);

		vi.resetModules();
		const freshConfigModule = await import("../lib/config.js");
		const reloaded = freshConfigModule.loadPluginConfig();
		expect(reloaded.fetchTimeoutMs).toBe(12_345);
		expect(reloaded.streamStallTimeoutMs).toBe(23_456);
	});

	it("applies representative backend prompt edits across all current categories", async () => {
		const api = await loadSettingsHubTestApi();
		const configModule = await import("../lib/config.js");
		const defaults = configModule.getDefaultPluginConfig();

		queueSelectResults(
			{ type: "open-category", key: "session-sync" },
			{ type: "toggle", key: "liveAccountSync" },
			{ type: "bump", key: "liveAccountSyncDebounceMs", direction: 1 },
			{ type: "back" },
			{ type: "open-category", key: "rotation-quota" },
			{ type: "toggle", key: "preemptiveQuotaEnabled" },
			{
				type: "bump",
				key: "preemptiveQuotaRemainingPercent5h",
				direction: 1,
			},
			{ type: "back" },
			{ type: "open-category", key: "performance-timeouts" },
			{ type: "toggle", key: "parallelProbing" },
			{ type: "bump", key: "fetchTimeoutMs", direction: 1 },
			{ type: "back" },
			{ type: "save" },
		);

		const selected = await api.promptBackendSettings(defaults);
		expect(selected).toEqual(
			expect.objectContaining({
				liveAccountSync: !(defaults.liveAccountSync ?? false),
				liveAccountSyncDebounceMs: api.clampBackendNumber(
					"liveAccountSyncDebounceMs",
					(defaults.liveAccountSyncDebounceMs ?? 50) + 50,
				),
				preemptiveQuotaEnabled: !(defaults.preemptiveQuotaEnabled ?? false),
				preemptiveQuotaRemainingPercent5h: api.clampBackendNumber(
					"preemptiveQuotaRemainingPercent5h",
					(defaults.preemptiveQuotaRemainingPercent5h ?? 0) + 1,
				),
				parallelProbing: !(defaults.parallelProbing ?? false),
				fetchTimeoutMs: api.clampBackendNumber(
					"fetchTimeoutMs",
					(defaults.fetchTimeoutMs ?? 60_000) + 5_000,
				),
			}),
		);
	});

	it("resets each backend category to defaults after category-specific drift", async () => {
		const api = await loadSettingsHubTestApi();
		const configModule = await import("../lib/config.js");
		const defaults = configModule.getDefaultPluginConfig();
		const initial: PluginConfig = {
			...defaults,
			liveAccountSync: !(defaults.liveAccountSync ?? false),
			liveAccountSyncDebounceMs: 0,
			preemptiveQuotaEnabled: !(defaults.preemptiveQuotaEnabled ?? false),
			preemptiveQuotaRemainingPercent5h: 999,
			storageBackupEnabled: !(defaults.storageBackupEnabled ?? false),
			tokenRefreshSkewMs: 0,
			parallelProbing: !(defaults.parallelProbing ?? false),
			fetchTimeoutMs: 999_999,
		};

		queueSelectResults(
			{ type: "open-category", key: "session-sync" },
			{ type: "reset-category" },
			{ type: "back" },
			{ type: "open-category", key: "rotation-quota" },
			{ type: "reset-category" },
			{ type: "back" },
			{ type: "open-category", key: "refresh-recovery" },
			{ type: "reset-category" },
			{ type: "back" },
			{ type: "open-category", key: "performance-timeouts" },
			{ type: "reset-category" },
			{ type: "back" },
			{ type: "save" },
		);

		const selected = await api.promptBackendSettings(initial);
		expect(selected).toEqual(
			expect.objectContaining({
				liveAccountSync: defaults.liveAccountSync,
				liveAccountSyncDebounceMs: defaults.liveAccountSyncDebounceMs,
				preemptiveQuotaEnabled: defaults.preemptiveQuotaEnabled,
				preemptiveQuotaRemainingPercent5h:
					defaults.preemptiveQuotaRemainingPercent5h,
				storageBackupEnabled: defaults.storageBackupEnabled,
				tokenRefreshSkewMs: defaults.tokenRefreshSkewMs,
				parallelProbing: defaults.parallelProbing,
				fetchTimeoutMs: defaults.fetchTimeoutMs,
			}),
		);
	});
	it("returns null for promptBackendSettings cancel without mutating runtime state", async () => {
		const api = await loadSettingsHubTestApi();
		const configModule = await import("../lib/config.js");
		queueSelectResults({ type: "cancel" });
		const selected = await api.promptBackendSettings({
			...configModule.getDefaultPluginConfig(),
			fetchTimeoutMs: 12_345,
		});
		expect(selected).toBeNull();
	});

	describe("settings-hub preview helpers", () => {
		it("builds account preview hint with details info", async () => {
			const api = await loadSettingsHubTestApi();
			const ui = getUiRuntimeOptions();
			const settings: DashboardDisplaySettings = {
				...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
				menuLayoutMode: "expanded-rows",
				menuShowQuotaSummary: false,
			};
			const preview = api.buildAccountListPreview(settings, ui, "menuSortMode");
			expect(preview.label).toContain("demo@example.com");
			expect(preview.hint).toContain("details shown on all rows");
		});

		it("renders summary text with a highlighted status note", async () => {
			const api = await loadSettingsHubTestApi();
			const ui = getUiRuntimeOptions();
			const summary = api.buildSummaryPreviewText(
				{
					...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
					menuShowStatusBadge: false,
					menuStatuslineFields: ["status"],
				},
				ui,
				"status",
			);
			expect(summary).toContain("status:");
		});

		it("normalizes and reorders statusline fields", async () => {
			const api = await loadSettingsHubTestApi();
			const normalized = api.normalizeStatuslineFields([
				"limits",
				"status",
				"status",
			] as DashboardStatuslineField[]);
			expect(normalized).toEqual(["limits", "status"]);
			const reordered = api.reorderField(normalized, "status", -1);
			expect(reordered).toEqual(["status", "limits"]);
		});
	});

	describe("settings-hub prompt helpers for non-backend panels", () => {
		it("toggles account list option before saving", async () => {
			const api = await loadSettingsHubTestApi();
			queueSelectResults(
				{ type: "toggle", key: "menuShowStatusBadge" },
				{ type: "save" },
			);
			const selected = await api.promptDashboardDisplaySettings({
				...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
			});
			expect(selected?.menuShowStatusBadge).toBe(false);
		});

		it("reorders summary fields in the prompt", async () => {
			const api = await loadSettingsHubTestApi();
			queueSelectResults({ type: "move-up", key: "status" }, { type: "save" });
			const selected = await api.promptStatuslineSettings({
				...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
				menuStatuslineFields: ["last-used", "limits", "status"],
			});
			expect(selected?.menuStatuslineFields).toEqual([
				"last-used",
				"status",
				"limits",
			]);
		});

		it("toggles behavior settings before returning the draft", async () => {
			const api = await loadSettingsHubTestApi();
			queueSelectResults({ type: "toggle-pause" }, { type: "save" });
			const selected = await api.promptBehaviorSettings({
				...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
			});
			expect(selected?.actionPauseOnKey).toBe(false);
		});

		it("restores theme baseline when the prompt is cancelled", async () => {
			const api = await loadSettingsHubTestApi();
			queueSelectResults({ type: "cancel" });
			setUiRuntimeOptions({ palette: "cyan", accent: "green" });
			const runtimeModule = await import("../lib/ui/runtime.js");
			const setSpy = vi.spyOn(runtimeModule, "setUiRuntimeOptions");
			await expect(
				api.promptThemeSettings({
					...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
					uiThemePreset: "blue",
					uiAccentColor: "yellow",
				}),
			).resolves.toBeNull();
			expect(setSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					palette: "blue",
					accent: "yellow",
				}),
			);
			setSpy.mockRestore();
		});

		it("retries experimental target reads for retryable filesystem errors", async () => {
			vi.doMock("../lib/oc-chatgpt-target-detection.js", () => ({
				detectOcChatgptMultiAuthTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: tempRoot,
						accountPath: join(tempRoot, "openai-codex-accounts.json"),
						backupRoot: join(tempRoot, "backups"),
						source: "default-global",
						resolution: "accounts",
					},
				}),
			}));
			const nodeFs = await import("node:fs");
			const busyError = new Error("busy") as NodeJS.ErrnoException;
			busyError.code = "EBUSY";
			const readSpy = vi
				.spyOn(nodeFs.promises, "readFile")
				.mockRejectedValueOnce(busyError)
				.mockResolvedValueOnce(
					JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
				);
			const api = await loadSettingsHubTestApi();
			const result = await api.loadExperimentalSyncTarget();
			expect(result.kind).toBe("target");
			expect(readSpy).toHaveBeenCalledTimes(2);
			readSpy.mockRestore();
		});

		it("decreases experimental refresh interval down to the configured minimum", async () => {
			const api = await loadSettingsHubTestApi();
			queueSelectResults(
				{ type: "decrease-refresh-interval" },
				{ type: "save" },
			);
			const selected = await api.promptExperimentalSettings({
				proactiveRefreshIntervalMs: 30_000,
			});
			expect(selected?.proactiveRefreshIntervalMs).toBe(60_000);
		});
	});
});
