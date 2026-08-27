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
import { describeCallbackFailure } from "../auth/callback-guidance.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import {
	type AccountMetadataV3,
	findMatchingAccountIndex,
	withAccountStorageTransaction,
} from "../storage.js";
import { cloneAccountStorageForPersistence } from "../storage/account-persistence.js";
import { CodexValidationError } from "../errors.js";
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
	targetAccountId?: string,
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

	// A targeted re-authentication names one saved row, which is a stricter and
	// more specific instruction than the ambient CODEX_AUTH_ACCOUNT_ID env var
	// that resolveOrgOverride also honours. Consulting the override first let an
	// unrelated exported org id hijack `login --account <n>` and then fail the
	// identity guard with a misleading "does not match" message. An explicit
	// `--org` cannot reach here alongside a target: parseAuthLoginArgs rejects
	// that combination outright.
	if (targetAccountId) {
		const targetedCandidate = candidates.find(
			(candidate) => candidate.accountId === targetAccountId,
		);
		if (targetedCandidate) {
			return {
				...tokens,
				accountIdOverride: targetedCandidate.accountId,
				// `id_token` candidates auto-follow the access token inside
				// resolveRequestAccountId, which would rewrite this binding back to
				// the access-token account and make the caller's own identity guard
				// reject the write. Pin those as an explicit selection; a `token`
				// candidate already IS the access-token account, and an `org`
				// candidate never auto-follows, so both keep their source.
				accountIdSource:
					targetedCandidate.source === "id_token"
						? "manual"
						: targetedCandidate.source,
				accountLabel: targetedCandidate.label,
				workspaces,
			};
		}
		// The user signed in as somebody else. Fall through to the generic
		// selection so persistAccountPool refuses the write with the precise
		// identity-mismatch message instead of a confusing override error.
	} else {
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
	const displayUrl = redactOAuthUrlForLog(url);
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
				if (!copied) {
					// The redacted line is safe for normal logs, but it cannot complete
					// an incognito/manual handoff. If clipboard access also failed,
					// provide the exact URL as the final recovery path.
					console.log(
						`${stylePromptText(UI_COPY.oauth.goTo, "accent")} ${url}`,
					);
				}
			}
		} else {
			// Manual/incognito sign-in depends on the exact authorization URL. In
			// particular, replacing `state` with a redaction marker causes the
			// provider to return that marker and the callback's CSRF validation must
			// (correctly) reject it. State validation remains strict below; this
			// output simply preserves the value minted for this login attempt.
			console.log(
				`${stylePromptText(UI_COPY.oauth.goTo, "accent")} ${url}`,
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

			// Explain *why* the callback failed before dropping the user into the
			// manual-paste prompt. A contended port 1455 — most often a Windows
			// listener shadowing a WSL one, or vice versa — otherwise presents as
			// an unexplained broken login.
			if (signInMode === "browser") {
				const failureLines = describeCallbackFailure(
					waitingForCallback ? "callback-timeout" : "bind-failed",
					{ bindErrorCode: oauthServer?.bindErrorCode },
				);
				for (const line of failureLines) {
					console.log(line.length > 0 ? stylePromptText(line, "muted") : "");
				}
			}
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
export interface PersistAccountPoolResult {
	/** How the pool absorbed this login (appended, refreshed, or rebound). */
	outcome: PersistAccountPoolOutcome;
	/** Index of the row the login actually wrote. */
	accountIndex: number;
	/** Global selection index after the write. */
	activeIndex: number;
	/**
	 * Whether the written row is the one plain `codex` will use. Callers gate the
	 * ~/.codex/auth.json sync on this: refreshing the active account must publish
	 * its new tokens, and refreshing any other row must not steal the selection.
	 */
	isActiveAccount: boolean;
	/** Whether the written row is enabled for rotation after the write. */
	accountEnabled: boolean;
}

/** @internal */
export type ExpectedLoginAccount = Pick<
	AccountMetadataV3,
	"recordId" | "accountId" | "email" | "refreshToken"
>;

/** @internal */
export interface PersistAccountPoolOptions {
	/** Keep every global/model-family selection on its pre-login identity. */
	preserveSelection?: boolean;
	/** Refuse the write unless the OAuth result is this saved account. */
	expectedAccount?: ExpectedLoginAccount;
	/**
	 * Position {@link expectedAccount} occupied when the caller resolved it.
	 * Treated as a hint that is verified against the row actually sitting there,
	 * never trusted: the pool can change between the caller's read and this
	 * transaction. It exists so an unambiguous positional request such as
	 * `login --account 2` stays deterministic when several saved rows share an
	 * identity, which identity matching alone cannot tell apart.
	 */
	expectedAccountIndex?: number;
}

function sameExpectedLoginIdentity(
	write: ResolvedAccountWrite,
	expected: ExpectedLoginAccount,
): boolean {
	const expectedAccountId = expected.accountId?.trim();
	const incomingAccountId = write.accountId?.trim();
	const expectedEmail = sanitizeEmail(expected.email);
	const incomingEmail = sanitizeEmail(write.email);

	// When the saved row already carries the provider identity it is
	// authoritative and the incoming login must match it: the id survives an
	// email change, and falling back to a shared email across workspaces would
	// let a targeted re-auth overwrite the wrong saved account.
	if (expectedAccountId) {
		return incomingAccountId === expectedAccountId;
	}
	// A pre-#491 row saved before workspace tracking carries no account id at
	// all. Fresh tokens essentially always carry one, so demanding the id on both
	// sides made every legacy row permanently un-refreshable through --account.
	// Email is the only identity such a row has, and the caller already resolved
	// it to a single unambiguous row before starting the sign-in.
	return Boolean(expectedEmail && incomingEmail === expectedEmail);
}

function matchesExpectedAccount(
	account: AccountMetadataV3 | undefined,
	expected: ExpectedLoginAccount,
): boolean {
	if (!account) return false;
	if (expected.recordId && account.recordId) {
		return account.recordId === expected.recordId;
	}
	const expectedAccountId = expected.accountId?.trim();
	const candidateAccountId = account.accountId?.trim();
	if (expectedAccountId || candidateAccountId) {
		return Boolean(
			expectedAccountId &&
				candidateAccountId &&
				expectedAccountId === candidateAccountId,
		);
	}
	const expectedEmail = sanitizeEmail(expected.email);
	const candidateEmail = sanitizeEmail(account.email);
	if (expectedEmail || candidateEmail) {
		return Boolean(expectedEmail && candidateEmail === expectedEmail);
	}
	return account.refreshToken === expected.refreshToken;
}

/**
 * Locate the saved row a targeted re-authentication must write.
 *
 * Resolution is deliberately identity-first and refresh-token-last. The runtime
 * rotation proxy rewrites a stored refreshToken whenever it refreshes an account
 * (AccountManager.commitRefreshedAuth), so a sign-in that overlaps a live codex
 * session would otherwise "lose" its own target and throw away a completed
 * OAuth. `recordId` is exact when both sides have one, the caller's position is
 * honoured only while the row sitting there is still the same identity, and
 * findMatchingAccountIndex supplies the same composite/email/refresh-token
 * ladder the rest of the pool already resolves identities with.
 */
function resolveExpectedAccountIndex(
	accounts: readonly AccountMetadataV3[],
	expected: ExpectedLoginAccount,
	hintedIndex: number | undefined,
): number | undefined {
	if (expected.recordId) {
		const byRecordId = accounts.findIndex(
			(account) => account?.recordId === expected.recordId,
		);
		if (byRecordId >= 0) return byRecordId;
	}
	if (
		validSelectionIndex(hintedIndex, accounts) &&
		matchesExpectedAccount(accounts[hintedIndex], expected)
	) {
		return hintedIndex;
	}
	return findMatchingAccountIndex(
		accounts,
		{
			accountId: expected.accountId,
			email: expected.email,
			refreshToken: expected.refreshToken,
		},
		{ allowUniqueAccountIdFallbackWithoutEmail: true },
	);
}

function validSelectionIndex(
	index: number | undefined,
	accounts: readonly AccountMetadataV3[],
): index is number {
	return (
		typeof index === "number" &&
		Number.isInteger(index) &&
		index >= 0 &&
		index < accounts.length
	);
}

/** @internal */
export async function persistAccountPool(
	results: TokenSuccessWithAccount[],
	replaceAll: boolean,
	options: PersistAccountPoolOptions = {},
): Promise<PersistAccountPoolResult | null> {
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
				// A targeted re-auth only tops up credentials for the row the user
				// named; it must not silently re-enable an account they disabled.
				preserveEnabledState: Boolean(options.expectedAccount),
				now,
			};
		});

		if (options.expectedAccount && writes.length !== 1) {
			throw new CodexValidationError(
				"Targeted re-authentication accepts exactly one OAuth result. No saved credentials were changed.",
			);
		}
		const expectedAccountIndex =
			options.expectedAccount && stored
				? resolveExpectedAccountIndex(
						stored.accounts,
						options.expectedAccount,
						options.expectedAccountIndex,
					)
				: undefined;
		if (options.expectedAccount && expectedAccountIndex === undefined) {
			throw new CodexValidationError(
				"The requested Codex account is no longer present. No saved credentials were changed.",
			);
		}

		const expectedAccount = options.expectedAccount;
		if (
			expectedAccount &&
			writes.some((write) => !sameExpectedLoginIdentity(write, expectedAccount))
		) {
			throw new CodexValidationError(
				"The authenticated Codex identity does not match the account requested for re-authentication. No saved credentials were changed.",
			);
		}

		const { accounts, activeIndex, outcome } = applyAccountPoolResults({
			existing,
			writes,
			priorActiveIndex: stored?.activeIndex,
			findMatchingAccountIndex:
				expectedAccountIndex === undefined
					? findMatchingAccountIndex
					: () => expectedAccountIndex,
		});

		const nextActiveIndex =
			options.preserveSelection &&
			validSelectionIndex(stored?.activeIndex, accounts)
				? stored.activeIndex
				: activeIndex;
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			const priorFamilyIndex =
				stored?.activeIndexByFamily?.[family] ?? stored?.activeIndex;
			activeIndexByFamily[family] =
				options.preserveSelection &&
				validSelectionIndex(priorFamilyIndex, accounts)
					? priorFamilyIndex
					: nextActiveIndex;
		}

		// Reuse the shared persistence clone so the pin/affinity carry-over rule
		// (issue #474) keeps living in exactly one place instead of being
		// re-derived at every write site with a slightly different validity check.
		const nextStorage = cloneAccountStorageForPersistence(stored);
		nextStorage.accounts = accounts;
		nextStorage.activeIndex = nextActiveIndex;
		nextStorage.activeIndexByFamily = activeIndexByFamily;
		// A selection-preserving login leaves the pool exactly where it was, so a
		// manual `switch <n>` pin survives it: login only updates a row in place
		// or appends one and never reorders, so the raw position still points at
		// the row the user pinned even when two rows share an identity.
		//
		// A plain login is the opposite. It moves activeIndex onto the account
		// just signed in and publishes that account to ~/.codex/auth.json.
		// Carrying an old pin through it would leave storage claiming one account
		// is active while the runtime proxy routes every request to another
		// (runtime-rotation-proxy resolves pinnedAccountIndex first) -- the
		// contradiction `status` reports as "runtime using N but pin requests M".
		if (
			!options.preserveSelection ||
			!validSelectionIndex(nextStorage.pinnedAccountIndex, accounts)
		) {
			delete nextStorage.pinnedAccountIndex;
		}

		await persist(nextStorage);

		if (outcome === null) return null;
		return {
			outcome,
			accountIndex: activeIndex,
			activeIndex: nextActiveIndex,
			// The Codex CLI reads the `codex` family selection, so that -- not the
			// bare global index -- decides whether this write owns the native
			// ~/.codex/auth.json credentials.
			isActiveAccount:
				activeIndex === (activeIndexByFamily.codex ?? nextActiveIndex),
			accountEnabled: accounts[activeIndex]?.enabled !== false,
		};
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
