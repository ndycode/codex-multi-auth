import type { OAuthAuthDetails, TokenResult } from "../types.js";
import type { PersistAccountPoolDeps } from "./account-pool.js";
import type { TokenSuccessWithAccount } from "./account-selection.js";

export async function runRuntimeOAuthFlow(
	forceNewLogin: boolean,
	deps: {
		runOAuthBrowserFlow: (input: {
			forceNewLogin: boolean;
			manualModeLabel: string;
			logInfo: (message: string) => void;
			logDebug: (message: string) => void;
			logWarn: (message: string) => void;
		}) => Promise<TokenResult>;
		manualModeLabel: string;
		logInfo: (message: string) => void;
		logDebug: (message: string) => void;
		logWarn: (message: string) => void;
		pluginName: string;
	},
): Promise<TokenResult> {
	return deps.runOAuthBrowserFlow({
		forceNewLogin,
		manualModeLabel: deps.manualModeLabel,
		logInfo: deps.logInfo,
		logDebug: (message) => deps.logDebug(`[${deps.pluginName}] ${message}`),
		logWarn: (message) => deps.logWarn(`[${deps.pluginName}] ${message}`),
	});
}

export function createPersistAccounts(
	deps: {
		persistAccountPool: (
			results: TokenSuccessWithAccount[],
			replaceAll: boolean,
			options: PersistAccountPoolDeps,
		) => Promise<void>;
	} & PersistAccountPoolDeps,
) {
	return async (
		results: TokenSuccessWithAccount[],
		replaceAll: boolean = false,
	): Promise<void> =>
		deps.persistAccountPool(results, replaceAll, {
			withAccountStorageTransaction: deps.withAccountStorageTransaction,
			extractAccountId: deps.extractAccountId,
			extractAccountEmail: deps.extractAccountEmail,
			sanitizeEmail: deps.sanitizeEmail,
			findMatchingAccountIndex: deps.findMatchingAccountIndex,
			MODEL_FAMILIES: deps.MODEL_FAMILIES,
		});
}

export function createAccountManagerReloader<TAccountManager>(deps: {
	reloadRuntimeAccountManager: (input: {
		currentReloadInFlight: Promise<TAccountManager> | null;
		loadFromDisk: (fallback?: OAuthAuthDetails) => Promise<TAccountManager>;
		setCachedAccountManager: (value: TAccountManager) => void;
		setAccountManagerPromise: (value: Promise<TAccountManager> | null) => void;
		setReloadInFlight: (value: Promise<TAccountManager> | null) => void;
		authFallback?: OAuthAuthDetails;
	}) => Promise<TAccountManager>;
	getReloadInFlight: () => Promise<TAccountManager> | null;
	loadFromDisk: (fallback?: OAuthAuthDetails) => Promise<TAccountManager>;
	setCachedAccountManager: (value: TAccountManager) => void;
	setAccountManagerPromise: (value: Promise<TAccountManager> | null) => void;
	setReloadInFlight: (value: Promise<TAccountManager> | null) => void;
}) {
	return async (authFallback?: OAuthAuthDetails): Promise<TAccountManager> =>
		deps.reloadRuntimeAccountManager({
			currentReloadInFlight: deps.getReloadInFlight(),
			loadFromDisk: deps.loadFromDisk,
			setCachedAccountManager: deps.setCachedAccountManager,
			setAccountManagerPromise: deps.setAccountManagerPromise,
			setReloadInFlight: deps.setReloadInFlight,
			authFallback,
		});
}
