import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("release-main-prs regressions", () => {
	let tempDir: string;
	let accountsPath: string;
	let authPath: string;
	let configPath: string;
	let previousMultiAuthDir: string | undefined;
	let previousAccountsPath: string | undefined;
	let previousAuthPath: string | undefined;
	let previousConfigPath: string | undefined;
	let previousSync: string | undefined;
	let previousEnforceFileStore: string | undefined;

	beforeEach(async () => {
		previousMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
		previousAccountsPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
		previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
		previousConfigPath = process.env.CODEX_CLI_CONFIG_PATH;
		previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		previousEnforceFileStore =
			process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;

		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-release-main-prs-"));
		accountsPath = join(tempDir, "accounts.json");
		authPath = join(tempDir, "auth.json");
		configPath = join(tempDir, "config.toml");

		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_CONFIG_PATH = configPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";

		vi.resetModules();
		clearCodexCliStateCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCodexCliStateCache();

		const { setStoragePathDirect } = await import("../lib/storage.js");
		setStoragePathDirect(null);

		if (previousMultiAuthDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = previousMultiAuthDir;
		if (previousAccountsPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
		else process.env.CODEX_CLI_ACCOUNTS_PATH = previousAccountsPath;
		if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
		else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
		if (previousConfigPath === undefined) delete process.env.CODEX_CLI_CONFIG_PATH;
		else process.env.CODEX_CLI_CONFIG_PATH = previousConfigPath;
		if (previousSync === undefined) delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		else process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
		if (previousEnforceFileStore === undefined) {
			delete process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
		} else {
			process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = previousEnforceFileStore;
		}

		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("keeps canonical storage and unified settings isolated from Codex CLI mirror files", async () => {
		const {
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");
		const { syncAccountStorageFromCodexCli } = await import("../lib/codex-cli/sync.js");
		const { MODEL_FAMILIES } = await import("../lib/prompts/codex.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 90_000 });
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "green",
		});

		await fs.writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_mirror",
					accounts: [
						{
							accountId: "acc_mirror",
							email: "mirror@example.com",
							auth: {
								tokens: {
									access_token: "mirror-access",
									refresh_token: "mirror-refresh",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_canonical",
					email: "canonical@example.com",
					refreshToken: "canonical-refresh",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: Object.fromEntries(MODEL_FAMILIES.map((family) => [family, 0])),
		};

		const result = await syncAccountStorageFromCodexCli(current);

		expect(result.changed).toBe(false);
		expect(result.storage).toBe(current);
		expect(result.storage?.accounts).toEqual(current.accounts);
		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			fetchTimeoutMs: 90_000,
		});
		expect(await loadUnifiedDashboardSettings()).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "green",
		});
	});

	it("keeps flagged reset suppression active even when Codex CLI mirrors exist", async () => {
		const {
			clearFlaggedAccounts,
			getFlaggedAccountsPath,
			loadFlaggedAccounts,
			saveFlaggedAccounts,
			setStoragePathDirect,
		} = await import("../lib/storage.js");
		const { syncAccountStorageFromCodexCli } = await import("../lib/codex-cli/sync.js");

		const storagePath = join(tempDir, "canonical-accounts.json");
		setStoragePathDirect(storagePath);

		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "stale-primary",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await fs.writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_mirror",
					accounts: [
						{
							accountId: "acc_mirror",
							email: "mirror@example.com",
							auth: {
								tokens: {
									access_token: "mirror-access",
									refresh_token: "mirror-refresh",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const flaggedPath = getFlaggedAccountsPath();
		const originalUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (targetPath) => {
			if (targetPath === flaggedPath) {
				const error = new Error("EPERM primary delete") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return originalUnlink(targetPath);
		});

		await expect(clearFlaggedAccounts()).resolves.toBe(false);

		const flagged = await loadFlaggedAccounts();
		const syncResult = await syncAccountStorageFromCodexCli(null);

		expect(existsSync(flaggedPath)).toBe(true);
		expect(flagged.accounts).toHaveLength(0);
		expect(syncResult.changed).toBe(false);
		expect(syncResult.storage).toBeNull();

		unlinkSpy.mockRestore();
	});
});
