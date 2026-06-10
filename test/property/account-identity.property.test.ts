import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	deduplicateAccounts,
	findMatchingAccountIndex,
	normalizeEmailKey,
} from "../../lib/storage.js";

// Small identity alphabets so generated pools actually collide on facets;
// the matcher's interesting behavior (ambiguity vetoes, newest-wins, tier
// precedence) only shows up when identities overlap.
const ACCOUNT_IDS = ["acc-1", "acc-2", "acc-3"];
const EMAIL_NAMES = ["alice", "bob", "carol"];
const REFRESH_TOKENS = ["rt-1", "rt-2", "rt-3"];

type TestAccount = {
	accountId?: string;
	email?: string;
	refreshToken?: string;
	lastUsed?: number;
	addedAt?: number;
};

// A spelled variant of an email that must normalize back to the same key:
// arbitrary casing plus surrounding whitespace.
const arbSpelledEmail = fc
	.tuple(
		fc.constantFrom(...EMAIL_NAMES),
		fc.boolean(),
		fc.constantFrom("", " ", "\t", "  "),
		fc.constantFrom("", " ", "\t"),
	)
	.map(([name, upper, pad, trail]) => {
		const address = `${name}@example.com`;
		return `${pad}${upper ? address.toUpperCase() : address}${trail}`;
	});

const arbAccount: fc.Arbitrary<TestAccount> = fc.record(
	{
		accountId: fc.option(fc.constantFrom(...ACCOUNT_IDS), { nil: undefined }),
		email: fc.option(arbSpelledEmail, { nil: undefined }),
		refreshToken: fc.option(fc.constantFrom(...REFRESH_TOKENS), {
			nil: undefined,
		}),
		addedAt: fc.nat(1_000_000),
	},
	{ requiredKeys: [] },
);

// Pools get strictly distinct lastUsed values so "newest wins" has a unique
// answer; ties would otherwise be broken by array position, which is exactly
// the order-dependence the permutation property must not trip over. Each
// account also carries a random sort key so pools can be re-shuffled into a
// wide range of permutations.
const arbPoolWithPermutation = fc
	.array(fc.tuple(arbAccount, fc.nat(1_000_000)), {
		minLength: 1,
		maxLength: 8,
	})
	.map((entries) => {
		const pool = entries.map(([account, permKey], index) => ({
			account: { ...account, lastUsed: (index + 1) * 1_000 },
			permKey,
		}));
		const permuted = [...pool]
			.sort((a, b) => a.permKey - b.permKey)
			.map((entry) => entry.account);
		return { pool: pool.map((entry) => entry.account), permuted };
	});

const arbCandidate: fc.Arbitrary<TestAccount> = arbAccount;

describe("normalizeEmailKey properties", () => {
	it("is idempotent and insensitive to casing and surrounding whitespace", () => {
		fc.assert(
			fc.property(arbSpelledEmail, (spelled) => {
				const key = normalizeEmailKey(spelled);
				expect(key).toBe(spelled.trim().toLowerCase());
				expect(normalizeEmailKey(key)).toBe(key);
				expect(normalizeEmailKey(spelled.toUpperCase())).toBe(key);
				expect(normalizeEmailKey(` ${spelled} `)).toBe(key);
			}),
		);
	});

	it("returns undefined for missing or blank input", () => {
		fc.assert(
			fc.property(fc.constantFrom("", " ", "\t", "  \t "), (blank) => {
				expect(normalizeEmailKey(blank)).toBeUndefined();
			}),
		);
		expect(normalizeEmailKey(undefined)).toBeUndefined();
	});
});

describe("findMatchingAccountIndex properties", () => {
	it("matches the same account regardless of pool order", () => {
		fc.assert(
			fc.property(arbPoolWithPermutation, arbCandidate, ({ pool, permuted }, candidate) => {
				const originalIndex = findMatchingAccountIndex(pool, candidate);
				const permutedIndex = findMatchingAccountIndex(permuted, candidate);
				if (originalIndex === undefined) {
					expect(permutedIndex).toBeUndefined();
					return;
				}
				expect(permutedIndex).not.toBeUndefined();
				// Same account object, not just same identity: with distinct
				// lastUsed values the newest-wins rule has a unique answer.
				expect(permuted[permutedIndex as number]).toBe(pool[originalIndex]);
			}),
		);
	});

	it("is insensitive to candidate email spelling", () => {
		fc.assert(
			fc.property(
				arbPoolWithPermutation,
				arbCandidate,
				fc.boolean(),
				({ pool }, candidate, upper) => {
					fc.pre(candidate.email !== undefined);
					const respelled = {
						...candidate,
						email: upper
							? `  ${(candidate.email as string).toUpperCase()}`
							: `${(candidate.email as string).toLowerCase()} `,
					};
					expect(findMatchingAccountIndex(pool, respelled)).toBe(
						findMatchingAccountIndex(pool, candidate),
					);
				},
			),
		);
	});

	it("only ever matches an account sharing an identity facet with the candidate", () => {
		fc.assert(
			fc.property(arbPoolWithPermutation, arbCandidate, ({ pool }, candidate) => {
				const index = findMatchingAccountIndex(pool, candidate);
				if (index === undefined) return;
				const matched = pool[index] as TestAccount;
				const sharesAccountId =
					candidate.accountId !== undefined &&
					matched.accountId === candidate.accountId;
				const sharesEmail =
					normalizeEmailKey(candidate.email) !== undefined &&
					normalizeEmailKey(matched.email) === normalizeEmailKey(candidate.email);
				const sharesRefreshToken =
					candidate.refreshToken !== undefined &&
					matched.refreshToken === candidate.refreshToken;
				expect(sharesAccountId || sharesEmail || sharesRefreshToken).toBe(true);
			}),
		);
	});

	it("never matches a candidate whose facets are all foreign to the pool", () => {
		fc.assert(
			fc.property(arbPoolWithPermutation, ({ pool }) => {
				const foreign = {
					accountId: "acc-foreign",
					email: "nobody@elsewhere.test",
					refreshToken: "rt-foreign",
				};
				expect(findMatchingAccountIndex(pool, foreign)).toBeUndefined();
			}),
		);
	});

	it("refuses email-only matches when the email maps to multiple account ids", () => {
		fc.assert(
			fc.property(
				arbPoolWithPermutation,
				arbSpelledEmail,
				fc.boolean(),
				({ pool }, email, upper) => {
					const ambiguous: TestAccount[] = [
						...pool,
						{ accountId: "acc-1", email, lastUsed: 999_001 },
						{
							accountId: "acc-2",
							email: upper ? email.toUpperCase() : email.toLowerCase(),
							lastUsed: 999_002,
						},
					];
					expect(
						findMatchingAccountIndex(ambiguous, { email }),
					).toBeUndefined();
				},
			),
		);
	});
});

describe("deduplicateAccounts properties", () => {
	// Deterministic replay of the counterexample this suite originally found:
	// the email tier merges the last record into the carol entry, leaving the
	// emailless acc-1/rt-1 record as a separate survivor that a second pass
	// would merge. The fixpoint loop in deduplicateAccountsByIdentity now
	// converges before returning.
	it("merges duplicates that only become adjacent after a newest-wins replacement", () => {
		const emaillessOriginal = {
			accountId: "acc-1",
			refreshToken: "rt-1",
			lastUsed: 1_000,
		};
		const carolWithoutId = {
			email: "carol@example.com",
			refreshToken: "rt-2",
			lastUsed: 3_000,
		};
		const relogin = {
			accountId: "acc-1",
			email: "carol@example.com",
			refreshToken: "rt-1",
			lastUsed: 7_000,
		};
		const deduplicated = deduplicateAccounts([
			emaillessOriginal,
			carolWithoutId,
			relogin,
		]);
		expect(deduplicated).toStrictEqual([relogin]);
	});

	it("returns a subset of the input accounts and is idempotent", () => {
		fc.assert(
			fc.property(arbPoolWithPermutation, ({ pool }) => {
				const deduplicated = deduplicateAccounts([...pool]);
				expect(deduplicated.length).toBeLessThanOrEqual(pool.length);
				for (const account of deduplicated) {
					// Object identity: dedup picks survivors, it never synthesizes.
					expect(pool).toContain(account);
				}
				expect(deduplicateAccounts([...deduplicated])).toStrictEqual(
					deduplicated,
				);
			}),
		);
	});
});
