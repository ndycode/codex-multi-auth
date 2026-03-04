import { describe, expect, it } from "vitest";
import { redactForExternalOutput } from "../lib/data-redaction.js";

describe("data redaction", () => {
	it("redacts sensitive keys recursively", () => {
		const value = {
			email: "person@example.com",
			profile: {
				accessToken: "abc",
				refresh_token: "def",
				nested: [{ accountId: "acct_123" }],
			},
		};

		const redacted = redactForExternalOutput(value);
		expect(redacted).toEqual({
			email: "***REDACTED***",
			profile: {
				accessToken: "***REDACTED***",
				refresh_token: "***REDACTED***",
				nested: [{ accountId: "***REDACTED***" }],
			},
		});
	});

	it("keeps non-sensitive fields unchanged", () => {
		const value = {
			command: "report",
			schemaVersion: 1,
			summary: { ok: 1, warn: 0, error: 0 },
		};
		expect(redactForExternalOutput(value)).toEqual(value);
	});

	it("preserves non-plain objects and prevents infinite recursion on cycles", () => {
		const timestamp = new Date("2026-03-05T00:00:00.000Z");
		const error = new Error("boom");
		const cyclic: Record<string, unknown> = {
			issuedAt: timestamp,
			failure: error,
			token: "secret",
		};
		cyclic.self = cyclic;

		const redacted = redactForExternalOutput(cyclic);
		expect(redacted.token).toBe("***REDACTED***");
		expect(redacted.issuedAt).toBe(timestamp);
		expect(redacted.failure).toBe(error);
		expect(redacted.self).toBe("[Circular]");
	});
});
