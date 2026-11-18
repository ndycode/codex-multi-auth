//! Port of `lib/ui/ansi.ts` — ANSI escape helpers and keyboard parsing for
//! interactive TUI menus.
//!
//! The escape constants are byte-exact copies of the TS `ANSI` map; `parse_key`
//! matches **exact whole-byte-sequences** (spec 12 §1). Note the deliberate TS
//! behaviors preserved here:
//! - Ctrl-C (`\x03`) maps to `Escape`, NOT a signal (raw mode swallows SIGINT).
//! - a lone ESC byte maps to `EscapeStart`; the caller disambiguates with the
//!   50 ms timer in `select.rs`.

use std::io::IsTerminal;

// Cursor control
pub const HIDE: &str = "\x1b[?25l";
pub const SHOW: &str = "\x1b[?25h";
pub const ALT_SCREEN_ON: &str = "\x1b[?1049h";
pub const ALT_SCREEN_OFF: &str = "\x1b[?1049l";
pub const CLEAR_LINE: &str = "\x1b[2K";
pub const CLEAR_SCREEN: &str = "\x1b[2J";

/// `ANSI.up(lines = 1)` => `\x1b[{lines}A`.
pub fn up(lines: usize) -> String {
    format!("\x1b[{lines}A")
}

/// `ANSI.moveTo(row, col)` => `\x1b[{row};{col}H`.
pub fn move_to(row: usize, col: usize) -> String {
    format!("\x1b[{row};{col}H")
}

// Styling
pub const BLACK: &str = "\x1b[30m";
pub const WHITE: &str = "\x1b[97m";
pub const CYAN: &str = "\x1b[36m";
pub const GREEN: &str = "\x1b[32m";
pub const RED: &str = "\x1b[31m";
pub const YELLOW: &str = "\x1b[33m";
pub const BG_BLUE: &str = "\x1b[44m";
pub const BG_BRIGHT_BLUE: &str = "\x1b[104m";
pub const BG_GREEN: &str = "\x1b[42m";
pub const BG_YELLOW: &str = "\x1b[43m";
pub const BG_RED: &str = "\x1b[41m";
pub const INVERSE: &str = "\x1b[7m";
pub const DIM: &str = "\x1b[2m";
pub const BOLD: &str = "\x1b[1m";
pub const RESET: &str = "\x1b[0m";

/// Normalized keyboard action token (TS `KeyAction`, minus the `null` arm which
/// becomes `None` on the Rust side).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Up,
    Down,
    Home,
    End,
    Enter,
    Escape,
    EscapeStart,
}

/// Maps a raw stdin byte buffer to a normalized keyboard action token.
///
/// Interprets common ANSI/terminal key sequences via **exact whole-string**
/// matches, mirroring `parseKey` from `lib/ui/ansi.ts` byte for byte.
pub fn parse_key(data: &[u8]) -> Option<KeyAction> {
    let input = String::from_utf8_lossy(data);
    let input = input.as_ref();

    if input == "\x1b[A" || input == "\x1bOA" {
        return Some(KeyAction::Up);
    }
    if input == "\x1b[B" || input == "\x1bOB" {
        return Some(KeyAction::Down);
    }
    if input == "\x1b[H" || input == "\x1bOH" || input == "\x1b[1~" || input == "\x1b[7~" {
        return Some(KeyAction::Home);
    }
    if input == "\x1b[F" || input == "\x1bOF" || input == "\x1b[4~" || input == "\x1b[8~" {
        return Some(KeyAction::End);
    }
    if input == "\r" || input == "\n" {
        return Some(KeyAction::Enter);
    }
    // Ctrl-C maps to "escape", NOT SIGINT (raw mode delivers it as a byte).
    if input == "\x03" {
        return Some(KeyAction::Escape);
    }
    // A bare ESC byte may be the start of a longer sequence arriving split.
    if input == "\x1b" {
        return Some(KeyAction::EscapeStart);
    }

    None
}

/// `isTTY()` — BOTH stdin and stdout must be TTYs.
pub fn is_tty() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_key_maps_arrow_and_keypad_variants() {
        assert_eq!(parse_key(b"\x1b[A"), Some(KeyAction::Up));
        assert_eq!(parse_key(b"\x1bOA"), Some(KeyAction::Up));
        assert_eq!(parse_key(b"\x1b[B"), Some(KeyAction::Down));
        assert_eq!(parse_key(b"\x1bOB"), Some(KeyAction::Down));
    }

    #[test]
    fn parse_key_maps_home_and_end_variants() {
        for seq in [b"\x1b[H".as_ref(), b"\x1bOH", b"\x1b[1~", b"\x1b[7~"] {
            assert_eq!(parse_key(seq), Some(KeyAction::Home));
        }
        for seq in [b"\x1b[F".as_ref(), b"\x1bOF", b"\x1b[4~", b"\x1b[8~"] {
            assert_eq!(parse_key(seq), Some(KeyAction::End));
        }
    }

    #[test]
    fn parse_key_maps_enter_escape_and_escape_start() {
        assert_eq!(parse_key(b"\r"), Some(KeyAction::Enter));
        assert_eq!(parse_key(b"\n"), Some(KeyAction::Enter));
        // Ctrl-C is "escape", not a signal.
        assert_eq!(parse_key(b"\x03"), Some(KeyAction::Escape));
        // Lone ESC is escape-start (50 ms disambiguation upstream).
        assert_eq!(parse_key(b"\x1b"), Some(KeyAction::EscapeStart));
    }

    #[test]
    fn parse_key_returns_none_for_unknown_input() {
        assert_eq!(parse_key(b"a"), None);
        assert_eq!(parse_key(b"\x1b[C"), None);
        assert_eq!(parse_key(b""), None);
        // Partial-prefix sequences are NOT whole-string matches.
        assert_eq!(parse_key(b"\x1b[Ax"), None);
    }

    #[test]
    fn escape_constants_are_exact() {
        assert_eq!(HIDE, "\u{1b}[?25l");
        assert_eq!(SHOW, "\u{1b}[?25h");
        assert_eq!(up(3), "\u{1b}[3A");
        assert_eq!(move_to(1, 1), "\u{1b}[1;1H");
        assert_eq!(CLEAR_LINE, "\u{1b}[2K");
        assert_eq!(CLEAR_SCREEN, "\u{1b}[2J");
        assert_eq!(BG_BRIGHT_BLUE, "\u{1b}[104m");
        assert_eq!(RESET, "\u{1b}[0m");
    }
}
