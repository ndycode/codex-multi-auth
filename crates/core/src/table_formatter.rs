//! Port of `lib/table-formatter.ts`: simple ASCII table formatter for CLI tools.
//!
//! Generates consistent, aligned table output. Cells are measured and padded in
//! *display columns* (via [`crate::display_width`] — CJK/emoji-aware), not code
//! units, so wide-glyph content stays aligned (ui-02).
//!
//! Contract highlights (spec 01 §2.16):
//! - cells joined with a single space;
//! - a column of width `<= 0` renders as the empty string (never an
//!   overflowing ellipsis);
//! - over-wide values truncate to `width - 1` columns plus `…` (U+2026);
//! - right alignment puts the padding before the cell.

use crate::display_width::{display_width, truncate_to_width};

/// Cell alignment. TS `align?: "left" | "right"` with left as the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TableAlign {
    #[default]
    Left,
    Right,
}

/// Column definition.
#[derive(Debug, Clone)]
pub struct TableColumn {
    /// Column header text.
    pub header: String,
    /// Column width (content will be padded/truncated to fit).
    pub width: i32,
    /// Alignment: left (default) or right.
    pub align: TableAlign,
}

impl TableColumn {
    /// Convenience constructor for a left-aligned column.
    pub fn new(header: impl Into<String>, width: i32) -> Self {
        Self {
            header: header.into(),
            width,
            align: TableAlign::Left,
        }
    }
}

/// Table options.
#[derive(Debug, Clone)]
pub struct TableOptions {
    /// Column definitions.
    pub columns: Vec<TableColumn>,
    /// Character used for the header separator line (default: `-`).
    pub separator_char: Option<String>,
}

/// Format a value to fit within a column width.
///
/// ui-02: measure and pad by display columns, not code units, so CJK/emoji
/// content stays aligned. When truncating, reserve one column for the ellipsis
/// and never split a wide glyph across the boundary. A zero-or-negative width
/// column has no room for content OR an ellipsis; returning `…` there would
/// overflow the declared width by one and desync the row from the
/// header/separator layout, so short-circuit to empty.
fn format_cell(value: &str, width: i32, align: TableAlign) -> String {
    if width <= 0 {
        return String::new();
    }
    let width = width as usize;
    let value_width = display_width(value);
    let cell = if value_width > width {
        let truncated = truncate_to_width(value, width.saturating_sub(1));
        format!("{}\u{2026}", truncated.text)
    } else {
        value.to_string()
    };
    let pad = width.saturating_sub(display_width(&cell));
    match align {
        TableAlign::Right => format!("{}{}", " ".repeat(pad), cell),
        TableAlign::Left => format!("{}{}", cell, " ".repeat(pad)),
    }
}

/// Build a table header row and separator line: `[header_row, separator_row]`.
pub fn build_table_header(options: &TableOptions) -> Vec<String> {
    let separator_char = options.separator_char.as_deref().unwrap_or("-");

    let header_row = options
        .columns
        .iter()
        .map(|col| format_cell(&col.header, col.width, col.align))
        .collect::<Vec<_>>()
        .join(" ");

    // NOTE: JS `String.prototype.repeat` throws a RangeError for a negative
    // count; negative widths are therefore de facto unsupported in the TS
    // implementation. Rust clamps to 0 instead of panicking.
    let separator_row = options
        .columns
        .iter()
        .map(|col| separator_char.repeat(col.width.max(0) as usize))
        .collect::<Vec<_>>()
        .join(" ");

    vec![header_row, separator_row]
}

/// Build a single table row from values. Values are matched to columns by
/// index; missing values render as empty cells.
pub fn build_table_row<S: AsRef<str>>(values: &[S], options: &TableOptions) -> String {
    options
        .columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let value = values.get(i).map(|v| v.as_ref()).unwrap_or("");
            format_cell(value, col.width, col.align)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Build a complete table with header, separator, and rows.
pub fn build_table<S: AsRef<str>>(rows: &[Vec<S>], options: &TableOptions) -> Vec<String> {
    let mut lines = build_table_header(options);
    for row in rows {
        lines.push(build_table_row(row, options));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_options() -> TableOptions {
        TableOptions {
            columns: vec![
                TableColumn::new("ID", 4),
                TableColumn::new("Name", 10),
                TableColumn::new("Status", 8),
            ],
            separator_char: None,
        }
    }

    // === buildTableHeader (ported from test/table-formatter.test.ts) ===

    #[test]
    fn builds_header_row_with_proper_padding() {
        let lines = build_table_header(&simple_options());
        assert_eq!(lines[0], "ID   Name       Status  ");
        assert_eq!(lines[1], "---- ---------- --------");
    }

    #[test]
    fn uses_custom_separator_character() {
        let options = TableOptions {
            columns: vec![TableColumn::new("Col", 5)],
            separator_char: Some("=".to_string()),
        };
        let lines = build_table_header(&options);
        assert_eq!(lines[1], "=====");
    }

    // === buildTableRow ===

    #[test]
    fn formats_values_with_proper_padding() {
        let row = build_table_row(&["1", "Alice", "active"], &simple_options());
        assert_eq!(row, "1    Alice      active  ");
    }

    #[test]
    fn truncates_long_values_with_ellipsis() {
        let row = build_table_row(&["1", "VeryLongNameHere", "ok"], &simple_options());
        assert_eq!(row, "1    VeryLongN\u{2026} ok      ");
    }

    #[test]
    fn handles_missing_values_gracefully() {
        let row = build_table_row(&["1"], &simple_options());
        assert_eq!(row, "1                       ");
    }

    #[test]
    fn supports_right_alignment() {
        let options = TableOptions {
            columns: vec![
                TableColumn {
                    header: "Num".to_string(),
                    width: 5,
                    align: TableAlign::Right,
                },
                TableColumn::new("Text", 5),
            ],
            separator_char: None,
        };
        let row = build_table_row(&["42", "abc"], &options);
        assert_eq!(row, "   42 abc  ");
    }

    // ui-02: CJK content must be padded by display columns, not code units.
    #[test]
    fn pads_cjk_values_by_display_width_so_columns_stay_aligned() {
        // Name col width 10; "漢字漢字" = 4 glyphs * 2 cols = 8 cols -> 2 pad spaces.
        let row = build_table_row(&["1", "漢字漢字", "ok"], &simple_options());
        assert_eq!(row, "1    漢字漢字   ok      ");
    }

    #[test]
    fn truncates_wide_glyph_values_without_splitting_a_glyph() {
        // Name width 10: a 6-glyph value = 12 cols overflows. Reserve 1 col for
        // the ellipsis -> keep up to 9 cols of content, but a 5th wide glyph
        // (10 cols) won't fit in 9, so only 4 glyphs (8 cols) are kept, then
        // "…", then pad.
        let row = build_table_row(&["1", "漢字漢字漢字", "ok"], &simple_options());
        assert_eq!(row, "1    漢字漢字\u{2026}  ok      ");
    }

    #[test]
    fn emits_empty_not_an_overflowing_ellipsis_for_a_zero_width_column() {
        // A width-0 column has no room for content OR the "…" — returning "…"
        // would overflow the declared width by one and desync the row from the
        // header/separator layout. The cell must be empty.
        let options = TableOptions {
            columns: vec![TableColumn::new("A", 0), TableColumn::new("B", 3)],
            separator_char: None,
        };
        let row = build_table_row(&["dropped", "ok"], &options);
        // First cell contributes 0 columns; the join space + 3-col "ok " follow.
        assert_eq!(row, " ok ");
        assert!(!row.contains('\u{2026}'));
    }

    // === buildTable ===

    #[test]
    fn builds_complete_table_with_header_and_rows() {
        let rows = vec![
            vec!["1", "Alice", "active"],
            vec!["2", "Bob", "idle"],
        ];
        let lines = build_table(&rows, &simple_options());
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], "ID   Name       Status  ");
        assert_eq!(lines[1], "---- ---------- --------");
        assert_eq!(lines[2], "1    Alice      active  ");
        assert_eq!(lines[3], "2    Bob        idle    ");
    }

    #[test]
    fn handles_empty_rows_array() {
        let rows: Vec<Vec<&str>> = Vec::new();
        let lines = build_table(&rows, &simple_options());
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("ID"));
        assert!(lines[1].contains("----"));
    }
}
