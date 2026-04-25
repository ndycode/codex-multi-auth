import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { HTTP_STATUS } from "../lib/constants.js";
import type { RuntimeRotationProxyServer } from "../lib/runtime-rotation-proxy.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const openServers: RuntimeRotationProxyServer[] = [];

function createStorage(now: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "account-1@example.com",
				accountId: "acc_1",
				refreshToken: "refresh-1",
				accessToken: "access-1",
				expiresAt: now + 3_600_000,
				addedAt: now - 60_000,
				lastUsed: now - 60_000,
				enabled: true,
			},
		],
	};
}

afterEach(async () => {
	for (const proxy of openServers.splice(0, openServers.length)) {
		await proxy.close();
	}
	vi.doUnmock("node:crypto");
	vi.resetModules();
});

describe("runtime rotation proxy client auth comparison", () => {
	it("still performs a timing-safe comparison for mismatched token lengths", async () => {
		vi.resetModules();
		const timingSafeEqualMock = vi.fn(
			(left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
				expect(left.byteLength).toBe(right.byteLength);
				return false;
			},
		);
		vi.doMock("node:crypto", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:crypto")>();
			return {
				...actual,
				timingSafeEqual: timingSafeEqualMock,
			};
		});
		const { startRuntimeRotationProxy } = await import(
			"../lib/runtime-rotation-proxy.js"
		);
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const fetchImpl = vi.fn<typeof fetch>();
		const proxy = await startRuntimeRotationProxy({
			accountManager,
			clientApiKey: "runtime-secret-with-longer-length",
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
		});
		openServers.push(proxy);

		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer short",
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "gpt-5-codex" }),
		});

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(timingSafeEqualMock).toHaveBeenCalledTimes(1);
	});
});
