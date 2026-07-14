/**
 * Integration coverage for the contended-callback-port path (issue #630).
 *
 * Binds the real callback port first, then asks the OAuth server to take it.
 * This is the half of the Windows/WSL conflict that can be reproduced on a
 * single host: whoever holds port 1455 wins, and the loser must be able to say
 * so rather than silently degrading.
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { startLocalOAuthServer } from "../lib/auth/server.js";
import { AUTH_REDIRECT } from "../lib/auth/auth.js";
import { describeCallbackFailure } from "../lib/auth/callback-guidance.js";

const squatters: net.Server[] = [];

/** Occupy the OAuth callback port, standing in for the other environment. */
async function squatOnCallbackPort(): Promise<void> {
	const server = net.createServer();
	squatters.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(AUTH_REDIRECT.port, AUTH_REDIRECT.host, resolve);
	});
}

afterEach(async () => {
	await Promise.all(
		squatters.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

describe("OAuth callback server under port contention", () => {
	it("reports EADDRINUSE instead of pretending to be ready", async () => {
		await squatOnCallbackPort();

		const info = await startLocalOAuthServer({ state: "test-state" });

		expect(info.ready).toBe(false);
		expect(info.bindErrorCode).toBe("EADDRINUSE");
		expect(info.port).toBe(AUTH_REDIRECT.port);
		// A server that never bound must not strand the caller waiting for a code.
		await expect(info.waitForCode("test-state")).resolves.toBeNull();
		info.close();
	});

	it("feeds the bind error into guidance that names the conflict", async () => {
		await squatOnCallbackPort();

		const info = await startLocalOAuthServer({ state: "test-state" });
		// This is the exact wiring lib/codex-manager/login-oauth.ts performs.
		const guidance = describeCallbackFailure("bind-failed", {
			bindErrorCode: info.bindErrorCode,
		}).join("\n");

		expect(guidance).toContain("another process already holds it");
		expect(guidance).toContain(String(AUTH_REDIRECT.port));
		expect(guidance).toContain("--device-auth");
		info.close();
	});

	it("binds cleanly and exposes no bind error when the port is free", async () => {
		const info = await startLocalOAuthServer({ state: "test-state" });

		expect(info.ready).toBe(true);
		expect(info.bindErrorCode).toBeUndefined();
		info.close();
	});
});
