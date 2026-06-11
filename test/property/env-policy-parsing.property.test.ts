import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { parseBooleanEnv } from "../../lib/env-parsing.js";
import {
	getAccountPolicyKey,
	normalizeAccountPolicyTag,
} from "../../lib/account-policy.js";

const TRUE_LITERALS = ["1", "true", "yes"] as const;
const FALSE_LITERALS = ["0", "false", "no"] as const;

const arbWhitespace = fc
	.array(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 4 })
	.map((chars) => chars.join(""));

const arbCasing = fc.constantFrom(
	(text: string) => text,
	(text: string) => text.toUpperCase(),
	(text: string) =>
		[...text]
			.map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
			.join(""),
);

describe("parseBooleanEnv property invariants", () => {
	it("recognized literals parse to their boolean under any casing and padding", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...TRUE_LITERALS, ...FALSE_LITERALS),
				arbCasing,
				arbWhitespace,
				arbWhitespace,
				(literal, casing, before, after) => {
					const parsed = parseBooleanEnv(`${before}${casing(literal)}${after}`);
					expect(parsed).toBe(
						(TRUE_LITERALS as readonly string[]).includes(literal),
					);
				},
			),
		);
	});

	it("everything else returns undefined, never a boolean", () => {
		const recognized = new Set<string>([...TRUE_LITERALS, ...FALSE_LITERALS]);
		fc.assert(
			fc.property(fc.string({ maxLength: 12 }), (value) => {
				fc.pre(!recognized.has(value.trim().toLowerCase()));
				expect(parseBooleanEnv(value)).toBeUndefined();
			}),
		);
		expect(parseBooleanEnv(undefined)).toBeUndefined();
	});
});

describe("account policy key/tag property invariants", () => {
	it("policy keys are stable sha256 handles: identity-insensitive to email case, never leak the identity", () => {
		fc.assert(
			fc.property(
				fc.option(fc.constantFrom("acc-1", "acc-2", "ACC-1 "), { nil: undefined }),
				fc.option(fc.constantFrom("user@x.test", "other@x.test"), {
					nil: undefined,
				}),
				arbCasing,
				(accountId, email, casing) => {
					const key = getAccountPolicyKey({ accountId, email });
					expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
					// The key must not leak the raw identity (it is written to a
					// policy file keyed by hash precisely to avoid that).
					if (email) expect(key.includes(email)).toBe(false);

					// accountId wins over email; email matches case-insensitively;
					// no identity at all degrades to the shared "unknown" bucket.
					if (accountId?.trim()) {
						expect(
							getAccountPolicyKey({ accountId, email: "different@x.test" }),
						).toBe(key);
					} else if (email) {
						expect(
							getAccountPolicyKey({ accountId: undefined, email: casing(email) }),
						).toBe(key);
					} else {
						expect(getAccountPolicyKey({})).toBe(key);
					}
				},
			),
		);
	});

	it("normalized tags are idempotent fixpoints in the [a-z0-9._-]{1,64} language or null", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (raw) => {
				const tag = normalizeAccountPolicyTag(raw);
				if (tag === null) {
					// Disallowed runs are replaced WITH a dash rather than dropped,
					// so the only way to normalize away entirely is an input that
					// trims to nothing.
					expect(raw.trim()).toBe("");
					return;
				}
				expect(tag.length).toBeGreaterThan(0);
				expect(tag.length).toBeLessThanOrEqual(64);
				expect(/^[a-z0-9._-]+$/.test(tag)).toBe(true);
				// Idempotence: a normalized tag survives re-normalization verbatim.
				expect(normalizeAccountPolicyTag(tag)).toBe(tag);
			}),
		);
	});
});
