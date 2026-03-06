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

	it("handles null/undefined and mixed arrays safely", () => {
		const value = {
			email: "person@example.com",
			mixed: [1, "two", null, { accountId: "acct-123" }],
			nested: {
				accessToken: "secret",
				nullable: null as null | string,
				optional: undefined as undefined | string,
			},
		};
		expect(redactForExternalOutput(value)).toEqual({
			email: "***REDACTED***",
			mixed: [1, "two", null, { accountId: "***REDACTED***" }],
			nested: {
				accessToken: "***REDACTED***",
				nullable: null,
				optional: undefined,
			},
		});
	});

	it("handles circular references without throwing", () => {
		const cyclic: { email: string; self?: unknown; nested: { accessToken: string; parent?: unknown } } = {
			email: "loop@example.com",
			nested: { accessToken: "tok" },
		};
		cyclic.self = cyclic;
		cyclic.nested.parent = cyclic;

		const redacted = redactForExternalOutput(cyclic) as {
			email: string;
			self: string;
			nested: { accessToken: string; parent: string };
		};
		expect(redacted.email).toBe("***REDACTED***");
		expect(redacted.nested.accessToken).toBe("***REDACTED***");
		expect(redacted.self).toBe("[Circular]");
		expect(redacted.nested.parent).toBe("[Circular]");
	});
});
