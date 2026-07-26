//! Port of `lib/ui/select.ts` — the interactive single-select TUI menu engine.
//!
//! A hand-rolled inline (non-alt-screen) raw-mode renderer over crossterm
//! (ARCHITECTURE §5.3). Contracts preserved from TS (spec 12 §6 + gotchas):
//! - exactly ONE selectable item => its value is returned immediately with no
//!   terminal interaction;
//! - 120 ms input-suppression guard after open (drops enter/escape only);
//! - bare-ESC vs escape-sequence disambiguation with a 50 ms timer;
//! - Ctrl-C in raw mode is "escape" (cancel), not a signal;
//! - `on_input` finishing condition: `Finish(None)` cancels, `Ignored`
//!   continues;
//! - `truncate_ansi` appends `\x1b[0m` after the `...` suffix only when the
//!   kept prefix contains an ESC (ui-01);
//! - cleanup tears down timers/listeners BEFORE restoring the terminal mode,
//!   each step individually guarded, and the cursor is always re-shown.
//!
//! Rendering is split into the pure [`render_select_frame`] (exact-string
//! testable) and the thin stdout writer used by [`select`].

use std::io::Write;
use std::time::{Duration, Instant};

use cma_core::display_width::display_width;
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};

use crate::ansi;
use crate::ansi::KeyAction;
use crate::theme::UiTheme;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuColor {
    Red,
    Green,
    Yellow,
    Cyan,
}

/// TS `MenuItem<T>`; `kind: "heading"` becomes the `heading` flag.
#[derive(Debug, Clone)]
pub struct MenuItem<T> {
    pub label: String,
    pub selected_label: Option<String>,
    pub value: T,
    pub hint: Option<String>,
    pub disabled: bool,
    pub hide_unavailable_suffix: bool,
    pub separator: bool,
    pub heading: bool,
    pub color: Option<MenuColor>,
}

impl<T> MenuItem<T> {
    pub fn new(label: impl Into<String>, value: T) -> Self {
        MenuItem {
            label: label.into(),
            selected_label: None,
            value,
            hint: None,
            disabled: false,
            hide_unavailable_suffix: false,
            separator: false,
            heading: false,
            color: None,
        }
    }

    pub fn separator(value: T) -> Self {
        let mut item = MenuItem::new("", value);
        item.separator = true;
        item
    }

    pub fn heading(label: impl Into<String>, value: T) -> Self {
        let mut item = MenuItem::new(label, value);
        item.heading = true;
        item
    }

    pub fn with_color(mut self, color: MenuColor) -> Self {
        self.color = Some(color);
        self
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectedEmphasis {
    Chip,
    Minimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FocusStyle {
    #[default]
    RowInvert,
    Chip,
}

/// Result of an `on_input` callback (TS `T | null | undefined`):
/// `Ignored` = `undefined` (continue), `Finish(None)` = `null` (cancel),
/// `Finish(Some(v))` = finish with `v`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectInputResult<T> {
    Ignored,
    Finish(Option<T>),
}

/// Context passed to `on_input` / `on_cursor_change` callbacks.
pub struct SelectContext<'i, T> {
    pub cursor: usize,
    pub items: &'i [MenuItem<T>],
    rerender_requested: &'i mut bool,
}

impl<T> SelectContext<'_, T> {
    pub fn request_rerender(&mut self) {
        *self.rerender_requested = true;
    }
}

pub type OnCursorChange<'cb, T> = Box<dyn FnMut(&mut SelectContext<'_, T>) + 'cb>;
pub type OnInput<'cb, T> =
    Box<dyn FnMut(&str, &mut SelectContext<'_, T>) -> SelectInputResult<T> + 'cb>;

/// TS `SelectOptions<T>`. `selected_emphasis` is accepted but never read by the
/// render code (API compatibility only) — only `focus_style` matters.
pub struct SelectOptions<'cb, T> {
    pub message: String,
    pub subtitle: Option<String>,
    pub dynamic_subtitle: Option<Box<dyn Fn() -> Option<String> + 'cb>>,
    pub help: Option<String>,
    pub clear_screen: bool,
    pub theme: Option<UiTheme>,
    pub selected_emphasis: Option<SelectedEmphasis>,
    pub focus_style: Option<FocusStyle>,
    pub show_hints_for_unselected: Option<bool>,
    pub refresh_interval_ms: Option<f64>,
    pub initial_cursor: Option<i64>,
    pub allow_escape: Option<bool>,
    pub on_cursor_change: Option<OnCursorChange<'cb, T>>,
    pub on_input: Option<OnInput<'cb, T>>,
}

impl<T> SelectOptions<'_, T> {
    pub fn new(message: impl Into<String>) -> Self {
        SelectOptions {
            message: message.into(),
            subtitle: None,
            dynamic_subtitle: None,
            help: None,
            clear_screen: false,
            theme: None,
            selected_emphasis: None,
            focus_style: None,
            show_hints_for_unselected: None,
            refresh_interval_ms: None,
            initial_cursor: None,
            allow_escape: None,
            on_cursor_change: None,
            on_input: None,
        }
    }
}

/// Errors thrown by `select` in TS; message strings are FROZEN.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectError {
    NotTty,
    NoItems,
    AllDisabled,
}

impl std::fmt::Display for SelectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SelectError::NotTty => write!(f, "Interactive select requires a TTY terminal"),
            SelectError::NoItems => write!(f, "No menu items provided"),
            SelectError::AllDisabled => write!(f, "All menu items are disabled"),
        }
    }
}

impl std::error::Error for SelectError {}

const ESCAPE_TIMEOUT_MS: u64 = 50;
const INPUT_GUARD_MS: u64 = 120;

/// Matches the leading `\x1b\[[0-9;]*m` SGR sequence, if any.
fn match_leading_sgr(input: &str) -> Option<&str> {
    let bytes = input.as_bytes();
    if bytes.len() < 2 || bytes[0] != 0x1b || bytes[1] != b'[' {
        return None;
    }
    let mut i = 2;
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b';') {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'm' {
        Some(&input[..=i])
    } else {
        None
    }
}

/// Strips SGR sequences (`/\x1b\[[0-9;]*m/g`) — SGR only, like the TS regex.
pub fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('\x1b') {
        output.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        if let Some(m) = match_leading_sgr(tail) {
            rest = &tail[m.len()..];
        } else {
            // Not an SGR sequence: keep the ESC char and move on.
            output.push('\x1b');
            rest = &tail['\x1b'.len_utf8()..];
        }
    }
    output.push_str(rest);
    output
}

/// Truncates a string to at most `max_visible_chars` display columns while
/// preserving ANSI SGR sequences, appending a `...` suffix (and a reset when
/// the kept prefix contains an ESC — ui-01). Widths are display columns, so a
/// 2-column glyph is never split. Exported for unit testing, like the TS.
pub fn truncate_ansi(input: &str, max_visible_chars: i64) -> String {
    if max_visible_chars <= 0 {
        return String::new();
    }
    let max_visible = max_visible_chars as usize;
    let visible = strip_ansi(input);
    if display_width(&visible) <= max_visible {
        return input.to_string();
    }

    // Reserve room for the suffix in display columns ("..." is 3 columns).
    let suffix = if max_visible >= 3 {
        "...".to_string()
    } else {
        ".".repeat(max_visible)
    };
    let keep = max_visible.saturating_sub(display_width(&suffix));
    let mut kept_width = 0usize;
    let mut output = String::new();
    let mut rest = input;

    while !rest.is_empty() && kept_width < keep {
        if rest.starts_with('\x1b')
            && let Some(m) = match_leading_sgr(rest) {
                output.push_str(m);
                rest = &rest[m.len()..];
                continue;
            }
        // Advance one full code point and budget by its display width so a
        // 2-column glyph is never split or allowed to overflow.
        let ch = match rest.chars().next() {
            Some(ch) => ch,
            None => break,
        };
        let mut buf = [0u8; 4];
        let ch_str: &str = ch.encode_utf8(&mut buf);
        let w = display_width(ch_str);
        if kept_width + w > keep {
            break;
        }
        output.push(ch);
        rest = &rest[ch.len_utf8()..];
        kept_width += w;
    }

    // ui-01: if the kept portion contains any ANSI escape, append a reset so
    // the color does not bleed past the truncation point.
    let reset = if output.contains('\x1b') { "\x1b[0m" } else { "" };
    format!("{output}{suffix}{reset}")
}

fn color_code(color: Option<MenuColor>) -> &'static str {
    match color {
        Some(MenuColor::Red) => ansi::RED,
        Some(MenuColor::Green) => ansi::GREEN,
        Some(MenuColor::Yellow) => ansi::YELLOW,
        Some(MenuColor::Cyan) => ansi::CYAN,
        None => "",
    }
}

/// TS `decodeHotkeyInput`: keypad escape sequences map to their digit/operator;
/// otherwise the first printable ASCII char wins; else `None`. Exported logic
/// kept as a pure byte-level function for parity tests; the interactive loop
/// receives already-decoded chars from crossterm.
pub fn decode_hotkey_input(data: &[u8]) -> Option<char> {
    let input = String::from_utf8_lossy(data);
    let mapped = match input.as_ref() {
        "\x1bOp" => Some('0'),
        "\x1bOq" => Some('1'),
        "\x1bOr" => Some('2'),
        "\x1bOs" => Some('3'),
        "\x1bOt" => Some('4'),
        "\x1bOu" => Some('5'),
        "\x1bOv" => Some('6'),
        "\x1bOw" => Some('7'),
        "\x1bOx" => Some('8'),
        "\x1bOy" => Some('9'),
        "\x1bOk" => Some('+'),
        "\x1bOm" => Some('-'),
        "\x1bOj" => Some('*'),
        "\x1bOo" => Some('/'),
        "\x1bOn" => Some('.'),
        _ => None,
    };
    if mapped.is_some() {
        return mapped;
    }
    // Fallback: strip control bytes and keep first printable ASCII char.
    input.chars().find(|&ch| (' '..='~').contains(&ch))
}

fn is_selectable<T>(item: &MenuItem<T>) -> bool {
    !item.disabled && !item.separator && !item.heading
}

/// Inputs to the pure frame renderer (one call == one TS `render()`).
pub struct SelectFrameParams<'a, T> {
    pub items: &'a [MenuItem<T>],
    pub cursor: usize,
    pub message: &'a str,
    /// Already-resolved subtitle (`dynamicSubtitle?.() ?? subtitle`).
    pub subtitle_text: Option<&'a str>,
    pub help: Option<&'a str>,
    pub clear_screen: bool,
    pub theme: Option<&'a UiTheme>,
    pub focus_style: FocusStyle,
    pub show_hints_for_unselected: bool,
    pub columns: usize,
    pub rows: usize,
}

pub struct SelectFrame {
    /// The exact byte sequence written to stdout for this frame.
    pub output: String,
    /// Number of physical lines written (TS `renderedLines`).
    pub lines_written: usize,
}

/// Pure port of the TS `render()` — produces the exact stdout byte sequence.
pub fn render_select_frame<T>(
    params: &SelectFrameParams<'_, T>,
    previous_rendered_lines: usize,
    has_rendered: bool,
) -> SelectFrame {
    let columns = params.columns as i64;
    let rows = params.rows as i64;
    let items = params.items;
    let cursor = params.cursor;
    let theme = params.theme;
    // Empty subtitles are falsy in TS.
    let subtitle_text = params.subtitle_text.filter(|s| !s.is_empty());

    let mut output = String::new();
    let mut did_full_clear = false;
    if params.clear_screen && !has_rendered {
        output.push_str(ansi::CLEAR_SCREEN);
        output.push_str(&ansi::move_to(1, 1));
        did_full_clear = true;
    } else if previous_rendered_lines > 0 {
        output.push_str(&ansi::up(previous_rendered_lines));
    }

    let mut lines_written = 0usize;
    let write_line = |output: &mut String, lines_written: &mut usize, line: &str| {
        output.push_str(ansi::CLEAR_LINE);
        output.push_str(line);
        output.push('\n');
        *lines_written += 1;
    };

    let subtitle_lines: i64 = if subtitle_text.is_some() { 2 } else { 0 };
    let fixed_lines = 2 + subtitle_lines + 2;
    let max_visible_items =
        std::cmp::max(1, std::cmp::min(items.len() as i64, rows - fixed_lines - 1)) as usize;

    let mut window_start = 0usize;
    let mut window_end = items.len();
    if items.len() > max_visible_items {
        let half = (max_visible_items / 2) as i64;
        let start = (cursor as i64) - half;
        let clamped = std::cmp::max(
            0,
            std::cmp::min(start, items.len() as i64 - max_visible_items as i64),
        ) as usize;
        window_start = clamped;
        window_end = window_start + max_visible_items;
    }

    let visible_len = window_end - window_start;
    let border = theme.map(|t| t.colors.border.as_str()).unwrap_or(ansi::DIM);
    let muted = theme.map(|t| t.colors.muted.as_str()).unwrap_or(ansi::DIM);
    let heading_color = theme
        .map(|t| t.colors.heading.as_str())
        .unwrap_or(ansi::RESET);
    let reset = theme.map(|t| t.colors.reset.as_str()).unwrap_or(ansi::RESET);
    let selected_glyph = theme.map(|t| t.glyphs.selected).unwrap_or(">");
    let unselected_glyph = theme.map(|t| t.glyphs.unselected).unwrap_or("o");
    let selected_glyph_color = theme
        .map(|t| t.colors.success.as_str())
        .unwrap_or(ansi::GREEN);
    let selected_chip = match theme {
        None => format!("{}{}{}", ansi::BG_GREEN, ansi::BLACK, ansi::BOLD),
        Some(t) => format!("{}{}{}", t.colors.focus_bg, t.colors.focus_text, ansi::BOLD),
    };
    let codex_color_code = |color: Option<MenuColor>| -> &str {
        match theme {
            None => color_code(color),
            Some(t) => match color {
                Some(MenuColor::Red) => t.colors.danger.as_str(),
                Some(MenuColor::Green) => t.colors.success.as_str(),
                Some(MenuColor::Yellow) => t.colors.warning.as_str(),
                Some(MenuColor::Cyan) => t.colors.accent.as_str(),
                None => t.colors.heading.as_str(),
            },
        }
    };

    write_line(
        &mut output,
        &mut lines_written,
        &format!(
            "{border}+{reset} {heading_color}{}{reset}",
            truncate_ansi(params.message, std::cmp::max(1, columns - 4))
        ),
    );
    if let Some(subtitle) = subtitle_text {
        write_line(
            &mut output,
            &mut lines_written,
            &format!(
                " {muted}{}{reset}",
                truncate_ansi(subtitle, std::cmp::max(1, columns - 2))
            ),
        );
    }
    write_line(&mut output, &mut lines_written, "");

    for (i, item) in items[window_start..window_end].iter().enumerate() {
        let item_index = window_start + i;

        if item.separator {
            write_line(&mut output, &mut lines_written, "");
            continue;
        }

        if item.heading {
            let heading_text = truncate_ansi(
                &format!("{muted}{}{reset}", item.label),
                std::cmp::max(1, columns - 2),
            );
            write_line(&mut output, &mut lines_written, &format!(" {heading_text}"));
            continue;
        }

        let selected = item_index == cursor;
        if selected {
            let selected_text = match &item.selected_label {
                Some(selected_label) => strip_ansi(selected_label),
                None => {
                    if item.disabled {
                        if item.hide_unavailable_suffix {
                            strip_ansi(&item.label)
                        } else {
                            format!("{} (unavailable)", strip_ansi(&item.label))
                        }
                    } else {
                        strip_ansi(&item.label)
                    }
                }
            };
            match params.focus_style {
                FocusStyle::RowInvert => {
                    let row_text = format!("{selected_glyph} {selected_text}");
                    let focused_row = match theme {
                        Some(t) => format!(
                            "{}{}{}{}{reset}",
                            t.colors.focus_bg,
                            t.colors.focus_text,
                            ansi::BOLD,
                            truncate_ansi(&row_text, std::cmp::max(1, columns - 2))
                        ),
                        None => format!(
                            "{}{}{}",
                            ansi::INVERSE,
                            truncate_ansi(&row_text, std::cmp::max(1, columns - 2)),
                            ansi::RESET
                        ),
                    };
                    write_line(&mut output, &mut lines_written, &format!(" {focused_row}"));
                }
                FocusStyle::Chip => {
                    let selected_label = format!("{selected_chip}{selected_text}{reset}");
                    write_line(
                        &mut output,
                        &mut lines_written,
                        &format!(
                            " {selected_glyph_color}{selected_glyph}{reset} {}",
                            truncate_ansi(&selected_label, std::cmp::max(1, columns - 4))
                        ),
                    );
                }
            }
            if let Some(hint) = &item.hint {
                for detail_line in hint.split('\n').take(3) {
                    let detail = truncate_ansi(detail_line, std::cmp::max(1, columns - 8));
                    write_line(&mut output, &mut lines_written, &format!("   {muted}{detail}{reset}"));
                }
            }
        } else {
            let item_color = codex_color_code(item.color);
            let label_text = if item.disabled {
                if item.hide_unavailable_suffix {
                    format!("{muted}{}{reset}", item.label)
                } else {
                    format!("{muted}{} (unavailable){reset}", item.label)
                }
            } else {
                format!("{item_color}{}{reset}", item.label)
            };
            write_line(
                &mut output,
                &mut lines_written,
                &format!(
                    " {muted}{unselected_glyph}{reset} {}",
                    truncate_ansi(&label_text, std::cmp::max(1, columns - 4))
                ),
            );
            if let Some(hint) = &item.hint
                && params.show_hints_for_unselected {
                    for detail_line in hint.split('\n').take(2) {
                        let detail = truncate_ansi(
                            &format!("{muted}{detail_line}{reset}"),
                            std::cmp::max(1, columns - 8),
                        );
                        write_line(&mut output, &mut lines_written, &format!("   {detail}"));
                    }
                }
        }
    }

    let window_hint = if items.len() > visible_len {
        format!(" ({}-{}/{})", window_start + 1, window_end, items.len())
    } else {
        String::new()
    };
    let help_text = match params.help {
        Some(help) => help.to_string(),
        None => format!("\u{2191}\u{2193} Move | Enter Select | Q Back{window_hint}"),
    };
    write_line(
        &mut output,
        &mut lines_written,
        &format!(
            " {muted}{}{reset}",
            truncate_ansi(&help_text, std::cmp::max(1, columns - 2))
        ),
    );
    write_line(&mut output, &mut lines_written, &format!("{border}+{reset}"));

    if !did_full_clear && previous_rendered_lines > lines_written {
        let extra = previous_rendered_lines - lines_written;
        for _ in 0..extra {
            write_line(&mut output, &mut lines_written, "");
        }
    }

    SelectFrame {
        output,
        lines_written,
    }
}

fn terminal_size() -> (usize, usize) {
    match crossterm::terminal::size() {
        Ok((cols, rows)) => (cols as usize, rows as usize),
        Err(_) => (80, 24),
    }
}

fn write_stdout(text: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// Restore terminal state. Mirrors the TS cleanup ordering guarantees: every
/// step is individually best-effort and the cursor is always re-shown.
fn cleanup_terminal(was_raw: bool) {
    if !was_raw {
        let _ = crossterm::terminal::disable_raw_mode();
    }
    write_stdout(ansi::SHOW);
}

/// Present an interactive TTY menu and let the user navigate and choose.
///
/// Returns `Ok(Some(value))` on selection, `Ok(None)` on cancel (Q / Esc /
/// Ctrl-C / raw-mode failure), or `Err` with the frozen TS error strings when
/// preconditions fail.
// The rerender flag mirrors the TS mutable `rerenderRequested` write pattern
// (reset before every callback), which trips the dead-store lint.
#[allow(unused_assignments)]
pub fn select<T: Clone>(
    items: &[MenuItem<T>],
    mut options: SelectOptions<'_, T>,
) -> Result<Option<T>, SelectError> {
    if !crate::ansi::is_tty() {
        return Err(SelectError::NotTty);
    }
    if items.is_empty() {
        return Err(SelectError::NoItems);
    }

    let selectable_count = items.iter().filter(|i| is_selectable(i)).count();
    if selectable_count == 0 {
        return Err(SelectError::AllDisabled);
    }
    if selectable_count == 1 {
        // Exactly one selectable item: return its value immediately without
        // rendering anything — callers rely on this.
        return Ok(items.iter().find(|i| is_selectable(i)).map(|i| i.value.clone()));
    }

    let first_selectable = items.iter().position(is_selectable).unwrap_or(0);
    let mut cursor = first_selectable;
    if let Some(initial) = options.initial_cursor {
        let bounded = std::cmp::max(0, std::cmp::min(items.len() as i64 - 1, initial)) as usize;
        cursor = bounded;
    }
    if !is_selectable(&items[cursor]) {
        cursor = first_selectable;
    }

    // Pull the render inputs and callbacks out of the options bag once.
    let message = options.message.clone();
    let static_subtitle = options.subtitle.clone();
    let dynamic_subtitle = options.dynamic_subtitle.take();
    let help = options.help.clone();
    let clear_screen = options.clear_screen;
    let theme = options.theme.clone();
    let focus_style = options.focus_style.unwrap_or_default();
    let show_hints_for_unselected = options.show_hints_for_unselected.unwrap_or(true);
    let allow_escape = options.allow_escape.unwrap_or(true);
    let mut on_cursor_change = options.on_cursor_change.take();
    let mut on_input = options.on_input.take();

    let was_raw = crossterm::terminal::is_raw_mode_enabled().unwrap_or(false);
    if crossterm::terminal::enable_raw_mode().is_err() {
        cleanup_terminal(was_raw);
        return Ok(None);
    }

    // Drain any buffered input so a queued Enter cannot instantly accept.
    while crossterm::event::poll(Duration::from_millis(0)).unwrap_or(false) {
        let _ = crossterm::event::read();
    }
    let input_guard_until = Instant::now() + Duration::from_millis(INPUT_GUARD_MS);
    write_stdout(ansi::HIDE);

    let mut rendered_lines = 0usize;
    let mut has_rendered = false;
    let mut rerender_requested = false;

    macro_rules! render {
        () => {{
            let subtitle_owned: Option<String> = match &dynamic_subtitle {
                Some(f) => f(),
                None => static_subtitle.clone(),
            };
            let (columns, rows) = terminal_size();
            let frame = render_select_frame(
                &SelectFrameParams {
                    items,
                    cursor,
                    message: &message,
                    subtitle_text: subtitle_owned.as_deref(),
                    help: help.as_deref(),
                    clear_screen,
                    theme: theme.as_ref(),
                    focus_style,
                    show_hints_for_unselected,
                    columns,
                    rows,
                },
                rendered_lines,
                has_rendered,
            );
            write_stdout(&frame.output);
            rendered_lines = frame.lines_written;
            has_rendered = true;
        }};
    }

    macro_rules! notify_cursor_change {
        () => {{
            if let Some(cb) = on_cursor_change.as_mut() {
                rerender_requested = false;
                let mut ctx = SelectContext {
                    cursor,
                    items,
                    rerender_requested: &mut rerender_requested,
                };
                cb(&mut ctx);
            }
        }};
    }

    macro_rules! finish {
        ($value:expr) => {{
            cleanup_terminal(was_raw);
            return Ok($value);
        }};
    }

    notify_cursor_change!();
    render!();

    let refresh_interval: Option<Duration> = match (&dynamic_subtitle, options.refresh_interval_ms)
    {
        (Some(_), Some(ms)) if ms > 0.0 => {
            Some(Duration::from_millis(std::cmp::max(80, ms.round() as u64)))
        }
        _ => None,
    };
    let mut next_refresh = refresh_interval.map(|d| Instant::now() + d);
    let mut escape_deadline: Option<Instant> = None;

    let find_next_selectable = |from: usize, direction: i64| -> usize {
        let len = items.len() as i64;
        let mut next = from as i64;
        loop {
            next = (next + direction + len) % len;
            let item = &items[next as usize];
            if !(item.disabled || item.separator || item.heading) {
                break;
            }
        }
        next as usize
    };

    loop {
        let now = Instant::now();
        if let Some(deadline) = escape_deadline
            && now >= deadline {
                // Bare ESC with no follow-up bytes: it really was Escape.
                finish!(None);
            }
        if let Some(due) = next_refresh
            && now >= due {
                render!();
                next_refresh = refresh_interval.map(|d| Instant::now() + d);
            }

        let mut timeout = Duration::from_millis(500);
        for deadline in [escape_deadline, next_refresh].into_iter().flatten() {
            let remaining = deadline.saturating_duration_since(now);
            if remaining < timeout {
                timeout = remaining;
            }
        }

        let has_event = crossterm::event::poll(timeout).unwrap_or(false);
        if !has_event {
            continue;
        }
        let event = match crossterm::event::read() {
            Ok(event) => event,
            Err(_) => continue,
        };
        let key = match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => key,
            _ => continue,
        };

        // Every input event first clears any pending escape timeout (it was an
        // escape-sequence prefix, not a lone ESC).
        escape_deadline = None;

        let action: Option<KeyAction> = match key.code {
            KeyCode::Up => Some(KeyAction::Up),
            KeyCode::Down => Some(KeyAction::Down),
            KeyCode::Home => Some(KeyAction::Home),
            KeyCode::End => Some(KeyAction::End),
            KeyCode::Enter => Some(KeyAction::Enter),
            KeyCode::Esc => Some(KeyAction::EscapeStart),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Some(KeyAction::Escape)
            }
            _ => None,
        };

        // 120 ms input guard: drop enter/escape/escape-start only; arrows and
        // hotkeys still work immediately.
        if Instant::now() < input_guard_until
            && matches!(
                action,
                Some(KeyAction::Enter) | Some(KeyAction::Escape) | Some(KeyAction::EscapeStart)
            )
        {
            continue;
        }

        match action {
            Some(KeyAction::Up) => {
                cursor = find_next_selectable(cursor, -1);
                notify_cursor_change!();
                render!();
            }
            Some(KeyAction::Down) => {
                cursor = find_next_selectable(cursor, 1);
                notify_cursor_change!();
                render!();
            }
            Some(KeyAction::Home) => {
                cursor = items.iter().position(is_selectable).unwrap_or(cursor);
                notify_cursor_change!();
                render!();
            }
            Some(KeyAction::End) => {
                for i in (0..items.len()).rev() {
                    if is_selectable(&items[i]) {
                        cursor = i;
                        break;
                    }
                }
                notify_cursor_change!();
                render!();
            }
            Some(KeyAction::Enter) => {
                finish!(Some(items[cursor].value.clone()));
            }
            Some(KeyAction::Escape) => {
                if allow_escape {
                    finish!(None);
                }
            }
            Some(KeyAction::EscapeStart) => {
                if allow_escape {
                    escape_deadline =
                        Some(Instant::now() + Duration::from_millis(ESCAPE_TIMEOUT_MS));
                }
            }
            None => {
                let hotkey: Option<char> = match key.code {
                    KeyCode::Char(ch)
                        if (' '..='~').contains(&ch)
                            && !key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        Some(ch)
                    }
                    _ => None,
                };
                if let Some(hk) = hotkey {
                    if hk.eq_ignore_ascii_case(&'q') {
                        finish!(None);
                    }
                    if let Some(cb) = on_input.as_mut() {
                        rerender_requested = false;
                        let result = {
                            let mut ctx = SelectContext {
                                cursor,
                                items,
                                rerender_requested: &mut rerender_requested,
                            };
                            cb(&hk.to_string(), &mut ctx)
                        };
                        match result {
                            SelectInputResult::Finish(value) => {
                                finish!(value);
                            }
                            SelectInputResult::Ignored => {
                                if rerender_requested {
                                    render!();
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{create_ui_theme, CreateUiThemeOptions};

    const ESC: char = '\x1b';

    // ---- truncateAnsi ANSI reset placement (ui-01) — from test/select.test.ts ----

    #[test]
    fn appends_suffix_and_reset_when_kept_portion_contains_ansi() {
        let red = format!("{ESC}[31m");
        let reset = format!("{ESC}[0m");
        // 10 colored visible chars truncated to 5 -> keep 2 visible, then reset.
        let out = truncate_ansi(&format!("{red}abcdefghij"), 5);
        assert!(out.ends_with(&format!("...{reset}")));
        assert!(out.starts_with(&red));
        assert_eq!(out, format!("{red}ab...{reset}"));
    }

    #[test]
    fn does_not_add_extra_reset_when_colored_input_fits() {
        let red = format!("{ESC}[31m");
        let reset = format!("{ESC}[0m");
        let input = format!("{red}abc{reset}");
        // Fits within width -> returned unchanged, no second reset appended.
        assert_eq!(truncate_ansi(&input, 10), input);
    }

    #[test]
    fn does_not_add_reset_when_plain_input_is_truncated() {
        let reset = format!("{ESC}[0m");
        let out = truncate_ansi("abcdefghij", 5);
        assert!(!out.contains(&reset));
        assert!(out.ends_with("..."));
        assert_eq!(out, "ab...");
    }

    #[test]
    fn still_ends_with_single_reset_when_multiple_escapes_kept() {
        let red = format!("{ESC}[31m");
        let reset = format!("{ESC}[0m");
        let out = truncate_ansi(&format!("{red}a{reset}{red}bcdefghij"), 5);
        assert!(out.ends_with(&reset));
        assert!(!out.ends_with(&format!("{reset}{reset}")));
    }

    #[test]
    fn truncate_ansi_zero_or_negative_budget_yields_empty() {
        assert_eq!(truncate_ansi("abc", 0), "");
        assert_eq!(truncate_ansi("abc", -3), "");
    }

    #[test]
    fn truncate_ansi_short_budget_uses_dot_suffix() {
        // maxVisibleChars < 3 => suffix is ".".repeat(maxVisibleChars), keep 0.
        assert_eq!(truncate_ansi("abcdef", 2), "..");
        assert_eq!(truncate_ansi("abcdef", 1), ".");
    }

    #[test]
    fn truncate_ansi_never_splits_a_wide_glyph() {
        // "漢" is 2 columns. Budget 6 => keep 3 => "漢" (2) fits, second would
        // exceed keep, so it stops at 1 glyph + "...".
        let out = truncate_ansi("漢漢漢漢", 6);
        assert_eq!(out, "漢...");
    }

    #[test]
    fn strip_ansi_removes_sgr_only() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        // Non-SGR CSI (cursor up) is NOT stripped by the SGR-only regex.
        assert_eq!(strip_ansi("\x1b[2Ax"), "\x1b[2Ax");
    }

    // ---- decodeHotkeyInput ----

    #[test]
    fn decode_hotkey_maps_keypad_sequences() {
        assert_eq!(decode_hotkey_input(b"\x1bOp"), Some('0'));
        assert_eq!(decode_hotkey_input(b"\x1bOq"), Some('1'));
        assert_eq!(decode_hotkey_input(b"\x1bOy"), Some('9'));
        assert_eq!(decode_hotkey_input(b"\x1bOk"), Some('+'));
        assert_eq!(decode_hotkey_input(b"\x1bOm"), Some('-'));
        assert_eq!(decode_hotkey_input(b"\x1bOj"), Some('*'));
        assert_eq!(decode_hotkey_input(b"\x1bOo"), Some('/'));
        assert_eq!(decode_hotkey_input(b"\x1bOn"), Some('.'));
    }

    #[test]
    fn decode_hotkey_keeps_first_printable_ascii_char() {
        assert_eq!(decode_hotkey_input(b"x"), Some('x'));
        assert_eq!(decode_hotkey_input(b"\x01a"), Some('a'));
        assert_eq!(decode_hotkey_input(b"\x01\x02"), None);
        assert_eq!(decode_hotkey_input(b""), None);
    }

    // ---- error strings (frozen contract) ----

    #[test]
    fn select_error_messages_are_frozen() {
        assert_eq!(
            SelectError::NotTty.to_string(),
            "Interactive select requires a TTY terminal"
        );
        assert_eq!(SelectError::NoItems.to_string(), "No menu items provided");
        assert_eq!(
            SelectError::AllDisabled.to_string(),
            "All menu items are disabled"
        );
    }

    // ---- pure render frame: exact output strings ----

    fn plain_items() -> Vec<MenuItem<&'static str>> {
        vec![MenuItem::new("A", "a"), MenuItem::new("B", "b")]
    }

    #[test]
    fn renders_exact_unthemed_first_frame() {
        let items = plain_items();
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "Pick one",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        let expected = concat!(
            // header: `${border}+${reset} ${heading}${message}${reset}`
            "\x1b[2K\x1b[2m+\x1b[0m \x1b[0mPick one\x1b[0m\n",
            // unconditional blank line
            "\x1b[2K\n",
            // selected row (no theme): inverse `> A`
            "\x1b[2K \x1b[7m> A\x1b[0m\n",
            // unselected row: ` ${muted}o${reset} B${reset}` (no item color)
            "\x1b[2K \x1b[2mo\x1b[0m B\x1b[0m\n",
            // footer help (default text, no window hint)
            "\x1b[2K \x1b[2m\u{2191}\u{2193} Move | Enter Select | Q Back\x1b[0m\n",
            // closing border
            "\x1b[2K\x1b[2m+\x1b[0m\n",
        );
        assert_eq!(frame.output, expected);
        assert_eq!(frame.lines_written, 6);
    }

    #[test]
    fn first_render_with_clear_screen_prefixes_clear_and_home() {
        let items = plain_items();
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: true,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        assert!(frame.output.starts_with("\x1b[2J\x1b[1;1H"));
    }

    #[test]
    fn subsequent_render_moves_cursor_up_and_pads_shrunk_frames() {
        let items = plain_items();
        let params = SelectFrameParams {
            items: &items,
            cursor: 0,
            message: "M",
            subtitle_text: None,
            help: None,
            clear_screen: false,
            theme: None,
            focus_style: FocusStyle::RowInvert,
            show_hints_for_unselected: true,
            columns: 80,
            rows: 24,
        };
        let frame = render_select_frame(&params, 8, true);
        assert!(frame.output.starts_with("\x1b[8A"));
        // Previous render had 8 lines, this one writes 6 + 2 blank pads.
        assert_eq!(frame.lines_written, 8);
        assert!(frame.output.ends_with("\x1b[2K\n\x1b[2K\n"));
    }

    #[test]
    fn subtitle_line_and_hints_render_with_muted_wrapping() {
        let mut items = plain_items();
        items[0].hint = Some("one\ntwo\nthree\nfour".to_string());
        items[1].hint = Some("h1\nh2\nh3".to_string());
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: Some("Sub"),
                help: Some("HELP"),
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        let lines: Vec<&str> = frame.output.split('\n').collect();
        // header + subtitle + blank + selected row + 3 selected hints (max 3
        // of 4) + unselected row + 2 unselected hints (max 2 of 3) + help +
        // border = 12 physical lines.
        assert_eq!(frame.lines_written, 12);
        assert_eq!(lines[1], "\x1b[2K \x1b[2mSub\x1b[0m");
        // Selected hints: raw line truncated, then wrapped in muted...reset.
        assert_eq!(lines[4], "\x1b[2K   \x1b[2mone\x1b[0m");
        assert_eq!(lines[6], "\x1b[2K   \x1b[2mthree\x1b[0m");
        // Unselected hints: wrapped first, then truncated (identical here).
        assert_eq!(lines[8], "\x1b[2K   \x1b[2mh1\x1b[0m");
        assert_eq!(lines[9], "\x1b[2K   \x1b[2mh2\x1b[0m");
        // Custom help does NOT get the window hint appended.
        assert_eq!(lines[10], "\x1b[2K \x1b[2mHELP\x1b[0m");
    }

    #[test]
    fn overflowing_items_window_appends_range_hint_to_default_help() {
        let items: Vec<MenuItem<usize>> = (0..10)
            .map(|i| MenuItem::new(format!("Item {i}"), i))
            .collect();
        // rows 8 -> fixedLines 4 -> maxVisible = max(1, min(10, 8-4-1)) = 3.
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 5,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 8,
            },
            0,
            false,
        );
        // windowStart = clamp(5 - 1, 0, 7) = 4 -> window 4..7 -> hint "(5-7/10)".
        assert!(frame.output.contains(" (5-7/10)"));
        assert!(frame.output.contains("Item 4"));
        assert!(frame.output.contains("Item 6"));
        assert!(!frame.output.contains("Item 7"));
    }

    #[test]
    fn disabled_rows_get_unavailable_suffix_unless_hidden() {
        let mut items = plain_items();
        items.push(MenuItem::new("C", "c"));
        items[1].disabled = true;
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        assert!(frame.output.contains("B (unavailable)"));

        items[1].hide_unavailable_suffix = true;
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        assert!(!frame.output.contains("(unavailable)"));
    }

    #[test]
    fn themed_selected_row_uses_focus_colors_and_chip_style_uses_glyph() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            disable_color: Some(false),
            ..Default::default()
        });
        let items = plain_items();
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: Some(&theme),
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        let expected_row = format!(
            " {}{}{}{}{}",
            theme.colors.focus_bg,
            theme.colors.focus_text,
            crate::ansi::BOLD,
            "> A",
            theme.colors.reset
        );
        assert!(frame.output.contains(&expected_row));

        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: Some(&theme),
                focus_style: FocusStyle::Chip,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        let expected_chip_row = format!(
            " {}{}{} {}{}{}A{}",
            theme.colors.success,
            theme.glyphs.selected,
            theme.colors.reset,
            theme.colors.focus_bg,
            theme.colors.focus_text,
            crate::ansi::BOLD,
            theme.colors.reset
        );
        assert!(frame.output.contains(&expected_chip_row));
    }

    #[test]
    fn separators_and_headings_render_without_glyphs() {
        let items = vec![
            MenuItem::heading("Section", 0usize),
            MenuItem::new("A", 1usize),
            MenuItem::separator(0usize),
            MenuItem::new("B", 2usize),
        ];
        let frame = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 1,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        let lines: Vec<&str> = frame.output.split('\n').collect();
        // header, blank, heading row, selected A, blank separator, B, help, border
        assert_eq!(lines[2], "\x1b[2K \x1b[2mSection\x1b[0m");
        assert_eq!(lines[4], "\x1b[2K");
    }

    #[test]
    fn empty_dynamic_subtitle_is_falsy_and_renders_no_subtitle_line() {
        let items = plain_items();
        let with_none = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: None,
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        let with_empty = render_select_frame(
            &SelectFrameParams {
                items: &items,
                cursor: 0,
                message: "M",
                subtitle_text: Some(""),
                help: None,
                clear_screen: false,
                theme: None,
                focus_style: FocusStyle::RowInvert,
                show_hints_for_unselected: true,
                columns: 80,
                rows: 24,
            },
            0,
            false,
        );
        assert_eq!(with_none.output, with_empty.output);
        assert_eq!(with_none.lines_written, with_empty.lines_written);
    }
}
