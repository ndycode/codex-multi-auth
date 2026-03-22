import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	REDIRECT_URI,
	redactOAuthUrlForLog,
} from "../auth/auth.js";
import { openBrowserUrl } from "../auth/browser.js";
import { startLocalOAuthServer } from "../auth/server.js";
import type { TokenResult } from "../types.js";

export async function runOAuthBrowserFlow(deps: {
	forceNewLogin?: boolean;
	manualModeLabel: string;
	logInfo: (message: string) => void;
	logDebug: (message: string) => void;
	logWarn: (message: string) => void;
}): Promise<TokenResult> {
	const { pkce, state, url } = await createAuthorizationFlow({
		forceNewLogin: deps.forceNewLogin ?? false,
	});
	deps.logInfo(`OAuth URL: ${redactOAuthUrlForLog(url)}`);

	let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null =
		null;
	try {
		serverInfo = await startLocalOAuthServer({ state });
	} catch (err) {
		deps.logDebug(
			`Failed to start OAuth server: ${(err as Error)?.message ?? String(err)}`,
		);
		serverInfo = null;
	}
	openBrowserUrl(url);

	if (!serverInfo || !serverInfo.ready) {
		serverInfo?.close();
		deps.logWarn(
			`\nOAuth callback server failed to start. Please retry with "${deps.manualModeLabel}".\n`,
		);
		return { type: "failed" as const };
	}

	const result = await serverInfo.waitForCode(state);
	serverInfo.close();

	if (!result) {
		return {
			type: "failed" as const,
			reason: "unknown" as const,
			message: "OAuth callback timeout or cancelled",
		};
	}

	return exchangeAuthorizationCode(result.code, pkce.verifier, REDIRECT_URI);
}
