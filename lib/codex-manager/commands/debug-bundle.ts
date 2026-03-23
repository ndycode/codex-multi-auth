import type { ConfigExplainReport } from "../../config.js";

export function runDebugBundleCommand(
	args: string[],
	deps: {
		getConfigReport: () => ConfigExplainReport;
		getStoragePath: () => string;
		loadAccounts: () => Promise<{
			accounts: Array<{ enabled?: boolean }>;
			activeIndex?: number;
		} | null>;
		loadFlaggedAccounts: () => Promise<{ accounts: unknown[] }>;
		loadCodexCliState: (options: { forceRefresh: boolean }) => Promise<{
			path: string;
			accounts: unknown[];
			activeEmail?: string;
			activeAccountId?: string;
			syncVersion?: number;
			sourceUpdatedAtMs?: number;
		} | null>;
		getLastAccountsSaveTimestamp: () => number;
		logInfo?: (message: string) => void;
		logError?: (message: string) => void;
	},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const json = args.includes("--json");
	const unknown = args.filter((arg) => arg !== "--json");
	if (unknown.length > 0) {
		logError(`Unknown option: ${unknown[0]}`);
		return Promise.resolve(1);
	}

	return Promise.all([
		Promise.resolve(deps.getConfigReport()),
		deps.loadAccounts(),
		deps.loadFlaggedAccounts(),
		deps.loadCodexCliState({ forceRefresh: true }),
	])
		.then(([config, accounts, flagged, codexCli]) => {
			const bundle = {
				generatedAt: new Date().toISOString(),
				storagePath: deps.getStoragePath(),
				lastAccountsSaveTimestamp: deps.getLastAccountsSaveTimestamp(),
				config,
				accounts: {
					total: accounts?.accounts.length ?? 0,
					enabled:
						accounts?.accounts.filter((account) => account.enabled !== false)
							.length ?? 0,
					activeIndex:
						typeof accounts?.activeIndex === "number"
							? accounts.activeIndex + 1
							: null,
				},
				flaggedAccounts: {
					total: flagged.accounts.length,
				},
				codexCli: codexCli
					? {
							path: codexCli.path,
							accountCount: codexCli.accounts.length,
							activeEmail: codexCli.activeEmail ?? null,
							activeAccountId: codexCli.activeAccountId ?? null,
							syncVersion: codexCli.syncVersion ?? null,
							sourceUpdatedAtMs: codexCli.sourceUpdatedAtMs ?? null,
						}
					: null,
			};

			if (json) {
				logInfo(JSON.stringify(bundle, null, 2));
				return 0;
			}

			logInfo(`Generated: ${bundle.generatedAt}`);
			logInfo(`Storage: ${bundle.storagePath}`);
			logInfo(
				`Accounts: ${bundle.accounts.total} total, ${bundle.accounts.enabled} enabled`,
			);
			logInfo(`Flagged: ${bundle.flaggedAccounts.total}`);
			if (bundle.codexCli) {
				logInfo(
					`Codex CLI: ${bundle.codexCli.accountCount} account(s), active ${bundle.codexCli.activeEmail ?? "unknown"}`,
				);
			}
			return 0;
		})
		.catch((error) => {
			logError(
				`Failed to generate debug bundle: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		});
}
