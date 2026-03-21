import { describe, expect, it, vi } from "vitest";
import {
	createAccountManagerReloader,
	createPersistAccounts,
	runRuntimeOAuthFlow,
} from "../lib/runtime/auth-facade.js";

describe("runRuntimeOAuthFlow", () => {
	it("passes through info logs and prefixes debug/warn logs with the plugin name", async () => {
		const logInfo = vi.fn();
		const logDebug = vi.fn();
		const logWarn = vi.fn();
		await runRuntimeOAuthFlow(true, {
			runOAuthBrowserFlow: vi.fn(async (input) => {
				input.logInfo("info message");
				input.logDebug("debug message");
				input.logWarn("warn message");
				return { type: "failed", reason: "cancelled" };
			}),
			manualModeLabel: "manual",
			logInfo,
			logDebug,
			logWarn,
			pluginName: "codex-multi-auth",
		});
		expect(logInfo).toHaveBeenCalledWith("info message");
		expect(logDebug).toHaveBeenCalledWith("[codex-multi-auth] debug message");
		expect(logWarn).toHaveBeenCalledWith("[codex-multi-auth] warn message");
	});
});

describe("createPersistAccounts", () => {
	it("forwards persist dependencies and replaceAll flag", async () => {
		const persistAccountPool = vi.fn(async () => {});
		const persistAccounts = createPersistAccounts({
			persistAccountPool,
			withAccountStorageTransaction: vi.fn(),
			extractAccountId: vi.fn(),
			extractAccountEmail: vi.fn(),
			sanitizeEmail: vi.fn(),
			findMatchingAccountIndex: vi.fn(),
			MODEL_FAMILIES: ["codex"],
		});
		const results = [{ refreshToken: "r1" }] as never[];
		await persistAccounts(results, true);
		expect(persistAccountPool).toHaveBeenCalledWith(
			results,
			true,
			expect.objectContaining({ MODEL_FAMILIES: ["codex"] }),
		);
	});
});

describe("createAccountManagerReloader", () => {
	it("forwards auth fallback and current reload state", async () => {
		const reloadRuntimeAccountManager = vi.fn(async () => "manager");
		const reloader = createAccountManagerReloader({
			reloadRuntimeAccountManager,
			getReloadInFlight: () => null,
			loadFromDisk: vi.fn(async () => "manager"),
			setCachedAccountManager: vi.fn(),
			setAccountManagerPromise: vi.fn(),
			setReloadInFlight: vi.fn(),
		});
		await expect(
			reloader({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
		).resolves.toBe("manager");
		expect(reloadRuntimeAccountManager).toHaveBeenCalledWith(
			expect.objectContaining({
				authFallback: expect.objectContaining({ refresh: "r" }),
			}),
		);
	});
});
