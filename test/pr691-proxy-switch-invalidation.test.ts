import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { PreemptiveQuotaScheduler } from "../lib/preemptive-quota-scheduler.js";
import {
	buildQuotaScheduleAccountPrefix,
	resetPinCacheForTesting,
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";

const { saveAccountsMock, withAccountStorageTransactionMock } = vi.hoisted(
	() => ({
		saveAccountsMock: vi.fn(),
		withAccountStorageTransactionMock: vi.fn(),
	}),
);

// The proxy's own debounced saves are irrelevant here and would race the
// hand-written storage file this test uses as the CLI's output.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

const CLIENT_API_KEY = "runtime-secret";
const openServers: RuntimeRotationProxyServer[] = [];
const tmpDirs: string[] = [];

function createStorage(count: number): AccountStorageV3 {
	const now = Date.now();
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000 - index,
			lastUsed: now - 60_000,
			enabled: true,
		})),
	};
}

function writeStorage(path: string, storage: AccountStorageV3): void {
	writeFileSync(path, JSON.stringify(storage), "utf8");
	// The proxy caches metadata by content hash; drop it so the next request
	// observes the file the "CLI" just wrote.
	resetPinCacheForTesting();
}

function makeStoragePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pr691-proxy-"));
	tmpDirs.push(dir);
	return join(dir, "openai-codex-accounts.json");
}

function streamingFetch(): typeof fetch {
	return (async () =>
		new Response("data: {}\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as unknown as typeof fetch;
}

async function postResponses(
	proxy: RuntimeRotationProxyServer,
): Promise<Response> {
	return fetch(`${proxy.baseUrl}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_API_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: "gpt-5.6", input: "hi" }),
	});
}

beforeEach(() => {
	resetPinCacheForTesting();
	saveAccountsMock.mockReset();
	saveAccountsMock.mockResolvedValue(undefined);
	withAccountStorageTransactionMock.mockReset();
	withAccountStorageTransactionMock.mockImplementation(async (handler) =>
		handler(null, async () => undefined),
	);
});

afterEach(async () => {
	for (const proxy of openServers.splice(0, openServers.length)) {
		await proxy.close();
	}
	resetPinCacheForTesting();
	setStoragePathDirect(null);
	vi.restoreAllMocks();
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("runtime proxy quota invalidation on an observed switch", () => {
	it("clears only the switched account's observations when the pin resolves", async () => {
		const path = makeStoragePath();
		const storage = createStorage(2);
		writeStorage(path, storage);
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const clearByPrefix = vi.spyOn(
			PreemptiveQuotaScheduler.prototype,
			"clearByPrefix",
		);
		const clearAll = vi.spyOn(PreemptiveQuotaScheduler.prototype, "clearAll");

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl: streamingFetch(),
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
		});
		openServers.push(proxy);

		writeStorage(path, {
			...storage,
			pinnedAccountIndex: 1,
			affinityGeneration: 1,
		});
		await postResponses(proxy);

		const switched = accountManager.getAccountByIndex(1);
		if (!switched) throw new Error("fixture account missing");
		expect(clearByPrefix).toHaveBeenCalledWith(
			buildQuotaScheduleAccountPrefix(switched),
		);
		expect(clearAll).not.toHaveBeenCalled();
	});

	it("clears every observation when the switched index is out of range", async () => {
		// Regression: this long-lived proxy re-reads only pin/gen, never the
		// account list, so a `login` that appended an account before the `switch`
		// leaves the new index unresolvable here. The generation only bumps on the
		// NEXT switch, so advancing the watermark without clearing anything
		// stranded the pre-switch quota observation forever and the proxy kept
		// deferring, which is the exact symptom this PR set out to fix.
		const path = makeStoragePath();
		const storage = createStorage(1);
		writeStorage(path, storage);
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const clearAll = vi.spyOn(PreemptiveQuotaScheduler.prototype, "clearAll");

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl: streamingFetch(),
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
		});
		openServers.push(proxy);

		expect(accountManager.getAccountByIndex(1)).toBeNull();
		writeStorage(path, {
			...storage,
			pinnedAccountIndex: 1,
			affinityGeneration: 1,
		});
		await postResponses(proxy);

		expect(clearAll).toHaveBeenCalled();
	});

	it("does not invalidate anything when the generation has not advanced", async () => {
		const path = makeStoragePath();
		const storage = createStorage(2);
		writeStorage(path, storage);
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const clearByPrefix = vi.spyOn(
			PreemptiveQuotaScheduler.prototype,
			"clearByPrefix",
		);
		const clearAll = vi.spyOn(PreemptiveQuotaScheduler.prototype, "clearAll");

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl: streamingFetch(),
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
		});
		openServers.push(proxy);

		await postResponses(proxy);

		expect(clearByPrefix).not.toHaveBeenCalled();
		expect(clearAll).not.toHaveBeenCalled();
	});
});
