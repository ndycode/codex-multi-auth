import { describe, expect, it } from "vitest";
import {
	buildContextBudgetHeaders,
	CONTEXT_BUDGET_PERCENT_HEADER,
	createContextBudgetPauseResponse,
} from "../lib/context-budget-response.js";

const HARD_ADVISORY = {
	level: "hard" as const,
	percent: 71.234,
	totalTokens: 71_234,
	windowTokens: 100_000,
	windowSource: "estimate" as const,
	model: "gpt-5.5",
};

describe("createContextBudgetPauseResponse", () => {
	it("returns a 200 OK synthetic SSE response", () => {
		const response = createContextBudgetPauseResponse(HARD_ADVISORY);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("X-Codex-Plugin-Synthetic")).toBe("true");
		expect(response.headers.get("X-Codex-Plugin-Error-Type")).toBe(
			"context_budget_pause",
		);
	});

	it("includes the model, percent, and recovery commands in the message", async () => {
		const response = createContextBudgetPauseResponse(HARD_ADVISORY);
		const text = await response.text();
		expect(text).toContain("gpt-5.5");
		expect(text).toContain("71.2%");
		expect(text).toContain("/compact");
		expect(text).toContain("/clear");
		expect(text).toContain("estimated window size");
	});

	it("labels an override-sourced window differently from an estimate", async () => {
		const response = createContextBudgetPauseResponse({
			...HARD_ADVISORY,
			windowSource: "override",
		});
		const text = await response.text();
		expect(text).toContain("your configured window size");
		expect(text).not.toContain("estimated window size");
	});

	it("round-trips through the Responses SSE parser the client uses", async () => {
		const { convertSseToJson } = await import("../lib/request/response-handler.js");
		const response = createContextBudgetPauseResponse(HARD_ADVISORY);
		const parsed = await convertSseToJson(response, new Headers());
		const body = (await parsed.json()) as { output_text?: string };
		expect(body.output_text).toContain("/compact");
	});
});

describe("buildContextBudgetHeaders", () => {
	it("formats the percent to one decimal place", () => {
		const headers = buildContextBudgetHeaders({
			...HARD_ADVISORY,
			level: "soft",
			percent: 65.0,
		});
		expect(headers[CONTEXT_BUDGET_PERCENT_HEADER]).toBe("65.0");
	});
});
