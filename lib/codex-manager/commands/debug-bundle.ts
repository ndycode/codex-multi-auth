import type { ConfigExplainReport } from "../../config.js";
import { homedir } from "node:os";
import { sep } from "node:path";
import { maskEmail } from "../../logger.js";

/**
 * Replace the user's home-directory prefix with `~` so the bundle does not leak
 * the OS username embedded in absolute paths (errors-logging-04).
 *
 * The match is path-aware, not a raw `startsWith`:
 *   - Windows path comparison is case-insensitive, so `C:\Users\Alice` and
 *     `c:\users\alice` must both redact. We case-fold both sides on win32.
 *   - A bare prefix check falsely matches sibling directories that merely share
 *     a string prefix (e.g. home `/users/alice` would "match" `/users/alice2`).
 *     We require a real path boundary: either an exact home match or the next
 *     character after the prefix is a path separator.
 *
 * @internal Exported for unit testing of the windows-casing / prefix-collision
 * branches; not part of the public CLI surface.
 */
export function redactHome(value: string): string {
	const home = homedir();
	if (!home) {
		return value;
	}

	const isWindows = process.platform === "win32";
	const normalizedValue = isWindows ? value.toLowerCase() : value;
	const normalizedHome = isWindows ? home.toLowerCase() : home;

	if (normalizedValue === normalizedHome) {
		return "~";
	}

	// Require a path boundary after the home prefix so `/users/alice2` is not
	// treated as living under home `/users/alice`. Accept either path separator
	// so a value captured with the foreign separator still redacts.
	const boundary = normalizedValue.slice(normalizedHome.length, normalizedHome.length + 1);
	if (
		normalizedValue.startsWith(normalizedHome) &&
		(boundary === sep || boundary === "/" || boundary === "\\")
	) {
		return `~${value.slice(home.length)}`;
	}

	return value;
}

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
				storagePath: redactHome(deps.getStoragePath()),
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
							path: redactHome(codexCli.path),
							accountCount: codexCli.accounts.length,
							activeEmail: codexCli.activeEmail
								? maskEmail(codexCli.activeEmail)
								: null,
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
