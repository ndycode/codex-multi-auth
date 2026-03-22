import type { FlaggedAccountMetadataV1 } from "../storage.js";
import type { TokenSuccessWithAccount } from "./account-selection.js";
import { createFlaggedVerificationState } from "./flagged-verify-types.js";

type SuccessfulAccountTokens = {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
	idToken?: string;
	multiAccount?: boolean;
};

export async function verifyRuntimeFlaggedAccounts(deps: {
	loadFlaggedAccounts: () => Promise<{
		version: 1;
		accounts: FlaggedAccountMetadataV1[];
	}>;
	lookupCodexCliTokensByEmail: (email: string | undefined) => Promise<
		| {
				accessToken: string;
				refreshToken?: string;
				expiresAt?: number;
		  }
		| null
		| undefined
	>;
	queuedRefresh: (refreshToken: string) => Promise<
		| {
				type: "success";
				access: string;
				refresh: string;
				expires: number;
				idToken?: string;
		  }
		| { type: "failed"; message?: string; reason?: string }
	>;
	resolveTokenSuccessAccount: (
		tokens: SuccessfulAccountTokens,
	) => TokenSuccessWithAccount<SuccessfulAccountTokens>;
	persistAccounts: (
		results: Array<TokenSuccessWithAccount<SuccessfulAccountTokens>>,
		replaceAll?: boolean,
	) => Promise<void>;
	invalidateAccountManagerCache: () => void;
	saveFlaggedAccounts: (storage: {
		version: 1;
		accounts: FlaggedAccountMetadataV1[];
	}) => Promise<void>;
	logError?: (message: string) => void;
	showLine: (message: string) => void;
	now?: () => number;
}): Promise<void> {
	const flaggedStorage = await deps.loadFlaggedAccounts();
	if (flaggedStorage.accounts.length === 0) {
		deps.showLine("\nNo flagged accounts to verify.\n");
		return;
	}

	deps.showLine("\nVerifying flagged accounts...\n");
	const state = createFlaggedVerificationState();

	for (let i = 0; i < flaggedStorage.accounts.length; i += 1) {
		const flagged = flaggedStorage.accounts[i];
		if (!flagged) continue;
		const label = flagged.email ?? flagged.accountLabel ?? `Flagged ${i + 1}`;
		try {
			const cached = await deps.lookupCodexCliTokensByEmail(flagged.email);
			const now = deps.now?.() ?? Date.now();
			if (
				cached &&
				typeof cached.expiresAt === "number" &&
				Number.isFinite(cached.expiresAt) &&
				cached.expiresAt > now
			) {
				const refreshToken =
					typeof cached.refreshToken === "string" && cached.refreshToken.trim()
						? cached.refreshToken.trim()
						: flagged.refreshToken;
				const resolved = deps.resolveTokenSuccessAccount({
					type: "success",
					access: cached.accessToken,
					refresh: refreshToken,
					expires: cached.expiresAt,
					multiAccount: true,
				});
				if (!resolved.accountIdOverride && flagged.accountId) {
					resolved.accountIdOverride = flagged.accountId;
					resolved.accountIdSource = flagged.accountIdSource ?? "manual";
				}
				if (!resolved.accountLabel && flagged.accountLabel) {
					resolved.accountLabel = flagged.accountLabel;
				}
				state.restored.push(resolved);
				deps.showLine(
					`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED (Codex CLI cache)`,
				);
				continue;
			}

			const refreshResult = await deps.queuedRefresh(flagged.refreshToken);
			if (refreshResult.type !== "success") {
				deps.showLine(
					`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: STILL FLAGGED (${refreshResult.message ?? refreshResult.reason ?? "refresh failed"})`,
				);
				state.remaining.push(flagged);
				continue;
			}

			const resolved = deps.resolveTokenSuccessAccount(refreshResult);
			if (!resolved.accountIdOverride && flagged.accountId) {
				resolved.accountIdOverride = flagged.accountId;
				resolved.accountIdSource = flagged.accountIdSource ?? "manual";
			}
			if (!resolved.accountLabel && flagged.accountLabel) {
				resolved.accountLabel = flagged.accountLabel;
			}
			state.restored.push(resolved);
			deps.showLine(
				`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.showLine(
				`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: ERROR (${message.slice(0, 120)})`,
			);
			state.remaining.push({
				...flagged,
				lastError: message,
			});
		}
	}

	if (state.restored.length > 0) {
		await deps.persistAccounts(state.restored, false);
		deps.invalidateAccountManagerCache();
	}

	await deps.saveFlaggedAccounts({
		version: 1,
		accounts: state.remaining,
	});

	deps.showLine("");
	deps.showLine(
		`Results: ${state.restored.length} restored, ${state.remaining.length} still flagged`,
	);
	deps.showLine("");
}
