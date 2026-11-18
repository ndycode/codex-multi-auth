import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthServerInfo } from "../types.js";
import { logError, logWarn } from "../logger.js";
import { AUTH_REDIRECT } from "./auth.js";

// Resolve path to oauth-success.html (one level up from auth/ subfolder)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const successHtml = fs.readFileSync(
	path.join(__dirname, "..", "oauth-success.html"),
	"utf-8",
);

/**
 * Host the callback listener actually binds.
 *
 * The registered redirect URI keeps its registered host name
 * (`http://localhost:1455/auth/callback`), but the LISTEN side pins a numeric
 * IPv4 loopback: Node resolves a listen host through DNS, and on a dual-stack
 * host "localhost" may resolve to ::1 first (leaving 127.0.0.1 clients unable
 * to reach the callback) or — with a hostile hosts-file entry — somewhere
 * off-box entirely. We therefore bind BOTH numeric loopbacks: whichever family
 * a resolver picks lands on this listener, and a holder of the other family's
 * same port still surfaces as EADDRINUSE instead of silently receiving the
 * callback code.
 */
const OAUTH_BIND_HOSTS =
	AUTH_REDIRECT.host === "localhost"
		? ["::1", "127.0.0.1"]
		: [AUTH_REDIRECT.host];

/**
 * Start a local HTTP server that captures an OAuth authorization code sent to /auth/callback.
 *
 * The server validates the `state` query parameter, serves a static success page for valid callbacks,
 * and retains a single authorization code on the server instance until consumed via `waitForCode`.
 * Only one code is stored at a time; call `close` to abort polling and shut down the server.
 *
 * On platforms such as Windows, binding the callback port may fail if another process holds it
 * or if firewall/antivirus restrictions prevent local binding; in that case the returned `ready`
 * flag is `false` to allow a manual paste fallback.
 *
 * Captured authorization codes are secrets and must be treated accordingly; callers should redact
 * them from logs and error messages.
 *
 * @param options - Object with a `state` string used to validate the OAuth redirect
 * @returns An OAuthServerInfo describing the server: `port` (1455), `ready` (boolean), a `close`
 *          function to abort polling and close the server, and `waitForCode` which returns
 *          `{ code: string }` when a code becomes available or `null` on timeout/abort.
 */
export async function startLocalOAuthServer({
	state,
}: {
	state: string;
}): Promise<OAuthServerInfo> {
	let pollAborted = false;
	// Capture the authorization code/state in per-call closure variables rather
	// than mutating the shared http.Server instance. Two logins in the same
	// process previously cross-bound callback state via server._lastCode/
	// _lastState; isolating them here keeps concurrent server instances
	// independent.
	let capturedCode: string | undefined;
	let capturedState: string | undefined;
	const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
		try {
			const url = new URL(req.url || "", AUTH_REDIRECT.origin);
			if (url.pathname !== AUTH_REDIRECT.path) {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.end("State mismatch");
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.end("Missing authorization code");
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.setHeader("X-Frame-Options", "DENY");
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.setHeader(
				"Content-Security-Policy",
				"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			);
			res.end(successHtml);
			if (capturedCode) {
				logWarn(
					"Duplicate OAuth callback received; preserving first authorization code",
				);
				return;
			}
			capturedCode = code;
			capturedState = state;
		} catch (err) {
			logError(
				`Request handler error: ${(err as Error)?.message ?? String(err)}`,
			);
			res.statusCode = 500;
			res.end("Internal error");
		}
	};

	const attempts = OAUTH_BIND_HOSTS.map((host) => {
		const candidate = http.createServer(requestHandler);
		candidate.unref();
		const bound = new Promise<{
			server: http.Server;
			ok: boolean;
			code?: string;
		}>((settle) => {
			candidate.on("error", (err: NodeJS.ErrnoException) => {
				settle({ server: candidate, ok: false, code: err?.code });
			});
			candidate.listen(AUTH_REDIRECT.port, host, () => {
				settle({ server: candidate, ok: true });
			});
		});
		return { candidate, bound };
	});
	const servers = attempts.map((attempt) => attempt.candidate);

	const closeAll = () => {
		for (const candidate of servers) {
			try {
				candidate.close();
			} catch (closeErr) {
				logError(
					`Failed to close OAuth server: ${(closeErr as Error)?.message ?? String(closeErr)}`,
				);
			}
		}
	};

	const waitForCode = async (expectedState: string) => {
		const POLL_INTERVAL_MS = 100;
		const TIMEOUT_MS = 5 * 60 * 1000;
		const maxIterations = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS);
		const poll = () =>
			new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
		for (let i = 0; i < maxIterations; i++) {
			if (pollAborted) return null;
			const lastCode = capturedCode;
			if (lastCode) {
				if (capturedState !== expectedState) {
					logWarn(
						"Discarding OAuth callback due to state mismatch in waitForCode",
					);
					return null;
				}
				return { code: lastCode };
			}
			await poll();
		}
		logWarn("OAuth poll timeout after 5 minutes");
		return null;
	};

	const outcomes = await Promise.all(attempts.map((attempt) => attempt.bound));

	const inUse = outcomes.find((outcome) => outcome.code === "EADDRINUSE");
	const bound = outcomes
		.filter((outcome) => outcome.ok)
		.map((outcome) => outcome.server);

	if (inUse || bound.length === 0) {
		// A holder on ANY loopback family conflicts with the registered callback
		// URI — surface it instead of degrading to whichever family was free.
		// When nothing bound, report the first error observed.
		const code =
			inUse?.code ?? outcomes.find((outcome) => !outcome.ok)?.code;
		logError(
			`Failed to bind ${AUTH_REDIRECT.origin} (${code}). Falling back to manual paste.`,
		);
		for (const candidate of bound) {
			try {
				candidate.close();
			} catch {
				// Best effort — the port was never ours to keep anyway.
			}
		}
		return {
			port: AUTH_REDIRECT.port,
			ready: false,
			bindErrorCode: code,
			close: () => {
				pollAborted = true;
				closeAll();
			},
			waitForCode: (_expectedState: string) => Promise.resolve(null),
		};
	}

	return {
		port: AUTH_REDIRECT.port,
		ready: true,
		close: () => {
			pollAborted = true;
			closeAll();
		},
		waitForCode,
	};
}
