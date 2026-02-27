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
 * Start a local HTTP listener that accepts the OAuth redirect on /auth/callback and provides helpers to obtain the authorization code.
 *
 * The server binds to 127.0.0.1:1455 and validates the `state` query parameter before capturing the `code`. The resolved object exposes `port`, `ready`, `close()`, and `waitForCode()`; `waitForCode()` polls for a captured code for up to 5 minutes and returns `{ code }` or `null`. Concurrency: the implementation expects a single consumer of `waitForCode()` (it returns the first captured code). No filesystem side effects are performed (Windows path semantics are not relevant). Authorization codes are handled in-memory and are not logged by this module; callers should avoid logging or persisting returned codes to prevent accidental token leakage.
 *
 * @param state - The expected OAuth `state` value used to validate incoming callback requests
 * @returns An object with runtime info and helpers:
 *          - `port`: 1455
 *          - `ready`: `true` if the server successfully bound to the port, `false` if binding failed and manual paste is required
 *          - `close()`: stops the server and aborts any pending polling
 *          - `waitForCode()`: polls for the authorization code and resolves to `{ code }` when received or `null` on abort/timeout
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
			(server as http.Server & { _lastCode?: string })._lastCode = code;
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
					} catch (err) {
					logError(`Failed to close OAuth server: ${(err as Error)?.message ?? String(err)}`);
					}
				},
					waitForCode: () => Promise.resolve(null),
				});
			});
	});
}
