import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileMock = vi.fn(async () => undefined);
const renameMock = vi.fn(async () => undefined);
const unlinkMock = vi.fn(async () => undefined);
const mkdirMock = vi.fn(async () => undefined);
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	readFileSync: readFileSyncMock,
	promises: {
		readFile: readFileMock,
		writeFile: writeFileMock,
		rename: renameMock,
		unlink: unlinkMock,
		mkdir: mkdirMock,
	},
}));

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
});
