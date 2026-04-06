import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	promises: {
		readFile: readFileMock,
		writeFile: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		unlink: vi.fn(async () => undefined),
		mkdir: vi.fn(async () => undefined),
	},
}));

vi.mock("../lib/runtime-paths.js", () => ({
	getCodexMultiAuthDir: () => "/mock/.codex/multi-auth",
}));

describe("runtime observability snapshot versioning", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		readFileMock.mockReset();
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
});
