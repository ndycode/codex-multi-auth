import { evaluateForecastAccount } from "../forecast.js";
import type { CodexQuotaSnapshot } from "../quota-probe.js";
import { resolveNormalizedModel } from "../request/helpers/model-map.js";
import type { AccountStorageV3 } from "../storage.js";
import type { AccountIdSource, TokenFailure, TokenResult } from "../types.js";

export interface StartupPreflightResult {
	currentHealthy: boolean;
	attemptedBestSelection: boolean;
	switched: boolean;
	activeIndex: number | null;
	reason: string;
}

export interface StartupPreflightDeps {
	applyStorageScope?: () => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
	hasUsableAccessToken: (
		account: { accessToken?: string; expiresAt?: number },
		now: number,
	) => boolean;
	queuedRefresh: (refreshToken: string) => Promise<TokenResult>;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	extractAccountId: (accessToken: string | undefined) => string | undefined;
	extractAccountEmail: (
		accessToken: string | undefined,
		idToken: string | undefined,
	) => string | undefined;
	sanitizeEmail: (email: string | undefined) => string | undefined;
	applyTokenAccountIdentity: (
		account: {
			accountId?: string;
			accountIdSource?: AccountIdSource;
		},
		tokenAccountId: string | undefined,
	) => boolean;
	fetchCodexQuotaSnapshot: (input: {
		accountId: string;
		accessToken: string;
		model: string;
	}) => Promise<CodexQuotaSnapshot>;
	selectBestAccount: (params: {
		model: string;
		currentIndex: number;
	}) => Promise<{ ok: boolean; switched: boolean }>;
	getNow?: () => number;
}

export async function runStartupAccountPreflight(
	model: string | undefined,
	deps: StartupPreflightDeps,
): Promise<StartupPreflightResult> {
	deps.applyStorageScope?.();
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		return {
			currentHealthy: false,
			attemptedBestSelection: false,
			switched: false,
			activeIndex: null,
			reason: "no-accounts",
		};
	}

	const now = deps.getNow?.() ?? Date.now();
	const probeModel = resolveNormalizedModel(model?.trim() || "gpt-5-codex");
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	const currentAccount = storage.accounts[activeIndex];
	if (!currentAccount) {
		return {
			currentHealthy: false,
			attemptedBestSelection: false,
			switched: false,
			activeIndex: null,
			reason: "missing-current-account",
		};
	}

	const attemptBestSelection = async (
		reason: string,
	): Promise<StartupPreflightResult> => {
		const selection = await deps.selectBestAccount({
			model: probeModel,
			currentIndex: activeIndex,
		});
		return {
			currentHealthy: false,
			attemptedBestSelection: true,
			switched: selection.ok && selection.switched,
			activeIndex,
			reason,
		};
	};

	if (currentAccount.enabled === false) {
		return attemptBestSelection("current-disabled");
	}

	let changed = false;
	let accessToken = currentAccount.accessToken;
	let accountId = currentAccount.accountId ?? deps.extractAccountId(accessToken);
	let refreshFailure: TokenFailure | undefined;

	if (!deps.hasUsableAccessToken(currentAccount, now)) {
		const refreshResult = await deps.queuedRefresh(currentAccount.refreshToken);
		if (refreshResult.type !== "success") {
			refreshFailure = {
				...refreshResult,
				message: deps.normalizeFailureDetail(
					refreshResult.message,
					refreshResult.reason,
				),
			};
		} else {
			const refreshedEmail = deps.sanitizeEmail(
				deps.extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
			const tokenAccountId = deps.extractAccountId(refreshResult.access);
			if (currentAccount.refreshToken !== refreshResult.refresh) {
				currentAccount.refreshToken = refreshResult.refresh;
				changed = true;
			}
			if (currentAccount.accessToken !== refreshResult.access) {
				currentAccount.accessToken = refreshResult.access;
				changed = true;
			}
			if (currentAccount.expiresAt !== refreshResult.expires) {
				currentAccount.expiresAt = refreshResult.expires;
				changed = true;
			}
			if (refreshedEmail && refreshedEmail !== currentAccount.email) {
				currentAccount.email = refreshedEmail;
				changed = true;
			}
			if (deps.applyTokenAccountIdentity(currentAccount, tokenAccountId)) {
				changed = true;
			}
			accessToken = currentAccount.accessToken;
			accountId = currentAccount.accountId ?? tokenAccountId;
		}
	}

	if (changed) {
		await deps.saveAccounts(storage);
	}

	if (refreshFailure) {
		return attemptBestSelection("current-refresh-failed");
	}

	if (!accessToken || !accountId) {
		return attemptBestSelection("current-missing-probe-identity");
	}

	let liveQuota: CodexQuotaSnapshot;
	try {
		liveQuota = await deps.fetchCodexQuotaSnapshot({
			accountId,
			accessToken,
			model: probeModel,
		});
	} catch {
		return attemptBestSelection("current-live-probe-failed");
	}

	const currentForecast = evaluateForecastAccount({
		index: activeIndex,
		account: currentAccount,
		isCurrent: true,
		now,
		liveQuota,
	});
	const currentHealthy =
		!currentForecast.disabled &&
		!currentForecast.hardFailure &&
		currentForecast.availability === "ready" &&
		currentForecast.riskLevel !== "high";

	if (currentHealthy) {
		return {
			currentHealthy: true,
			attemptedBestSelection: false,
			switched: false,
			activeIndex,
			reason: "current-ready",
		};
	}

	return attemptBestSelection(
		`current-${currentForecast.availability}-${currentForecast.riskLevel}`,
	);
}
