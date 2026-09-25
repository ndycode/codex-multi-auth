import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileMock = vi.fn(async () => undefined);
const renameMock = vi.fn(async () => undefined);
const unlinkMock = vi.fn(async () => undefined);
const mkdirMock = vi.fn(async () => undefined);
const chmodMock = vi.fn(async () => undefined);
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	readFileSync: readFileSyncMock,
	promises: {
		readFile: readFileMock,
		writeFile: writeFileMock,
		rename: renameMock,
		unlink: unlinkMock,
		mkdir: mkdirMock,
		chmod: chmodMock,
	},
}));

vi.mock("../lib/logger.js", () => ({createLogger:()=>({warn:vi.fn()})}));

vi.mock("../lib/runtime-paths.js", () => ({
	getCodexMultiAuthDir: () => "/mock/.codex/multi-auth",
}));

describe("runtime observability snapshot versioning", () => {
	const originalVitestEnv = process.env.VITEST;

	beforeEach(() => {
		vi.resetModules();
		process.env.VITEST = originalVitestEnv;
	});

	afterEach(() => {
		readFileMock.mockReset();
		readFileSyncMock.mockReset();
		writeFileMock.mockReset();
		renameMock.mockReset();
		unlinkMock.mockReset();
		mkdirMock.mockReset();
		chmodMock.mockReset();
		if (originalVitestEnv === undefined) {
			delete process.env.VITEST;
		} else {
			process.env.VITEST = originalVitestEnv;
		}
	});

	it("normalizes legacy unversioned snapshots", async () => {
		readFileMock.mockResolvedValueOnce(
			JSON.stringify({
				updatedAt: 1,
				responsesRequests: 2,
				runtimeMetrics: { totalRequests: 3 },
			}),
		);

		const { loadPersistedRuntimeObservabilitySnapshot } = await import(
			"../lib/runtime/runtime-observability.js"
		);
		const snapshot = await loadPersistedRuntimeObservabilitySnapshot();

		expect(snapshot?.version).toBe(1);
		expect(snapshot?.responsesRequests).toBe(2);
		expect(snapshot?.lastAccountIndex).toBeNull();
		expect(snapshot?.lastAccountEmail).toBeNull();
		expect(snapshot?.runtimeMetrics.totalRequests).toBe(3);
		expect(snapshot?.runtimeMetrics.failedRequests).toBe(0);
	});

	it("drops unknown future snapshot versions safely", async () => {
		readFileMock.mockResolvedValueOnce(JSON.stringify({ version: 99 }));

		const { loadPersistedRuntimeObservabilitySnapshot } = await import(
			"../lib/runtime/runtime-observability.js"
		);
		const snapshot = await loadPersistedRuntimeObservabilitySnapshot();

		expect(snapshot).toBeNull();
	});

	it("retries transient rename contention when persisting a snapshot", async () => {
		process.env.VITEST = "";
		let attempts = 0;
		renameMock.mockImplementation(async () => {
			attempts += 1;
			if (attempts === 1) {
				throw Object.assign(new Error("busy"), { code: "EBUSY" });
			}
		});

		const mod = await import("../lib/runtime/runtime-observability.js");
		mod.mutateRuntimeObservabilitySnapshot((snapshot) => {
			snapshot.responsesRequests = 3;
		});

		await vi.waitFor(() => {
			expect(renameMock).toHaveBeenCalledTimes(2);
		});
		expect(unlinkMock).toHaveBeenCalled();
	});

	it("collapses a burst of snapshot mutations into the in-flight write and the latest one", async () => {
		process.env.VITEST = "";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		writeFileMock.mockImplementationOnce(async () => { await gate; });
		renameMock.mockResolvedValue(undefined);
		const mod = await import("../lib/runtime/runtime-observability.js");
		for (let i = 1; i <= 10; i++) mod.mutateRuntimeObservabilitySnapshot((snapshot) => { snapshot.responsesRequests = i; });
		await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(1));
		for (let i = 11; i <= 20; i++) mod.mutateRuntimeObservabilitySnapshot((snapshot) => { snapshot.responsesRequests = i; });
		release();
		await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(2));
		expect(writeFileMock).toHaveBeenCalledTimes(2);
		const written = (writeFileMock.mock.calls as unknown[][]).map((call) => JSON.parse(String(call[1])).responsesRequests);
		expect(written).toEqual([10, 20]);
	});

	it("does not chmod the dir on win32 and still persists the snapshot", async () => {
		// The 0o700 re-assert is POSIX-only (win32 perms are ACL-based, mode is a
		// no-op). Persistence must still succeed without calling chmod.
		process.env.VITEST = "";
		const platformSpy = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		renameMock.mockResolvedValue(undefined);
		try {
			const mod = await import("../lib/runtime/runtime-observability.js");
			mod.mutateRuntimeObservabilitySnapshot((snapshot) => {
				snapshot.responsesRequests = 7;
			});
			await vi.waitFor(() => {
				expect(renameMock).toHaveBeenCalled();
			});
			expect(chmodMock).not.toHaveBeenCalled();
			// The snapshot temp file is written owner-only regardless of platform.
			expect(writeFileMock).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.objectContaining({ mode: 0o600 }),
			);
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("contains permanent snapshot write failures without leaving pending writes rejected", async () => {
		process.env.VITEST = "";
		renameMock.mockImplementation(async () => {
			throw Object.assign(new Error("disk full"), { code: "EIO" });
		});

		const mod = await import("../lib/runtime/runtime-observability.js");
		mod.mutateRuntimeObservabilitySnapshot((snapshot) => {
			snapshot.responsesRequests = 1;
		});

		await vi.waitFor(() => {
			expect(renameMock).toHaveBeenCalled();
		});

		renameMock.mockReset();
		renameMock.mockResolvedValue(undefined);
		mod.mutateRuntimeObservabilitySnapshot((snapshot) => {
			snapshot.responsesRequests = 2;
		});

		await vi.waitFor(() => {
			expect(renameMock).toHaveBeenCalled();
		});
	});

	it("seeds the first in-memory snapshot from disk before mutating", async () => {
		process.env.VITEST = "";
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				version: 1,
				authRefreshRequests: 7,
				poolExhaustionCooldownUntil: 12345,
				runtimeMetrics: { failedRequests: 4 },
			}),
		);

		const mod = await import("../lib/runtime/runtime-observability.js");
		mod.mutateRuntimeObservabilitySnapshot((snapshot) => {
			snapshot.responsesRequests = 9;
		});

		const snapshot = mod.getRuntimeObservabilitySnapshot();
		expect(snapshot.responsesRequests).toBe(9);
		expect(snapshot.authRefreshRequests).toBe(7);
		expect(snapshot.poolExhaustionCooldownUntil).toBe(12345);
		expect(snapshot.runtimeMetrics.failedRequests).toBe(4);
	});

	it("normalizes and persists runtime pool exhaustion diagnostics", async () => {
		process.env.VITEST = "";
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				version: 1,
				lastPoolExhaustionReason: "no-account",
				lastPoolExhaustionRetryAfterMs: 0,
				lastPoolExhaustionSkipReasons: { "0": "circuit-open" },
				accountSkipReasons: { "0": "circuit-open" },
				policyBlockedIndexes: [1],
				policyBlockedReasons: { "1": "policy-blocked" },
			}),
		);

		const mod = await import("../lib/runtime/runtime-observability.js");
		const snapshot = mod.getRuntimeObservabilitySnapshot();
		expect(snapshot.lastPoolExhaustionReason).toBe("no-account");
		expect(snapshot.lastPoolExhaustionSkipReasons).toEqual({
			"0": "circuit-open",
		});
		expect(snapshot.policyBlockedIndexes).toEqual([1]);

		mod.recordRuntimePoolExhaustion({
			reason: "rate-limit",
			retryAfterMs: 5000,
			accountSkipReasons: { "2": "token-exhausted" },
		});
		await vi.waitFor(() => {
			expect(renameMock).toHaveBeenCalled();
		});
		expect(mod.getRuntimeObservabilitySnapshot().accountSkipReasons).toEqual({
			"2": "token-exhausted",
		});
	});

	it("clears a single account's stale skip reason on recovery", async () => {
		process.env.VITEST = "";
		const mod = await import("../lib/runtime/runtime-observability.js");
		mod.recordRuntimePoolExhaustion({
			reason: "rate-limit",
			retryAfterMs: 5000,
			accountSkipReasons: { "0": "token-exhausted", "1": "rate-limited" },
		});
		expect(mod.getRuntimeObservabilitySnapshot().accountSkipReasons).toEqual({
			"0": "token-exhausted",
			"1": "rate-limited",
		});

		mod.recordRuntimeAccountRecovery(0);

		const after = mod.getRuntimeObservabilitySnapshot();
		expect(after.accountSkipReasons).toEqual({ "1": "rate-limited" });
		expect(after.lastPoolExhaustionSkipReasons).toEqual({ "1": "rate-limited" });
	});

	it("is a no-op when the recovered account has no recorded skip reason", async () => {
		process.env.VITEST = "";
		const mod = await import("../lib/runtime/runtime-observability.js");
		mod.recordRuntimePoolExhaustion({
			reason: "rate-limit",
			retryAfterMs: 5000,
			accountSkipReasons: { "1": "rate-limited" },
		});
		const before = mod.getRuntimeObservabilitySnapshot().updatedAt;

		mod.recordRuntimeAccountRecovery(0);
		mod.recordRuntimeAccountRecovery(-1);
		mod.recordRuntimeAccountRecovery(2.5);

		const after = mod.getRuntimeObservabilitySnapshot();
		expect(after.accountSkipReasons).toEqual({ "1": "rate-limited" });
		expect(after.updatedAt).toBe(before);
	});
});
