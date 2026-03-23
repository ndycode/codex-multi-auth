import { describe, expect, it, vi } from "vitest";
import {
	createAccountManagerReloader,
	createPersistAccounts,
	runRuntimeOAuthFlow,
} from "../lib/runtime/auth-facade.js";

describe("runRuntimeOAuthFlow", () => {
	it("passes through the flow config and prefixes debug/warn logs with the plugin name", async () => {
		const runBrowserOAuthFlow = vi.fn(async (input) => {
			input.logInfo("info message");
			input.logDebug("debug message");
			input.logWarn("warn message");
			return { type: "failed" as const, reason: "cancelled" };
		});
		const logInfo = vi.fn();
		const logDebug = vi.fn();
		const logWarn = vi.fn();
		await expect(
			runRuntimeOAuthFlow(true, {
				runBrowserOAuthFlow,
				manualModeLabel: "manual",
				logInfo,
				logDebug,
				logWarn,
				pluginName: "codex-multi-auth",
			}),
		).resolves.toEqual({ type: "failed", reason: "cancelled" });
		expect(runBrowserOAuthFlow).toHaveBeenCalledWith(
			expect.objectContaining({
				forceNewLogin: true,
				manualModeLabel: "manual",
			}),
		);
		expect(logInfo).toHaveBeenCalledWith("info message");
		expect(logDebug).toHaveBeenCalledWith("[codex-multi-auth] debug message");
		expect(logWarn).toHaveBeenCalledWith("\n[codex-multi-auth] warn message");
	});
});

describe("createPersistAccounts", () => {
	it("forwards persist dependencies and replaceAll flag", async () => {
		const withAccountStorageTransaction = vi.fn();
		const extractAccountId = vi.fn();
		const extractAccountEmail = vi.fn();
		const sanitizeEmail = vi.fn();
		const findMatchingAccountIndex = vi.fn();
		const persistAccountPoolResults = vi.fn(async () => {});
		const persistAccounts = createPersistAccounts({
			persistAccountPoolResults,
			withAccountStorageTransaction,
			extractAccountId,
			extractAccountEmail,
			sanitizeEmail,
			findMatchingAccountIndex,
			modelFamilies: ["codex"],
		});
		const results = [{ refreshToken: "r1" }] as never[];
		await persistAccounts(results, true);
		expect(persistAccountPoolResults).toHaveBeenCalledWith({
			results,
			replaceAll: true,
			modelFamilies: ["codex"],
			withAccountStorageTransaction,
			extractAccountId,
			extractAccountEmail,
			sanitizeEmail,
			findMatchingAccountIndex,
		});
	});

	it("keeps replaceAll optional and false by default", async () => {
		const persistAccountPoolResults = vi.fn(async () => {});
		const withAccountStorageTransaction = vi.fn();
		const extractAccountId = vi.fn();
		const extractAccountEmail = vi.fn();
		const sanitizeEmail = vi.fn();
		const findMatchingAccountIndex = vi.fn();
		const persistAccounts = createPersistAccounts({
			persistAccountPoolResults,
			withAccountStorageTransaction,
			extractAccountId,
			extractAccountEmail,
			sanitizeEmail,
			findMatchingAccountIndex,
			modelFamilies: ["codex"],
		});
		await persistAccounts([{ refreshToken: "r2" }] as never[]);
		expect(persistAccountPoolResults).toHaveBeenCalledWith(
			expect.objectContaining({
				results: expect.any(Array),
				replaceAll: false,
				modelFamilies: ["codex"],
				withAccountStorageTransaction,
				extractAccountId,
				extractAccountEmail,
				sanitizeEmail,
				findMatchingAccountIndex,
			}),
		);
	});
});

describe("createAccountManagerReloader", () => {
	it("returns existing reload promise when one is in flight", async () => {
		const reloadRuntimeAccountManager = vi.fn(async () => "manager");
		const inFlight = Promise.resolve("existing-manager");
		const reloader = createAccountManagerReloader({
			reloadRuntimeAccountManager,
			getReloadInFlight: () => inFlight as Promise<string>,
			loadFromDisk: vi.fn(async () => "manager"),
			setCachedAccountManager: vi.fn(),
			setAccountManagerPromise: vi.fn(),
			setReloadInFlight: vi.fn(),
		});
		await expect(reloader()).resolves.toBe("existing-manager");
		expect(reloadRuntimeAccountManager).not.toHaveBeenCalled();
	});

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
