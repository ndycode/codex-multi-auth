import type { ModelFamily } from "../prompts/codex.js";
import type { OAuthAuthDetails, TokenResult } from "../types.js";
import type { TokenSuccessWithAccount } from "./account-pool.js";

export async function runRuntimeOAuthFlow(
	forceNewLogin: boolean,
	deps: {
		runBrowserOAuthFlow: (input: {
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
	const pluginPrefix = `[${deps.pluginName}]`;
	const prefixLogMessage = (
		message: string,
		options?: { leadingNewline?: boolean },
	): string => {
		if (
			message.startsWith(pluginPrefix) ||
			message.startsWith(`\n${pluginPrefix}`)
		) {
			return message;
		}
		return options?.leadingNewline
			? `\n${pluginPrefix} ${message}`
			: `${pluginPrefix} ${message}`;
	};
	return deps.runBrowserOAuthFlow({
		forceNewLogin,
		manualModeLabel: deps.manualModeLabel,
		logInfo: deps.logInfo,
		logDebug: (message) => deps.logDebug(prefixLogMessage(message)),
		logWarn: (message) =>
			deps.logWarn(prefixLogMessage(message, { leadingNewline: true })),
	});
}

export function createPersistAccounts(deps: {
	persistAccountPoolResults: (params: {
		results: TokenSuccessWithAccount[];
		replaceAll?: boolean;
		modelFamilies: readonly ModelFamily[];
		withAccountStorageTransaction: <T>(
			handler: (
				loadedStorage: import("../storage.js").AccountStorageV3 | null,
				persist: (
					storage: import("../storage.js").AccountStorageV3,
				) => Promise<void>,
			) => Promise<T>,
		) => Promise<T>;
		findMatchingAccountIndex: typeof import("../storage.js").findMatchingAccountIndex;
		extractAccountId: (accessToken: string) => string | undefined;
		extractAccountEmail: (
			accessToken: string,
			idToken?: string,
		) => string | undefined;
		sanitizeEmail: (email: string | undefined) => string | undefined;
	}) => Promise<void>;
	modelFamilies: readonly ModelFamily[];
	withAccountStorageTransaction: <T>(
		handler: (
			loadedStorage: import("../storage.js").AccountStorageV3 | null,
			persist: (
				storage: import("../storage.js").AccountStorageV3,
			) => Promise<void>,
		) => Promise<T>,
	) => Promise<T>;
	findMatchingAccountIndex: typeof import("../storage.js").findMatchingAccountIndex;
	extractAccountId: (accessToken: string) => string | undefined;
	extractAccountEmail: (
		accessToken: string,
		idToken?: string,
	) => string | undefined;
	sanitizeEmail: (email: string | undefined) => string | undefined;
}) {
	return async (
		results: TokenSuccessWithAccount[],
		replaceAll: boolean = false,
	): Promise<void> =>
		deps.persistAccountPoolResults({
			results,
			replaceAll,
			modelFamilies: deps.modelFamilies,
			withAccountStorageTransaction: deps.withAccountStorageTransaction,
			findMatchingAccountIndex: deps.findMatchingAccountIndex,
			extractAccountId: deps.extractAccountId,
			extractAccountEmail: deps.extractAccountEmail,
			sanitizeEmail: deps.sanitizeEmail,
		});
}

export function createAccountManagerReloader<TAccountManager>(deps: {
	reloadRuntimeAccountManager: (input: {
		currentReloadInFlight: Promise<TAccountManager> | null;
		loadFromDisk: (fallback?: OAuthAuthDetails) => Promise<TAccountManager>;
		setCachedAccountManager: (value: TAccountManager) => void;
		setAccountManagerPromise: (
			value: Promise<TAccountManager> | null,
		) => void;
		setReloadInFlight: (value: Promise<TAccountManager> | null) => void;
		authFallback?: OAuthAuthDetails;
	}) => Promise<TAccountManager>;
	getReloadInFlight: () => Promise<TAccountManager> | null;
	loadFromDisk: (fallback?: OAuthAuthDetails) => Promise<TAccountManager>;
	setCachedAccountManager: (value: TAccountManager) => void;
	setAccountManagerPromise: (
		value: Promise<TAccountManager> | null,
	) => void;
	setReloadInFlight: (value: Promise<TAccountManager> | null) => void;
}) {
	return async (authFallback?: OAuthAuthDetails): Promise<TAccountManager> => {
		const inFlight = deps.getReloadInFlight();
		if (inFlight) {
			return inFlight;
		}
		return deps.reloadRuntimeAccountManager({
			currentReloadInFlight: inFlight,
			loadFromDisk: deps.loadFromDisk,
			setCachedAccountManager: deps.setCachedAccountManager,
			setAccountManagerPromise: deps.setAccountManagerPromise,
			setReloadInFlight: deps.setReloadInFlight,
			authFallback,
		});
	};
}
