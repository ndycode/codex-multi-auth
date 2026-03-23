import type {
	AccountStorageV3,
	FlaggedAccountMetadataV1,
} from "../../storage.js";
import type { TokenResult } from "../../types.js";

export interface VerifyFlaggedCliOptions {
	dryRun: boolean;
	json: boolean;
	restore: boolean;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

export interface VerifyFlaggedReport {
	index: number;
	label: string;
	outcome: "restored" | "healthy-flagged" | "still-flagged" | "restore-skipped";
	message: string;
}

export interface VerifyFlaggedCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadFlaggedAccounts: () => Promise<{
		version: 1;
		accounts: FlaggedAccountMetadataV1[];
	}>;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	queuedRefresh: (refreshToken: string) => Promise<TokenResult>;
	parseVerifyFlaggedArgs: (
		args: string[],
	) => ParsedArgsResult<VerifyFlaggedCliOptions>;
	printVerifyFlaggedUsage: () => void;
	createEmptyAccountStorage: () => AccountStorageV3;
	upsertRecoveredFlaggedAccount: (
		storage: AccountStorageV3,
		flagged: FlaggedAccountMetadataV1,
		refreshResult: Extract<TokenResult, { type: "success" }>,
		now: number,
	) => { restored: boolean; changed: boolean; message: string };
	resolveStoredAccountIdentity: (
		accountId: string | undefined,
		accountIdSource: FlaggedAccountMetadataV1["accountIdSource"],
		tokenAccountId: string | undefined,
	) => {
		accountId?: string;
		accountIdSource?: FlaggedAccountMetadataV1["accountIdSource"];
	};
	extractAccountId: (accessToken: string | undefined) => string | undefined;
	extractAccountEmail: (
		accessToken: string | undefined,
		idToken: string | undefined,
	) => string | undefined;
	sanitizeEmail: (email: string | undefined) => string | undefined;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	withAccountAndFlaggedStorageTransaction: (
		callback: (
			loadedStorage: AccountStorageV3 | null,
			persist: (
				nextStorage: AccountStorageV3,
				nextFlagged: { version: 1; accounts: FlaggedAccountMetadataV1[] },
			) => Promise<void>,
		) => Promise<void>,
	) => Promise<void>;
	normalizeDoctorIndexes: (storage: AccountStorageV3) => void;
	saveFlaggedAccounts: (data: {
		version: 1;
		accounts: FlaggedAccountMetadataV1[];
	}) => Promise<void>;
	formatAccountLabel: (
		account: Pick<
			FlaggedAccountMetadataV1,
			"email" | "accountLabel" | "accountId"
		>,
		index: number,
	) => string;
	stylePromptText: (
		text: string,
		tone: "accent" | "success" | "warning" | "danger" | "muted",
	) => string;
	styleAccountDetailText: (
		detail: string,
		fallbackTone?: "accent" | "success" | "warning" | "danger" | "muted",
	) => string;
	formatResultSummary: (
		segments: ReadonlyArray<{
			text: string;
			tone: "accent" | "success" | "warning" | "danger" | "muted";
		}>,
	) => string;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

export async function runVerifyFlaggedCommand(
	args: string[],
	deps: VerifyFlaggedCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		deps.printVerifyFlaggedUsage();
		return 0;
	}

	const parsedArgs = deps.parseVerifyFlaggedArgs(args);
	if (!parsedArgs.ok) {
		logError(parsedArgs.message);
		deps.printVerifyFlaggedUsage();
		return 1;
	}
	const options = parsedArgs.options;

	deps.setStoragePath(null);
	const flaggedStorage = await deps.loadFlaggedAccounts();
	if (flaggedStorage.accounts.length === 0) {
		if (options.json) {
			logInfo(
				JSON.stringify(
					{
						command: "verify-flagged",
						total: 0,
						restored: 0,
						healthyFlagged: 0,
						stillFlagged: 0,
						changed: false,
						dryRun: options.dryRun,
						restore: options.restore,
						reports: [] as VerifyFlaggedReport[],
					},
					null,
					2,
				),
			);
			return 0;
		}
		logInfo("No flagged accounts to check.");
		return 0;
	}

	let storageChanged = false;
	let flaggedChanged = false;
	const reports: VerifyFlaggedReport[] = [];
	const nextFlaggedAccounts: FlaggedAccountMetadataV1[] = [];
	const now = deps.getNow?.() ?? Date.now();
	const refreshChecks: Array<{
		index: number;
		flagged: FlaggedAccountMetadataV1;
		label: string;
		result: TokenResult;
	}> = [];

	for (let i = 0; i < flaggedStorage.accounts.length; i += 1) {
		const flagged = flaggedStorage.accounts[i];
		if (!flagged) continue;
		const label = deps.formatAccountLabel(flagged, i);
		refreshChecks.push({
			index: i,
			flagged,
			label,
			result: await deps.queuedRefresh(flagged.refreshToken),
		});
	}

	const applyRefreshChecks = (
		storage: AccountStorageV3,
	): {
		storageChanged: boolean;
		flaggedChanged: boolean;
		reports: VerifyFlaggedReport[];
		nextFlaggedAccounts: FlaggedAccountMetadataV1[];
	} => {
		let nextStorageChanged = false;
		let nextFlaggedChanged = false;
		const nextReports: VerifyFlaggedReport[] = [];
		const pendingFlaggedAccounts: FlaggedAccountMetadataV1[] = [];
		for (const check of refreshChecks) {
			const { index: i, flagged, label, result } = check;
			if (result.type === "success") {
				if (!options.restore) {
					const tokenAccountId = deps.extractAccountId(result.access);
					const nextIdentity = deps.resolveStoredAccountIdentity(
						flagged.accountId,
						flagged.accountIdSource,
						tokenAccountId,
					);
					const nextFlagged: FlaggedAccountMetadataV1 = {
						...flagged,
						refreshToken: result.refresh,
						accessToken: result.access,
						expiresAt: result.expires,
						accountId: nextIdentity.accountId,
						accountIdSource: nextIdentity.accountIdSource,
						email:
							deps.sanitizeEmail(
								deps.extractAccountEmail(result.access, result.idToken),
							) ?? flagged.email,
						lastUsed: now,
						lastError: undefined,
					};
					pendingFlaggedAccounts.push(nextFlagged);
					if (JSON.stringify(nextFlagged) !== JSON.stringify(flagged))
						nextFlaggedChanged = true;
					nextReports.push({
						index: i,
						label,
						outcome: "healthy-flagged",
						message:
							"session is healthy (left in flagged list due to --no-restore)",
					});
					continue;
				}

				const upsertResult = deps.upsertRecoveredFlaggedAccount(
					storage,
					flagged,
					result,
					now,
				);
				if (upsertResult.restored) {
					nextStorageChanged = nextStorageChanged || upsertResult.changed;
					nextFlaggedChanged = true;
					nextReports.push({
						index: i,
						label,
						outcome: "restored",
						message: upsertResult.message,
					});
					continue;
				}

				const tokenAccountId = deps.extractAccountId(result.access);
				const nextIdentity = deps.resolveStoredAccountIdentity(
					flagged.accountId,
					flagged.accountIdSource,
					tokenAccountId,
				);
				const updatedFlagged: FlaggedAccountMetadataV1 = {
					...flagged,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					accountId: nextIdentity.accountId,
					accountIdSource: nextIdentity.accountIdSource,
					email:
						deps.sanitizeEmail(
							deps.extractAccountEmail(result.access, result.idToken),
						) ?? flagged.email,
					lastUsed: now,
					lastError: upsertResult.message,
				};
				pendingFlaggedAccounts.push(updatedFlagged);
				if (JSON.stringify(updatedFlagged) !== JSON.stringify(flagged))
					nextFlaggedChanged = true;
				nextReports.push({
					index: i,
					label,
					outcome: "restore-skipped",
					message: upsertResult.message,
				});
				continue;
			}

			const detail = deps.normalizeFailureDetail(result.message, result.reason);
			const failedFlagged: FlaggedAccountMetadataV1 = {
				...flagged,
				lastError: detail,
			};
			pendingFlaggedAccounts.push(failedFlagged);
			if ((flagged.lastError ?? "") !== detail) nextFlaggedChanged = true;
			nextReports.push({
				index: i,
				label,
				outcome: "still-flagged",
				message: detail,
			});
		}
		return {
			storageChanged: nextStorageChanged,
			flaggedChanged: nextFlaggedChanged,
			reports: nextReports,
			nextFlaggedAccounts: pendingFlaggedAccounts,
		};
	};

	const assignRefreshCheckResult = (result: {
		storageChanged: boolean;
		flaggedChanged: boolean;
		reports: VerifyFlaggedReport[];
		nextFlaggedAccounts: FlaggedAccountMetadataV1[];
	}): void => {
		storageChanged = result.storageChanged;
		flaggedChanged = result.flaggedChanged;
		reports.length = 0;
		reports.push(...result.reports);
		nextFlaggedAccounts.length = 0;
		nextFlaggedAccounts.push(...result.nextFlaggedAccounts);
	};

	if (options.restore) {
		if (options.dryRun) {
			assignRefreshCheckResult(
				applyRefreshChecks(
					(await deps.loadAccounts()) ?? deps.createEmptyAccountStorage(),
				),
			);
		} else {
			let transactionResult:
				| {
						storageChanged: boolean;
						flaggedChanged: boolean;
						reports: VerifyFlaggedReport[];
						nextFlaggedAccounts: FlaggedAccountMetadataV1[];
				  }
				| undefined;
			await deps.withAccountAndFlaggedStorageTransaction(
				async (loadedStorage, persist) => {
					const nextStorage = loadedStorage
						? structuredClone(loadedStorage)
						: deps.createEmptyAccountStorage();
					const attemptResult = applyRefreshChecks(nextStorage);
					if (!attemptResult.storageChanged) {
						transactionResult = attemptResult;
						return;
					}
					deps.normalizeDoctorIndexes(nextStorage);
					await persist(nextStorage, {
						version: 1,
						accounts: attemptResult.nextFlaggedAccounts,
					});
					transactionResult = attemptResult;
				},
			);
			if (!transactionResult) {
				logError(
					"verify-flagged: transaction completed without a result; storage may be unchanged",
				);
				return 1;
			}
			assignRefreshCheckResult(transactionResult);
		}
	} else {
		assignRefreshCheckResult(
			applyRefreshChecks(deps.createEmptyAccountStorage()),
		);
	}

	const remainingFlagged = nextFlaggedAccounts.length;
	const restored = reports.filter(
		(report) => report.outcome === "restored",
	).length;
	const healthyFlagged = reports.filter(
		(report) => report.outcome === "healthy-flagged",
	).length;
	const stillFlagged = reports.filter(
		(report) => report.outcome === "still-flagged",
	).length;
	const changed = storageChanged || flaggedChanged;

	if (
		!options.dryRun &&
		flaggedChanged &&
		(!options.restore || !storageChanged)
	) {
		await deps.saveFlaggedAccounts({
			version: 1,
			accounts: nextFlaggedAccounts,
		});
	}

	if (options.json) {
		logInfo(
			JSON.stringify(
				{
					command: "verify-flagged",
					total: flaggedStorage.accounts.length,
					restored,
					healthyFlagged,
					stillFlagged,
					remainingFlagged,
					changed,
					dryRun: options.dryRun,
					restore: options.restore,
					reports,
				},
				null,
				2,
			),
		);
		return 0;
	}

	logInfo(
		deps.stylePromptText(
			`Checking ${flaggedStorage.accounts.length} flagged account(s)...`,
			"accent",
		),
	);
	for (const report of reports) {
		const tone =
			report.outcome === "restored"
				? "success"
				: report.outcome === "healthy-flagged" ||
						report.outcome === "restore-skipped"
					? "warning"
					: "danger";
		const marker =
			report.outcome === "restored"
				? "✓"
				: report.outcome === "healthy-flagged" ||
						report.outcome === "restore-skipped"
					? "!"
					: "✗";
		logInfo(
			`${deps.stylePromptText(marker, tone)} ${deps.stylePromptText(`${report.index + 1}. ${report.label}`, "accent")} ${deps.stylePromptText("|", "muted")} ${deps.styleAccountDetailText(report.message, tone)}`,
		);
	}
	logInfo("");
	logInfo(
		deps.formatResultSummary([
			{
				text: `${restored} restored`,
				tone: restored > 0 ? "success" : "muted",
			},
			{
				text: `${healthyFlagged} healthy (kept flagged)`,
				tone: healthyFlagged > 0 ? "warning" : "muted",
			},
			{
				text: `${stillFlagged} still flagged`,
				tone: stillFlagged > 0 ? "danger" : "muted",
			},
		]),
	);
	if (options.dryRun) {
		logInfo(
			deps.stylePromptText("Preview only: no changes were saved.", "warning"),
		);
	} else if (!changed) {
		logInfo(deps.stylePromptText("No storage changes were needed.", "muted"));
	}

	return 0;
}
