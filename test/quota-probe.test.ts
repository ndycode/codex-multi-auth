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
	it("parses reset-at values expressed as epoch seconds and epoch milliseconds", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const primarySeconds = nowSec + 120;
		const secondaryMs = Date.now() + 180_000;
		const headers = new Headers({
			"x-codex-primary-used-percent": "10",
			"x-codex-primary-window-minutes": "60",
			"x-codex-primary-reset-at": String(primarySeconds),
			"x-codex-secondary-used-percent": "20",
			"x-codex-secondary-window-minutes": "120",
			"x-codex-secondary-reset-at": String(secondaryMs),
		});
		const fetchMock = vi.fn(async () => new Response("", { status: 200, headers }));
		vi.stubGlobal("fetch", fetchMock);

		const snapshot = await fetchCodexQuotaSnapshot({
			accountId: "acc-epoch",
			accessToken: "token-epoch",
			model: "gpt-5-codex",
			fallbackModels: [],
		});

		expect(snapshot.primary.resetAtMs).toBe(primarySeconds * 1000);
		expect(snapshot.secondary.resetAtMs).toBe(secondaryMs);
	});

	it("keeps resetAt undefined for invalid reset-at values", async () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "not-a-number",
			"x-codex-primary-window-minutes": "60",
			"x-codex-primary-reset-at": "not-a-date",
			"x-codex-secondary-used-percent": "30",
			"x-codex-secondary-window-minutes": "90",
			"x-codex-secondary-reset-at": "",
		});
		const fetchMock = vi.fn(async () => new Response("", { status: 200, headers }));
		vi.stubGlobal("fetch", fetchMock);

		const snapshot = await fetchCodexQuotaSnapshot({
			accountId: "acc-invalid-reset",
			accessToken: "token-invalid-reset",
			model: "gpt-5-codex",
			fallbackModels: [],
		});

		expect(snapshot.primary.usedPercent).toBeUndefined();
		expect(snapshot.primary.resetAtMs).toBeUndefined();
		expect(snapshot.secondary.resetAtMs).toBeUndefined();
	});

	it("throws parsed nested error.message for non-ok response without quota headers", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ error: { message: "nested failure" } }), {
				status: 500,
				headers: new Headers({ "content-type": "application/json" }),
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-error",
				accessToken: "token-error",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("nested failure");
	});

	it("throws top-level message/plain text/HTTP fallback for non-ok response", async () => {
		const topLevel = vi.fn(async () =>
			new Response(JSON.stringify({ message: "top-level failure" }), {
				status: 502,
				headers: new Headers({ "content-type": "application/json" }),
			}),
		);
		vi.stubGlobal("fetch", topLevel);
		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-msg",
				accessToken: "token-msg",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("top-level failure");

		const plainText = vi.fn(async () =>
			new Response("plain-text failure", {
				status: 503,
				headers: new Headers({ "content-type": "text/plain" }),
			}),
		);
		vi.stubGlobal("fetch", plainText);
		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-plain",
				accessToken: "token-plain",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("plain-text failure");

		const emptyBody = vi.fn(async () => new Response("", { status: 504 }));
		vi.stubGlobal("fetch", emptyBody);
		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-empty",
				accessToken: "token-empty",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("HTTP 504");
	});

	it("uses default unsupported-model message when helper does not provide one", async () => {
		getUnsupportedCodexModelInfoMock.mockReturnValue({
			isUnsupported: true,
			unsupportedModel: "gpt-5-codex",
			message: undefined,
		});
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ error: { message: "unsupported model" } }), {
				status: 400,
				headers: new Headers({ "content-type": "application/json" }),
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-unsupported",
				accessToken: "token-unsupported",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("Model 'gpt-5-codex' unsupported for this account");
	});

	it("throws generic failure when no normalized probe models are available", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-none",
				accessToken: "token-none",
				model: "   ",
				fallbackModels: ["", "   "],
			}),
		).rejects.toThrow("Failed to fetch quotas");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("converts non-Error thrown values into Error instances", async () => {
		const fetchMock = vi.fn(async () => {
			throw "string failure";
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-string",
				accessToken: "token-string",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("string failure");
	});

	it("throws missing-quota-header error when response succeeds without quota headers", async () => {
		const fetchMock = vi.fn(async () => new Response("ok-no-headers", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchCodexQuotaSnapshot({
				accountId: "acc-no-headers",
				accessToken: "token-no-headers",
				model: "gpt-5-codex",
				fallbackModels: [],
			}),
		).rejects.toThrow("Codex response did not include quota headers");
	});

	it("formats quota lines with day/hour labels, reset text, plan, and active limits", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-02T12:00:00.000Z"));

		const line = formatQuotaSnapshotLine({
			status: 429,
			planType: "pro",
			activeLimit: 4,
			model: "gpt-5-codex",
			primary: {
				windowMinutes: 1440,
				usedPercent: 60,
				resetAtMs: new Date("2026-03-02T13:00:00.000Z").getTime(),
			},
			secondary: {
				windowMinutes: 60,
				usedPercent: 10,
				resetAtMs: new Date("2026-03-03T14:00:00.000Z").getTime(),
			},
		});

		expect(line).toContain("1d");
		expect(line).toContain("1h");
		expect(line).toContain("resets");
		expect(line).toContain("on ");
		expect(line).toContain("plan:pro");
		expect(line).toContain("active:4");
		expect(line).toContain("rate-limited");
	});

	it("formats fallback quota labels and suppresses invalid reset time", () => {
		const line = formatQuotaSnapshotLine({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				windowMinutes: 0,
				usedPercent: 150,
				resetAtMs: Number.NaN,
			},
			secondary: {
				windowMinutes: 15,
				usedPercent: -20,
				resetAtMs: undefined,
			},
			planType: undefined,
			activeLimit: Number.NaN,
		});

		expect(line).toContain("quota");
		expect(line).toContain("15m");
		expect(line).not.toContain("resets");
		expect(line).not.toContain("plan:");
		expect(line).not.toContain("active:");
	});
});
