import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	extractAccountEmail,
	extractAccountId,
	getAccountIdCandidates,
	resolveRequestAccountId,
	sanitizeEmail,
	selectBestAccountCandidate,
	type Workspace,
} from "../accounts.js";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	redactOAuthUrlForLog,
	REDIRECT_URI,
} from "../auth/auth.js";
import {
	copyTextToClipboard,
	openBrowserUrl,
} from "../auth/browser.js";
import { runDeviceAuthFlow } from "../auth/device-auth.js";
import { resolveOrgOverride } from "../auth/org-override.js";
import { startLocalOAuthServer } from "../auth/server.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import {
	findMatchingAccountIndex,
	withAccountStorageTransaction,
} from "../storage.js";
import type { AccountIdSource, TokenResult } from "../types.js";
import { UI_COPY } from "../ui/ui-copy.js";
import {
	type AccountPoolWriteOutcome,
	applyAccountPoolResults,
	type ResolvedAccountWrite,
} from "./account-pool-write.js";
import { stylePromptText } from "./formatters/index.js";
import {
	classifyManualCallbackInput,
	type ManualCallbackClassification,
} from "./manual-callback.js";

/**
 * OAuth/device sign-in plumbing for the login dashboard: authorization-flow
 * execution, manual callback entry, account-id selection for fresh tokens, and
 * account-pool persistence of sign-in results. Moved verbatim out of
 * lib/codex-manager.ts (audit roadmap §4.1.1 phase 4).
 */

/** @internal */
export type TokenSuccess = Extract<TokenResult, { type: "success" }>;
/** @internal */
export type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
};

const log = createLogger("codex-manager");

/** @internal */
export function isOAuthCancellation(
	result: Exclude<TokenResult, { type: "success" }>,
): boolean {
	const message = (result.message ?? result.reason ?? "").trim().toLowerCase();
	return message.includes("cancelled") || message.includes("canceled");
}

/** @internal */
export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const maybe = error as Error & { code?: string };
	return maybe.name === "AbortError" || maybe.code === "ABORT_ERR";
}

/**
 * Resolve the account-id selection for freshly-minted tokens.
 *
 * The org-override precedence (explicit `login --org` wins over the ambient
 * CODEX_AUTH_ACCOUNT_ID env, for this call only) lives in the internal
 * lib/auth/org-override.ts module so it can be unit-tested without exporting this
 * CLI-internal function. Threading the org as a parameter avoids mutating
 * process.env for the duration of a login, which raced on concurrent re-entry.
 *
 * @internal
 */
export function resolveAccountSelection(
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

/** @internal */
export type OAuthSignInMode =
	| "browser"
	| "manual"
	| "device"
	| "restore-backup"
	| "cancel";
/** @internal */
export type SignInFlowOptions = {
	timeoutMs?: number;
};

/** @internal */
export async function runOAuthFlow(
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

/** @internal */
export async function runSignInFlow(
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

/** @internal */
export type PersistAccountPoolOutcome = AccountPoolWriteOutcome;

/** @internal */
export async function persistAccountPool(
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

/** @internal */
export async function syncSelectionToCodex(
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
