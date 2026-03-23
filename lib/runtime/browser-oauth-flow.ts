import type { TokenResult } from "../types.js";

export async function runBrowserOAuthFlow(params: {
	forceNewLogin?: boolean;
	createAuthorizationFlow: (options: {
		forceNewLogin: boolean;
	}) => Promise<{ pkce: { verifier: string }; state: string; url: string }>;
	logInfo: (message: string) => void;
	redactOAuthUrlForLog: (url: string) => string;
	startLocalOAuthServer: (options: { state: string }) => Promise<{
		ready: boolean;
		close: () => void;
		waitForCode: (state: string) => Promise<{ code: string } | null>;
	}>;
	logDebug: (message: string) => void;
	openBrowserUrl: (url: string) => void;
	pluginName: string;
	authManualLabel: string;
	logWarn: (message: string) => void;
	exchangeAuthorizationCode: (
		code: string,
		verifier: string,
		redirectUri: string,
	) => Promise<TokenResult>;
	redirectUri: string;
}): Promise<TokenResult> {
	const { pkce, state, url } = await params.createAuthorizationFlow({
		forceNewLogin: params.forceNewLogin ?? false,
	});
	params.logInfo(`OAuth URL: ${params.redactOAuthUrlForLog(url)}`);

	let serverInfo: Awaited<
		ReturnType<typeof params.startLocalOAuthServer>
	> | null = null;
	try {
		serverInfo = await params.startLocalOAuthServer({ state });
	} catch (err) {
		params.logDebug(
			`[${params.pluginName}] Failed to start OAuth server: ${(err as Error)?.message ?? String(err)}`,
		);
		serverInfo = null;
	}

	if (!serverInfo || !serverInfo.ready) {
		serverInfo?.close();
		params.logWarn(
			`\n[${params.pluginName}] OAuth callback server failed to start. Please retry with "${params.authManualLabel}".\n`,
		);
		return { type: "failed" as const };
	}

	params.openBrowserUrl(url);
	const result = await serverInfo.waitForCode(state);
	serverInfo.close();

	if (!result) {
		return {
			type: "failed" as const,
			reason: "unknown" as const,
			message: "OAuth callback timeout or cancelled",
		};
	}

	return params.exchangeAuthorizationCode(
		result.code,
		pkce.verifier,
		params.redirectUri,
	);
}
