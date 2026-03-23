import {
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	REDIRECT_URI,
} from "../auth/auth.js";
import {
	getAccountIdCandidates,
	selectBestAccountCandidate,
} from "../auth/token-utils.js";
import type { TokenResult } from "../types.js";
import {
	resolveAccountSelection,
	type TokenSuccessWithAccount,
} from "./account-selection.js";

type TokenSuccess = Extract<TokenResult, { type: "success" }>;
type RuntimeResolvedToken = TokenSuccessWithAccount<TokenSuccess>;

type ManualOAuthFlow<TResolved extends TokenSuccess> = {
	url: string;
	method: "code";
	instructions: string;
	validate: (input: string) => string | undefined;
	callback: (input: string) => Promise<TokenResult | TResolved>;
};

type ManualOAuthFlowParams<TResolved extends TokenSuccess> = {
	pkce: { verifier: string };
	url: string;
	expectedState: string;
	redirectUri: string;
	parseAuthorizationInput: (input: string) => {
		code?: string;
		state?: string;
	};
	exchangeAuthorizationCode: (
		code: string,
		verifier: string,
		redirectUri: string,
	) => Promise<TokenResult>;
	resolveTokenSuccess: (tokens: TokenSuccess) => TResolved;
	onSuccess?: (tokens: TResolved) => Promise<void>;
	instructions: string;
};

type RuntimeManualOAuthFlowDeps = {
	instructions: string;
	logInfo: (message: string) => void;
	onSuccess?: (tokens: RuntimeResolvedToken) => Promise<void>;
};

function buildManualOAuthFlowFromParams<TResolved extends TokenSuccess>(
	params: ManualOAuthFlowParams<TResolved>,
): ManualOAuthFlow<TResolved> {
	return {
		url: params.url,
		method: "code",
		instructions: params.instructions,
		validate: (input: string): string | undefined => {
			const parsed = params.parseAuthorizationInput(input);
			if (!parsed.code) {
				return `No authorization code found. Paste the full callback URL (e.g., ${params.redirectUri}?code=...)`;
			}
			if (!parsed.state) {
				return "Missing OAuth state. Paste the full callback URL including both code and state parameters.";
			}
			if (parsed.state !== params.expectedState) {
				return "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt.";
			}
			return undefined;
		},
		callback: async (input: string): Promise<TokenResult | TResolved> => {
			const parsed = params.parseAuthorizationInput(input);
			if (!parsed.code || !parsed.state) {
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message: "Missing authorization code or OAuth state",
				};
			}
			if (parsed.state !== params.expectedState) {
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message: "OAuth state mismatch. Restart login and try again.",
				};
			}
			const tokens = await params.exchangeAuthorizationCode(
				parsed.code,
				params.pkce.verifier,
				params.redirectUri,
			);
			if (tokens?.type === "success") {
				const resolved = params.resolveTokenSuccess(tokens);
				if (params.onSuccess) {
					await params.onSuccess(resolved);
				}
				return resolved;
			}
			return tokens?.type === "failed" ? tokens : { type: "failed" as const };
		},
	};
}

export function buildManualOAuthFlow<TResolved extends TokenSuccess>(
	params: ManualOAuthFlowParams<TResolved>,
): ManualOAuthFlow<TResolved>;

export function buildManualOAuthFlow(
	pkce: { verifier: string },
	url: string,
	expectedState: string,
	deps: RuntimeManualOAuthFlowDeps,
): ManualOAuthFlow<RuntimeResolvedToken>;

export function buildManualOAuthFlow<TResolved extends TokenSuccess>(
	paramsOrPkce: ManualOAuthFlowParams<TResolved> | { verifier: string },
	url?: string,
	expectedState?: string,
	deps?: RuntimeManualOAuthFlowDeps,
): ManualOAuthFlow<TResolved | RuntimeResolvedToken> {
	if (typeof url === "string" && typeof expectedState === "string" && deps) {
		return buildManualOAuthFlowFromParams<RuntimeResolvedToken>({
			pkce: paramsOrPkce as { verifier: string },
			url,
			expectedState,
			redirectUri: REDIRECT_URI,
			parseAuthorizationInput,
			exchangeAuthorizationCode,
			resolveTokenSuccess: (tokens) =>
				resolveAccountSelection(tokens, {
					envAccountId: process.env.CODEX_AUTH_ACCOUNT_ID,
					logInfo: deps.logInfo,
					getAccountIdCandidates,
					selectBestAccountCandidate,
				}),
			onSuccess: deps.onSuccess,
			instructions: deps.instructions,
		});
	}

	return buildManualOAuthFlowFromParams(
		paramsOrPkce as ManualOAuthFlowParams<TResolved>,
	);
}
