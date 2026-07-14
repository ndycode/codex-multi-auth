/**
 * Operator-facing guidance for OAuth callback failures on the fixed callback port.
 *
 * The redirect URI is registered with the provider, so the port cannot be
 * negotiated away when it is contended. The best the CLI can do is name the
 * likely conflict and point at a flow that does not need the port at all.
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
const INSPECT_LINUX = `  Linux / WSL:           ss -lptn 'sport = :${AUTH_REDIRECT.port}'`;
const INSPECT_DARWIN = `  macOS:                 lsof -nP -iTCP:${AUTH_REDIRECT.port} -sTCP:LISTEN`;
const USE_DEVICE_AUTH =
	"  Or sign in without the callback port: codex-multi-auth login --device-auth";

/**
 * The commands that would reveal a listener on the callback port here.
 *
 * Inside WSL both sides of the boundary are worth checking, because the
 * offending listener is usually the one on the Windows host.
 */
function inspectCommands(): string[] {
	if (isWsl()) return [INSPECT_WINDOWS, INSPECT_LINUX];
	if (process.platform === "win32") return [INSPECT_WINDOWS];
	if (process.platform === "darwin") return [INSPECT_DARWIN];
	return [INSPECT_LINUX];
}

/**
 * Why a listener on the other side of the Windows/WSL boundary may be at fault.
 *
 * @returns Explanatory lines, or an empty array when no WSL boundary is in play.
 */
function crossBoundaryNote(): string[] {
	if (isWsl()) {
		const distro = getWslDistroName();
		const where = distro ? `WSL (${distro})` : "WSL";
		return [
			`You are running inside ${where}, but the browser opens on the Windows host.`,
			`Windows and ${where} contend for localhost:${AUTH_REDIRECT.port}, so a codex-multi-auth`,
			"or Codex login or proxy on the Windows side can take the callback meant for this one.",
		];
	}
	if (process.platform === "win32") {
		return [
			`A codex-multi-auth login or proxy running inside WSL can also hold port ${AUTH_REDIRECT.port}.`,
		];
	}
	return [];
}

/**
 * Build the lines shown to the user when a browser OAuth callback fails.
 *
 * Contention is only *asserted* when it was actually observed — that is, the
 * listen failed with `EADDRINUSE`. A callback that never arrives is far more
 * often a cancelled or abandoned sign-in than a stolen redirect, so that case
 * is phrased as a conditional ("if you completed sign-in and still landed
 * here") rather than a diagnosis.
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

	if (reason === "bind-failed") {
		// A failed listen is hard evidence: something is on the port right now.
		if (context.bindErrorCode === "EADDRINUSE") {
			return [
				`Could not listen on port ${port} for the OAuth callback — another process already holds it.`,
				...crossBoundaryNote(),
				"",
				`Find the listener:`,
				...inspectCommands(),
				"",
				"Close it, then retry.",
				USE_DEVICE_AUTH,
			];
		}

		return [
			`Could not listen on port ${port} for the OAuth callback${
				context.bindErrorCode ? ` (${context.bindErrorCode})` : ""
			}.`,
			"",
			"The callback port is fixed by the provider and cannot be changed.",
			USE_DEVICE_AUTH,
		];
	}

	// The listener bound cleanly and nothing arrived. Usually the sign-in was
	// simply cancelled or abandoned — say so first, and do not misdiagnose it.
	return [
		`No OAuth callback arrived on port ${port} before the sign-in window closed.`,
		"",
		"If you closed or cancelled the browser sign-in, just run login again.",
		"",
		"If you completed sign-in in the browser and still landed here, something else",
		`may have taken the callback on port ${port}:`,
		...crossBoundaryNote(),
		...inspectCommands(),
		"",
		USE_DEVICE_AUTH,
	];
}
