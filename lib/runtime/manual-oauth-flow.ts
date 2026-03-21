import {
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	REDIRECT_URI,
} from "../auth/auth.js";
import type { TokenResult } from "../types.js";
import {
	resolveAccountSelection,
	type TokenSuccessWithAccount,
} from "./account-selection.js";

export function buildManualOAuthFlow(
	pkce: { verifier: string },
	url: string,
	expectedState: string,
	deps: {
		instructions: string;
		logInfo: (message: string) => void;
		onSuccess?: (tokens: TokenSuccessWithAccount) => Promise<void>;
	},
) {
	return {
		url,
		method: "code" as const,
		instructions: deps.instructions,
		validate: (input: string): string | undefined => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) {
				return `No authorization code found. Paste the full callback URL (e.g., ${REDIRECT_URI}?code=...)`;
			}
			if (!parsed.state) {
				return "Missing OAuth state. Paste the full callback URL including both code and state parameters.";
			}
			if (parsed.state !== expectedState) {
				return "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt.";
			}
			return undefined;
		},
		callback: async (
			input: string,
		): Promise<TokenResult> => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code || !parsed.state) {
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message: "Missing authorization code or OAuth state",
				};
			}
			if (parsed.state !== expectedState) {
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message: "OAuth state mismatch. Restart login and try again.",
				};
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type === "success") {
				const resolved = resolveAccountSelection(tokens, {
					logInfo: deps.logInfo,
				});
				if (deps.onSuccess) {
					await deps.onSuccess(resolved);
				}
				return resolved;
			}
			return tokens?.type === "failed" ? tokens : { type: "failed" as const };
		},
	};
}
