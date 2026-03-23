import { existsSync, promises as fs } from "node:fs";
import type { ForecastAccountResult } from "../../forecast.js";
import type { AccountStorageV3 } from "../../storage.js";
import type { TokenResult } from "../../types.js";

export type DoctorSeverity = "ok" | "warn" | "error";

export interface DoctorCheck {
	key: string;
	severity: DoctorSeverity;
	message: string;
	details?: string;
}

export interface DoctorFixAction {
	key: string;
	message: string;
}

export interface DoctorCliOptions {
	json: boolean;
	fix: boolean;
	dryRun: boolean;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

export interface DoctorCommandDeps {
	setStoragePath: (path: string | null) => void;
	getStoragePath: () => string;
	getCodexCliAuthPath: () => string;
	getCodexCliConfigPath: () => string;
	loadCodexCliState: (options: { forceRefresh: boolean }) => Promise<{
		activeEmail?: string;
		activeAccountId?: string;
		path?: string;
	} | null>;
	parseDoctorArgs: (args: string[]) => ParsedArgsResult<DoctorCliOptions>;
	printDoctorUsage: () => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	applyDoctorFixes: (storage: AccountStorageV3) => {
		changed: boolean;
		actions: DoctorFixAction[];
	};
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
	evaluateForecastAccounts: (
		inputs: Array<{
			index: number;
			account: AccountStorageV3["accounts"][number];
			isCurrent: boolean;
			now: number;
		}>,
	) => ForecastAccountResult[];
	recommendForecastAccount: (results: ForecastAccountResult[]) => {
		recommendedIndex: number | null;
		reason: string;
	};
	sanitizeEmail: (email: string | undefined) => string | undefined;
	extractAccountEmail: (
		accessToken: string | undefined,
		idToken?: string | undefined,
	) => string | undefined;
	extractAccountId: (accessToken: string | undefined) => string | undefined;
	hasPlaceholderEmail: (value: string | undefined) => boolean;
	hasLikelyInvalidRefreshToken: (refreshToken: string) => boolean;
	getDoctorRefreshTokenKey: (refreshToken: unknown) => string | undefined;
	hasUsableAccessToken: (
		account: { accessToken?: string; expiresAt?: number },
		now: number,
	) => boolean;
	queuedRefresh: (refreshToken: string) => Promise<TokenResult>;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	applyTokenAccountIdentity: (
		account: AccountStorageV3["accounts"][number],
		accountId: string | undefined,
	) => boolean;
	setCodexCliActiveSelection: (params: {
		accountId?: string;
		email?: string;
		accessToken?: string;
		refreshToken: string;
		expiresAt?: number;
		idToken?: string;
	}) => Promise<boolean>;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

export async function runDoctorCommand(
	args: string[],
	deps: DoctorCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		deps.printDoctorUsage();
		return 0;
	}
	const parsedArgs = deps.parseDoctorArgs(args);
	if (!parsedArgs.ok) {
		logError(parsedArgs.message);
		deps.printDoctorUsage();
		return 1;
	}
	const options = parsedArgs.options;

	deps.setStoragePath(null);
	const storagePath = deps.getStoragePath();
	const checks: DoctorCheck[] = [];
	const addCheck = (check: DoctorCheck): void => {
		checks.push(check);
	};

	addCheck({
		key: "storage-file",
		severity: existsSync(storagePath) ? "ok" : "warn",
		message: existsSync(storagePath)
			? "Account storage file found"
			: "Account storage file does not exist yet (first login pending)",
		details: storagePath,
	});

	if (existsSync(storagePath)) {
		try {
			const stat = await fs.stat(storagePath);
			addCheck({
				key: "storage-readable",
				severity: stat.size > 0 ? "ok" : "warn",
				message:
					stat.size > 0 ? "Storage file is readable" : "Storage file is empty",
				details: `${stat.size} bytes`,
			});
		} catch (error) {
			addCheck({
				key: "storage-readable",
				severity: "error",
				message: "Unable to read storage file metadata",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const codexAuthPath = deps.getCodexCliAuthPath();
	const codexConfigPath = deps.getCodexCliConfigPath();
	let codexAuthEmail: string | undefined;
	let codexAuthAccountId: string | undefined;

	addCheck({
		key: "codex-auth-file",
		severity: existsSync(codexAuthPath) ? "ok" : "warn",
		message: existsSync(codexAuthPath)
			? "Codex auth file found"
			: "Codex auth file does not exist",
		details: codexAuthPath,
	});
	if (existsSync(codexAuthPath)) {
		try {
			const raw = await fs.readFile(codexAuthPath, "utf-8");
			const parsedUnknown = JSON.parse(raw) as unknown;
			if (!parsedUnknown || typeof parsedUnknown !== "object") {
				addCheck({
					key: "codex-auth-readable",
					severity: "error",
					message: "Codex auth file contains invalid JSON shape",
					details: codexAuthPath,
				});
			} else {
				const parsed = parsedUnknown as Record<string, unknown>;
				const tokens =
					parsed.tokens && typeof parsed.tokens === "object"
						? (parsed.tokens as Record<string, unknown>)
						: null;
				const accessToken =
					tokens && typeof tokens.access_token === "string"
						? tokens.access_token
						: undefined;
				const idToken =
					tokens && typeof tokens.id_token === "string"
						? tokens.id_token
						: undefined;
				const accountIdFromFile =
					tokens && typeof tokens.account_id === "string"
						? tokens.account_id
						: undefined;
				const emailFromFile =
					typeof parsed.email === "string" ? parsed.email : undefined;
				codexAuthEmail = deps.sanitizeEmail(
					emailFromFile ?? deps.extractAccountEmail(accessToken, idToken),
				);
				codexAuthAccountId =
					accountIdFromFile ?? deps.extractAccountId(accessToken);
				addCheck({
					key: "codex-auth-readable",
					severity: "ok",
					message: "Codex auth file is readable",
					details:
						codexAuthEmail || codexAuthAccountId
							? `email=${codexAuthEmail ?? "unknown"}, accountId=${codexAuthAccountId ?? "unknown"}`
							: undefined,
				});
			}
		} catch (error) {
			addCheck({
				key: "codex-auth-readable",
				severity: "error",
				message: "Unable to read Codex auth file",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}

	addCheck({
		key: "codex-config-file",
		severity: existsSync(codexConfigPath) ? "ok" : "warn",
		message: existsSync(codexConfigPath)
			? "Codex config file found"
			: "Codex config file does not exist",
		details: codexConfigPath,
	});
	let codexAuthStoreMode: string | undefined;
	if (existsSync(codexConfigPath)) {
		try {
			const configRaw = await fs.readFile(codexConfigPath, "utf-8");
			const match = configRaw.match(
				/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/m,
			);
			if (match?.[1]) codexAuthStoreMode = match[1].trim();
		} catch (error) {
			addCheck({
				key: "codex-auth-store",
				severity: "warn",
				message: "Unable to read Codex auth-store config",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (!checks.some((check) => check.key === "codex-auth-store")) {
		addCheck({
			key: "codex-auth-store",
			severity: codexAuthStoreMode === "file" ? "ok" : "warn",
			message:
				codexAuthStoreMode === "file"
					? "Codex auth storage is set to file"
					: "Codex auth storage is not explicitly set to file",
			details: codexAuthStoreMode ? `mode=${codexAuthStoreMode}` : "mode=unset",
		});
	}

	const codexCliState = await deps.loadCodexCliState({ forceRefresh: true });
	addCheck({
		key: "codex-cli-state",
		severity: codexCliState ? "ok" : "warn",
		message: codexCliState
			? "Codex CLI state loaded"
			: "Codex CLI state unavailable",
		details: codexCliState?.path,
	});

	const storage = await deps.loadAccounts();
	let fixChanged = false;
	let fixActions: DoctorFixAction[] = [];
	let storageNeedsSave = false;
	if (options.fix && storage && storage.accounts.length > 0) {
		const fixed = deps.applyDoctorFixes(storage);
		fixChanged = fixed.changed;
		fixActions = fixed.actions;
		storageNeedsSave = fixed.changed;
	}

	if (!storage || storage.accounts.length === 0) {
		addCheck({
			key: "accounts",
			severity: "warn",
			message: "No accounts configured",
		});
	} else {
		addCheck({
			key: "accounts",
			severity: "ok",
			message: `Loaded ${storage.accounts.length} account(s)`,
		});
		const activeIndex = deps.resolveActiveIndex(storage, "codex");
		const activeExists =
			activeIndex >= 0 && activeIndex < storage.accounts.length;
		addCheck({
			key: "active-index",
			severity: activeExists ? "ok" : "error",
			message: activeExists
				? `Active index is valid (${activeIndex + 1})`
				: "Active index is out of range",
		});
		const disabledCount = storage.accounts.filter(
			(a) => a.enabled === false,
		).length;
		addCheck({
			key: "enabled-accounts",
			severity: disabledCount >= storage.accounts.length ? "error" : "ok",
			message:
				disabledCount >= storage.accounts.length
					? "All accounts are disabled"
					: `${storage.accounts.length - disabledCount} enabled / ${disabledCount} disabled`,
		});

		const seenRefreshTokens = new Set<string>();
		let duplicateTokenCount = 0;
		const seenEmails = new Set<string>();
		let duplicateEmailCount = 0;
		let placeholderEmailCount = 0;
		let likelyInvalidRefreshTokenCount = 0;
		for (const account of storage.accounts) {
			const token = deps.getDoctorRefreshTokenKey(account.refreshToken);
			if (token) {
				if (seenRefreshTokens.has(token)) duplicateTokenCount += 1;
				seenRefreshTokens.add(token);
			}
			const email = deps.sanitizeEmail(account.email);
			if (email) {
				if (seenEmails.has(email)) duplicateEmailCount += 1;
				seenEmails.add(email);
				if (deps.hasPlaceholderEmail(email)) placeholderEmailCount += 1;
			}
			if (deps.hasLikelyInvalidRefreshToken(account.refreshToken))
				likelyInvalidRefreshTokenCount += 1;
		}
		addCheck({
			key: "duplicate-refresh-token",
			severity: duplicateTokenCount > 0 ? "warn" : "ok",
			message:
				duplicateTokenCount > 0
					? `Detected ${duplicateTokenCount} duplicate refresh token entr${duplicateTokenCount === 1 ? "y" : "ies"}`
					: "No duplicate refresh tokens detected",
		});
		addCheck({
			key: "duplicate-email",
			severity: duplicateEmailCount > 0 ? "warn" : "ok",
			message:
				duplicateEmailCount > 0
					? `Detected ${duplicateEmailCount} duplicate email entr${duplicateEmailCount === 1 ? "y" : "ies"}`
					: "No duplicate emails detected",
		});
		addCheck({
			key: "placeholder-email",
			severity: placeholderEmailCount > 0 ? "warn" : "ok",
			message:
				placeholderEmailCount > 0
					? `${placeholderEmailCount} account(s) appear to be placeholder/demo entries`
					: "No placeholder emails detected",
		});
		addCheck({
			key: "refresh-token-shape",
			severity: likelyInvalidRefreshTokenCount > 0 ? "warn" : "ok",
			message:
				likelyInvalidRefreshTokenCount > 0
					? `${likelyInvalidRefreshTokenCount} account(s) have likely invalid refresh token format`
					: "Refresh token format looks normal",
		});

		const now = deps.getNow?.() ?? Date.now();
		const forecastResults = deps.evaluateForecastAccounts(
			storage.accounts.map((account, index) => ({
				index,
				account,
				isCurrent: index === activeIndex,
				now,
			})),
		);
		const recommendation = deps.recommendForecastAccount(forecastResults);
		addCheck({
			key: "recommended-switch",
			severity:
				recommendation.recommendedIndex !== null &&
				recommendation.recommendedIndex !== activeIndex
					? "warn"
					: "ok",
			message:
				recommendation.recommendedIndex !== null &&
				recommendation.recommendedIndex !== activeIndex
					? `A healthier account is available: switch to ${recommendation.recommendedIndex + 1}`
					: "Current account aligns with forecast recommendation",
			details:
				recommendation.recommendedIndex !== null &&
				recommendation.recommendedIndex !== activeIndex
					? recommendation.reason
					: undefined,
		});

		if (activeExists) {
			const activeAccount = storage.accounts[activeIndex];
			const managerActiveEmail = deps.sanitizeEmail(activeAccount?.email);
			const managerActiveAccountId = activeAccount?.accountId;
			const codexActiveEmail =
				deps.sanitizeEmail(codexCliState?.activeEmail) ?? codexAuthEmail;
			const codexActiveAccountId =
				codexCliState?.activeAccountId ?? codexAuthAccountId;
			const isEmailMismatch =
				!!managerActiveEmail &&
				!!codexActiveEmail &&
				managerActiveEmail !== codexActiveEmail;
			const isAccountIdMismatch =
				!!managerActiveAccountId &&
				!!codexActiveAccountId &&
				managerActiveAccountId !== codexActiveAccountId;
			addCheck({
				key: "active-selection-sync",
				severity: isEmailMismatch || isAccountIdMismatch ? "warn" : "ok",
				message:
					isEmailMismatch || isAccountIdMismatch
						? "Manager active account and Codex active account are not aligned"
						: "Manager active account and Codex active account are aligned",
				details: `manager=${managerActiveEmail ?? managerActiveAccountId ?? "unknown"} | codex=${codexActiveEmail ?? codexActiveAccountId ?? "unknown"}`,
			});

			if (options.fix && activeAccount) {
				let syncAccessToken = activeAccount.accessToken;
				let syncRefreshToken = activeAccount.refreshToken;
				let syncExpiresAt = activeAccount.expiresAt;
				let syncIdToken: string | undefined;

				if (!deps.hasUsableAccessToken(activeAccount, now)) {
					if (options.dryRun) {
						fixChanged = true;
						fixActions.push({
							key: "doctor-refresh",
							message: `Prepared active-account token refresh for account ${activeIndex + 1} (dry-run)`,
						});
					} else {
						const refreshResult = await deps.queuedRefresh(activeAccount.refreshToken);
						if (refreshResult.type === "success") {
							const refreshedEmail = deps.sanitizeEmail(
								deps.extractAccountEmail(refreshResult.access, refreshResult.idToken),
							);
							const refreshedAccountId = deps.extractAccountId(refreshResult.access);
							activeAccount.accessToken = refreshResult.access;
							activeAccount.refreshToken = refreshResult.refresh;
							activeAccount.expiresAt = refreshResult.expires;
							if (refreshedEmail) activeAccount.email = refreshedEmail;
							deps.applyTokenAccountIdentity(activeAccount, refreshedAccountId);
							syncAccessToken = refreshResult.access;
							syncRefreshToken = refreshResult.refresh;
							syncExpiresAt = refreshResult.expires;
							syncIdToken = refreshResult.idToken;
							storageNeedsSave = true;
							fixChanged = true;
							fixActions.push({
								key: "doctor-refresh",
								message: `Refreshed active account tokens for account ${activeIndex + 1}`,
							});
						} else {
							addCheck({
								key: "doctor-refresh",
								severity: "warn",
								message: "Unable to refresh active account before Codex sync",
								details: deps.normalizeFailureDetail(
									refreshResult.message,
									refreshResult.reason,
								),
							});
						}
					}
				}

				if (!options.dryRun) {
					const synced = await deps.setCodexCliActiveSelection({
						accountId: activeAccount.accountId,
						email: activeAccount.email,
						accessToken: syncAccessToken,
						refreshToken: syncRefreshToken,
						expiresAt: syncExpiresAt,
						...(syncIdToken ? { idToken: syncIdToken } : {}),
					});
					if (synced) {
						fixChanged = true;
						fixActions.push({
							key: "codex-active-sync",
							message: "Synced manager active account into Codex auth state",
						});
					} else {
						addCheck({
							key: "codex-active-sync",
							severity: "warn",
							message: "Failed to sync manager active account into Codex auth state",
						});
					}
				} else {
					fixChanged = true;
					fixActions.push({
						key: "codex-active-sync",
						message: "Prepared Codex active-account sync (dry-run)",
					});
				}
			}
		}
	}

	if (options.fix) {
		addCheck({
			key: "auto-fix",
			severity: fixChanged ? "warn" : "ok",
			message: fixChanged
				? options.dryRun
					? `Prepared ${fixActions.length} fix(es) (dry-run)`
					: `Applied ${fixActions.length} fix(es)`
				: "No safe auto-fixes needed",
		});
	}

	if (storageNeedsSave && !options.dryRun && storage) {
		await deps.saveAccounts(storage);
	}

	const summary = checks.reduce(
		(acc, check) => {
			acc[check.severity] += 1;
			return acc;
		},
		{ ok: 0, warn: 0, error: 0 },
	);
	if (options.json) {
		logInfo(
			JSON.stringify(
				{
					command: "doctor",
					storagePath,
					summary,
					checks,
					fix: {
						enabled: options.fix,
						dryRun: options.dryRun,
						changed: fixChanged,
						actions: fixActions,
					},
				},
				null,
				2,
			),
		);
		return summary.error > 0 ? 1 : 0;
	}
	logInfo("Doctor diagnostics");
	logInfo(`Storage: ${storagePath}`);
	logInfo(
		`Summary: ${summary.ok} ok, ${summary.warn} warnings, ${summary.error} errors`,
	);
	logInfo("");
	for (const check of checks) {
		const marker =
			check.severity === "ok" ? "✓" : check.severity === "warn" ? "!" : "✗";
		logInfo(`${marker} ${check.key}: ${check.message}`);
		if (check.details) logInfo(`  ${check.details}`);
	}
	if (options.fix) {
		logInfo("");
		if (fixActions.length > 0) {
			logInfo(`Auto-fix actions (${options.dryRun ? "dry-run" : "applied"}):`);
			for (const action of fixActions) logInfo(`  - ${action.message}`);
		} else {
			logInfo("Auto-fix actions: none");
		}
	}
	return summary.error > 0 ? 1 : 0;
}
