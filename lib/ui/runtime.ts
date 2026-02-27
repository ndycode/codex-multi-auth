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
 * Update the global UI runtime options and rebuild the derived theme.
 *
 * This mutates module-level state: callers should avoid concurrent conflicting updates.
 * This function does not access the filesystem and is unaffected by Windows filesystem semantics.
 * Do not pass secrets or sensitive tokens as option values; they are stored in-memory and may be observable.
 *
 * @param options - Partial runtime option fields to apply (the `theme` field is ignored)
 * @returns The updated runtime options object reflecting the applied fields and the regenerated theme
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

export function getUiRuntimeOptions(): UiRuntimeOptions {
	return runtimeOptions;
}

/**
 * Reset the UI runtime options to their default values.
 *
 * This replaces the shared runtime options with a fresh copy of the defaults. Callers should avoid concurrent mutations to `runtimeOptions` — the operation is synchronous but not safe against concurrent updates from other execution contexts. The function performs no filesystem I/O (no Windows filesystem implications) and does not read, write, or expose sensitive tokens.
 *
 * @returns The runtime options object after being reset to default values.
 */
export function resetUiRuntimeOptions(): UiRuntimeOptions {
	runtimeOptions = { ...DEFAULT_OPTIONS };
	return runtimeOptions;
}
