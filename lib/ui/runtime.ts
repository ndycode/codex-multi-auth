import {
	createUiTheme,
	type UiColorProfile,
	type UiGlyphMode,
	type UiPalette,
	type UiAccent,
	type UiTheme,
} from "./theme.js";

export interface UiRuntimeOptions {
	v2Enabled: boolean;
	colorProfile: UiColorProfile;
	glyphMode: UiGlyphMode;
	palette: UiPalette;
	accent: UiAccent;
	theme: UiTheme;
}

const DEFAULT_OPTIONS: UiRuntimeOptions = {
	v2Enabled: true,
	colorProfile: "truecolor",
	glyphMode: "ascii",
	palette: "green",
	accent: "green",
	theme: createUiTheme({
		profile: "truecolor",
		glyphMode: "ascii",
		palette: "green",
		accent: "green",
	}),
};

let runtimeOptions: UiRuntimeOptions = { ...DEFAULT_OPTIONS };

/**
 * Update UI runtime options and recompute the derived theme.
 *
 * Unspecified fields in `options` retain their current values; the exported `runtimeOptions`
 * object is replaced with a new object containing the resolved fields and a newly created
 * `theme` based on `colorProfile`, `glyphMode`, `palette`, and `accent`.
 *
 * Concurrency: callers should synchronize externally if multiple callers may update options
 * concurrently (updates are a single replacement and may race). Filesystem: this function
 * performs no filesystem operations and is unaffected by Windows filesystem semantics.
 * Token handling: this function does not perform token redaction or logging—sensitive
 * values should be redacted by the caller before passing them in.
 *
 * @param options - Partial runtime options (omit `theme`); any omitted fields keep their current values
 * @returns The resolved `UiRuntimeOptions` including the recomputed `theme`
 */
export function setUiRuntimeOptions(
	options: Partial<Omit<UiRuntimeOptions, "theme">>,
): UiRuntimeOptions {
	const v2Enabled = options.v2Enabled ?? runtimeOptions.v2Enabled;
	const colorProfile = options.colorProfile ?? runtimeOptions.colorProfile;
	const glyphMode = options.glyphMode ?? runtimeOptions.glyphMode;
	const palette = options.palette ?? runtimeOptions.palette;
	const accent = options.accent ?? runtimeOptions.accent;
	runtimeOptions = {
		v2Enabled,
		colorProfile,
		glyphMode,
		palette,
		accent,
		theme: createUiTheme({ profile: colorProfile, glyphMode, palette, accent }),
	};
	return runtimeOptions;
}

/**
 * Accesses the current UI runtime options.
 *
 * The returned object reflects the current in-memory runtime configuration; concurrent callers may observe updates made by others, so external synchronization is recommended when mutating options. This function performs no filesystem I/O (including on Windows) and the runtime options contain no sensitive tokens that require redaction.
 *
 * @returns The current UiRuntimeOptions object
 */
export function getUiRuntimeOptions(): UiRuntimeOptions {
	return runtimeOptions;
}

/**
 * Reset the UI runtime options to the default configuration.
 *
 * This replaces the global runtime options with a fresh shallow copy of DEFAULT_OPTIONS. Concurrent callers may observe the updated options immediately; callers that need isolation should clone the returned object. This operation performs no filesystem access (including on Windows). The runtime options contain only configuration fields and do not include sensitive tokens.
 *
 * @returns The new runtime options object set to the defaults
 */
export function resetUiRuntimeOptions(): UiRuntimeOptions {
	runtimeOptions = { ...DEFAULT_OPTIONS };
	return runtimeOptions;
}
