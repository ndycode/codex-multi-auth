//! Port of `settings-hub/backend.ts` + `backend-settings-{controller,helpers,
//! prompt}.ts` + `backend-category-{helpers,prompt}.ts` (entry shims
//! absorbed) — the backend settings hub, category editor, and the pure
//! helpers around `PluginConfig`.

use std::cell::RefCell;

use cma_core::schemas::plugin_config::{FallbackChain, PluginConfig};
use cma_tui::runtime_options::{get_ui_runtime_options, UiRuntimeOptions};
use cma_tui::select::{select, MenuColor, MenuItem, SelectInputResult, SelectOptions};
use cma_tui::ui_copy;
use serde_json::{Map, Number, Value};

use crate::settings::hub::{clamp_backend_number, format_dashboard_setting_state, is_tty_interactive};
use crate::settings::persist::persist_backend_config_selection;
use crate::settings::preview::highlight_preview_token;
use crate::settings::schema::{
    backend_defaults, backend_number_option_by_key, backend_toggle_option_by_key,
    BackendCategoryConfigAction, BackendCategoryKey, BackendCategoryOption,
    BackendNumberSettingKey, BackendNumberSettingOption, BackendNumberUnit,
    BackendSettingFocusKey, BackendSettingsHubAction, BACKEND_CATEGORY_OPTIONS,
    BACKEND_NUMBER_OPTIONS, BACKEND_TOGGLE_OPTIONS,
};

// ---------------------------------------------------------------------------
// Helpers (`backend-settings-helpers.ts`)
// ---------------------------------------------------------------------------

/// `cloneBackendPluginConfig(config)` — `{...BACKEND_DEFAULTS, ...config}`
/// plus a shallow copy of `unsupportedCodexFallbackChain` (defaults to `{}`
/// when absent). NOTE: the clone materializes ALL defaults into the object.
pub fn clone_backend_plugin_config(config: &PluginConfig) -> PluginConfig {
    let mut clone = PluginConfig::overlay(&backend_defaults(), config);
    clone.unsupported_codex_fallback_chain = Some(
        config
            .unsupported_codex_fallback_chain
            .clone()
            .unwrap_or_default(),
    );
    clone
}

/// `backendSettingsSnapshot(config)` — plain record of all 27 schema keys
/// with `config[key] ?? defaults[key] ?? (false | option.min)`.
pub fn backend_settings_snapshot(config: &PluginConfig) -> Map<String, Value> {
    let defaults = backend_defaults();
    let mut snapshot = Map::new();
    for option in &BACKEND_TOGGLE_OPTIONS {
        let value = option
            .key
            .get(config)
            .or_else(|| option.key.get(&defaults))
            .unwrap_or(false);
        snapshot.insert(option.key.as_str().to_string(), Value::Bool(value));
    }
    for option in &BACKEND_NUMBER_OPTIONS {
        let value = option
            .key
            .get(config)
            .or_else(|| option.key.get(&defaults))
            .unwrap_or(option.min);
        let number = if value.fract() == 0.0 && value.is_finite() {
            Number::from(value as i64)
        } else {
            Number::from_f64(value).unwrap_or_else(|| Number::from(0))
        };
        snapshot.insert(option.key.as_str().to_string(), Value::Number(number));
    }
    snapshot
}

/// `backendSettingsEqual` — snapshot comparison over ONLY schema-managed keys.
pub fn backend_settings_equal(left: &PluginConfig, right: &PluginConfig) -> bool {
    backend_settings_snapshot(left) == backend_settings_snapshot(right)
}

/// `formatBackendNumberValue(option, value)` — percent → `N%`; count → `N`;
/// ms → `Nm`/`Ns`/`Nms` by divisibility.
pub fn format_backend_number_value(option: &BackendNumberSettingOption, value: f64) -> String {
    match option.unit {
        BackendNumberUnit::Percent => format!("{}%", value.round() as i64),
        BackendNumberUnit::Count => format!("{}", value.round() as i64),
        BackendNumberUnit::Ms => {
            let ms = value;
            if ms >= 60_000.0 && ms % 60_000.0 == 0.0 {
                format!("{}m", (ms / 60_000.0).round() as i64)
            } else if ms >= 1_000.0 && ms % 1_000.0 == 0.0 {
                format!("{}s", (ms / 1_000.0).round() as i64)
            } else {
                format!("{}ms", ms.round() as i64)
            }
        }
    }
}

/// `clampBackendNumberForTests(settingKey, value)` — string-keyed clamp;
/// unknown key → `Err("Unknown backend numeric setting key: <key>")` (thrown
/// in TS).
pub fn clamp_backend_number_for_tests(setting_key: &str, value: f64) -> Result<f64, String> {
    let option = BACKEND_NUMBER_OPTIONS
        .iter()
        .find(|option| option.key.as_str() == setting_key)
        .ok_or_else(|| format!("Unknown backend numeric setting key: {setting_key}"))?;
    Ok(clamp_backend_number(option, value))
}

/// `buildBackendSettingsPreview(config, ui, focus, {highlightPreviewToken})`.
pub fn build_backend_settings_preview(
    config: &PluginConfig,
    ui: &UiRuntimeOptions,
    focus: Option<BackendSettingFocusKey>,
    highlight: &dyn Fn(&str, &UiRuntimeOptions) -> String,
) -> (String, String) {
    use crate::settings::schema::{BackendNumberSettingKey as N, BackendToggleSettingKey as T};
    let defaults = backend_defaults();
    let toggle = |key: T, fallback: bool| -> bool {
        key.get(config).or_else(|| key.get(&defaults)).unwrap_or(fallback)
    };
    let number = |key: N, fallback: f64| -> f64 {
        key.get(config).or_else(|| key.get(&defaults)).unwrap_or(fallback)
    };
    let live_sync = toggle(T::LiveAccountSync, true);
    let affinity = toggle(T::SessionAffinity, true);
    let preemptive = toggle(T::PreemptiveQuotaEnabled, true);
    let threshold_5h = number(N::PreemptiveQuotaRemainingPercent5h, 5.0);
    let threshold_7d = number(N::PreemptiveQuotaRemainingPercent7d, 5.0);
    let fetch_timeout = number(N::FetchTimeoutMs, 60_000.0);
    let stall_timeout = number(N::StreamStallTimeoutMs, 45_000.0);
    let fetch_option = backend_number_option_by_key(N::FetchTimeoutMs);
    let stall_option = backend_number_option_by_key(N::StreamStallTimeoutMs);

    let highlight_if = |key: BackendSettingFocusKey, text: String| -> String {
        if focus == Some(key) {
            highlight(&text, ui)
        } else {
            text
        }
    };
    let on_off = |value: bool| if value { "on" } else { "off" }.to_string();

    let label = [
        format!(
            "live sync {}",
            highlight_if(
                BackendSettingFocusKey::Toggle(T::LiveAccountSync),
                on_off(live_sync)
            )
        ),
        format!(
            "affinity {}",
            highlight_if(
                BackendSettingFocusKey::Toggle(T::SessionAffinity),
                on_off(affinity)
            )
        ),
        format!(
            "preemptive {}",
            highlight_if(
                BackendSettingFocusKey::Toggle(T::PreemptiveQuotaEnabled),
                on_off(preemptive)
            )
        ),
    ]
    .join(" | ");

    let hint = [
        format!(
            "thresholds 5h<={}",
            highlight_if(
                BackendSettingFocusKey::Number(N::PreemptiveQuotaRemainingPercent5h),
                format!("{}%", format_js_number(threshold_5h))
            )
        ),
        format!(
            "7d<={}",
            highlight_if(
                BackendSettingFocusKey::Number(N::PreemptiveQuotaRemainingPercent7d),
                format!("{}%", format_js_number(threshold_7d))
            )
        ),
        format!(
            "timeouts {}/{}",
            highlight_if(
                BackendSettingFocusKey::Number(N::FetchTimeoutMs),
                format_backend_number_value(fetch_option, fetch_timeout)
            ),
            highlight_if(
                BackendSettingFocusKey::Number(N::StreamStallTimeoutMs),
                format_backend_number_value(stall_option, stall_timeout)
            )
        ),
    ]
    .join(" | ");

    (label, hint)
}

/// Print a JS number without a trailing `.0` for integral values (template
/// literal `${threshold5h}` parity).
fn format_js_number(value: f64) -> String {
    cma_core::json_io::format_js_number(value)
}

/// `buildBackendConfigPatch(config)` — only present booleans for toggle keys,
/// only finite numbers (clamped) for number keys; nothing else. This is the
/// full `savePluginConfig` patch — non-schema plugin config keys are never
/// rewritten by the settings hub.
pub fn build_backend_config_patch(config: &PluginConfig) -> Map<String, Value> {
    let mut patch = Map::new();
    for option in &BACKEND_TOGGLE_OPTIONS {
        if let Some(value) = option.key.get(config) {
            patch.insert(option.key.as_str().to_string(), Value::Bool(value));
        }
    }
    for option in &BACKEND_NUMBER_OPTIONS {
        if let Some(value) = option.key.get(config)
            && value.is_finite() {
                let clamped = clamp_backend_number(option, value);
                let number = if clamped.fract() == 0.0 {
                    Number::from(clamped as i64)
                } else {
                    Number::from_f64(clamped).unwrap_or_else(|| Number::from(0))
                };
                patch.insert(option.key.as_str().to_string(), Value::Number(number));
            }
    }
    patch
}

// ---------------------------------------------------------------------------
// Category helpers (`backend-category-helpers.ts`)
// ---------------------------------------------------------------------------

/// `resolveFocusedBackendNumberKey(focus, numberOptions)`.
pub fn resolve_focused_backend_number_key(
    focus: Option<BackendSettingFocusKey>,
    number_options: &[&'static BackendNumberSettingOption],
) -> BackendNumberSettingKey {
    if let Some(BackendSettingFocusKey::Number(key)) = focus
        && number_options.iter().any(|option| option.key == key) {
            return key;
        }
    number_options
        .first()
        .map(|option| option.key)
        .unwrap_or(BackendNumberSettingKey::FetchTimeoutMs)
}

/// `getBackendCategory(key, categoryOptions)`.
pub fn get_backend_category(
    key: BackendCategoryKey,
    category_options: &'static [BackendCategoryOption],
) -> Option<&'static BackendCategoryOption> {
    category_options.iter().find(|category| category.key == key)
}

/// `getBackendCategoryInitialFocus(category)` — first toggle, else first
/// number, else `None`.
pub fn get_backend_category_initial_focus(
    category: &BackendCategoryOption,
) -> Option<BackendSettingFocusKey> {
    if let Some(first_toggle) = category.toggle_keys.first() {
        return Some(BackendSettingFocusKey::Toggle(*first_toggle));
    }
    category
        .number_keys
        .first()
        .map(|key| BackendSettingFocusKey::Number(*key))
}

/// `applyBackendCategoryDefaults(draft, category, deps)` — resets ONLY the
/// category's keys to `defaults[key] ?? false` / `defaults[key] ?? option.min`.
pub fn apply_backend_category_defaults(
    draft: &PluginConfig,
    category: &BackendCategoryOption,
) -> PluginConfig {
    let defaults = backend_defaults();
    let mut next = draft.clone();
    for key in category.toggle_keys {
        key.set(&mut next, Some(key.get(&defaults).unwrap_or(false)));
    }
    for key in category.number_keys {
        let option = backend_number_option_by_key(*key);
        key.set(&mut next, Some(key.get(&defaults).unwrap_or(option.min)));
    }
    next
}

// ---------------------------------------------------------------------------
// Category editor (`backend-category-prompt.ts`)
// ---------------------------------------------------------------------------

/// Result of the category editor: the (possibly edited) draft plus the last
/// focused setting; edits are KEPT on back — save/cancel semantics live at
/// the hub level (spec 09 gotcha 23).
pub struct BackendCategoryPromptResult {
    pub draft: PluginConfig,
    pub focus_key: Option<BackendSettingFocusKey>,
}

/// `promptBackendCategorySettingsMenu` — one category's editor.
pub fn prompt_backend_category_settings(
    initial: &PluginConfig,
    category: &'static BackendCategoryOption,
    initial_focus: Option<BackendSettingFocusKey>,
) -> BackendCategoryPromptResult {
    let ui = get_ui_runtime_options();
    let defaults = backend_defaults();
    let mut draft = clone_backend_plugin_config(initial);

    let belongs_to_category = |focus: BackendSettingFocusKey| -> bool {
        match focus {
            BackendSettingFocusKey::Toggle(key) => category.toggle_keys.contains(&key),
            BackendSettingFocusKey::Number(key) => category.number_keys.contains(&key),
        }
    };
    let mut focus_key = match initial_focus {
        Some(focus) if belongs_to_category(focus) => Some(focus),
        _ => get_backend_category_initial_focus(category),
    };

    let toggle_options: Vec<_> = category
        .toggle_keys
        .iter()
        .map(|key| backend_toggle_option_by_key(*key))
        .collect();
    let number_options: Vec<&'static BackendNumberSettingOption> = category
        .number_keys
        .iter()
        .map(|key| backend_number_option_by_key(*key))
        .collect();

    loop {
        let (preview_label, preview_hint) =
            build_backend_settings_preview(&draft, &ui, focus_key, &|text, ui| {
                highlight_preview_token(text, ui)
            });

        let mut items: Vec<MenuItem<BackendCategoryConfigAction>> = vec![
            MenuItem::heading(
                ui_copy::settings::PREVIEW_HEADING,
                BackendCategoryConfigAction::Back,
            ),
            {
                let mut item = MenuItem::new(preview_label, BackendCategoryConfigAction::Back)
                    .with_hint(preview_hint)
                    .with_color(MenuColor::Green);
                item.disabled = true;
                item.hide_unavailable_suffix = true;
                item
            },
            MenuItem::separator(BackendCategoryConfigAction::Back),
            MenuItem::heading(
                ui_copy::settings::BACKEND_TOGGLE_HEADING,
                BackendCategoryConfigAction::Back,
            ),
        ];
        for (index, option) in toggle_options.iter().enumerate() {
            let enabled = option
                .key
                .get(&draft)
                .or_else(|| option.key.get(&defaults))
                .unwrap_or(false);
            items.push(
                MenuItem::new(
                    format!(
                        "{} {}. {}",
                        format_dashboard_setting_state(enabled),
                        index + 1,
                        option.label
                    ),
                    BackendCategoryConfigAction::Toggle(option.key),
                )
                .with_hint(option.description)
                .with_color(if enabled {
                    MenuColor::Green
                } else {
                    MenuColor::Yellow
                }),
            );
        }
        items.push(MenuItem::separator(BackendCategoryConfigAction::Back));
        items.push(MenuItem::heading(
            ui_copy::settings::BACKEND_NUMBER_HEADING,
            BackendCategoryConfigAction::Back,
        ));
        for option in &number_options {
            let raw_value = option
                .key
                .get(&draft)
                .or_else(|| option.key.get(&defaults))
                .unwrap_or(option.min);
            let numeric = if raw_value.is_finite() {
                raw_value
            } else {
                option.min
            };
            let clamped = clamp_backend_number(option, numeric);
            let value_label = format_backend_number_value(option, clamped);
            items.push(
                MenuItem::new(
                    format!("{}: {}", option.label, value_label),
                    BackendCategoryConfigAction::Bump {
                        key: option.key,
                        direction: 1,
                    },
                )
                .with_hint(format!(
                    "{} Step {}.",
                    option.description,
                    format_backend_number_value(option, option.step)
                ))
                .with_color(MenuColor::Yellow),
            );
        }

        let focused_number_key = resolve_focused_backend_number_key(focus_key, &number_options);
        if !number_options.is_empty() {
            items.push(MenuItem::separator(BackendCategoryConfigAction::Back));
            items.push(
                MenuItem::new(
                    ui_copy::settings::BACKEND_DECREASE,
                    BackendCategoryConfigAction::Bump {
                        key: focused_number_key,
                        direction: -1,
                    },
                )
                .with_color(MenuColor::Yellow),
            );
            items.push(
                MenuItem::new(
                    ui_copy::settings::BACKEND_INCREASE,
                    BackendCategoryConfigAction::Bump {
                        key: focused_number_key,
                        direction: 1,
                    },
                )
                .with_color(MenuColor::Green),
            );
        }
        items.push(MenuItem::separator(BackendCategoryConfigAction::Back));
        items.push(
            MenuItem::new(
                ui_copy::settings::BACKEND_RESET_CATEGORY,
                BackendCategoryConfigAction::ResetCategory,
            )
            .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(
                ui_copy::settings::BACKEND_BACK_TO_CATEGORIES,
                BackendCategoryConfigAction::Back,
            )
            .with_color(MenuColor::Red),
        );

        let initial_cursor = items.iter().position(|item| {
            if item.separator || item.disabled || item.heading {
                return false;
            }
            match item.value {
                BackendCategoryConfigAction::Toggle(key) => {
                    focus_key == Some(BackendSettingFocusKey::Toggle(key))
                }
                BackendCategoryConfigAction::Bump { key, .. } => {
                    focus_key == Some(BackendSettingFocusKey::Number(key))
                }
                _ => false,
            }
        });

        let focus_cell: RefCell<Option<BackendSettingFocusKey>> = RefCell::new(focus_key);
        let focus_for_cursor = &focus_cell;
        let focus_for_input = &focus_cell;
        let number_options_for_input = number_options.clone();
        let toggle_options_for_input = toggle_options.clone();

        let mut options: SelectOptions<'_, BackendCategoryConfigAction> = SelectOptions::new(
            format!("{}: {}", ui_copy::settings::BACKEND_CATEGORY_TITLE, category.label),
        );
        options.subtitle = Some(category.description.to_string());
        options.help = Some(ui_copy::settings::BACKEND_CATEGORY_HELP.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.initial_cursor = initial_cursor.map(|cursor| cursor as i64);
        options.on_cursor_change = Some(Box::new(move |ctx| {
            let focused = ctx.items.get(ctx.cursor).map(|item| &item.value);
            match focused {
                Some(BackendCategoryConfigAction::Toggle(key)) => {
                    *focus_for_cursor.borrow_mut() = Some(BackendSettingFocusKey::Toggle(*key));
                }
                Some(BackendCategoryConfigAction::Bump { key, .. }) => {
                    *focus_for_cursor.borrow_mut() = Some(BackendSettingFocusKey::Number(*key));
                }
                _ => {}
            }
        }));
        options.on_input = Some(Box::new(move |raw, _ctx| {
            let lower = raw.to_lowercase();
            if lower == "q" {
                return SelectInputResult::Finish(Some(BackendCategoryConfigAction::Back));
            }
            if lower == "r" {
                return SelectInputResult::Finish(Some(
                    BackendCategoryConfigAction::ResetCategory,
                ));
            }
            if !number_options_for_input.is_empty()
                && (lower == "+" || lower == "=" || lower == "]" || lower == "d")
            {
                return SelectInputResult::Finish(Some(BackendCategoryConfigAction::Bump {
                    key: resolve_focused_backend_number_key(
                        *focus_for_input.borrow(),
                        &number_options_for_input,
                    ),
                    direction: 1,
                }));
            }
            if !number_options_for_input.is_empty()
                && (lower == "-" || lower == "[" || lower == "a")
            {
                return SelectInputResult::Finish(Some(BackendCategoryConfigAction::Bump {
                    key: resolve_focused_backend_number_key(
                        *focus_for_input.borrow(),
                        &number_options_for_input,
                    ),
                    direction: -1,
                }));
            }
            if let Ok(parsed) = raw.trim().parse::<usize>()
                && parsed >= 1 && parsed <= toggle_options_for_input.len() {
                    return SelectInputResult::Finish(Some(BackendCategoryConfigAction::Toggle(
                        toggle_options_for_input[parsed - 1].key,
                    )));
                }
            SelectInputResult::Ignored
        }));

        let result = select(&items, options).ok().flatten();
        // Adopt the focus the cursor landed on (TS mutates focusKey inside
        // onCursorChange).
        focus_key = *focus_cell.borrow();

        let Some(result) = result else {
            return BackendCategoryPromptResult { draft, focus_key };
        };
        match result {
            BackendCategoryConfigAction::Back => {
                return BackendCategoryPromptResult { draft, focus_key };
            }
            BackendCategoryConfigAction::ResetCategory => {
                draft = apply_backend_category_defaults(&draft, category);
                focus_key = get_backend_category_initial_focus(category);
            }
            BackendCategoryConfigAction::Toggle(key) => {
                let current = key.get(&draft).or_else(|| key.get(&defaults)).unwrap_or(false);
                key.set(&mut draft, Some(!current));
                focus_key = Some(BackendSettingFocusKey::Toggle(key));
            }
            BackendCategoryConfigAction::Bump { key, direction } => {
                let option = backend_number_option_by_key(key);
                let current = key.get(&draft).or_else(|| key.get(&defaults)).unwrap_or(option.min);
                let numeric = if current.is_finite() { current } else { option.min };
                key.set(
                    &mut draft,
                    Some(clamp_backend_number(
                        option,
                        numeric + option.step * direction as f64,
                    )),
                );
                focus_key = Some(BackendSettingFocusKey::Number(key));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Backend hub (`backend-settings-prompt.ts`)
// ---------------------------------------------------------------------------

/// `promptBackendSettings(initial)` — hub over the 4 categories. Save →
/// `Some(draft)`; cancel → `None` (discarding all category edits).
pub fn prompt_backend_settings(initial: &PluginConfig) -> Option<PluginConfig> {
    if !is_tty_interactive() {
        return None;
    }
    let ui = get_ui_runtime_options();
    let mut draft = clone_backend_plugin_config(initial);
    let mut active_category = BACKEND_CATEGORY_OPTIONS[0].key;
    let mut focus_by_category: Vec<(BackendCategoryKey, Option<BackendSettingFocusKey>)> =
        BACKEND_CATEGORY_OPTIONS
            .iter()
            .map(|category| (category.key, get_backend_category_initial_focus(category)))
            .collect();

    fn focus_of(
        map: &[(BackendCategoryKey, Option<BackendSettingFocusKey>)],
        key: BackendCategoryKey,
    ) -> Option<BackendSettingFocusKey> {
        map.iter()
            .find(|(category_key, _)| *category_key == key)
            .and_then(|(_, focus)| *focus)
    }

    loop {
        let preview_focus = focus_of(&focus_by_category, active_category);
        let (preview_label, preview_hint) =
            build_backend_settings_preview(&draft, &ui, preview_focus, &|text, ui| {
                highlight_preview_token(text, ui)
            });

        let mut items: Vec<MenuItem<BackendSettingsHubAction>> = vec![
            MenuItem::heading(
                ui_copy::settings::PREVIEW_HEADING,
                BackendSettingsHubAction::Cancel,
            ),
            {
                let mut item = MenuItem::new(preview_label, BackendSettingsHubAction::Cancel)
                    .with_hint(preview_hint)
                    .with_color(MenuColor::Green);
                item.disabled = true;
                item.hide_unavailable_suffix = true;
                item
            },
            MenuItem::separator(BackendSettingsHubAction::Cancel),
            MenuItem::heading(
                ui_copy::settings::BACKEND_CATEGORIES_HEADING,
                BackendSettingsHubAction::Cancel,
            ),
        ];
        for (index, category) in BACKEND_CATEGORY_OPTIONS.iter().enumerate() {
            items.push(
                MenuItem::new(
                    format!("{}. {}", index + 1, category.label),
                    BackendSettingsHubAction::OpenCategory(category.key),
                )
                .with_hint(category.description)
                .with_color(MenuColor::Green),
            );
        }
        items.push(MenuItem::separator(BackendSettingsHubAction::Cancel));
        items.push(
            MenuItem::new(
                ui_copy::settings::RESET_DEFAULT,
                BackendSettingsHubAction::Reset,
            )
            .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(
                ui_copy::settings::SAVE_AND_BACK,
                BackendSettingsHubAction::Save,
            )
            .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(
                ui_copy::settings::BACK_NO_SAVE,
                BackendSettingsHubAction::Cancel,
            )
            .with_color(MenuColor::Red),
        );

        let initial_cursor = items.iter().position(|item| {
            if item.separator || item.disabled || item.heading {
                return false;
            }
            matches!(item.value, BackendSettingsHubAction::OpenCategory(key) if key == active_category)
        });

        let active_cell: RefCell<BackendCategoryKey> = RefCell::new(active_category);
        let mut options: SelectOptions<'_, BackendSettingsHubAction> =
            SelectOptions::new(ui_copy::settings::BACKEND_TITLE);
        options.subtitle = Some(ui_copy::settings::BACKEND_SUBTITLE.to_string());
        options.help = Some(ui_copy::settings::BACKEND_HELP.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.initial_cursor = initial_cursor.map(|cursor| cursor as i64);
        options.on_cursor_change = Some(Box::new(|ctx| {
            if let Some(MenuItem {
                value: BackendSettingsHubAction::OpenCategory(key),
                ..
            }) = ctx.items.get(ctx.cursor)
            {
                *active_cell.borrow_mut() = *key;
            }
        }));
        options.on_input = Some(Box::new(|raw, _ctx| {
            let lower = raw.to_lowercase();
            if lower == "q" {
                return SelectInputResult::Finish(Some(BackendSettingsHubAction::Cancel));
            }
            if lower == "s" {
                return SelectInputResult::Finish(Some(BackendSettingsHubAction::Save));
            }
            if lower == "r" {
                return SelectInputResult::Finish(Some(BackendSettingsHubAction::Reset));
            }
            if let Ok(parsed) = raw.trim().parse::<usize>()
                && parsed >= 1 && parsed <= BACKEND_CATEGORY_OPTIONS.len() {
                    return SelectInputResult::Finish(Some(
                        BackendSettingsHubAction::OpenCategory(
                            BACKEND_CATEGORY_OPTIONS[parsed - 1].key,
                        ),
                    ));
                }
            SelectInputResult::Ignored
        }));

        let result = select(&items, options).ok().flatten();
        active_category = *active_cell.borrow();

        let result = result?;
        match result {
            BackendSettingsHubAction::Cancel => return None,
            BackendSettingsHubAction::Save => return Some(draft),
            BackendSettingsHubAction::Reset => {
                draft = clone_backend_plugin_config(&backend_defaults());
                for (category_key, focus) in focus_by_category.iter_mut() {
                    let category = get_backend_category(*category_key, &BACKEND_CATEGORY_OPTIONS)
                        .expect("category keys are static");
                    *focus = get_backend_category_initial_focus(category);
                }
                active_category = BACKEND_CATEGORY_OPTIONS[0].key;
            }
            BackendSettingsHubAction::OpenCategory(key) => {
                let Some(category) = get_backend_category(key, &BACKEND_CATEGORY_OPTIONS) else {
                    continue;
                };
                active_category = category.key;
                let focus = focus_of(&focus_by_category, category.key)
                    .or_else(|| get_backend_category_initial_focus(category));
                let category_result =
                    prompt_backend_category_settings(&draft, category, focus);
                draft = category_result.draft;
                for (category_key, slot) in focus_by_category.iter_mut() {
                    if *category_key == category.key {
                        *slot = category_result.focus_key;
                    }
                }
            }
        }
    }
}

/// `configureBackendSettings(config)` — controller: non-interactive prints
/// `"Settings require interactive mode."`; unchanged/cancelled returns the
/// current clone; else persists via the write queue.
pub async fn configure_backend_settings(current_config: Option<&PluginConfig>) -> PluginConfig {
    let current = clone_backend_plugin_config(
        &current_config
            .cloned()
            .unwrap_or_else(cma_config::load::load_plugin_config),
    );
    if !is_tty_interactive() {
        println!("Settings require interactive mode.");
        return current;
    }
    let Some(selected) = prompt_backend_settings(&current) else {
        return current;
    };
    if backend_settings_equal(&current, &selected) {
        return current;
    }
    persist_backend_config_selection(&selected, "backend").await
}

// Silence an "unused" warning until the fallback-chain override is exercised
// beyond clone (parity with the TS import surface).
#[allow(unused)]
fn _fallback_chain_default() -> FallbackChain {
    FallbackChain::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::schema::{BackendNumberSettingKey as N, BackendToggleSettingKey as T};

    #[test]
    fn clone_materializes_all_defaults_and_copies_the_fallback_chain() {
        let config = PluginConfig {
            fast_session: Some(true),
            ..Default::default()
        };
        let clone = clone_backend_plugin_config(&config);
        assert_eq!(clone.fast_session, Some(true));
        // Defaults materialized:
        assert!(clone.live_account_sync.is_some());
        assert!(clone.fetch_timeout_ms.is_some());
        // Absent chain → empty object, not the defaults'.
        assert_eq!(clone.unsupported_codex_fallback_chain, Some(FallbackChain::new()));
    }

    #[test]
    fn snapshot_equality_ignores_non_schema_keys() {
        let left = PluginConfig {
            codex_mode: Some(false), // NOT schema-managed
            ..Default::default()
        };
        let mut right = PluginConfig::default();
        assert!(backend_settings_equal(&left, &right));
        right.fast_session = Some(!backend_defaults().fast_session.unwrap_or(false));
        assert!(!backend_settings_equal(&left, &right));
    }

    #[test]
    fn format_backend_number_value_units() {
        let percent = backend_number_option_by_key(N::PreemptiveQuotaRemainingPercent5h);
        assert_eq!(format_backend_number_value(percent, 12.4), "12%");
        let count = backend_number_option_by_key(N::ParallelProbingMaxConcurrency);
        assert_eq!(format_backend_number_value(count, 3.0), "3");
        let ms = backend_number_option_by_key(N::FetchTimeoutMs);
        assert_eq!(format_backend_number_value(ms, 120_000.0), "2m");
        assert_eq!(format_backend_number_value(ms, 90_000.0), "90s");
        assert_eq!(format_backend_number_value(ms, 1_500.0), "1500ms");
        assert_eq!(format_backend_number_value(ms, 250.0), "250ms");
    }

    #[test]
    fn clamp_for_tests_rejects_unknown_keys_with_the_frozen_message() {
        assert_eq!(
            clamp_backend_number_for_tests("fetchTimeoutMs", 1e9).unwrap(),
            600_000.0
        );
        let error = clamp_backend_number_for_tests("bogusKey", 1.0).unwrap_err();
        assert_eq!(error, "Unknown backend numeric setting key: bogusKey");
    }

    #[test]
    fn config_patch_contains_only_typed_schema_keys_clamped() {
        let config = PluginConfig {
            fast_session: Some(true),
            fetch_timeout_ms: Some(10_000_000.0), // above max → clamped
            network_error_cooldown_ms: Some(f64::NAN), // non-finite → omitted
            codex_mode: Some(true), // non-schema → omitted
            ..Default::default()
        };
        let patch = build_backend_config_patch(&config);
        assert_eq!(patch.get("fastSession"), Some(&Value::Bool(true)));
        assert_eq!(
            patch.get("fetchTimeoutMs"),
            Some(&Value::Number(Number::from(600_000)))
        );
        assert!(!patch.contains_key("networkErrorCooldownMs"));
        assert!(!patch.contains_key("codexMode"));
    }

    #[test]
    fn category_defaults_reset_only_that_category() {
        let mut draft = clone_backend_plugin_config(&PluginConfig::default());
        // Mutate one key in rotation-quota and one in session-sync.
        T::PreemptiveQuotaEnabled.set(&mut draft, Some(false));
        N::LiveAccountSyncPollMs.set(&mut draft, Some(59_500.0));
        let rotation = get_backend_category(BackendCategoryKey::RotationQuota, &BACKEND_CATEGORY_OPTIONS)
            .unwrap();
        let next = apply_backend_category_defaults(&draft, rotation);
        // rotation-quota key reset to default...
        assert_eq!(
            T::PreemptiveQuotaEnabled.get(&next),
            backend_defaults().preemptive_quota_enabled
        );
        // ...session-sync key untouched.
        assert_eq!(N::LiveAccountSyncPollMs.get(&next), Some(59_500.0));
    }

    #[test]
    fn focused_number_key_falls_back_to_first_option_then_fetch_timeout() {
        let perf = get_backend_category(
            BackendCategoryKey::PerformanceTimeouts,
            &BACKEND_CATEGORY_OPTIONS,
        )
        .unwrap();
        let options: Vec<_> = perf
            .number_keys
            .iter()
            .map(|key| backend_number_option_by_key(*key))
            .collect();
        assert_eq!(
            resolve_focused_backend_number_key(
                Some(BackendSettingFocusKey::Number(N::FetchTimeoutMs)),
                &options
            ),
            N::FetchTimeoutMs
        );
        // Focus on a key from another category → first option of this one.
        assert_eq!(
            resolve_focused_backend_number_key(
                Some(BackendSettingFocusKey::Number(N::SessionAffinityTtlMs)),
                &options
            ),
            N::FastSessionMaxInputItems
        );
        // Toggle focus → first option.
        assert_eq!(
            resolve_focused_backend_number_key(
                Some(BackendSettingFocusKey::Toggle(T::FastSession)),
                &options
            ),
            N::FastSessionMaxInputItems
        );
        assert_eq!(resolve_focused_backend_number_key(None, &[]), N::FetchTimeoutMs);
    }

    #[test]
    fn backend_preview_shows_toggles_thresholds_and_timeouts() {
        let config = clone_backend_plugin_config(&PluginConfig::default());
        let ui = get_ui_runtime_options();
        let no_highlight = |text: &str, _ui: &UiRuntimeOptions| text.to_string();
        let (label, hint) = build_backend_settings_preview(&config, &ui, None, &no_highlight);
        assert!(label.starts_with("live sync "));
        assert!(label.contains(" | affinity "));
        assert!(label.contains(" | preemptive "));
        assert!(hint.starts_with("thresholds 5h<="));
        assert!(hint.contains(" | 7d<="));
        assert!(hint.contains(" | timeouts "));
    }
}
