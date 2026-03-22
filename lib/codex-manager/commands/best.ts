import type { ForecastAccountResult } from "../../forecast.js";
import type { CodexQuotaSnapshot } from "../../quota-probe.js";
import { resolveNormalizedModel } from "../../request/helpers/model-map.js";
import type { AccountStorageV3 } from "../../storage.js";
import type { TokenFailure, TokenResult } from "../../types.js";

export interface BestCliOptions {
	live: boolean;
	json: boolean;
	model: string;
	modelProvided: boolean;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

export interface BestCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	parseBestArgs: (args: string[]) => ParsedArgsResult<BestCliOptions>;
	printBestUsage: () => void;
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
	formatAccountLabel: (
		account: { email?: string; accountLabel?: string; accountId?: string },
		index: number,
	) => string;
	fetchCodexQuotaSnapshot: (input: {
		accountId: string;
		accessToken: string;
		model: string;
	}) => Promise<CodexQuotaSnapshot>;
	evaluateForecastAccounts: (
		inputs: Array<{
			index: number;
			account: AccountStorageV3["accounts"][number];
			isCurrent: boolean;
			now: number;
			refreshFailure?: TokenFailure;
			liveQuota?: CodexQuotaSnapshot;
		}>,
	) => ForecastAccountResult[];
	recommendForecastAccount: (results: ForecastAccountResult[]) => {
		recommendedIndex: number | null;
		reason: string;
	};
	persistAndSyncSelectedAccount: (params: {
		storage: AccountStorageV3;
		targetIndex: number;
		parsed: number;
		switchReason: "best";
		initialSyncIdToken?: string;
	}) => Promise<{ synced: boolean; wasDisabled: boolean }>;
	setCodexCliActiveSelection: (params: {
		accountId?: string;
		email?: string;
		accessToken?: string;
		refreshToken: string;
		expiresAt?: number;
		idToken?: string;
	}) => Promise<boolean>;
	logInfo?: (message: string) => void;
	logWarn?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

export async function runBestCommand(
	args: string[],
	deps: BestCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logWarn = deps.logWarn ?? console.warn;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		deps.printBestUsage();
		return 0;
	}

	const parsedArgs = deps.parseBestArgs(args);
	if (!parsedArgs.ok) {
		logError(parsedArgs.message);
		deps.printBestUsage();
		return 1;
	}
	const options = parsedArgs.options;
	const probeModel = resolveNormalizedModel(
		options.model?.trim() || "gpt-5-codex",
	);
	if (options.modelProvided && !options.live) {
		logError("--model requires --live for codex auth best");
		deps.printBestUsage();
		return 1;
	}

	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		if (options.json) {
			logInfo(JSON.stringify({ error: "No accounts configured." }, null, 2));
		} else {
			logInfo("No accounts configured.");
		}
		return 1;
	}

	const now = deps.getNow?.() ?? Date.now();
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, CodexQuotaSnapshot>();
	const probeIdTokenByIndex = new Map<number, string>();
	const probeRefreshedIndices = new Set<number>();
	const probeErrors: string[] = [];
	let changed = false;
	const persistProbeChangesIfNeeded = async (
		beforeSave?: () => void,
	): Promise<void> => {
		if (!changed) return;
		beforeSave?.();
		await deps.saveAccounts(storage);
		changed = false;
	};

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account || !options.live || account.enabled === false) continue;

		let probeAccessToken = account.accessToken;
		let probeAccountId =
			account.accountId ?? deps.extractAccountId(account.accessToken);
		if (!deps.hasUsableAccessToken(account, now)) {
			const refreshResult = await deps.queuedRefresh(account.refreshToken);
			if (refreshResult.type !== "success") {
				refreshFailures.set(i, {
					...refreshResult,
					message: deps.normalizeFailureDetail(
						refreshResult.message,
						refreshResult.reason,
					),
				});
				continue;
			}

			const refreshedEmail = deps.sanitizeEmail(
				deps.extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
			const refreshedAccountId = deps.extractAccountId(refreshResult.access);
			const previousRefreshToken = account.refreshToken;
			const previousAccessToken = account.accessToken;
			const previousExpiresAt = account.expiresAt;
			const previousEmail = account.email;
			const previousAccountId = account.accountId;
			const previousAccountIdSource = account.accountIdSource;
			account.refreshToken = refreshResult.refresh;
			account.accessToken = refreshResult.access;
			account.expiresAt = refreshResult.expires;
			if (refreshedEmail) account.email = refreshedEmail;
			if (refreshedAccountId) {
				account.accountId = refreshedAccountId;
				account.accountIdSource = "token";
			}
			changed =
				changed ||
				previousRefreshToken !== account.refreshToken ||
				previousAccessToken !== account.accessToken ||
				previousExpiresAt !== account.expiresAt ||
				previousEmail !== account.email ||
				previousAccountId !== account.accountId ||
				previousAccountIdSource !== account.accountIdSource;
			if (refreshResult.idToken)
				probeIdTokenByIndex.set(i, refreshResult.idToken);
			probeRefreshedIndices.add(i);

			probeAccessToken = account.accessToken;
			probeAccountId = account.accountId ?? refreshedAccountId;
		}

		if (!probeAccessToken || !probeAccountId) {
			probeErrors.push(
				`${deps.formatAccountLabel(account, i)}: missing accountId for live probe`,
			);
			continue;
		}

		try {
			const liveQuota = await deps.fetchCodexQuotaSnapshot({
				accountId: probeAccountId,
				accessToken: probeAccessToken,
				model: probeModel,
			});
			liveQuotaByIndex.set(i, liveQuota);
		} catch (error) {
			const message = deps.normalizeFailureDetail(
				error instanceof Error ? error.message : String(error),
				undefined,
			);
			probeErrors.push(`${deps.formatAccountLabel(account, i)}: ${message}`);
		}
	}

	const forecastInputs = storage.accounts.map((account, index) => ({
		index,
		account,
		isCurrent: index === deps.resolveActiveIndex(storage, "codex"),
		now,
		refreshFailure: refreshFailures.get(index),
		liveQuota: liveQuotaByIndex.get(index),
	}));
	const forecastResults = deps.evaluateForecastAccounts(forecastInputs);
	const recommendation = deps.recommendForecastAccount(forecastResults);

	const printProbeNotes = (): void => {
		if (probeErrors.length === 0) return;
		logInfo(`Live check notes (${probeErrors.length}):`);
		for (const error of probeErrors) logInfo(`  - ${error}`);
	};

	if (recommendation.recommendedIndex === null) {
		await persistProbeChangesIfNeeded();
		if (options.json) {
			logInfo(
				JSON.stringify(
					{
						error: recommendation.reason,
						...(probeErrors.length > 0 ? { probeErrors } : {}),
					},
					null,
					2,
				),
			);
		} else {
			logInfo(`No best account available: ${recommendation.reason}`);
			printProbeNotes();
		}
		return 1;
	}

	const bestIndex = recommendation.recommendedIndex;
	const bestAccount = storage.accounts[bestIndex];
	if (!bestAccount) {
		await persistProbeChangesIfNeeded();
		if (options.json) {
			logInfo(JSON.stringify({ error: "Best account not found." }, null, 2));
		} else {
			logInfo("Best account not found.");
		}
		return 1;
	}

	const currentIndex = deps.resolveActiveIndex(storage, "codex");
	if (currentIndex === bestIndex) {
		const shouldSyncCurrentBest =
			probeRefreshedIndices.has(bestIndex) ||
			probeIdTokenByIndex.has(bestIndex);
		let alreadyBestSynced: boolean | undefined;
		await persistProbeChangesIfNeeded(() => {
			bestAccount.lastUsed = now;
		});
		if (shouldSyncCurrentBest) {
			alreadyBestSynced = await deps.setCodexCliActiveSelection({
				accountId: bestAccount.accountId,
				email: bestAccount.email,
				accessToken: bestAccount.accessToken,
				refreshToken: bestAccount.refreshToken,
				expiresAt: bestAccount.expiresAt,
				...(probeIdTokenByIndex.has(bestIndex)
					? { idToken: probeIdTokenByIndex.get(bestIndex) }
					: {}),
			});
			if (!alreadyBestSynced && !options.json) {
				logWarn(
					"Codex auth sync did not complete. Multi-auth routing will still use this account.",
				);
			}
		}
		if (options.json) {
			logInfo(
				JSON.stringify(
					{
						message: `Already on best account: ${deps.formatAccountLabel(bestAccount, bestIndex)}`,
						accountIndex: bestIndex + 1,
						reason: recommendation.reason,
						...(alreadyBestSynced !== undefined
							? { synced: alreadyBestSynced }
							: {}),
						...(probeErrors.length > 0 ? { probeErrors } : {}),
					},
					null,
					2,
				),
			);
		} else {
			logInfo(
				`Already on best account ${bestIndex + 1}: ${deps.formatAccountLabel(bestAccount, bestIndex)}`,
			);
			logInfo(`Reason: ${recommendation.reason}`);
			printProbeNotes();
		}
		return 0;
	}

	const parsed = bestIndex + 1;
	const { synced, wasDisabled } = await deps.persistAndSyncSelectedAccount({
		storage,
		targetIndex: bestIndex,
		parsed,
		switchReason: "best",
		initialSyncIdToken: probeIdTokenByIndex.get(bestIndex),
	});

	if (options.json) {
		logInfo(
			JSON.stringify(
				{
					message: `Switched to best account: ${deps.formatAccountLabel(bestAccount, bestIndex)}`,
					accountIndex: parsed,
					reason: recommendation.reason,
					synced,
					wasDisabled,
					...(probeErrors.length > 0 ? { probeErrors } : {}),
				},
				null,
				2,
			),
		);
	} else {
		logInfo(
			`Switched to best account ${parsed}: ${deps.formatAccountLabel(bestAccount, bestIndex)}${wasDisabled ? " (re-enabled)" : ""}`,
		);
		logInfo(`Reason: ${recommendation.reason}`);
		printProbeNotes();
		if (!synced) {
			logWarn(
				"Codex auth sync did not complete. Multi-auth routing will still use this account.",
			);
		}
	}
	return 0;
}
