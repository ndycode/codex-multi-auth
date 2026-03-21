import type { AccountStorageV3 } from "../storage.js";
import type { AccountIdSource, TokenResult } from "../types.js";

export async function hydrateRuntimeEmails(
	storage: AccountStorageV3 | null,
	deps: {
		queuedRefresh: (refreshToken: string) => Promise<TokenResult>;
		extractAccountId: (accessToken: string | undefined) => string | undefined;
		sanitizeEmail: (email: string | undefined) => string | undefined;
		extractAccountEmail: (
			accessToken: string | undefined,
			idToken?: string | undefined,
		) => string | undefined;
		shouldUpdateAccountIdFromToken: (
			accountIdSource: AccountIdSource | undefined,
			accountId: string | undefined,
		) => boolean;
		saveAccounts: (storage: AccountStorageV3) => Promise<void>;
		logWarn: (message: string) => void;
		pluginName: string;
	},
): Promise<AccountStorageV3 | null> {
	if (!storage) return storage;
	const skipHydrate =
		process.env.VITEST_WORKER_ID !== undefined ||
		process.env.NODE_ENV === "test" ||
		process.env.CODEX_SKIP_EMAIL_HYDRATE === "1";
	if (skipHydrate) return storage;

	const accountsCopy = storage.accounts.map((account) =>
		account ? { ...account } : account,
	);
	const accountsToHydrate = accountsCopy.filter(
		(account) => account && !account.email,
	);
	if (accountsToHydrate.length === 0) return storage;

	let changed = false;
	await Promise.all(
		accountsToHydrate.map(async (account) => {
			try {
				const refreshed = await deps.queuedRefresh(account.refreshToken);
				if (refreshed.type !== "success") return;
				const id = deps.extractAccountId(refreshed.access);
				const email = deps.sanitizeEmail(
					deps.extractAccountEmail(refreshed.access, refreshed.idToken),
				);
				if (
					id &&
					id !== account.accountId &&
					deps.shouldUpdateAccountIdFromToken(
						account.accountIdSource,
						account.accountId,
					)
				) {
					account.accountId = id;
					account.accountIdSource = "token";
					changed = true;
				}
				if (email && email !== account.email) {
					account.email = email;
					changed = true;
				}
				if (refreshed.access && refreshed.access !== account.accessToken) {
					account.accessToken = refreshed.access;
					changed = true;
				}
				if (
					typeof refreshed.expires === "number" &&
					refreshed.expires !== account.expiresAt
				) {
					account.expiresAt = refreshed.expires;
					changed = true;
				}
				if (refreshed.refresh && refreshed.refresh !== account.refreshToken) {
					account.refreshToken = refreshed.refresh;
					changed = true;
				}
			} catch {
				deps.logWarn(
					`[${deps.pluginName}] Failed to hydrate email for account`,
				);
			}
		}),
	);

	if (changed) {
		storage.accounts = accountsCopy;
		await deps.saveAccounts(storage);
	}
	return storage;
}
