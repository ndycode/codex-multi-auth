import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getCodexInstructionsMock,
	createCodexHeadersMock,
	getUnsupportedCodexModelInfoMock,
} = vi.hoisted(() => ({
	getCodexInstructionsMock: vi.fn(async (model: string) => `instructions:${model}`),
	createCodexHeadersMock: vi.fn(() => new Headers()),
	getUnsupportedCodexModelInfoMock: vi.fn(() => ({
		isUnsupported: false,
		unsupportedModel: undefined,
		message: undefined,
	})),
}));

vi.mock("../lib/prompts/codex.js", () => ({
	getCodexInstructions: getCodexInstructionsMock,
}));

vi.mock("../lib/request/fetch-helpers.js", () => ({
	createCodexHeaders: createCodexHeadersMock,
	getUnsupportedCodexModelInfo: getUnsupportedCodexModelInfoMock,
}));

import { fetchCodexQuotaSnapshot, formatQuotaSnapshotLine } from "../lib/quota-probe.js";

function makeQuotaHeaders(overrides: Record<string, string> = {}): Headers {
	const headers = new Headers({
		"x-codex-primary-used-percent": "32",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-after-seconds": "120",
		"x-codex-secondary-used-percent": "64",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-after-seconds": "600",
		"x-codex-plan-type": "plus",
		...overrides,
	});
	return headers;
}

describe("quota-probe", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		getCodexInstructionsMock.mockClear();
		createCodexHeadersMock.mockClear();
		getUnsupportedCodexModelInfoMock.mockReset();
		getUnsupportedCodexModelInfoMock.mockReturnValue({
			isUnsupported: false,
			unsupportedModel: undefined,
			message: undefined,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("returns parsed quota snapshot from response headers", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 200, headers: makeQuotaHeaders() }));
		vi.stubGlobal("fetch", fetchMock);

		const snapshot = await fetchCodexQuotaSnapshot({
			accountId: "acc-1",
			accessToken: "token-1",
			model: "gpt-5-codex",
			fallbackModels: ["gpt-5.2-codex"],
		});

		expect(snapshot.model).toBe("gpt-5-codex");
		expect(snapshot.status).toBe(200);
		expect(snapshot.primary.usedPercent).toBe(32);
		expect(snapshot.secondary.usedPercent).toBe(64);
		expect(snapshot.planType).toBe("plus");
		expect(formatQuotaSnapshotLine(snapshot)).toContain("5h");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to next model when first model is unsupported", async () => {
		const unsupported = new Response(
			JSON.stringify({
				error: { message: "Model gpt-5.3-codex unsupported", type: "invalid_request_error" },
			}),
			{ status: 400, headers: new Headers({ "content-type": "application/json" }) },
		);
		const ok = new Response("", {
			status: 200,
			headers: makeQuotaHeaders({ "x-codex-primary-used-percent": "11" }),
		});
		const fetchMock = vi.fn().mockResolvedValueOnce(unsupported).mockResolvedValueOnce(ok);
		vi.stubGlobal("fetch", fetchMock);

		getUnsupportedCodexModelInfoMock
			.mockReturnValueOnce({
				isUnsupported: true,
				unsupportedModel: "gpt-5.3-codex",
				message: "unsupported",
			})
			.mockReturnValue({
				isUnsupported: false,
				unsupportedModel: undefined,
				message: undefined,
			});

		const snapshot = await fetchCodexQuotaSnapshot({
			accountId: "acc-1",
			accessToken: "token-1",
			model: "gpt-5.3-codex",
			fallbackModels: ["gpt-5.2-codex"],
		});

		expect(snapshot.model).toBe("gpt-5.2-codex");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(getCodexInstructionsMock).toHaveBeenNthCalledWith(1, "gpt-5.3-codex");
		expect(getCodexInstructionsMock).toHaveBeenNthCalledWith(2, "gpt-5.2-codex");
	});

	it("accepts 429 responses when quota headers are present", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("", {
				status: 429,
				headers: makeQuotaHeaders({ "x-codex-secondary-used-percent": "100" }),
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const snapshot = await fetchCodexQuotaSnapshot({
			accountId: "acc-1",
			accessToken: "token-1",
			model: "gpt-5-codex",
			fallbackModels: ["gpt-5.2-codex"],
		});

		expect(snapshot.status).toBe(429);
		expect(formatQuotaSnapshotLine(snapshot)).toContain("rate-limited");
	});

	it("times out a stalled probe and surfaces abort failure", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener(
						"abort",
						() => {
							const error = new Error("aborted");
							(error as Error & { name?: string }).name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				}
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const pending = fetchCodexQuotaSnapshot({
			accountId: "acc-timeout",
			accessToken: "token-timeout",
			model: "gpt-5-codex",
			fallbackModels: [],
			timeoutMs: 1_000,
		});
		const assertion = expect(pending).rejects.toThrow(/abort/i);

		await vi.advanceTimersByTimeAsync(1_100);
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
