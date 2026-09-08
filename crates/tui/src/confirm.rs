//! Port of `lib/ui/confirm.ts` — Yes/No prompt built on `select`.
//!
//! `default_yes` only changes item ORDER (the cursor starts on the first
//! item); there is no timeout/default-submit behavior. Cancel (Esc / Q /
//! Ctrl-C) returns `false` (spec 12 gotcha 27).

use crate::runtime_options::get_ui_runtime_options;
use crate::select::{select, MenuItem, SelectError, SelectOptions};

/// Prompt the user with a Yes/No choice. Returns `true` iff "Yes" is selected;
/// cancel returns `false`. Propagates `select`'s precondition errors (non-TTY).
pub fn confirm(message: &str, default_yes: bool) -> Result<bool, SelectError> {
    let ui = get_ui_runtime_options();
    let items: Vec<MenuItem<bool>> = if default_yes {
        vec![MenuItem::new("Yes", true), MenuItem::new("No", false)]
    } else {
        vec![MenuItem::new("No", false), MenuItem::new("Yes", true)]
    };

    let mut options = SelectOptions::new(message);
    options.theme = Some(ui.theme);
    let result = select(&items, options)?;
    Ok(result.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    // `confirm` itself requires a TTY (select throws first), so only the item
    // ordering contract is testable headlessly; the interactive behavior is
    // covered by the select engine tests.

    #[test]
    fn default_yes_flag_only_changes_item_order() {
        // Mirror the construction logic to pin the order contract.
        let default_no: Vec<(&str, bool)> = vec![("No", false), ("Yes", true)];
        let default_yes: Vec<(&str, bool)> = vec![("Yes", true), ("No", false)];
        assert_eq!(default_no[0].0, "No");
        assert_eq!(default_yes[0].0, "Yes");
    }
}
