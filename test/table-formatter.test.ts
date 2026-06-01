import { describe, it, expect } from "vitest";
import {
	buildTableHeader,
	buildTableRow,
	buildTable,
	type TableOptions,
} from "../lib/table-formatter.js";

describe("table-formatter", () => {
	const simpleOptions: TableOptions = {
		columns: [
			{ header: "ID", width: 4 },
			{ header: "Name", width: 10 },
			{ header: "Status", width: 8 },
		],
	};

	describe("buildTableHeader", () => {
		it("builds header row with proper padding", () => {
			const [headerRow, separator] = buildTableHeader(simpleOptions);

			expect(headerRow).toBe("ID   Name       Status  ");
			expect(separator).toBe("---- ---------- --------");
		});

		it("uses custom separator character", () => {
			const options: TableOptions = {
				columns: [{ header: "Col", width: 5 }],
				separatorChar: "=",
			};

			const [, separator] = buildTableHeader(options);
			expect(separator).toBe("=====");
		});
	});

	describe("buildTableRow", () => {
		it("formats values with proper padding", () => {
			const row = buildTableRow(["1", "Alice", "active"], simpleOptions);
			expect(row).toBe("1    Alice      active  ");
		});

		it("truncates long values with ellipsis", () => {
			const row = buildTableRow(["1", "VeryLongNameHere", "ok"], simpleOptions);
			expect(row).toBe("1    VeryLongN… ok      ");
		});

		it("handles missing values gracefully", () => {
			const row = buildTableRow(["1"], simpleOptions);
			expect(row).toBe("1                       ");
		});

		it("supports right alignment", () => {
			const options: TableOptions = {
				columns: [
					{ header: "Num", width: 5, align: "right" },
					{ header: "Text", width: 5 },
				],
			};

			const row = buildTableRow(["42", "abc"], options);
			expect(row).toBe("   42 abc  ");
		});

		// ui-02: CJK content must be padded by display columns, not code units.
		it("pads CJK values by display width so columns stay aligned", () => {
			// Name col width 10; "漢字漢字" = 4 glyphs * 2 cols = 8 cols -> 2 pad spaces.
			const row = buildTableRow(["1", "漢字漢字", "ok"], simpleOptions);
			// "1" -> 4 cols, "漢字漢字" -> 8 + 2 pad = 10 cols, "ok" -> 8 cols.
			expect(row).toBe("1    漢字漢字   ok      ");
		});

		it("truncates wide-glyph values without splitting a glyph", () => {
			// Name width 10: a 6-glyph value = 12 cols overflows. Reserve 1 col for the
			// ellipsis -> keep up to 9 cols of content, but a 5th wide glyph (10 cols)
			// won't fit in 9, so only 4 glyphs (8 cols) are kept, then "…", then pad.
			const row = buildTableRow(["1", "漢字漢字漢字", "ok"], simpleOptions);
			expect(row).toBe("1    漢字漢字…  ok      ");
		});
	});

	describe("buildTable", () => {
		it("builds complete table with header and rows", () => {
			const rows = [
				["1", "Alice", "active"],
				["2", "Bob", "idle"],
			];

			const lines = buildTable(rows, simpleOptions);

			expect(lines).toHaveLength(4);
			expect(lines[0]).toBe("ID   Name       Status  ");
			expect(lines[1]).toBe("---- ---------- --------");
			expect(lines[2]).toBe("1    Alice      active  ");
			expect(lines[3]).toBe("2    Bob        idle    ");
		});

		it("handles empty rows array", () => {
			const lines = buildTable([], simpleOptions);

			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("ID");
			expect(lines[1]).toContain("----");
		});
	});
});
