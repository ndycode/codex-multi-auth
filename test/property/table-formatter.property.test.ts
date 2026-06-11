import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	buildTable,
	buildTableRow,
	type TableColumn,
	type TableOptions,
} from "../../lib/table-formatter.js";
import { displayWidth } from "../../lib/ui/display-width.js";

// Mix single-column ASCII with double-column CJK and emoji so padding and
// truncation are exercised in display columns, not UTF-16 code units (ui-02).
const arbCellText = fc
	.array(fc.constantFrom("a", "B", "7", " ", "-", "é", "漢", "字", "🚀", "⚡"), {
		minLength: 0,
		maxLength: 12,
	})
	.map((chars) => chars.join(""));

const arbColumn: fc.Arbitrary<TableColumn> = fc.record({
	header: arbCellText,
	width: fc.integer({ min: 0, max: 10 }),
	// undefined exercises formatCell's default-left branch.
	align: fc.option(fc.constantFrom<"left" | "right">("left", "right"), {
		nil: undefined,
	}),
});

const arbOptions: fc.Arbitrary<TableOptions> = fc
	.array(arbColumn, { minLength: 1, maxLength: 5 })
	.map((columns) => ({ columns }));

function expectedLineWidth(options: TableOptions): number {
	const widths = options.columns.map((column) => Math.max(0, column.width));
	return widths.reduce((sum, width) => sum + width, 0) + (options.columns.length - 1);
}

describe("table formatter property invariants", () => {
	it("every line of any table has the exact same display width as the layout", () => {
		fc.assert(
			fc.property(
				arbOptions,
				fc.array(fc.array(arbCellText, { minLength: 0, maxLength: 6 }), {
					minLength: 0,
					maxLength: 8,
				}),
				(options, rows) => {
					const lines = buildTable(rows, options);
					expect(lines).toHaveLength(rows.length + 2);
					const layoutWidth = expectedLineWidth(options);
					for (const line of lines) {
						// Header, separator, and every data row stay in lockstep no
						// matter what content (incl. CJK/emoji, missing cells, or
						// extra cells beyond the column count) lands in the rows.
						expect(displayWidth(line)).toBe(layoutWidth);
					}
				},
			),
		);
	});

	it("content that fits is preserved verbatim with padding on the declared side", () => {
		fc.assert(
			fc.property(
				arbCellText,
				fc.integer({ min: 1, max: 14 }),
				fc.option(fc.constantFrom<"left" | "right">("left", "right"), {
					nil: undefined,
				}),
				(value, width, align) => {
					fc.pre(displayWidth(value) <= width);
					const row = buildTableRow([value], {
						columns: [{ header: "h", width, align }],
					});
					const pad = " ".repeat(width - displayWidth(value));
					// undefined align defaults to left.
					expect(row).toBe(align === "right" ? pad + value : value + pad);
				},
			),
		);
	});

	it("content that overflows is truncated to a prefix plus ellipsis, never overflowing", () => {
		fc.assert(
			fc.property(
				arbCellText,
				fc.integer({ min: 1, max: 6 }),
				fc.constantFrom<"left" | "right">("left", "right"),
				(value, width, align) => {
					fc.pre(displayWidth(value) > width);
					const row = buildTableRow([value], {
						columns: [{ header: "h", width, align }],
					});
					expect(displayWidth(row)).toBe(width);
					// The ellipsis terminates the visible content for either
					// alignment (content can never follow it, so trimming trailing
					// padding cannot eat content).
					expect(row.trimEnd().endsWith("…")).toBe(true);
					// Prefix fidelity is validated on the LEFT-aligned rendering,
					// where the cell starts at column 0: stripping leading spaces on
					// a right-aligned row could eat spaces that belong to the
					// truncated content itself, not just alignment padding.
					const leftRow = buildTableRow([value], {
						columns: [{ header: "h", width, align: "left" }],
					});
					const visible = leftRow.replace(/ +$/, "");
					expect(visible.endsWith("…")).toBe(true);
					expect(value.startsWith(visible.slice(0, -1))).toBe(true);
					expect(displayWidth(visible)).toBeLessThanOrEqual(width);
				},
			),
		);
	});

	it("zero-width columns render empty and never leak an ellipsis into the layout", () => {
		fc.assert(
			fc.property(arbCellText, (value) => {
				const row = buildTableRow([value], {
					columns: [{ header: "h", width: 0 }],
				});
				expect(row).toBe("");
			}),
		);
	});
});
