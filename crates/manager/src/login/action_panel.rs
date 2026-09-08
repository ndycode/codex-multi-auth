//! Port of `lib/codex-manager/login-action-panel.ts` — the full-screen action
//! panel used by the login dashboard to run a menu action with captured
//! output, plus the return-to-menu wait prompt.
//!
//! Capture model (deliberate port deviation, mandated by ARCHITECTURE §6.15):
//! the TS module monkey-patched `console.log/warn/error` so action output
//! streamed into the panel live. Rust never patches global stdout — the
//! action receives an owned capture [`CliOut`] sink and hands it back when it
//! finishes; the captured lines are rendered in the completion frame (the
//! spinner still animates on the 120 ms timer while the action runs). The
//! visible contracts are unchanged: `"! "`/`"x "` prefixes, 400-line ring
//! buffer, `max(8, rows-8)` visible lines, done/failed status copy, and the
//! auto-return countdown.

use std::future::Future;
use std::io::Write;
use std::time::Duration;

use cma_config::dashboard_settings::DashboardDisplaySettings;
use cma_tui::ansi;
use cma_tui::ui_copy;

use crate::dispatcher::{CliOut, OutLine};
use crate::formatters::text_style::{style_prompt_text, PromptTone};

/// Spinner frames (TS `["-", "\\", "|", "/"]`).
const SPINNER_FRAMES: [&str; 4] = ["-", "\\", "|", "/"];

/// Captured-output ring buffer cap (TS `400`).
const CAPTURE_CAP: usize = 400;

/// Render interval for the spinner frame (TS `120` ms).
const RENDER_INTERVAL_MS: u64 = 120;

/// Countdown re-render interval (TS `80` ms).
const COUNTDOWN_INTERVAL_MS: u64 = 80;

/// TS `output.rows ?? 24`. The manager crate has no terminal-size API
/// (crossterm is a cma-tui-internal dependency), so the Node fallback value
/// is used unconditionally.
const FALLBACK_TERMINAL_ROWS: i64 = 24;

/// `Math.max(8, (output.rows ?? 24) - 8)`.
pub(crate) fn max_visible_lines(rows: Option<i64>) -> usize {
    std::cmp::max(8, rows.unwrap_or(FALLBACK_TERMINAL_ROWS) - 8) as usize
}

/// TS `capture(prefix, args)` — trim, skip empty, apply prefix.
pub(crate) fn capture_line(prefix: &str, text: &str) -> Option<String> {
    let line = text.trim();
    if line.is_empty() {
        return None;
    }
    if prefix.is_empty() {
        Some(line.to_string())
    } else {
        Some(format!("{prefix}{line}"))
    }
}

/// Push a captured line, keeping only the newest [`CAPTURE_CAP`] entries
/// (TS `captured.splice(0, captured.length - 400)`).
pub(crate) fn push_captured(captured: &mut Vec<String>, line: String) {
    captured.push(line);
    if captured.len() > CAPTURE_CAP {
        let excess = captured.len() - CAPTURE_CAP;
        captured.drain(0..excess);
    }
}

/// Map the sink lines an action produced onto panel capture lines:
/// `info` → bare, `warn` → `"! "`, `error` → `"x "` (the TS console
/// replacements).
pub(crate) fn out_lines_to_captured(lines: &[OutLine]) -> Vec<String> {
    let mut captured: Vec<String> = Vec::new();
    for line in lines {
        let (prefix, text) = match line {
            OutLine::Info(text) => ("", text.as_str()),
            OutLine::Warn(text) => ("! ", text.as_str()),
            OutLine::Error(text) => ("x ", text.as_str()),
        };
        if let Some(entry) = capture_line(prefix, text) {
            push_captured(&mut captured, entry);
        }
    }
    captured
}

/// Status line text + tone for the current panel state (TS `render`).
pub(crate) fn panel_status(
    running: bool,
    failed: bool,
    frame: usize,
    stage: &str,
) -> (String, PromptTone) {
    if running {
        let spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.len()];
        (format!("{spinner} {stage}"), PromptTone::Accent)
    } else if failed {
        (ui_copy::return_flow::FAILED.to_string(), PromptTone::Danger)
    } else {
        (ui_copy::return_flow::DONE.to_string(), PromptTone::Success)
    }
}

/// Build one full panel frame as a string (TS `render`, minus the terminal
/// writes): clear screen, title, status line, blank, the last
/// `max_visible` captured lines padded with blanks, blank, and the
/// "Running..." hint while the action is still going.
pub(crate) fn build_panel_frame(
    title: &str,
    stage: &str,
    running: bool,
    failed: bool,
    captured: &[String],
    max_visible: usize,
    frame: usize,
) -> String {
    let (status_text, status_tone) = panel_status(running, failed, frame, stage);
    let mut out = String::new();
    out.push_str(ansi::CLEAR_SCREEN);
    out.push_str(&ansi::move_to(1, 1));
    out.push_str(&style_prompt_text(title, PromptTone::Accent));
    out.push('\n');
    out.push_str(&style_prompt_text(&status_text, status_tone));
    out.push('\n');
    out.push('\n');

    let start = captured.len().saturating_sub(max_visible);
    let visible = &captured[start..];
    for line in visible {
        out.push_str(line);
        out.push('\n');
    }
    for _ in 0..max_visible.saturating_sub(visible.len()) {
        out.push('\n');
    }
    out.push('\n');
    if running {
        out.push_str(&style_prompt_text(
            ui_copy::return_flow::WORKING,
            PromptTone::Muted,
        ));
        out.push('\n');
    }
    out
}

/// TS `Math.max(1, Math.ceil(remainingMs / 1000))`.
pub(crate) fn countdown_seconds(remaining_ms: i64) -> i64 {
    std::cmp::max(1, (remaining_ms.max(0) + 999) / 1000)
}

/// Options for [`wait_for_menu_return`] (TS `WaitForReturnOptions`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WaitForReturnOptions {
    pub prompt_text: Option<String>,
    pub auto_return_ms: i64,
    pub pause_on_any_key: bool,
}

/// Resolve the wait options for the post-action prompt: failed actions block
/// on the "Action failed" question; successful ones auto-return after
/// `actionAutoReturnMs ?? 2_000` with `actionPauseOnKey ?? true`.
pub(crate) fn resolve_wait_options(
    failed: bool,
    settings: Option<&DashboardDisplaySettings>,
) -> WaitForReturnOptions {
    if failed {
        WaitForReturnOptions {
            prompt_text: Some(ui_copy::return_flow::ACTION_FAILED_PROMPT.to_string()),
            auto_return_ms: 0,
            pause_on_any_key: true,
        }
    } else {
        WaitForReturnOptions {
            prompt_text: None,
            auto_return_ms: settings.map_or(2_000, |value| value.action_auto_return_ms),
            pause_on_any_key: settings.is_none_or(|value| value.action_pause_on_key),
        }
    }
}

fn write_inline_status(message: &str) {
    let mut stdout = std::io::stdout();
    let _ = write!(
        stdout,
        "\r{}{}",
        ansi::CLEAR_LINE,
        style_prompt_text(message, PromptTone::Muted)
    );
    let _ = stdout.flush();
}

fn clear_inline_status() {
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "\r{}", ansi::CLEAR_LINE);
    let _ = stdout.flush();
}

/// TS `waitForMenuReturn`.
///
/// Port note: the TS "press any key to pause the countdown" behavior needs a
/// raw-mode single-keypress read, which `cma-tui` does not currently expose
/// (its raw-mode plumbing is internal to `select`). The countdown therefore
/// renders and auto-returns without key interception; the `pause_on_any_key`
/// flag only selects between the rendered countdown and a silent sleep,
/// matching the TS timing behavior for users who never press a key.
async fn wait_for_menu_return(options: WaitForReturnOptions) {
    if !ansi::is_tty() {
        return;
    }

    if options.auto_return_ms > 0 {
        if !options.pause_on_any_key {
            tokio::time::sleep(Duration::from_millis(options.auto_return_ms as u64)).await;
            return;
        }
        let end_at = cma_core::utils::now_ms() + options.auto_return_ms;
        let mut last_shown_seconds: i64 = -1;
        loop {
            let remaining_ms = end_at - cma_core::utils::now_ms();
            if remaining_ms <= 0 {
                break;
            }
            let seconds = countdown_seconds(remaining_ms);
            if seconds != last_shown_seconds {
                last_shown_seconds = seconds;
                write_inline_status(&ui_copy::return_flow::auto_return(seconds));
            }
            let tick = std::cmp::min(remaining_ms, COUNTDOWN_INTERVAL_MS as i64);
            tokio::time::sleep(Duration::from_millis(tick as u64)).await;
        }
        clear_inline_status();
        return;
    }

    // autoReturnMs == 0 → blocking readline question.
    let prompt_text = options
        .prompt_text
        .unwrap_or_else(|| ui_copy::return_flow::CONTINUE_PROMPT.to_string());
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "\r{}", ansi::CLEAR_LINE);
    if !prompt_text.is_empty() {
        let _ = write!(
            stdout,
            "{} ",
            style_prompt_text(&prompt_text, PromptTone::Muted)
        );
    }
    let _ = stdout.flush();
    let mut answer = String::new();
    let _ = std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut answer);
    clear_inline_status();
}

fn write_raw(text: &str) {
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "{text}");
    let _ = stdout.flush();
}

/// TS `runActionPanel(title, stage, action, settings?)`.
///
/// The action receives an owned [`CliOut`] sink (capture mode when the panel
/// is interactive) and must return it together with its outcome; the panel
/// renders the captured lines and re-surfaces the error to the caller AFTER
/// the screen is restored (TS `throw failed` after `altScreenOff`).
///
/// Non-TTY: the action runs without any panel chrome and its captured lines
/// are replayed into the caller's sink (the TS non-TTY path wrote straight to
/// the console).
pub async fn run_action_panel<E, F, Fut>(
    title: &str,
    stage: &str,
    out: &mut CliOut,
    settings: Option<&DashboardDisplaySettings>,
    action: F,
) -> Result<(), E>
where
    E: std::fmt::Display,
    F: FnOnce(CliOut) -> Fut,
    Fut: Future<Output = (CliOut, Result<(), E>)>,
{
    if !ansi::is_tty() {
        let (action_out, result) = action(CliOut::capture()).await;
        for line in action_out.lines() {
            match line {
                OutLine::Info(text) => out.info(text.clone()),
                OutLine::Warn(text) => out.warn(text.clone()),
                OutLine::Error(text) => out.error(text.clone()),
            }
        }
        return result;
    }

    let max_visible = max_visible_lines(None);
    let mut frame: usize = 0;

    write_raw(&format!("{}{}", ansi::ALT_SCREEN_ON, ansi::HIDE));
    // Initial frame (running, no output yet).
    write_raw(&build_panel_frame(
        title,
        stage,
        true,
        false,
        &[],
        max_visible,
        frame,
    ));
    frame += 1;

    let action_future = action(CliOut::capture());
    tokio::pin!(action_future);
    let mut interval = tokio::time::interval(Duration::from_millis(RENDER_INTERVAL_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // The first tick fires immediately; consume it so the spinner advances on
    // the 120 ms cadence after the initial frame above.
    interval.tick().await;

    let (action_out, result) = loop {
        tokio::select! {
            outcome = &mut action_future => break outcome,
            _ = interval.tick() => {
                write_raw(&build_panel_frame(
                    title,
                    stage,
                    true,
                    false,
                    &[],
                    max_visible,
                    frame,
                ));
                frame += 1;
            }
        }
    };

    let mut captured = out_lines_to_captured(action_out.lines());
    let failed_message = result.as_ref().err().map(|error| error.to_string());
    if let Some(message) = &failed_message
        && let Some(entry) = capture_line("x ", message) {
            push_captured(&mut captured, entry);
        }

    // Final frame (TS `finally { running = false; render(); }`).
    write_raw(&build_panel_frame(
        title,
        stage,
        false,
        failed_message.is_some(),
        &captured,
        max_visible,
        frame,
    ));

    wait_for_menu_return(resolve_wait_options(failed_message.is_some(), settings)).await;

    write_raw(&format!(
        "{}{}{}{}",
        ansi::ALT_SCREEN_OFF,
        ansi::SHOW,
        ansi::CLEAR_SCREEN,
        ansi::move_to(1, 1)
    ));

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_line_trims_skips_empty_and_prefixes() {
        assert_eq!(capture_line("", "  hello  "), Some("hello".to_string()));
        assert_eq!(capture_line("! ", "warned"), Some("! warned".to_string()));
        assert_eq!(capture_line("x ", "boom"), Some("x boom".to_string()));
        assert_eq!(capture_line("! ", "   "), None);
        assert_eq!(capture_line("", ""), None);
    }

    #[test]
    fn push_captured_caps_at_400_dropping_oldest() {
        let mut captured: Vec<String> = Vec::new();
        for i in 0..405 {
            push_captured(&mut captured, format!("line {i}"));
        }
        assert_eq!(captured.len(), 400);
        assert_eq!(captured[0], "line 5");
        assert_eq!(captured[399], "line 404");
    }

    #[test]
    fn out_lines_map_to_console_prefixes() {
        let lines = vec![
            OutLine::Info("plain".to_string()),
            OutLine::Warn("careful".to_string()),
            OutLine::Error("broken".to_string()),
            OutLine::Info("   ".to_string()),
        ];
        assert_eq!(
            out_lines_to_captured(&lines),
            vec![
                "plain".to_string(),
                "! careful".to_string(),
                "x broken".to_string()
            ]
        );
    }

    #[test]
    fn panel_status_matches_ts_state_machine() {
        let (text, tone) = panel_status(true, false, 0, "Comparing accounts");
        assert_eq!(text, "- Comparing accounts");
        assert_eq!(tone, PromptTone::Accent);
        let (text, _) = panel_status(true, false, 1, "s");
        assert_eq!(text, "\\ s");
        let (text, tone) = panel_status(false, true, 7, "ignored");
        assert_eq!(text, "Failed.");
        assert_eq!(tone, PromptTone::Danger);
        let (text, tone) = panel_status(false, false, 7, "ignored");
        assert_eq!(text, "Done.");
        assert_eq!(tone, PromptTone::Success);
    }

    #[test]
    fn build_panel_frame_pads_to_max_visible() {
        let captured = vec!["a".to_string(), "b".to_string()];
        let frame = build_panel_frame("Title", "stage", true, false, &captured, 8, 0);
        // title + status + blank + 2 lines + 6 pad + blank + working hint.
        let newlines = frame.matches('\n').count();
        assert_eq!(newlines, 3 + 2 + 6 + 1 + 1);
        assert!(frame.contains("Title"));
        assert!(frame.contains("- stage"));
        assert!(frame.contains("Running..."));
        // Completed frames drop the working hint.
        let done = build_panel_frame("Title", "stage", false, false, &captured, 8, 0);
        assert!(!done.contains("Running..."));
        assert!(done.contains("Done."));
    }

    #[test]
    fn build_panel_frame_shows_only_last_max_visible_lines() {
        let captured: Vec<String> = (0..20).map(|i| format!("row {i}")).collect();
        let frame = build_panel_frame("T", "s", false, false, &captured, 8, 0);
        assert!(!frame.contains("row 11\n"));
        assert!(frame.contains("row 12\n"));
        assert!(frame.contains("row 19\n"));
    }

    #[test]
    fn countdown_seconds_floors_at_one_and_ceils() {
        assert_eq!(countdown_seconds(0), 1);
        assert_eq!(countdown_seconds(1), 1);
        assert_eq!(countdown_seconds(1000), 1);
        assert_eq!(countdown_seconds(1001), 2);
        assert_eq!(countdown_seconds(2000), 2);
        assert_eq!(countdown_seconds(-50), 1);
    }

    #[test]
    fn max_visible_lines_uses_rows_minus_8_with_floor_8() {
        assert_eq!(max_visible_lines(None), 16);
        assert_eq!(max_visible_lines(Some(24)), 16);
        assert_eq!(max_visible_lines(Some(10)), 8);
        assert_eq!(max_visible_lines(Some(40)), 32);
    }

    #[test]
    fn resolve_wait_options_defaults() {
        let failed = resolve_wait_options(true, None);
        assert_eq!(
            failed.prompt_text.as_deref(),
            Some("Action failed. Press Enter to go back.")
        );
        assert_eq!(failed.auto_return_ms, 0);

        let default_ok = resolve_wait_options(false, None);
        assert_eq!(default_ok.auto_return_ms, 2_000);
        assert!(default_ok.pause_on_any_key);

        let settings = DashboardDisplaySettings {
            action_auto_return_ms: 4_000,
            action_pause_on_key: false,
            ..Default::default()
        };
        let custom = resolve_wait_options(false, Some(&settings));
        assert_eq!(custom.auto_return_ms, 4_000);
        assert!(!custom.pause_on_any_key);
    }

    // Non-TTY path: the action runs with a capture sink and its lines are
    // replayed into the caller's sink; errors surface AFTER the replay (TS
    // non-TTY simply awaited the action).
    #[tokio::test]
    async fn non_tty_replays_action_output_and_returns_error() {
        // Test processes have no TTY, so run_action_panel takes the
        // pass-through branch deterministically.
        let mut out = CliOut::capture();
        let result: Result<(), String> =
            run_action_panel("T", "stage", &mut out, None, |mut panel_out| async move {
                panel_out.info("did a thing");
                panel_out.warn("uh oh");
                (panel_out, Err("exploded".to_string()))
            })
            .await;
        assert_eq!(result, Err("exploded".to_string()));
        assert_eq!(out.info_text(), "did a thing");
        assert_eq!(out.warn_text(), "uh oh");
    }
}
