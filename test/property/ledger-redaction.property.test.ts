import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { fc } from "./setup.js";
import {
	createUsageAccountRef,
	hashUsageIdentifier,
	normalizeUsageLedgerRow,
	usageRowToJsonLine,
} from "../../lib/usage/redaction.js";
import {
	appendUsageLedgerRow,
	getUsageLedgerPaths,
	readUsageLedgerRows,
} from "../../lib/usage/ledger.js";
import type {
	UsageLedgerAppendInput,
	UsageLedgerOperation,
	UsageLedgerOutcome,
	UsageLedgerRow,
	UsageLedgerSource,
} from "../../lib/usage/types.js";
import { removeWithRetry } from "../helpers/remove-with-retry.js";

// The redaction contract has an explicit boundary: accountId/email/accountIndex
// are the only identity fields, and they are hashed (sha256:<hex>) or numeric —
// never serialized verbatim. Metadata fields (model, projectKey, requestId,
// errorCode, id) are caller-controlled and pass through by design. These
// properties assert BOTH halves of that contract so neither the hashing nor
// the pass-through boundary can silently shift.

const SECRET_PATTERN = /@|Bearer|sk-|secret/i;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// Strings carrying every pattern the ledger must never leak from identity
// fields: emails, bearer tokens, API keys, "secret" markers.
const arbSecretBearing = fc.oneof(
	fc
		.tuple(
			fc.string({ minLength: 1, maxLength: 12 }),
			fc.constantFrom("example.com", "corp.io", "sub.domain.org"),
		)
		.map(([user, domain]) => `${user}@${domain}`),
	fc.string({ maxLength: 24 }).map((s) => `Bearer ${s}`),
	fc.string({ minLength: 1, maxLength: 24 }).map((s) => `sk-${s}`),
	fc.string({ maxLength: 24 }).map((s) => `secret-${s}`),
	fc.string({ maxLength: 24 }).map((s) => `${s} secret ${s}`),
);

// Caller-controlled metadata fields are generated pattern-free so the
// whole-line secret scan in the identity-hash property stays meaningful —
// any hit can only come from an identity-field leak.
const arbPlainString = fc
	.stringMatching(/^[a-zA-Z0-9._:-]{1,40}$/)
	// Pattern-free by construction: a generated "sk-…"/"secret…" model name
	// would false-positive the whole-line secret scan without being a leak.
	.filter((s) => !SECRET_PATTERN.test(s));

const arbOutcome: fc.Arbitrary<UsageLedgerOutcome> = fc.constantFrom(
	"success",
	"failure",
	"blocked",
	"cancelled",
);

const arbAppendInput: fc.Arbitrary<UsageLedgerAppendInput> = fc.record(
	{
		id: fc.option(arbPlainString, { nil: undefined }),
		createdAt: fc.option(fc.nat({ max: 4_102_444_800_000 }), {
			nil: undefined,
		}),
		source: fc.option(
			fc.constantFrom(
				"runtime-proxy",
				"plugin-host",
				"local-bridge",
				"cli",
				"bogus-source",
			) as fc.Arbitrary<UsageLedgerSource>,
			{ nil: undefined },
		),
		operation: fc.option(
			fc.constantFrom(
				"responses",
				"images",
				"models",
				"thread-goal",
				"transcribe",
				"auth-refresh",
				"diagnostic",
				"bogus-op",
			) as fc.Arbitrary<UsageLedgerOperation>,
			{ nil: undefined },
		),
		outcome: arbOutcome,
		model: fc.option(arbPlainString, { nil: undefined }),
		projectKey: fc.option(arbPlainString, { nil: undefined }),
		requestId: fc.option(arbPlainString, { nil: undefined }),
		errorCode: fc.option(arbPlainString, { nil: undefined }),
		accountId: fc.option(fc.oneof(arbSecretBearing, arbPlainString), {
			nil: undefined,
		}),
		email: fc.option(fc.oneof(arbSecretBearing, arbPlainString), {
			nil: undefined,
		}),
		accountIndex: fc.option(fc.integer({ min: 0, max: 50 }), {
			nil: undefined,
		}),
		statusCode: fc.option(fc.integer({ min: 50, max: 700 }), {
			nil: undefined,
		}),
		durationMs: fc.option(fc.integer({ min: -100, max: 60000 }), {
			nil: undefined,
		}),
		inputTokens: fc.option(fc.nat({ max: 1000000 }), { nil: undefined }),
		outputTokens: fc.option(fc.nat({ max: 1000000 }), { nil: undefined }),
		cachedInputTokens: fc.option(fc.nat({ max: 500000 }), { nil: undefined }),
		reasoningTokens: fc.option(fc.nat({ max: 500000 }), { nil: undefined }),
		totalTokens: fc.option(fc.nat({ max: 3000000 }), { nil: undefined }),
		serviceTier: fc.option(
			fc.constantFrom("standard", "priority", "flex", "batch", "scale"),
			{ nil: undefined },
		),
		costUsd: fc.option(
			fc.double({ min: -10, max: 1000, noNaN: true }),
			{ nil: undefined },
		),
	},
	{ requiredKeys: ["outcome"] },
) as fc.Arbitrary<UsageLedgerAppendInput>;

// ---------------------------------------------------------------------------
// Oracles mirroring the redaction normalizers
// ---------------------------------------------------------------------------

const sha256 = (value: string): string =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

const trimToNull = (value: string | null | undefined): string | null =>
	typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;

function expectedAccountRef(input: UsageLedgerAppendInput) {
	const accountId = trimToNull(input.accountId);
	const email = trimToNull(input.email)?.toLowerCase() ?? null;
	const index =
		typeof input.accountIndex === "number" &&
		Number.isInteger(input.accountIndex) &&
		input.accountIndex >= 0
			? input.accountIndex
			: null;
	if (!accountId && !email && index === null) return null;
	return {
		accountHash: accountId ? sha256(accountId) : undefined,
		emailHash: email ? sha256(email) : undefined,
		index: index ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// Rows are compared as multisets of canonical serializations: caller-supplied
// ids can legitimately repeat across appended inputs and read order is by
// createdAt, so a Set keyed on r.id cannot express per-row membership.
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, v) =>
		v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						a.localeCompare(b),
					),
				)
			: v,
	);

async function ensureCleanLedger(): Promise<void> {
	const { dir } = getUsageLedgerPaths();
	if (existsSync(dir)) {
		await removeWithRetry(dir, { recursive: true, force: true });
	}
}

afterEach(ensureCleanLedger);

describe("usage ledger redaction properties", () => {
	it("identity fields are hashed; serialized output carries no raw secret patterns", async () => {
		await fc.assert(
			fc.asyncProperty(arbAppendInput, async (input) => {
				const row = normalizeUsageLedgerRow(input);
				const line = usageRowToJsonLine(row);

				// The full serialized line — not just the account subtree — must be
				// free of every raw pattern whenever the input confined secrets to
				// identity fields. (Metadata fields are pattern-free by generation,
				// so any match is a genuine identity leak.)
				expect(SECRET_PATTERN.test(line)).toBe(false);

				// The exact raw identity values must not appear verbatim
				// anywhere. Length floor: a 1-3 char value like ":" appears in
				// JSON punctuation coincidentally and proves nothing.
				const rawAccountId = trimToNull(input.accountId);
				const rawEmail = trimToNull(input.email);
				if (rawAccountId && rawAccountId.length >= 6) {
					expect(line).not.toContain(rawAccountId);
				}
				if (rawEmail && rawEmail.length >= 6) {
					expect(line).not.toContain(rawEmail);
					expect(line).not.toContain(rawEmail.toLowerCase());
				}

				// The account ref is exactly the expected hash triple — nothing more.
				const expected = expectedAccountRef(input);
				expect(row.account).toEqual(expected);
				if (row.account) {
					// The ref may carry keys whose value is undefined (JSON drops
					// them); only defined keys count.
					const definedKeys = Object.keys(row.account)
						.filter(
							(k) =>
								(row.account as Record<string, unknown>)[k] !==
								undefined,
						)
						.sort();
					expect(definedKeys).toEqual(
						["accountHash", "emailHash", "index"]
							.filter(
								(k) =>
									(row.account as Record<string, unknown>)[k] !==
									undefined,
							)
							.sort(),
					);
					if (row.account.accountHash) {
						expect(row.account.accountHash).toMatch(
							/^sha256:[0-9a-f]{64}$/,
						);
					}
					if (row.account.emailHash) {
						expect(row.account.emailHash).toMatch(
							/^sha256:[0-9a-f]{64}$/,
						);
					}
				}
			}),
		);
	});

	it("hashUsageIdentifier is deterministic, sha256-shaped, and distinct per input", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.string({ minLength: 1, maxLength: 64 }),
				fc.string({ minLength: 1, maxLength: 64 }),
				async (a, b) => {
					const hashA = hashUsageIdentifier(a);
					expect(hashA).toMatch(/^sha256:[0-9a-f]{64}$/);
					expect(hashUsageIdentifier(a)).toBe(hashA);
					// Trimming is part of the hash contract.
					expect(hashUsageIdentifier(`  ${a.trim()}  `)).toBe(
						hashUsageIdentifier(a.trim()),
					);
					if (a.trim() !== b.trim()) {
						expect(hashUsageIdentifier(b)).not.toBe(hashA);
					}
				},
			),
		);
	});

	it("createUsageAccountRef returns null only for fully-empty identity", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.option(arbSecretBearing, { nil: undefined }),
				fc.option(arbSecretBearing, { nil: undefined }),
				fc.option(fc.integer({ min: -5, max: 50 }), { nil: undefined }),
				async (accountId, email, accountIndex) => {
					const ref = createUsageAccountRef({
						accountId,
						email,
						accountIndex,
					});
					const expected = expectedAccountRef({
						outcome: "success",
						accountId,
						email,
						accountIndex,
					});
					expect(ref).toEqual(expected);
				},
			),
		);
	});

	it("usageRowToJsonLine ↔ JSON.parse is lossless for normalized rows", async () => {
		await fc.assert(
			fc.asyncProperty(arbAppendInput, async (input) => {
				const row = normalizeUsageLedgerRow(input);
				const line = usageRowToJsonLine(row);
				expect(line.endsWith("\n")).toBe(true);
				// JSONL: exactly one non-empty line.
				expect(line.trim().split(/\r?\n/).length).toBe(1);
				expect(JSON.parse(line)).toEqual(JSON.parse(JSON.stringify(row)));
			}),
		);
	});

	it("append → read round-trips normalized rows exactly (read path is a fixpoint)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(arbAppendInput, { minLength: 1, maxLength: 8 }),
				async (inputs) => {
					await ensureCleanLedger();
					const appended = [];
					for (const input of inputs) {
						appended.push(await appendUsageLedgerRow(input));
					}
					const rows = await readUsageLedgerRows();
					expect(rows.length).toBe(appended.length);

					expect(rows.map(canonical).sort()).toEqual(
						appended.map(canonical).sort(),
					);
					// And no raw secret pattern ever hit the file.
					expect(SECRET_PATTERN.test(JSON.stringify(rows))).toBe(false);
				},
			),
		);
	});

	it("since/until query bounds are inclusive and consistent with row timestamps", async () => {
		// Deliberately adversarial generation for this property: ids come from a
		// small shared pool (collisions across the array are routine) and
		// timestamps/bounds share a tight range so windows routinely straddle
		// rows — including same-id rows split across the boundary, the case an
		// id-keyed presence set cannot express. createdAt is always pinned so
		// the seeded run is fully deterministic (no Date.now() fallback).
		const arbWindowInput = arbAppendInput.chain((input) =>
			fc
				.record({
					id: fc.option(
						fc.constantFrom("dup-a", "dup-b", "dup-c"),
						{ nil: undefined },
					),
					createdAt: fc.nat({ max: 400 }),
				})
				.map(
					(overrides): UsageLedgerAppendInput => ({
						...input,
						...overrides,
					}),
				),
		);
		await fc.assert(
			fc.asyncProperty(
				fc.array(arbWindowInput, { minLength: 1, maxLength: 8 }),
				fc.option(fc.nat({ max: 600 }), { nil: undefined }),
				fc.option(fc.nat({ max: 600 }), { nil: undefined }),
				async (inputs, since, until) => {
					await ensureCleanLedger();
					const appended = [];
					for (const input of inputs) {
						appended.push(await appendUsageLedgerRow(input));
					}
					const rows = await readUsageLedgerRows(
						since !== undefined || until !== undefined
							? {
									...(since !== undefined ? { since } : {}),
									...(until !== undefined ? { until } : {}),
								}
							: {},
					);
					for (const row of rows) {
						if (since !== undefined) {
							expect(row.createdAt).toBeGreaterThanOrEqual(since);
						}
						if (until !== undefined) {
							expect(row.createdAt).toBeLessThanOrEqual(until);
						}
					}
					// The read set must equal exactly the in-window appended rows,
					// as a multiset: caller ids may repeat, so membership is checked
					// on the full serialized row (which carries its own createdAt),
					// not on a Set<id> that would conflate distinct same-id rows.
					const inWindow = (row: UsageLedgerRow): boolean =>
						(since === undefined || row.createdAt >= since) &&
						(until === undefined || row.createdAt <= until);
					expect(rows.map(canonical).sort()).toEqual(
						appended.filter(inWindow).map(canonical).sort(),
					);
				},
			),
		);
	});

	it("redaction boundary is explicit: verbatim metadata fields pass through untouched", async () => {
		// This pins the documented pass-through half of the contract: model,
		// projectKey, requestId, errorCode and id are caller-controlled strings
		// and are NOT hashed — redaction applies to account identity only. If a
		// future change starts hashing metadata (or stops hashing identity),
		// this property and the one above diverge loudly.
		await fc.assert(
			fc.asyncProperty(arbAppendInput, async (input) => {
				const row = normalizeUsageLedgerRow(input);
				expect(row.model).toBe(trimToNull(input.model));
				expect(row.projectKey).toBe(trimToNull(input.projectKey));
				expect(row.requestId).toBe(trimToNull(input.requestId));
				expect(row.errorCode).toBe(trimToNull(input.errorCode));
				if (trimToNull(input.id) !== null) {
					expect(row.id).toBe(trimToNull(input.id));
				}
			}),
		);
	});
});
