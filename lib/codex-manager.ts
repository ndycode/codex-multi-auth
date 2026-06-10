import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	formatWaitTime,
	getAccountIdCandidates,
	resolveRequestAccountId,
	sanitizeEmail,
	selectBestAccountCandidate,
	type Workspace,
} from "./accounts.js";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	redactOAuthUrlForLog,
	REDIRECT_URI,
} from "./auth/auth.js";
import { runDeviceAuthFlow } from "./auth/device-auth.js";
import { resolveOrgOverride } from "./auth/org-override.js";
import {
	copyTextToClipboard,
	isBrowserLaunchSuppressed,
	openBrowserUrl,
} from "./auth/browser.js";
import { startLocalOAuthServer } from "./auth/server.js";
import { promptAddAnotherAccount, promptLoginMode } from "./cli.js";
import { loadCodexCliState } from "./codex-cli/state.js";
import { setCodexCliActiveSelection } from "./codex-cli/writer.js";
import {
	parseBestArgs,
	printBestUsage,
	runBestCommand,
} from "./codex-manager/commands/best.js";
import {
	applyTokenAccountIdentity,
	hasLikelyInvalidRefreshToken,
	hasUsableAccessToken,
	resolveStoredAccountIdentity,
} from "./codex-manager/account-credentials.js";
import { runHealthCheck } from "./codex-manager/health-check.js";
import {
	countMenuQuotaRefreshTargets,
	DEFAULT_MENU_QUOTA_REFRESH_TTL_MS,
	loadRuntimeCurrentSelectionForStorage,
	refreshQuotaCacheForMenu,
	syncCodexCliActiveSelectionIfDrifted,
	toExistingAccountInfo,
} from "./codex-manager/login-menu-data.js";
import { persistAndSyncSelectedAccount } from "./codex-manager/persist-selected-account.js";
import {
	cloneQuotaCacheData,
	pruneUnsafeQuotaEmailCacheEntry,
	updateQuotaCacheForAccount,
} from "./codex-manager/quota-cache-helpers.js";
import { runAccountCommand } from "./codex-manager/commands/account.js";
import { ACCOUNT_MANAGER_COMMANDS } from "./codex-manager/account-manager-commands.js";
import {
	type AccountPoolWriteOutcome,
	applyAccountPoolResults,
	type ResolvedAccountWrite,
} from "./codex-manager/account-pool-write.js";
import {
	classifyManualCallbackInput,
	type ManualCallbackClassification,
} from "./codex-manager/manual-callback.js";
import { runBudgetCommand } from "./codex-manager/commands/budget.js";
import { runBridgeCommand } from "./codex-manager/commands/bridge.js";
import { runCheckCommand } from "./codex-manager/commands/check.js";
import { runIntegrationsCommand } from "./codex-manager/commands/integrations.js";
import { runModelsCommand } from "./codex-manager/commands/models.js";
import { runMonitorCommand } from "./codex-manager/commands/monitor.js";
import { runConfigExplainCommand } from "./codex-manager/commands/config-explain.js";
import { runDebugBundleCommand } from "./codex-manager/commands/debug-bundle.js";
import {
	parseWhySelectedArgs,
	printWhySelectedUsage,
	runWhySelectedCommand,
} from "./codex-manager/commands/why-selected.js";
import {
	parseVerifyArgs,
	printVerifyUsage,
	runVerifyCommand,
} from "./codex-manager/commands/verify.js";
import {
	findProjectRoot,
	getProjectConfigDir,
	getProjectGlobalConfigDir,
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
	resolvePath as resolveStoragePath,
} from "./storage/paths.js";
import {
	type AccountWithMetrics,
	getHealthTracker,
	getTokenTracker,
	selectHybridAccountTraced,
} from "./rotation.js";
import {
	runDoctor as runRepairDoctor,
	type RepairCommandDeps,
	runFix as runRepairFix,
	runVerifyFlagged as runRepairVerifyFlagged,
} from "./codex-manager/repair-commands.js";
import { runUninstallCommand } from "./codex-manager/commands/uninstall.js";
import { runForecastCommand } from "./codex-manager/commands/forecast.js";
import { runInitConfigCommand } from "./codex-manager/commands/init-config.js";
import { runReportCommand } from "./codex-manager/commands/report.js";
import { runRotationCommand } from "./codex-manager/commands/rotation.js";
import {
	runFeaturesCommand,
	runStatusCommand,
} from "./codex-manager/commands/status.js";
import { loadPersistedRuntimeObservabilitySnapshot } from "./runtime/runtime-observability.js";
import { runSwitchCommand } from "./codex-manager/commands/switch.js";
import { runUnpinCommand } from "./codex-manager/commands/unpin.js";
import { runWorkspaceCommand } from "./codex-manager/commands/workspace.js";
import { runUsageCommand } from "./codex-manager/commands/usage.js";
import {
	type AuthLoginOptions,
	parseAuthLoginArgs,
	printUsage,
} from "./codex-manager/help.js";
import {
	availabilityTone,
	formatBackupSavedAt,
	formatCompactQuotaSnapshot,
	formatRateLimitEntry,
	formatResultSummary,
	normalizeFailureDetail,
	riskTone,
	stringifyLogArgs,
	styleAccountDetailText,
	stylePromptText,
	styleQuotaSummary,
} from "./codex-manager/formatters/index.js";
import {
	applyUiThemeFromDashboardSettings,
	configureUnifiedSettings,
} from "./codex-manager/settings-hub.js";
import {
	getCodexRuntimeRotationProxy,
	getPluginConfigExplainReport,
	loadPluginConfig,
	savePluginConfig,
} from "./config.js";
import {
	bindCodexAppRuntimeRotation,
	getAppBindStatus,
	unbindCodexAppRuntimeRotation,
} from "./runtime/app-bind.js";
import { ACCOUNT_LIMITS } from "./constants.js";
import {
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	loadDashboardDisplaySettings,
} from "./dashboard-settings.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
	summarizeForecast,
} from "./forecast.js";
import { createLogger } from "./logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import { resolveActiveIndex } from "./runtime/account-status.js";
import { buildQuotaEmailFallbackState } from "./quota-readiness.js";
import { loadQuotaCache, saveQuotaCache } from "./quota-cache.js";
import { readAppRuntimeHelperAccountSignal } from "./runtime/runtime-current-account.js";
import {
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "./quota-probe.js";
import { queuedRefresh } from "./refresh-queue.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	clearAccounts,
	findMatchingAccountIndex,
	formatStorageErrorHint,
	inspectStorageHealth,
	getLastAccountsSaveTimestamp,
	getNamedBackups,
	getStoragePath,
	loadAccounts,
	loadFlaggedAccounts,
	type NamedBackupSummary,
	restoreAccountsFromBackup,
	StorageError,
	saveAccounts,
	setStoragePath,
	withAccountStorageTransaction,
} from "./storage.js";
import type { AccountIdSource, TokenResult } from "./types.js";
import { ANSI } from "./ui/ansi.js";
import { confirm } from "./ui/confirm.js";
import { UI_COPY } from "./ui/ui-copy.js";
import { getUiRuntimeOptions } from "./ui/runtime.js";
import { type MenuItem, select } from "./ui/select.js";

type TokenSuccess = Extract<TokenResult, { type: "success" }>;
type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
};
// Formatter implementations moved to lib/codex-manager/formatters/ (audit
// roadmap §4.1.1 phase 1). Re-exported here so existing consumers importing
// from lib/codex-manager.js keep working unchanged.
export { formatBackupSavedAt, styleAccountDetailText };

const log = createLogger("codex-manager");

function createRepairCommandDeps(): RepairCommandDeps {
	return {
		stylePromptText,
		styleAccountDetailText,
		formatResultSummary,
		resolveActiveIndex,
		hasUsableAccessToken,
		hasLikelyInvalidRefreshToken,
		normalizeFailureDetail,
		buildQuotaEmailFallbackState,
		updateQuotaCacheForAccount,
		cloneQuotaCacheData,
		pruneUnsafeQuotaEmailCacheEntry,
		formatCompactQuotaSnapshot,
		resolveStoredAccountIdentity,
		applyTokenAccountIdentity,
	};
}

function isOAuthCancellation(
	result: Exclude<TokenResult, { type: "success" }>,
): boolean {
	const message = (result.message ?? result.reason ?? "").trim().toLowerCase();
	return message.includes("cancelled") || message.includes("canceled");
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const maybe = error as Error & { code?: string };
	return maybe.name === "AbortError" || maybe.code === "ABORT_ERR";
}

interface ImplementedFeature {
	id: number;
	name: string;
}

const IMPLEMENTED_FEATURES: ImplementedFeature[] = [
	{ id: 1, name: "Multi-account OAuth login dashboard" },
	{ id: 2, name: "Account add/update dedupe by token/id/email" },
	{ id: 3, name: "Set current account command" },
	{ id: 4, name: "Per-family active index handling" },
	{ id: 5, name: "Quick health check command" },
	{ id: 6, name: "Full refresh check command" },
	{ id: 7, name: "Flagged account verification command" },
	{ id: 8, name: "Flagged account restore flow" },
	{ id: 9, name: "Best account forecast engine" },
	{ id: 10, name: "Forecast live quota probing" },
	{ id: 11, name: "Auto-fix command (safe mode)" },
	{ id: 12, name: "Doctor diagnostics command" },
	{ id: 13, name: "JSON outputs for machine automation" },
	{ id: 14, name: "Report generation command" },
	{ id: 15, name: "Storage v3 normalization and migration" },
	{ id: 16, name: "Storage backup and recovery journal" },
	{ id: 17, name: "Project-scoped and global storage paths" },
	{ id: 18, name: "Quota cache storage" },
	{ id: 19, name: "Live account sync watcher" },
	{ id: 20, name: "Session affinity store" },
	{ id: 21, name: "Refresh queue dedupe (in-process)" },
	{ id: 22, name: "Refresh lease dedupe (cross-process)" },
	{ id: 23, name: "Token rotation mapping in refresh queue" },
	{ id: 24, name: "Refresh guardian (proactive refresh)" },
	{ id: 25, name: "Preemptive quota scheduler" },
	{ id: 26, name: "Entitlement cache for unsupported models" },
	{ id: 27, name: "Capability policy scoring store" },
	{ id: 28, name: "Failure policy evaluation module" },
	{ id: 29, name: "Streaming failover pipeline" },
	{ id: 30, name: "Rate-limit backoff and cooldown handling" },
	{ id: 31, name: "Host request transformer bridge" },
	{ id: 32, name: "Prompt template sync with cache" },
	{ id: 33, name: "Codex CLI active-account state sync" },
	{ id: 34, name: "TUI quick-switch hotkeys (1-9)" },
	{ id: 35, name: "TUI search and help toggles" },
	{ id: 36, name: "TUI account detail hotkeys (S/R/E/D)" },
	{ id: 37, name: "TUI settings hub (list/summary/behavior/theme)" },
	{ id: 38, name: "Dashboard display customization" },
	{ id: 39, name: "Unified color/theme runtime (v2 UI)" },
	{ id: 40, name: "OAuth browser-first flow with manual callback fallback" },
	{ id: 41, name: "Auto-switch to best account command" },
];

/**
 * Resolve the account-id selection for freshly-minted tokens.
 *
 * The org-override precedence (explicit `login --org` wins over the ambient
 * CODEX_AUTH_ACCOUNT_ID env, for this call only) lives in the internal
 * lib/auth/org-override.ts module so it can be unit-tested without exporting this
 * CLI-internal function. Threading the org as a parameter avoids mutating
 * process.env for the duration of a login, which raced on concurrent re-entry.
 */
function resolveAccountSelection(
	tokens: TokenSuccess,
	orgOverride?: string,
): TokenSuccessWithAccount {
	const candidates = getAccountIdCandidates(tokens.access, tokens.idToken);

	// Surface every workspace/organization exposed by the token so the saved
	// account can track them (issue #491/#512). Without this, same-email
	// multi-workspace logins persisted rows with `workspaces: null` and
	// `workspace <account>` was unusable. Built before the `--org` override
	// branch so the explicit-binding flow persists workspaces too (#512).
	const workspaces: Workspace[] | undefined =
		candidates.length > 0
			? candidates.map((candidate) => ({
					id: candidate.accountId,
					name: candidate.label,
					enabled: true,
					isDefault: candidate.isDefault,
				}))
			: undefined;

	const override = resolveOrgOverride(orgOverride);
	if (override) {
		// Prefer the token candidate's human label for the chosen org so the
		// saved row is identifiable, falling back to a bare manual binding.
		const matched = candidates.find(
			(candidate) => candidate.accountId === override,
		);
		return {
			...tokens,
			accountIdOverride: override,
			accountIdSource: "manual",
			accountLabel: matched?.label,
			workspaces,
		};
	}

	if (candidates.length === 0) {
		return tokens;
	}

	if (candidates.length === 1) {
		const [candidate] = candidates;
		if (candidate) {
			return {
				...tokens,
				accountIdOverride: candidate.accountId,
				accountIdSource: candidate.source,
				accountLabel: candidate.label,
				workspaces,
			};
		}
	}

	const best = selectBestAccountCandidate(candidates);
	if (!best) {
		return tokens;
	}

	return {
		...tokens,
		accountIdOverride: best.accountId,
		accountIdSource: best.source ?? "token",
		accountLabel: best.label,
		workspaces,
	};
}

/**
 * Result of prompting for a manual OAuth callback URL. The classification lives
 * in {@link classifyManualCallbackInput}; this alias keeps the prompt's return
 * type tied to that single source of truth (issue #512 follow-up).
 */
type ManualCallbackResult = ManualCallbackClassification;

async function promptManualCallback(
	state: string,
	options: { allowNonTty?: boolean } = {},
): Promise<ManualCallbackResult> {
	const useInteractivePrompt = input.isTTY && output.isTTY;
	if (!useInteractivePrompt && !options.allowNonTty) {
		return { type: "cancelled" };
	}

	const rl = createInterface({ input, output });
	try {
		if (useInteractivePrompt) {
			console.log("");
			console.log(stylePromptText(UI_COPY.oauth.pastePrompt, "accent"));
		}
		const answer = useInteractivePrompt
			? await rl.question("◆  ")
			: await new Promise<string | null>((resolve, reject) => {
					if (input.readableEnded || input.destroyed) {
						resolve(null);
						return;
					}
					let settled = false;
					const handleInputClosed = () => {
						if (settled) return;
						settled = true;
						input.off("end", handleInputClosed);
						input.off("close", handleInputClosed);
						resolve(null);
					};
					const finish = (value: string) => {
						if (settled) return;
						settled = true;
						input.off("end", handleInputClosed);
						input.off("close", handleInputClosed);
						resolve(value);
					};
					const fail = (error: unknown) => {
						if (settled) return;
						settled = true;
						input.off("end", handleInputClosed);
						input.off("close", handleInputClosed);
						reject(error);
					};
					rl.question("")
						.then((value) => finish(value))
						.catch((error) => {
							if (isAbortError(error) || isReadlineClosedError(error)) {
								handleInputClosed();
								return;
							}
							fail(error);
						});
					input.once("end", handleInputClosed);
					input.once("close", handleInputClosed);
				});
		return classifyManualCallbackInput(answer, state);
	} catch (error) {
		if (isAbortError(error) || isReadlineClosedError(error)) {
			return { type: "cancelled" };
		}
		throw error;
	} finally {
		rl.close();
	}
}

function isReadlineClosedError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const errorCode =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code?: unknown }).code)
			: "";
	return (
		errorCode === "ERR_USE_AFTER_CLOSE" ||
		/readline was closed/i.test(error.message)
	);
}

type OAuthSignInMode =
	| "browser"
	| "manual"
	| "device"
	| "restore-backup"
	| "cancel";
type BackupRestoreMode = "latest" | "manual" | "back";
type SignInFlowOptions = {
	timeoutMs?: number;
};

async function promptOAuthSignInMode(
	backupOption: NamedBackupSummary | null,
	backupDiscoveryWarning: string | null = null,
): Promise<OAuthSignInMode> {
	if (!input.isTTY || !output.isTTY) {
		return "browser";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<OAuthSignInMode>[] = [
		{
			label: UI_COPY.oauth.signInHeading,
			value: "cancel" as const,
			kind: "heading",
		},
		{ label: UI_COPY.oauth.openBrowser, value: "browser", color: "green" },
		{ label: UI_COPY.oauth.manualMode, value: "manual", color: "yellow" },
		...(backupOption
			? [
					{ separator: true, label: "", value: "cancel" as const },
					{
						label: UI_COPY.oauth.restoreHeading,
						value: "cancel" as const,
						kind: "heading" as const,
					},
					{
						label: UI_COPY.oauth.restoreSavedBackup,
						value: "restore-backup" as const,
						hint: UI_COPY.oauth.loadLastBackupHint(
							backupOption.fileName,
							backupOption.accountCount,
							formatBackupSavedAt(backupOption.mtimeMs),
						),
						color: "cyan" as const,
					},
				]
			: []),
		{ separator: true, label: "", value: "cancel" as const },
		{ label: UI_COPY.oauth.back, value: "cancel", color: "red" },
	];

	const selected = await select<OAuthSignInMode>(items, {
		message: UI_COPY.oauth.chooseModeTitle,
		subtitle: backupDiscoveryWarning
			? `${UI_COPY.oauth.chooseModeSubtitle} ${backupDiscoveryWarning}`
			: UI_COPY.oauth.chooseModeSubtitle,
		help: backupOption
			? UI_COPY.oauth.chooseModeHelpWithBackup
			: UI_COPY.oauth.chooseModeHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "cancel";
			if (lower === "1") return "browser";
			if (lower === "2") return "manual";
			if (lower === "3" && backupOption) return "restore-backup";
			return undefined;
		},
	});

	return selected ?? "cancel";
}

async function promptBackupRestoreMode(
	latestBackup: NamedBackupSummary,
): Promise<BackupRestoreMode> {
	if (!input.isTTY || !output.isTTY) {
		return "latest";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<BackupRestoreMode>[] = [
		{
			label: UI_COPY.oauth.loadLastBackup,
			value: "latest",
			hint: `${UI_COPY.oauth.restoreBackupLatestHint}\n${UI_COPY.oauth.manualBackupHint(
				latestBackup.accountCount,
				formatBackupSavedAt(latestBackup.mtimeMs),
			)}`,
			color: "cyan",
		},
		{
			label: UI_COPY.oauth.chooseBackupManually,
			value: "manual",
			color: "yellow",
		},
		{ label: UI_COPY.oauth.back, value: "back", color: "red" },
	];

	const selected = await select<BackupRestoreMode>(items, {
		message: UI_COPY.oauth.restoreBackupTitle,
		subtitle: UI_COPY.oauth.restoreBackupSubtitle,
		help: UI_COPY.oauth.restoreBackupHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "back";
			if (lower === "1") return "latest";
			if (lower === "2") return "manual";
			return undefined;
		},
	});

	return selected ?? "back";
}

async function promptManualBackupSelection(
	backups: NamedBackupSummary[],
): Promise<NamedBackupSummary | null> {
	if (!input.isTTY || !output.isTTY) {
		return backups[0] ?? null;
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<NamedBackupSummary | null>[] = backups.map(
		(backup) => ({
			label: backup.fileName,
			value: backup,
			hint: UI_COPY.oauth.manualBackupHint(
				backup.accountCount,
				formatBackupSavedAt(backup.mtimeMs),
			),
			color: "cyan",
		}),
	);
	items.push({ label: UI_COPY.oauth.back, value: null, color: "red" });

	const selected = await select<NamedBackupSummary | null>(items, {
		message: UI_COPY.oauth.manualBackupTitle,
		subtitle: UI_COPY.oauth.manualBackupSubtitle,
		help: UI_COPY.oauth.manualBackupHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			if (raw.toLowerCase() === "q") return null;
			return undefined;
		},
	});

	return selected;
}

interface WaitForReturnOptions {
	promptText?: string;
	autoReturnMs?: number;
	pauseOnAnyKey?: boolean;
}

async function waitForMenuReturn(
	options: WaitForReturnOptions = {},
): Promise<void> {
	if (!input.isTTY || !output.isTTY) {
		return;
	}

	const promptText = options.promptText ?? UI_COPY.returnFlow.continuePrompt;
	const autoReturnMs = options.autoReturnMs ?? 0;
	const pauseOnAnyKey = options.pauseOnAnyKey ?? true;

	try {
		let chunk: Buffer | string | null;
		do {
			chunk = input.read();
		} while (chunk !== null);
	} catch {
		// best effort buffer drain
	}

	const writeInlineStatus = (message: string): void => {
		output.write(`\r${ANSI.clearLine}${stylePromptText(message, "muted")}`);
	};

	const clearInlineStatus = (): void => {
		output.write(`\r${ANSI.clearLine}`);
	};

	if (autoReturnMs > 0) {
		if (!pauseOnAnyKey) {
			await new Promise<void>((resolve) => setTimeout(resolve, autoReturnMs));
			return;
		}
		const wasRaw = input.isRaw ?? false;
		const endAt = Date.now() + autoReturnMs;
		let lastShownSeconds: number | null = null;
		const renderCountdown = () => {
			const remainingMs = Math.max(0, endAt - Date.now());
			const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
			if (lastShownSeconds === remainingSeconds) return;
			lastShownSeconds = remainingSeconds;
			writeInlineStatus(UI_COPY.returnFlow.autoReturn(remainingSeconds));
		};
		renderCountdown();
		const pinned = await new Promise<boolean>((resolve) => {
			let done = false;
			const interval = setInterval(renderCountdown, 80);
			let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				timeout = null;
				if (!done) {
					done = true;
					cleanup();
					resolve(false);
				}
			}, autoReturnMs);
			const onData = () => {
				if (done) return;
				done = true;
				cleanup();
				resolve(true);
			};
			const cleanup = () => {
				clearInterval(interval);
				if (timeout) {
					clearTimeout(timeout);
					timeout = null;
				}
				input.removeListener("data", onData);
				try {
					input.setRawMode(wasRaw);
				} catch {
					// best effort restore
				}
			};
			try {
				input.setRawMode(true);
			} catch {
				// if raw mode fails, keep countdown behavior
			}
			input.on("data", onData);
			input.resume();
		});
		clearInlineStatus();
		if (!pinned) {
			return;
		}
		const paused = stylePromptText(UI_COPY.returnFlow.paused, "muted");
		writeInlineStatus(paused);
		await new Promise<void>((resolve) => {
			const wasRaw = input.isRaw ?? false;
			const onData = () => {
				cleanup();
				resolve();
			};
			const cleanup = () => {
				input.removeListener("data", onData);
				try {
					input.setRawMode(wasRaw);
				} catch {
					// best effort restore
				}
			};
			try {
				input.setRawMode(true);
			} catch {
				// best effort fallback
			}
			input.on("data", onData);
			input.resume();
		});
		clearInlineStatus();
		return;
	}

	const rl = createInterface({ input, output });
	try {
		const question =
			promptText.length > 0 ? `${stylePromptText(promptText, "muted")} ` : "";
		output.write(`\r${ANSI.clearLine}`);
		await rl.question(question);
	} catch (error) {
		if (!isAbortError(error)) {
			throw error;
		}
	} finally {
		rl.close();
		clearInlineStatus();
	}
}

async function runActionPanel(
	title: string,
	stage: string,
	action: () => Promise<void> | void,
	settings?: DashboardDisplaySettings,
): Promise<void> {
	if (!input.isTTY || !output.isTTY) {
		await action();
		return;
	}

	const spinnerFrames = ["-", "\\", "|", "/"];
	let frame = 0;
	let running = true;
	let failed: unknown = null;
	const captured: string[] = [];
	const maxVisibleLines = Math.max(8, (output.rows ?? 24) - 8);
	const previousLog = console.log;
	const previousWarn = console.warn;
	const previousError = console.error;

	const capture = (prefix: string, args: unknown[]): void => {
		const line = stringifyLogArgs(args).trim();
		if (!line) return;
		captured.push(prefix ? `${prefix}${line}` : line);
		if (captured.length > 400) {
			captured.splice(0, captured.length - 400);
		}
	};

	const render = () => {
		output.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		const spinner = running
			? `${spinnerFrames[frame % spinnerFrames.length] ?? "-"} `
			: failed
				? "x "
				: "+ ";
		const stageText = running
			? `${spinner}${stage}`
			: failed
				? UI_COPY.returnFlow.failed
				: UI_COPY.returnFlow.done;
		previousLog(stylePromptText(title, "accent"));
		previousLog(
			stylePromptText(
				stageText,
				failed ? "danger" : running ? "accent" : "success",
			),
		);
		previousLog("");

		const lines = captured.slice(-maxVisibleLines);
		for (const line of lines) {
			previousLog(line);
		}

		const remainingLines = Math.max(0, maxVisibleLines - lines.length);
		for (let i = 0; i < remainingLines; i += 1) {
			previousLog("");
		}
		previousLog("");
		if (running)
			previousLog(stylePromptText(UI_COPY.returnFlow.working, "muted"));
		frame += 1;
	};

	console.log = (...args: unknown[]) => {
		capture("", args);
	};
	console.warn = (...args: unknown[]) => {
		capture("! ", args);
	};
	console.error = (...args: unknown[]) => {
		capture("x ", args);
	};

	output.write(ANSI.altScreenOn + ANSI.hide);
	let timer: ReturnType<typeof setInterval> | null = null;
	try {
		render();
		timer = setInterval(() => {
			if (!running) return;
			render();
		}, 120);

		await action();
	} catch (error) {
		failed = error;
		capture("x ", [error instanceof Error ? error.message : String(error)]);
	} finally {
		running = false;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		render();
		console.log = previousLog;
		console.warn = previousWarn;
		console.error = previousError;
	}

	if (failed) {
		await waitForMenuReturn({
			promptText: UI_COPY.returnFlow.actionFailedPrompt,
		});
	} else {
		await waitForMenuReturn({
			autoReturnMs: settings?.actionAutoReturnMs ?? 2_000,
			pauseOnAnyKey: settings?.actionPauseOnKey ?? true,
		});
	}
	output.write(
		ANSI.altScreenOff + ANSI.show + ANSI.clearScreen + ANSI.moveTo(1, 1),
	);
	if (failed) {
		throw failed;
	}
}

async function runOAuthFlow(
	forceNewLogin: boolean,
	signInMode: Extract<OAuthSignInMode, "browser" | "manual">,
): Promise<TokenResult> {
	const { pkce, state, url } = await createAuthorizationFlow({ forceNewLogin });
	let code: string | null = null;
	let oauthServer: Awaited<ReturnType<typeof startLocalOAuthServer>> | null =
		null;
	try {
		if (signInMode === "browser") {
			try {
				oauthServer = await startLocalOAuthServer({ state });
			} catch (serverError) {
				log.warn(
					"Local OAuth callback server unavailable; falling back to manual callback entry.",
					serverError instanceof Error
						? {
								message: serverError.message,
								stack: serverError.stack,
								code:
									typeof serverError === "object" &&
									serverError !== null &&
									"code" in serverError
										? String(serverError.code)
										: undefined,
							}
						: { error: String(serverError) },
				);
				oauthServer = null;
			}
		}

		// Display the OAuth URL with sensitive query parameters (state,
		// code, code_challenge, code_verifier) redacted so they do not leak
		// into shell history, screen captures, CI transcripts, or clipboard
		// managers. The full URL is still handed to the browser opener and
		// the clipboard so sign-in continues to work end-to-end.
		const displayUrl = redactOAuthUrlForLog(url);

		if (signInMode === "browser") {
			const opened = openBrowserUrl(url);
			if (opened) {
				console.log(stylePromptText(UI_COPY.oauth.browserOpened, "success"));
			} else {
				console.log(stylePromptText(UI_COPY.oauth.browserOpenFail, "warning"));
				console.log(
					`${stylePromptText(UI_COPY.oauth.goTo, "accent")} ${displayUrl}`,
				);
				const copied = copyTextToClipboard(url);
				console.log(
					stylePromptText(
						copied ? UI_COPY.oauth.copyOk : UI_COPY.oauth.copyFail,
						copied ? "success" : "warning",
					),
				);
			}
		} else {
			console.log(
				`${stylePromptText(UI_COPY.oauth.goTo, "accent")} ${displayUrl}`,
			);
			const copied = copyTextToClipboard(url);
			console.log(
				stylePromptText(
					copied ? UI_COPY.oauth.copyOk : UI_COPY.oauth.copyFail,
					copied ? "success" : "warning",
				),
			);
		}

		const waitingForCallback =
			signInMode === "browser" && oauthServer?.ready === true;
		if (waitingForCallback && oauthServer) {
			console.log(stylePromptText(UI_COPY.oauth.waitingCallback, "muted"));
			const callbackResult = await oauthServer.waitForCode(state);
			code = callbackResult?.code ?? null;
		}

		if (!code) {
			console.log(
				stylePromptText(
					waitingForCallback
						? UI_COPY.oauth.callbackMissed
						: signInMode === "manual"
							? UI_COPY.oauth.callbackBypassed
							: UI_COPY.oauth.callbackUnavailable,
					"warning",
				),
			);
			const manualResult = await promptManualCallback(state, {
				allowNonTty: signInMode === "manual",
			});
			// A parse/state failure must surface its own validation error instead
			// of being reported as `Cancelled.` like a genuine user abort
			// (issue #512 follow-up). Only an actual cancellation falls through to
			// the cancelled path below.
			if (manualResult.type === "invalid") {
				return {
					type: "failed",
					reason: "invalid_response",
					message: UI_COPY.oauth.callbackInvalid,
				};
			}
			if (manualResult.type === "state-mismatch") {
				return {
					type: "failed",
					reason: "invalid_response",
					message: UI_COPY.oauth.callbackStateMismatch,
				};
			}
			code = manualResult.type === "code" ? manualResult.code : null;
		}
	} finally {
		oauthServer?.close();
	}

	if (!code) {
		return {
			type: "failed",
			reason: "unknown",
			message: UI_COPY.oauth.cancelled,
		};
	}
	return exchangeAuthorizationCode(code, pkce.verifier, REDIRECT_URI);
}

async function runSignInFlow(
	forceNewLogin: boolean,
	signInMode: Extract<OAuthSignInMode, "browser" | "manual" | "device">,
	options: SignInFlowOptions = {},
): Promise<TokenResult> {
	if (signInMode === "device") {
		// OpenAI owns the device-code account picker; there is no force-new-login
		// equivalent to pass through for this mode.
		// TODO: Thread a manager-level AbortSignal when login cancellation exists.
		return runDeviceAuthFlow({
			log: console.log,
			timeoutMs: options.timeoutMs,
			// CLI invocations rely on top-level await in scripts/codex-multi-auth.js;
			// without keepAlive the polling timers unref and Node exits before the
			// user can complete the browser step (issue #477).
			keepAlive: true,
		});
	}
	return runOAuthFlow(forceNewLogin, signInMode);
}

type PersistAccountPoolOutcome = AccountPoolWriteOutcome;

async function persistAccountPool(
	results: TokenSuccessWithAccount[],
	replaceAll: boolean,
): Promise<PersistAccountPoolOutcome | null> {
	if (results.length === 0) return null;

	return await withAccountStorageTransaction(async (loadedStorage, persist) => {
		const stored = replaceAll ? null : loadedStorage;
		const now = Date.now();
		const existing = stored?.accounts ? [...stored.accounts] : [];

		const writes: ResolvedAccountWrite[] = results.map((result) => {
			const tokenAccountId = extractAccountId(result.access);
			const accountId = resolveRequestAccountId(
				result.accountIdOverride,
				result.accountIdSource,
				tokenAccountId,
			);
			const accountIdSource = accountId
				? (result.accountIdSource ??
					(result.accountIdOverride ? "manual" : "token"))
				: undefined;
			return {
				accountId,
				accountIdSource,
				accountLabel: result.accountLabel,
				email: sanitizeEmail(
					extractAccountEmail(result.access, result.idToken),
				),
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				workspaces: result.workspaces,
				now,
			};
		});

		const { accounts, activeIndex, outcome } = applyAccountPoolResults({
			existing,
			writes,
			priorActiveIndex: stored?.activeIndex,
			findMatchingAccountIndex,
		});

		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			activeIndexByFamily[family] = activeIndex;
		}

		await persist({
			version: 3,
			accounts,
			activeIndex,
			activeIndexByFamily,
		});

		return outcome;
	});
}

async function syncSelectionToCodex(
	tokens: TokenSuccessWithAccount,
): Promise<void> {
	const tokenAccountId = extractAccountId(tokens.access);
	const accountId = resolveRequestAccountId(
		tokens.accountIdOverride,
		tokens.accountIdSource,
		tokenAccountId,
	);
	const email = sanitizeEmail(
		extractAccountEmail(tokens.access, tokens.idToken),
	);
	await setCodexCliActiveSelection({
		accountId,
		email,
		accessToken: tokens.access,
		refreshToken: tokens.refresh,
		expiresAt: tokens.expires,
		idToken: tokens.idToken,
	});
}

async function runForecast(args: string[]): Promise<number> {
	return runForecastCommand(args, {
		setStoragePath,
		loadAccounts,
		saveAccounts,
		loadDashboardDisplaySettings,
		resolveActiveIndex,
		loadQuotaCache,
		saveQuotaCache,
		cloneQuotaCacheData,
		buildQuotaEmailFallbackState,
		updateQuotaCacheForAccount,
		hasUsableAccessToken,
		queuedRefresh,
		fetchCodexQuotaSnapshot,
		normalizeFailureDetail,
		formatAccountLabel,
		extractAccountId,
		evaluateForecastAccounts,
		summarizeForecast,
		recommendForecastAccount,
		stylePromptText,
		formatResultSummary,
		styleQuotaSummary,
		formatCompactQuotaSnapshot,
		availabilityTone,
		riskTone,
		formatWaitTime,
		defaultDisplay: DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		formatQuotaSnapshotLine,
		loadRuntimeObservabilitySnapshot: loadPersistedRuntimeObservabilitySnapshot,
	});
}

async function clearAccountsAndReset(): Promise<void> {
	await clearAccounts();
}

function adjustManageActionSelectionIndex(
	currentIndex: number | undefined,
	removedIndex: number,
	remainingCount: number,
): number {
	if (remainingCount <= 0) {
		return 0;
	}
	if (typeof currentIndex !== "number" || currentIndex < 0) {
		return 0;
	}
	if (currentIndex < removedIndex) {
		return Math.min(currentIndex, remainingCount - 1);
	}
	if (currentIndex > removedIndex) {
		return currentIndex - 1;
	}
	return Math.min(removedIndex, remainingCount - 1);
}

function resetManageActionSelection(
	storage: AccountStorageV3,
	removedIndex: number,
): void {
	const remainingCount = storage.accounts.length;
	if (remainingCount <= 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		for (const family of MODEL_FAMILIES) {
			storage.activeIndexByFamily[family] = 0;
		}
		return;
	}

	const previousActiveIndex = storage.activeIndex;
	const previousByFamily = { ...storage.activeIndexByFamily };
	storage.activeIndex = adjustManageActionSelectionIndex(
		previousActiveIndex,
		removedIndex,
		remainingCount,
	);
	storage.activeIndexByFamily = {};
	for (const family of MODEL_FAMILIES) {
		storage.activeIndexByFamily[family] = adjustManageActionSelectionIndex(
			previousByFamily[family] ?? previousActiveIndex,
			removedIndex,
			remainingCount,
		);
	}
}

function replaceManageActionStorage(
	target: AccountStorageV3,
	source: AccountStorageV3,
): void {
	target.version = source.version;
	target.accounts = structuredClone(source.accounts);
	target.activeIndex = source.activeIndex;
	target.activeIndexByFamily = {
		...source.activeIndexByFamily,
	};
}

function resolveManageActionAccountIndex(
	storage: AccountStorageV3,
	fallbackIndex: number,
	account: AccountMetadataV3 | undefined,
): number | null {
	if (account) {
		const matchedIndex = findMatchingAccountIndex(
			storage.accounts,
			{
				accountId: account.accountId,
				email: account.email,
				refreshToken: account.refreshToken,
			},
			{
				allowUniqueAccountIdFallbackWithoutEmail: true,
			},
		);
		if (typeof matchedIndex === "number" && matchedIndex >= 0) {
			return matchedIndex;
		}
		return null;
	}
	return fallbackIndex >= 0 && fallbackIndex < storage.accounts.length
		? fallbackIndex
		: null;
}

function matchesManageActionAccount(
	account: AccountMetadataV3 | undefined,
	candidate: AccountMetadataV3 | undefined,
): boolean {
	if (!account || !candidate) {
		return false;
	}
	if (account.accountId || candidate.accountId) {
		return account.accountId === candidate.accountId;
	}
	return (
		account.refreshToken === candidate.refreshToken &&
		sanitizeEmail(account.email) === sanitizeEmail(candidate.email)
	);
}
async function handleManageAction(
	storage: AccountStorageV3,
	menuResult: Awaited<ReturnType<typeof promptLoginMode>>,
): Promise<void> {
	if (typeof menuResult.switchAccountIndex === "number") {
		const index = menuResult.switchAccountIndex;
		await runSwitchCommand([String(index + 1)], {
			setStoragePath,
			loadAccounts,
			persistAndSyncSelectedAccount,
		});
		return;
	}

	if (typeof menuResult.deleteAccountIndex === "number") {
		const idx = menuResult.deleteAccountIndex;
		const selectedAccount = storage.accounts[idx];
		let deleted = false;
		if (selectedAccount) {
			await withAccountStorageTransaction(async (loadedStorage, persist) => {
				const nextStorage = loadedStorage
					? structuredClone(loadedStorage)
					: structuredClone(storage);
				const nextIndex = resolveManageActionAccountIndex(
					nextStorage,
					idx,
					selectedAccount,
				);
				if (nextIndex === null) {
					return;
				}
				const nextAccount = nextStorage.accounts[nextIndex];
				if (!matchesManageActionAccount(selectedAccount, nextAccount)) {
					return;
				}
				nextStorage.accounts.splice(nextIndex, 1);
				resetManageActionSelection(nextStorage, nextIndex);
				await persist(nextStorage);
				replaceManageActionStorage(storage, nextStorage);
				deleted = true;
			});
		}
		if (deleted) {
			console.log(`Deleted account ${idx + 1}.`);
		}
		return;
	}

	if (typeof menuResult.toggleAccountIndex === "number") {
		const idx = menuResult.toggleAccountIndex;
		const selectedAccount = storage.accounts[idx];
		let nextEnabledState: boolean | null = null;
		if (selectedAccount) {
			await withAccountStorageTransaction(async (loadedStorage, persist) => {
				const nextStorage = loadedStorage
					? structuredClone(loadedStorage)
					: structuredClone(storage);
				const nextIndex = resolveManageActionAccountIndex(
					nextStorage,
					idx,
					selectedAccount,
				);
				if (nextIndex === null) {
					return;
				}
				const nextAccount = nextStorage.accounts[nextIndex];
				if (
					!nextAccount ||
					!matchesManageActionAccount(selectedAccount, nextAccount)
				) {
					return;
				}
				nextAccount.enabled = nextAccount.enabled === false;
				await persist(nextStorage);
				replaceManageActionStorage(storage, nextStorage);
				nextEnabledState = nextAccount.enabled !== false;
			});
		}
		if (nextEnabledState !== null) {
			console.log(
				`${nextEnabledState ? "Enabled" : "Disabled"} account ${idx + 1}.`,
			);
		}
		return;
	}

	if (typeof menuResult.refreshAccountIndex === "number") {
		const idx = menuResult.refreshAccountIndex;
		const existing = storage.accounts[idx];
		if (!existing) return;

		const signInMode = await promptOAuthSignInMode(null);
		if (signInMode === "cancel") {
			console.log(stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"));
			return;
		}
		if (signInMode !== "browser" && signInMode !== "manual") {
			return;
		}

		const tokenResult = await runOAuthFlow(true, signInMode);
		if (tokenResult.type !== "success") {
			console.error(
				`Refresh failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`,
			);
			return;
		}

		const resolved = resolveAccountSelection(tokenResult);
		await persistAccountPool([resolved], false);
		await syncSelectionToCodex(resolved);
		console.log(`Refreshed account ${idx + 1}.`);
	}
}

async function runAuthLogin(args: string[]): Promise<number> {
	const parsedArgs = parseAuthLoginArgs(args);
	if (!parsedArgs.ok) {
		if (parsedArgs.reason === "error") {
			console.error(parsedArgs.message);
			printUsage();
			return 1;
		}
		return 0;
	}

	const loginOptions = parsedArgs.options;
	// `--org <id>` binds this login to a specific workspace/org so the same
	// email's personal vs business/team workspace can be registered on demand
	// (issue #491). The org is threaded explicitly into resolveAccountSelection
	// (no process.env mutation), so concurrent re-entry (menu re-entry, a reused
	// test worker) can never bind a login to a stale org via a shared global.
	if (loginOptions.org) {
		console.log(`Binding this login to workspace org id: ${loginOptions.org}`);
	}
	return runAuthLoginFlow(loginOptions);
}

async function runAuthLoginFlow(
	loginOptions: AuthLoginOptions,
): Promise<number> {
	setStoragePath(null);
	let pendingMenuQuotaRefresh: Promise<void> | null = null;
	let menuQuotaRefreshStatus: string | undefined;
	let skipNextMenuQuotaAutoRefresh = false;
	let menuQuotaRefreshGeneration = 0;
	const clearMenuQuotaAutoRefreshSkip = () => {
		skipNextMenuQuotaAutoRefresh = false;
		menuQuotaRefreshGeneration += 1;
	};
	// When the user explicitly picks a sign-in transport on the command line
	// (--device-auth, --manual, --no-browser), they want to add a new account
	// directly. Skipping the dashboard menu keeps `login --device-auth`
	// usable from scripts and matches the documented behavior of the help text.
	const explicitSignInMode = loginOptions.deviceAuth || loginOptions.manual;
	loginFlow: while (true) {
		let existingStorage = await loadAccounts();
		if (
			!explicitSignInMode &&
			existingStorage &&
			existingStorage.accounts.length > 0
		) {
			while (true) {
				existingStorage = await loadAccounts();
				if (!existingStorage || existingStorage.accounts.length === 0) {
					break;
				}
				const currentStorage = existingStorage;
				const displaySettings = await loadDashboardDisplaySettings();
				applyUiThemeFromDashboardSettings(displaySettings);
				const quotaCache = await loadQuotaCache();
				const shouldAutoFetchLimits =
					displaySettings.menuAutoFetchLimits ?? true;
				const showFetchStatus = displaySettings.menuShowFetchStatus ?? true;
				const quotaTtlMs =
					displaySettings.menuQuotaTtlMs ?? DEFAULT_MENU_QUOTA_REFRESH_TTL_MS;
				const shouldSkipAutoFetchThisPass =
					!pendingMenuQuotaRefresh && skipNextMenuQuotaAutoRefresh;
				if (shouldSkipAutoFetchThisPass) {
					skipNextMenuQuotaAutoRefresh = false;
				}
				if (
					shouldAutoFetchLimits &&
					!pendingMenuQuotaRefresh &&
					!shouldSkipAutoFetchThisPass
				) {
					const staleCount = countMenuQuotaRefreshTargets(
						currentStorage,
						quotaCache,
						quotaTtlMs,
					);
					if (staleCount > 0) {
						if (showFetchStatus) {
							menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [0/${staleCount}]`;
						}
						const refreshGeneration = menuQuotaRefreshGeneration;
						pendingMenuQuotaRefresh = refreshQuotaCacheForMenu(
							currentStorage,
							quotaCache,
							quotaTtlMs,
							(current, total) => {
								if (!showFetchStatus) return;
								menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [${current}/${total}]`;
							},
						)
							.then(() => {
								if (refreshGeneration === menuQuotaRefreshGeneration) {
									skipNextMenuQuotaAutoRefresh = true;
								}
								return undefined;
							})
							.catch(() => undefined)
							.finally(() => {
								menuQuotaRefreshStatus = undefined;
								pendingMenuQuotaRefresh = null;
							});
					}
				}
				const flaggedStorage = await loadFlaggedAccounts();
				await syncCodexCliActiveSelectionIfDrifted(currentStorage);
				const runtimeCurrent = await loadRuntimeCurrentSelectionForStorage(
					currentStorage,
				);

				const menuResult = await promptLoginMode(
					toExistingAccountInfo(
						currentStorage,
						quotaCache,
						displaySettings,
						runtimeCurrent,
					),
					{
						flaggedCount: flaggedStorage.accounts.length,
						statusMessage: showFetchStatus
							? () => menuQuotaRefreshStatus
							: undefined,
					},
				);

				if (menuResult.mode === "cancel") {
					console.log("Cancelled.");
					return 0;
				}
				if (menuResult.mode === "check") {
					clearMenuQuotaAutoRefreshSkip();
					await runActionPanel(
						"Quick Check",
						"Checking local session + live status",
						async () => {
							await runHealthCheck({ forceRefresh: false, liveProbe: true });
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "deep-check") {
					clearMenuQuotaAutoRefreshSkip();
					await runActionPanel(
						"Deep Check",
						"Refreshing and testing all accounts",
						async () => {
							await runHealthCheck({ forceRefresh: true, liveProbe: true });
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "forecast") {
					clearMenuQuotaAutoRefreshSkip();
					await runActionPanel(
						"Best Account",
						"Comparing accounts",
						async () => {
							await runForecast(["--live"]);
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "fix") {
					clearMenuQuotaAutoRefreshSkip();
					await runActionPanel(
						"Auto-Fix",
						"Checking and fixing common issues",
						async () => {
							await runRepairFix(["--live"], createRepairCommandDeps());
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "settings") {
					clearMenuQuotaAutoRefreshSkip();
					await configureUnifiedSettings(displaySettings);
					continue;
				}
				if (menuResult.mode === "verify-flagged") {
					clearMenuQuotaAutoRefreshSkip();
					await runActionPanel(
						"Problem Account Check",
						"Checking problem accounts",
						async () => {
							await runRepairVerifyFlagged([], createRepairCommandDeps());
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "fresh" && menuResult.deleteAll) {
					clearMenuQuotaAutoRefreshSkip();
					await runActionPanel(
						"Reset Accounts",
						"Deleting all saved accounts",
						async () => {
							await clearAccountsAndReset();
							console.log(
								"Cleared saved accounts from active storage. Recovery snapshots remain available.",
							);
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "manage") {
					clearMenuQuotaAutoRefreshSkip();
					const requiresInteractiveOAuth =
						typeof menuResult.refreshAccountIndex === "number";
					if (requiresInteractiveOAuth) {
						await handleManageAction(currentStorage, menuResult);
						continue;
					}
					await runActionPanel(
						"Applying Change",
						"Updating selected account",
						async () => {
							await handleManageAction(currentStorage, menuResult);
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "add") {
					break;
				}
			}
		}

		const refreshedStorage = await loadAccounts();
		let existingCount = refreshedStorage?.accounts.length ?? 0;
		let forceNewLogin = existingCount > 0;
		let onboardingBackupDiscoveryWarning: string | null = null;
		const loadNamedBackupsForOnboarding = async (): Promise<
			NamedBackupSummary[]
		> => {
			if (existingCount > 0) {
				onboardingBackupDiscoveryWarning = null;
				return [];
			}
			try {
				onboardingBackupDiscoveryWarning = null;
				return await getNamedBackups();
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				log.debug("getNamedBackups failed, skipping restore option", {
					code,
					error: error instanceof Error ? error.message : String(error),
				});
				if (code && code !== "ENOENT") {
					onboardingBackupDiscoveryWarning =
						"Named backup discovery failed. Continuing with browser or manual sign-in only.";
					console.warn(onboardingBackupDiscoveryWarning);
				} else {
					onboardingBackupDiscoveryWarning = null;
				}
				return [];
			}
		};
		let namedBackups = await loadNamedBackupsForOnboarding();
		while (true) {
			const latestNamedBackup = namedBackups[0] ?? null;
			const preferManualMode =
				loginOptions.manual || isBrowserLaunchSuppressed();
			const signInMode: OAuthSignInMode = loginOptions.deviceAuth
				? "device"
				: preferManualMode
					? "manual"
					: await promptOAuthSignInMode(
							latestNamedBackup,
							onboardingBackupDiscoveryWarning,
						);
			if (signInMode === "cancel") {
				if (existingCount > 0) {
					console.log(
						stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"),
					);
					continue loginFlow;
				}
				console.log("Cancelled.");
				return 0;
			}
			if (signInMode === "restore-backup") {
				const latestAvailableBackup = namedBackups[0] ?? null;
				if (!latestAvailableBackup) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				const restoreMode = await promptBackupRestoreMode(
					latestAvailableBackup,
				);
				if (restoreMode === "back") {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const selectedBackup =
					restoreMode === "manual"
						? await promptManualBackupSelection(namedBackups)
						: latestAvailableBackup;
				if (!selectedBackup) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const confirmed = await confirm(
					UI_COPY.oauth.restoreBackupConfirm(
						selectedBackup.fileName,
						selectedBackup.accountCount,
					),
				);
				if (!confirmed) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const displaySettings = await loadDashboardDisplaySettings();
				applyUiThemeFromDashboardSettings(displaySettings);
				try {
					await runActionPanel(
						"Load Backup",
						`Loading ${selectedBackup.fileName}`,
						async () => {
							const restoredStorage = await restoreAccountsFromBackup(
								selectedBackup.path,
								{ persist: false },
							);
							const targetIndex = resolveActiveIndex(restoredStorage);
							const { synced } = await persistAndSyncSelectedAccount({
								storage: restoredStorage,
								targetIndex,
								parsed: targetIndex + 1,
								switchReason: "restore",
								preserveActiveIndexByFamily: true,
							});
							console.log(
								UI_COPY.oauth.restoreBackupLoaded(
									selectedBackup.fileName,
									restoredStorage.accounts.length,
								),
							);
							if (!synced) {
								console.warn(UI_COPY.oauth.restoreBackupSyncWarning);
							}
						},
						displaySettings,
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (error instanceof StorageError) {
						console.error(formatStorageErrorHint(error, selectedBackup.path));
					} else {
						console.error(`Backup restore failed: ${message}`);
					}
					const storageAfterRestoreAttempt = await loadAccounts().catch(
						() => null,
					);
					if ((storageAfterRestoreAttempt?.accounts.length ?? 0) > 0) {
						continue loginFlow;
					}
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				continue loginFlow;
			}

			if (
				signInMode !== "browser" &&
				signInMode !== "manual" &&
				signInMode !== "device"
			) {
				continue;
			}

			const tokenResult = await runSignInFlow(forceNewLogin, signInMode);
			if (tokenResult.type !== "success") {
				if (isOAuthCancellation(tokenResult)) {
					// In explicit-mode invocations the dashboard was bypassed,
					// so falling back to it on cancel would re-enter the same
					// transport flow and trap the user. Exit cleanly instead.
					if (explicitSignInMode) {
						console.log("Cancelled.");
						return 0;
					}
					if (existingCount > 0) {
						console.log(
							stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"),
						);
						continue loginFlow;
					}
					console.log("Cancelled.");
					return 0;
				}
				console.error(
					`Login failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`,
				);
				return 1;
			}

			const resolved = resolveAccountSelection(tokenResult, loginOptions.org);
			const persistOutcome = await persistAccountPool([resolved], false);
			await syncSelectionToCodex(resolved);

			const latestStorage = await loadAccounts();
			const count = latestStorage?.accounts.length ?? 1;
			existingCount = count;
			namedBackups = [];
			onboardingBackupDiscoveryWarning = null;
			// Only claim a new saved slot when one was actually appended. A
			// same-email login that maps onto an existing entry updates or
			// rebinds it instead of growing the pool (issue #512).
			const outcomeMessage =
				persistOutcome === "rebound"
					? `Rebound workspace for existing account. Total: ${count}`
					: persistOutcome === "updated"
						? `Updated existing account. Total: ${count}`
						: `Added account. Total: ${count}`;
			console.log(outcomeMessage);
			console.log("Next steps:");
			console.log("  codex-multi-auth status  Check that the wrapper is active.");
			console.log(
				"  codex-multi-auth check   Confirm your saved accounts look healthy.",
			);
			console.log(
				"  codex-multi-auth list    Review saved accounts before switching.",
			);
			if (count >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				console.log(
					`Reached maximum account limit (${ACCOUNT_LIMITS.MAX_ACCOUNTS}).`,
				);
				// Same reasoning as the addAnother=false branch below: in
				// explicit mode the dashboard is bypassed, so falling out of
				// the inner loop would re-enter loginFlow and silently start
				// another sign-in session despite the cap.
				if (explicitSignInMode) {
					return 0;
				}
				break;
			}

			const addAnother = await promptAddAnotherAccount(count);
			if (!addAnother) {
				// With an explicit transport flag the dashboard was bypassed,
				// so falling back to it after declining would loop into a fresh
				// sign-in instead of exiting. Return directly in that case.
				if (explicitSignInMode) {
					return 0;
				}
				break;
			}
			forceNewLogin = true;
		}
	}
}

async function runBest(args: string[]): Promise<number> {
	return runBestCommand(args, {
		setStoragePath,
		loadAccounts,
		saveAccounts,
		parseBestArgs,
		printBestUsage,
		resolveActiveIndex,
		hasUsableAccessToken,
		queuedRefresh,
		normalizeFailureDetail,
		extractAccountId,
		extractAccountEmail,
		sanitizeEmail,
		formatAccountLabel,
		fetchCodexQuotaSnapshot,
		evaluateForecastAccounts,
		recommendForecastAccount,
		persistAndSyncSelectedAccount,
		setCodexCliActiveSelection,
	});
}

export async function autoSyncActiveAccountToCodex(): Promise<boolean> {
	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		return false;
	}

	const activeIndex = resolveActiveIndex(storage, "codex");
	if (activeIndex < 0 || activeIndex >= storage.accounts.length) {
		return false;
	}

	const account = storage.accounts[activeIndex];
	if (!account) {
		return false;
	}
	const accountMatch = {
		accountId: account.accountId,
		email: account.email,
		refreshToken: account.refreshToken,
	};

	const now = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken: string | undefined;
	let syncAccountId = account.accountId;
	let syncEmail = account.email;
	let changed = false;
	let nextStoredAccount: AccountMetadataV3 | null = null;

	if (!hasUsableAccessToken(account, now)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type !== "success") {
			return false;
		}
		nextStoredAccount = structuredClone(account);
		const tokenAccountId = extractAccountId(refreshResult.access);
		const nextEmail = sanitizeEmail(
			extractAccountEmail(refreshResult.access, refreshResult.idToken),
		);
		if (nextStoredAccount.refreshToken !== refreshResult.refresh) {
			nextStoredAccount.refreshToken = refreshResult.refresh;
			changed = true;
		}
		if (nextStoredAccount.accessToken !== refreshResult.access) {
			nextStoredAccount.accessToken = refreshResult.access;
			changed = true;
		}
		if (nextStoredAccount.expiresAt !== refreshResult.expires) {
			nextStoredAccount.expiresAt = refreshResult.expires;
			changed = true;
		}
		if (nextEmail && nextEmail !== nextStoredAccount.email) {
			nextStoredAccount.email = nextEmail;
			changed = true;
		}
		if (applyTokenAccountIdentity(nextStoredAccount, tokenAccountId)) {
			changed = true;
		}
		syncAccessToken = refreshResult.access;
		syncRefreshToken = refreshResult.refresh;
		syncExpiresAt = refreshResult.expires;
		syncIdToken = refreshResult.idToken;
		syncAccountId = nextStoredAccount.accountId;
		syncEmail = nextStoredAccount.email;
	}

	if (changed && nextStoredAccount) {
		let persisted = false;
		await withAccountStorageTransaction(async (loadedStorage, persist) => {
			if (!loadedStorage) {
				return;
			}
			const nextStorage = structuredClone(loadedStorage);
			const targetIndex =
				findMatchingAccountIndex(nextStorage.accounts, accountMatch, {
					allowUniqueAccountIdFallbackWithoutEmail: true,
				}) ??
				findMatchingAccountIndex(nextStorage.accounts, nextStoredAccount, {
					allowUniqueAccountIdFallbackWithoutEmail: true,
				});
			if (targetIndex === undefined) {
				return;
			}
			nextStorage.accounts[targetIndex] = structuredClone(nextStoredAccount);
			await persist(nextStorage);
			persisted = true;
		});
		if (!persisted) {
			return false;
		}
	}

	return setCodexCliActiveSelection({
		accountId: syncAccountId,
		email: syncEmail,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
}
function buildSelectAccountTraced(): (
	storage: AccountStorageV3,
) => ReturnType<typeof selectHybridAccountTraced> {
	return (storage: AccountStorageV3) => {
		const now = Date.now();
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();
		const accountsWithMetrics: AccountWithMetrics[] = storage.accounts.map(
			(account, index) => {
				const enabled = account?.enabled !== false;
				const rateLimits = account?.rateLimitResetTimes ?? {};
				let rateLimited = false;
				for (const value of Object.values(rateLimits)) {
					if (typeof value === "number" && value > now) {
						rateLimited = true;
						break;
					}
				}
				const coolingDown =
					typeof account?.coolingDownUntil === "number" &&
					account.coolingDownUntil > now;
				const isAvailable = enabled && !rateLimited && !coolingDown;
				return {
					index,
					trackerKey: account?.accountId ?? index,
					isAvailable,
					lastUsed: account?.lastUsed ?? 0,
				};
			},
		);
		return selectHybridAccountTraced({
			accounts: accountsWithMetrics,
			healthTracker,
			tokenTracker,
		});
	};
}

/**
 * Uniform handler signature for the `auth` subcommand registry: every entry
 * receives the already-parsed argument tail (everything after the subcommand)
 * and resolves to the process exit code. Dependencies are closure-captured
 * from this module exactly as the previous if/else dispatch chain did.
 */
type CliCommandHandler = (rest: string[]) => number | Promise<number>;

/**
 * Shared handler for `list` and `status` (aliases of the same view).
 */
const runListOrStatusCommand: CliCommandHandler = (rest) =>
	runStatusCommand({
		setStoragePath,
		getStoragePath,
		loadAccounts,
		inspectStorageHealth,
		resolveActiveIndex,
		formatRateLimitEntry,
		loadRuntimeObservabilitySnapshot: loadPersistedRuntimeObservabilitySnapshot,
		loadAppBindStatus: async () =>
			getAppBindStatus()
				.then((status) => (status.running ? status.router : null))
				.catch(() => null),
		loadAppHelperStatus: readAppRuntimeHelperAccountSignal,
		loadQuotaCache,
		json: rest.includes("--json") || rest.includes("-j"),
	});

/**
 * Command registry for the `auth` dispatcher (audit roadmap §4.1.1 phase 2).
 *
 * Replaces the former `if (command === …)` chain in runCodexMultiAuthCli with
 * a lookup map. Aliases (`status` → `list` view) point at the same handler.
 * Per-invocation dependency factories (createRepairCommandDeps,
 * buildSelectAccountTraced) are still invoked inside each handler so they are
 * constructed at dispatch time, not at module load — identical to the old
 * chain. Keys are exact-match and unique, so lookup order cannot change
 * semantics relative to the sequential chain it replaces.
 */
const CLI_COMMAND_HANDLERS: ReadonlyMap<string, CliCommandHandler> = new Map<
	string,
	CliCommandHandler
>([
	["login", (rest) => runAuthLogin(rest)],
	["list", runListOrStatusCommand],
	["status", runListOrStatusCommand],
	[
		"switch",
		(rest) =>
			runSwitchCommand(rest, {
				setStoragePath,
				loadAccounts,
				persistAndSyncSelectedAccount,
			}),
	],
	[
		"unpin",
		() =>
			runUnpinCommand({
				setStoragePath,
				loadAccounts,
				saveAccounts,
				getStoragePath,
			}),
	],
	[
		"workspace",
		(rest) =>
			runWorkspaceCommand(rest, {
				setStoragePath,
				loadAccounts,
				saveAccounts,
			}),
	],
	["check", () => runCheckCommand({ runHealthCheck })],
	[
		"features",
		() => runFeaturesCommand({ implementedFeatures: IMPLEMENTED_FEATURES }),
	],
	[
		"verify-flagged",
		(rest) => runRepairVerifyFlagged(rest, createRepairCommandDeps()),
	],
	["forecast", (rest) => runForecast(rest)],
	["best", (rest) => runBest(rest)],
	[
		"account",
		(rest) =>
			runAccountCommand(rest, {
				setStoragePath,
				loadAccounts,
			}),
	],
	["budget", (rest) => runBudgetCommand(rest)],
	["bridge", (rest) => runBridgeCommand(rest)],
	["integrations", (rest) => runIntegrationsCommand(rest)],
	[
		"models",
		(rest) =>
			runModelsCommand(rest, {
				setStoragePath,
				loadAccounts,
				loadQuotaCache,
			}),
	],
	[
		"monitor",
		(rest) =>
			runMonitorCommand(rest, {
				setStoragePath,
				loadAccounts,
			}),
	],
	[
		"report",
		(rest) =>
			runReportCommand(rest, {
				setStoragePath,
				getStoragePath,
				loadAccounts,
				inspectStorageHealth,
				saveAccounts,
				resolveActiveIndex,
				hasUsableAccessToken,
				queuedRefresh,
				fetchCodexQuotaSnapshot,
				formatRateLimitEntry,
				normalizeFailureDetail,
				loadRuntimeObservabilitySnapshot:
					loadPersistedRuntimeObservabilitySnapshot,
				loadQuotaCache,
			}),
	],
	["usage", (rest) => runUsageCommand(rest)],
	[
		"rotation",
		(rest) =>
			runRotationCommand(rest, {
				loadPluginConfig,
				savePluginConfig,
				getCodexRuntimeRotationProxy,
				setStoragePath,
				getStoragePath,
				loadAccounts,
				saveAccounts,
				resolveActiveIndex,
				bindCodexApp: bindCodexAppRuntimeRotation,
				unbindCodexApp: unbindCodexAppRuntimeRotation,
				getCodexAppBindStatus: getAppBindStatus,
				loadRuntimeObservabilitySnapshot:
					loadPersistedRuntimeObservabilitySnapshot,
				loadQuotaCache,
			}),
	],
	[
		"why-selected",
		(rest) =>
			runWhySelectedCommand(rest, {
				parseWhySelectedArgs,
				printWhySelectedUsage,
				setStoragePath,
				loadAccounts,
				resolveActiveIndex,
				selectAccountTraced: buildSelectAccountTraced(),
				loadRuntimeObservabilitySnapshot: async () => {
					const snapshot = await loadPersistedRuntimeObservabilitySnapshot();
					if (!snapshot) return null;
					const generatedAt =
						typeof (snapshot as { generatedAt?: unknown }).generatedAt ===
							"number" ||
						typeof (snapshot as { generatedAt?: unknown }).generatedAt ===
							"string"
							? (snapshot as { generatedAt?: number | string }).generatedAt
							: undefined;
					return { generatedAt };
				},
				sanitizeEmail,
			}),
	],
	[
		"verify",
		(rest) =>
			runVerifyCommand(rest, {
				parseVerifyArgs,
				printVerifyUsage,
				runVerifyFlagged: async (flaggedArgs: string[]) =>
					runRepairVerifyFlagged(flaggedArgs, createRepairCommandDeps()),
				setStoragePath,
				verifyPathsDeps: {
					getCwd: () => process.cwd(),
					findProjectRoot,
					resolveProjectStorageIdentityRoot,
					getProjectStorageKey,
					getProjectConfigDir,
					getProjectGlobalConfigDir,
					resolvePath: resolveStoragePath,
				},
			}),
	],
	["fix", (rest) => runRepairFix(rest, createRepairCommandDeps())],
	["doctor", (rest) => runRepairDoctor(rest, createRepairCommandDeps())],
	["uninstall", (rest) => runUninstallCommand(rest, { clearAccounts })],
	[
		"config",
		(rest) => {
			const [subcommand, ...configArgs] = rest;
			if (subcommand === "explain") {
				return runConfigExplainCommand(configArgs, {
					getReport: getPluginConfigExplainReport,
				});
			}
			if (subcommand === "template") {
				return runInitConfigCommand(configArgs);
			}
			console.error(`Unknown config command: ${subcommand ?? "(missing)"}`);
			return 1;
		},
	],
	["init-config", (rest) => runInitConfigCommand(rest)],
	[
		"debug",
		(rest) => {
			const [subcommand, ...debugArgs] = rest;
			if (subcommand === "bundle") {
				return runDebugBundleCommand(debugArgs, {
					getConfigReport: getPluginConfigExplainReport,
					getStoragePath,
					loadAccounts,
					loadFlaggedAccounts,
					loadCodexCliState,
					getLastAccountsSaveTimestamp,
				});
			}
			console.error(`Unknown debug command: ${subcommand ?? "(missing)"}`);
			return 1;
		},
	],
]);

export async function runCodexMultiAuthCli(rawArgs: string[]): Promise<number> {
	const startupDisplaySettings = await loadDashboardDisplaySettings();
	applyUiThemeFromDashboardSettings(startupDisplaySettings);

	const args =
		rawArgs[0] && rawArgs[0] !== "auth" && ACCOUNT_MANAGER_COMMANDS.has(rawArgs[0])
			? ["auth", ...rawArgs]
			: [...rawArgs];
	if (args.length === 0) {
		printUsage();
		return 0;
	}
	if (args[0] === "--help" || args[0] === "-h") {
		printUsage();
		return 0;
	}

	const [root, sub, ...rest] = args;
	if (root !== "auth") {
		printUsage();
		return 1;
	}

	const command = sub ?? "login";
	if (command === "--help" || command === "-h") {
		printUsage();
		return 0;
	}

	const handler = CLI_COMMAND_HANDLERS.get(command);
	if (handler) {
		return handler(rest);
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	return 1;
}

