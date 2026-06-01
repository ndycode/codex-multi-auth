/**
 * Integration test for OAuth server flow
 * Tests the local HTTP callback server used for OAuth authentication
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { startLocalOAuthServer } from "../lib/auth/server.js";

const OAUTH_PORT = 1455;

/**
 * Wait until the OAuth port is actually free again.
 *
 * `startLocalOAuthServer().close()` stops accepting connections but releases the
 * listening socket asynchronously (via the server's close callback), and the test
 * helper does not await it. Each `it()` here binds the same fixed port 1455, so
 * without waiting for release the next bind can intermittently hit EADDRINUSE under
 * full-suite load. This polls a throwaway listener until the port binds cleanly,
 * making teardown deterministic (hardens the tests-ci-03 fragility).
 */
async function waitForPortFree(port: number, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const free = await new Promise<boolean>((resolve) => {
			const probe = http.createServer();
			probe.once("error", () => {
				probe.close();
				resolve(false);
			});
			probe.listen(port, "127.0.0.1", () => {
				probe.close(() => resolve(true));
			});
		});
		if (free) return;
		if (Date.now() >= deadline) {
			// Fail loudly instead of returning best-effort: a port that never frees
			// means the next case starts with 1455 occupied and hits the same
			// intermittent EADDRINUSE race this helper exists to prevent.
			throw new Error(
				`Port ${port} did not free within ${timeoutMs}ms during test teardown.`,
			);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("OAuth Server Integration", () => {
	let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;

	afterEach(async () => {
		if (serverInfo) {
			serverInfo.close();
			serverInfo = null;
			await waitForPortFree(OAUTH_PORT);
		}
	});

	it("should start server and handle valid OAuth callback", async () => {
		const testState = "test-state-12345";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);
		expect(serverInfo.port).toBe(1455);

		// Simulate OAuth callback
		const testCode = "auth-code-67890";
		const callbackUrl = `http://localhost:1455/auth/callback?code=${testCode}&state=${testState}`;

		const response = await fetch(callbackUrl);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");

		// Server should have captured the code
		const result = await serverInfo.waitForCode(testState);
		expect(result).toEqual({ code: testCode });
	});

	it("should reject callback with wrong state", async () => {
		const testState = "correct-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const callbackUrl = `http://localhost:1455/auth/callback?code=test&state=wrong-state`;
		const response = await fetch(callbackUrl);
		expect(response.status).toBe(400);

		const body = await response.text();
		expect(body).toContain("State mismatch");
	});

	it("should reject callback without code", async () => {
		const testState = "test-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const callbackUrl = `http://localhost:1455/auth/callback?state=${testState}`;
		const response = await fetch(callbackUrl);
		expect(response.status).toBe(400);

		const body = await response.text();
		expect(body).toContain("Missing authorization code");
	});

	it("should return 404 for non-callback paths", async () => {
		const testState = "test-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const response = await fetch("http://localhost:1455/other-path");
		expect(response.status).toBe(404);
	});

	it("should handle server cleanup properly", async () => {
		const testState = "cleanup-test";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		// Close should work without error
		serverInfo.close();

		// Subsequent requests should fail (server closed)
		await expect(
			fetch("http://localhost:1455/auth/callback?code=test&state=test")
		).rejects.toThrow();

		serverInfo = null; // Prevent double-close in afterEach
	});
});
