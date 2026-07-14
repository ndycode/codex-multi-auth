/**
 * Operator-facing guidance for OAuth callback failures on the fixed callback port.
 *
 * The redirect URI is registered with the provider, so the port cannot be
 * negotiated away when it is contended. The best the CLI can do is name the
 * conflict and point at a flow that does not need the port at all.
 *
 * Windows and WSL contend for that port as far as a browser running on the
 * Windows host is concerned, so a listener on either side can swallow a callback
 * intended for the other. From inside the distro this is invisible: the WSL
 * listener binds cleanly and simply never receives the redirect.
 */

import { AUTH_REDIRECT } from "./auth.js";
import { getWslDistroName, isWsl } from "../wsl.js";

/**
 * Why the browser callback did not produce an authorization code.
 *
 * - `bind-failed`: the local listener could not take the callback port at all.
 * - `callback-timeout`: the listener bound, but no redirect ever arrived.
 */
export type CallbackFailureReason = "bind-failed" | "callback-timeout";

/** @internal */
export type CallbackFailureContext = {
	/** `errno` code from a failed listen, when one is known. */
	bindErrorCode?: string;
};

const INSPECT_WINDOWS = `  Windows (PowerShell):  Get-NetTCPConnection -LocalPort ${AUTH_REDIRECT.port}`;
const INSPECT_LINUX = `  WSL / Linux:           ss -lptn 'sport = :${AUTH_REDIRECT.port}'`;
const USE_DEVICE_AUTH =
	"  Or sign in without the callback port: codex-multi-auth login --device-auth";

/**
 * Build the lines shown to the user when a browser OAuth callback fails.
 *
 * Port contention is only asserted when it is actually observed (`EADDRINUSE`)
 * or when the callback never arrived despite a clean bind — the shape of a
 * cross-boundary Windows/WSL hijack.
 *
 * @param reason - Which half of the callback flow broke.
 * @param context - Extra detail from the failed bind, when available.
 * @returns Guidance lines. Empty strings are intentional blank separators.
 */
export function describeCallbackFailure(
	reason: CallbackFailureReason,
	context: CallbackFailureContext = {},
): string[] {
	const port = AUTH_REDIRECT.port;
	const portIsContended =
		reason === "callback-timeout" || context.bindErrorCode === "EADDRINUSE";
	const lines: string[] = [];

	if (reason === "bind-failed") {
		lines.push(
			portIsContended
				? `Could not listen on port ${port} for the OAuth callback — something else already holds it.`
				: `Could not listen on port ${port} for the OAuth callback${
						context.bindErrorCode ? ` (${context.bindErrorCode})` : ""
					}.`,
		);
	} else {
		lines.push(
			`No OAuth callback arrived on port ${port} before the sign-in window closed.`,
		);
	}

	if (!portIsContended) {
		lines.push(
			"",
			`The callback port is fixed by the provider and cannot be changed.`,
			USE_DEVICE_AUTH,
		);
		return lines;
	}

	if (isWsl()) {
		const distro = getWslDistroName();
		const where = distro ? `WSL (${distro})` : "WSL";
		lines.push(
			`You are running inside ${where}, but the browser opens on the Windows host.`,
			`Windows and ${where} contend for localhost:${port}, so a codex-multi-auth or Codex`,
			"login or proxy running on the Windows side can take the callback meant for this one.",
			"From in here that is indistinguishable from a broken login.",
			"",
			`Check both sides for a listener on port ${port}:`,
			INSPECT_WINDOWS,
			INSPECT_LINUX,
			"",
			"Close the Windows-side login or proxy, then retry.",
			USE_DEVICE_AUTH,
		);
		return lines;
	}

	lines.push(
		"",
		`Check for another process holding port ${port}:`,
		process.platform === "win32" ? INSPECT_WINDOWS : INSPECT_LINUX,
		"",
		"On a Windows host, a codex-multi-auth login or proxy running inside WSL can also hold it.",
		"Close the other listener, then retry.",
		USE_DEVICE_AUTH,
	);
	return lines;
}
