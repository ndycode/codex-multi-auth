import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { displayWidth, truncateToWidth } from "../../lib/ui/display-width.js";
import { parseKey, type KeyAction } from "../../lib/ui/ansi.js";

// Adversarial code-point alphabet: plain ASCII and CJK, plus every cluster
// mechanic the implementation special-cases — ZWJ, variation selector-16,
// keycap, combining marks, skin-tone modifiers, regional indicators, emoji.
const arbAdversarialText = fc
	.array(
		fc.constantFrom(
			"a",
			"Z",
			"7",
			" ",
			"漢",
			"한",
			"🚀",
			"👩",
			"👨",
			"☀",
			"❤",
			"‍", // ZWJ
			"️", // variation selector-16
			"⃣", // combining enclosing keycap
			"́", // combining acute accent
			"\u{1f3fb}", // skin-tone modifier
			"\u{1f1e6}", // regional indicator A
			"\u{1f1fa}", // regional indicator U
		),
		{ minLength: 0, maxLength: 16 },
	)
	.map((chars) => chars.join(""));

// Plain alphabet with no joiners/modifiers: per-character widths are
// independent, giving an exact sum oracle (the table-formatter assumption).
const PLAIN_WIDTHS: ReadonlyArray<readonly [string, number]> = [
	["a", 1],
	["B", 1],
	["7", 1],
	[" ", 1],
	["-", 1],
	["é", 1],
	["漢", 2],
	["字", 2],
	["한", 2],
	["🚀", 2],
];

const arbPlainText = fc.array(
	fc.constantFrom(...PLAIN_WIDTHS.map(([char]) => char)),
	{ minLength: 0, maxLength: 20 },
);

const KEY_ACTIONS: readonly KeyAction[] = [
	"up",
	"down",
	"home",
	"end",
	"enter",
	"escape",
	"escape-start",
	null,
];

describe("display-width property invariants", () => {
	it("displayWidth is total, non-negative, and bounded by two columns per code point", () => {
		fc.assert(
			fc.property(arbAdversarialText, (text) => {
				const width = displayWidth(text);
				expect(Number.isInteger(width)).toBe(true);
				expect(width).toBeGreaterThanOrEqual(0);
				expect(width).toBeLessThanOrEqual([...text].length * 2);
			}),
		);
	});

	it("plain text width equals the sum of per-character widths", () => {
		fc.assert(
			fc.property(arbPlainText, (chars) => {
				const widthByChar = new Map(PLAIN_WIDTHS);
				const expected = chars.reduce(
					(sum, char) => sum + (widthByChar.get(char) ?? 0),
					0,
				);
				expect(displayWidth(chars.join(""))).toBe(expected);
				// With no joiners or modifiers in the alphabet, concatenation is
				// exactly additive — the assumption the table formatter relies on.
				const half = Math.floor(chars.length / 2);
				const left = chars.slice(0, half).join("");
				const right = chars.slice(half).join("");
				expect(displayWidth(left) + displayWidth(right)).toBe(expected);
			}),
		);
	});

	it("truncateToWidth returns a self-consistent, in-budget prefix that is maximal", () => {
		fc.assert(
			fc.property(
				arbAdversarialText,
				fc.integer({ min: 0, max: 20 }),
				(text, maxWidth) => {
					const { text: kept, width } = truncateToWidth(text, maxWidth);
					// Self-consistency: the reported width is the measurer's answer.
					expect(displayWidth(kept)).toBe(width);
					expect(width).toBeLessThanOrEqual(maxWidth);
					expect(text.startsWith(kept)).toBe(true);
					if (kept !== text) {
						// Maximality: clusters are at most 2 columns wide, so a gap of
						// 2+ columns means the next cluster would have fit — the only
						// legal reason to stop early is a remaining gap of 0 or 1.
						expect(maxWidth - width).toBeLessThanOrEqual(1);
					}
					// Idempotence: re-truncating the kept prefix changes nothing.
					const again = truncateToWidth(kept, maxWidth);
					expect(again.text).toBe(kept);
					expect(again.width).toBe(width);
				},
			),
		);
	});

	it("truncation prefixes grow monotonically with the width budget", () => {
		fc.assert(
			fc.property(
				arbAdversarialText,
				fc.integer({ min: 0, max: 18 }),
				fc.integer({ min: 0, max: 6 }),
				(text, smaller, delta) => {
					const narrow = truncateToWidth(text, smaller);
					const wide = truncateToWidth(text, smaller + delta);
					expect(wide.text.startsWith(narrow.text)).toBe(true);
					expect(wide.width).toBeGreaterThanOrEqual(narrow.width);
				},
			),
		);
	});
});

describe("parseKey property invariants", () => {
	it("is total over arbitrary byte buffers and only ever returns known actions", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 12 }), (bytes) => {
				const action = parseKey(Buffer.from(bytes));
				expect(KEY_ACTIONS.includes(action)).toBe(true);
			}),
		);
	});

	it("recognized sequences are stable and unrecognized ones map to null", () => {
		const table: ReadonlyArray<readonly [string, KeyAction]> = [
			["\x1b[A", "up"],
			["\x1bOA", "up"],
			["\x1b[B", "down"],
			["\x1bOB", "down"],
			["\x1b[H", "home"],
			["\x1bOH", "home"],
			["\x1b[1~", "home"],
			["\x1b[7~", "home"],
			["\x1b[F", "end"],
			["\x1bOF", "end"],
			["\x1b[4~", "end"],
			["\x1b[8~", "end"],
			["\r", "enter"],
			["\n", "enter"],
			["\x03", "escape"],
			["\x1b", "escape-start"],
		];
		const known = new Set(table.map(([sequence]) => sequence));
		for (const [sequence, action] of table) {
			expect(parseKey(Buffer.from(sequence))).toBe(action);
		}
		fc.assert(
			fc.property(fc.string({ maxLength: 6 }), (input) => {
				fc.pre(!known.has(input));
				expect(parseKey(Buffer.from(input))).toBeNull();
			}),
		);
	});
});
