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
