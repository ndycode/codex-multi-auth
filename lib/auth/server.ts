import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthServerInfo } from "../types.js";
import { logError, logWarn } from "../logger.js";

// Resolve path to oauth-success.html (one level up from auth/ subfolder)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const successHtml = fs.readFileSync(path.join(__dirname, "..", "oauth-success.html"), "utf-8");

/**
 * Start a local HTTP server that captures an OAuth authorization code sent to /auth/callback.
 *
 * The server validates the `state` query parameter, serves a static success page for valid callbacks,
 * and retains a single authorization code on the server instance until consumed via `waitForCode`.
 * Only one code is stored at a time; call `close` to abort polling and shut down the server.
 *
 * On platforms such as Windows, binding to 127.0.0.1:1455 may fail if another process holds the port
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
export function startLocalOAuthServer({ state }: { state: string }): Promise<OAuthServerInfo> {
	let pollAborted = false;
	const server = http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
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
			const trackedServer = server as http.Server & { _lastCode?: string };
			if (trackedServer._lastCode) {
				logWarn("Duplicate OAuth callback received; preserving first authorization code");
				return;
			}
			trackedServer._lastCode = code;
		} catch (err) {
			logError(`Request handler error: ${(err as Error)?.message ?? String(err)}`);
			res.statusCode = 500;
			res.end("Internal error");
		}
	});

	server.unref();

	return new Promise((resolve) => {
		server
			.listen(1455, "127.0.0.1", () => {
				resolve({
					port: 1455,
					ready: true,
					close: () => {
						pollAborted = true;
						server.close();
					},
					waitForCode: async () => {
						const POLL_INTERVAL_MS = 100;
						const TIMEOUT_MS = 5 * 60 * 1000;
						const maxIterations = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS);
						const poll = () => new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
						for (let i = 0; i < maxIterations; i++) {
							if (pollAborted) return null;
							const lastCode = (server as http.Server & { _lastCode?: string })._lastCode;
							if (lastCode) return { code: lastCode };
							await poll();
						}
						logWarn("OAuth poll timeout after 5 minutes");
						return null;
					},
				});
			})
			.on("error", (err: NodeJS.ErrnoException) => {
				logError(
					`Failed to bind http://127.0.0.1:1455 (${err?.code}). Falling back to manual paste.`,
				);
				resolve({
					port: 1455,
					ready: false,
					close: () => {
						pollAborted = true;
						try {
							server.close();
						} catch (closeErr) {
							logError(
								`Failed to close OAuth server: ${(closeErr as Error)?.message ?? String(closeErr)}`,
							);
						}
					},
					waitForCode: () => Promise.resolve(null),
				});
			});
	});
}
