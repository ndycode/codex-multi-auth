// Back-compat re-export stub. The settings hub now lives under
// lib/codex-manager/settings-hub/ as five focused sub-modules.
// Existing consumers (and test mocks) continue to import from this path.
export {
	__testOnly,
	applyUiThemeFromDashboardSettings,
	configureUnifiedSettings,
	resolveMenuLayoutMode,
} from "./settings-hub/index.js";
