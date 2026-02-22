/**
 * Simple ASCII table formatter for CLI tools.
 * Generates consistent, aligned table output.
 */

export interface TableColumn {
	/** Column header text */
	header: string;
	/** Column width (content will be padded/truncated to fit) */
	width: number;
	/** Alignment: 'left' (default) or 'right' */
	align?: "left" | "right";
}

export interface TableOptions {
	/** Column definitions */
	columns: TableColumn[];
	/** Character used for header separator line (default: '-') */
	separatorChar?: string;
}

/**
 * Format a value to fit within a column width.
 */
function formatCell(value: string, width: number, align: "left" | "right" = "left"): string {
	const truncated = value.length > width ? value.slice(0, width - 1) + "…" : value;
	return align === "right" ? truncated.padStart(width) : truncated.padEnd(width);
}

/**
 * Build a table header row and separator line.
 */
export function buildTableHeader(options: TableOptions): string[] {
	const { columns, separatorChar = "-" } = options;

	const headerRow = columns.map((col) => formatCell(col.header, col.width, col.align)).join(" ");

	const separatorRow = columns.map((col) => separatorChar.repeat(col.width)).join(" ");

	return [headerRow, separatorRow];
}

/**
 * Build a single table row from values.
 * Values are matched to columns by index.
 */
export function buildTableRow(values: string[], options: TableOptions): string {
	const { columns } = options;

	return columns
		.map((col, i) => {
			const value = values[i] ?? "";
			return formatCell(value, col.width, col.align);
		})
		.join(" ");
}

/**
 * Build a complete table with header, separator, and rows.
 */
export function buildTable(rows: string[][], options: TableOptions): string[] {
	const lines = buildTableHeader(options);
	for (const row of rows) {
		lines.push(buildTableRow(row, options));
	}
	return lines;
}
