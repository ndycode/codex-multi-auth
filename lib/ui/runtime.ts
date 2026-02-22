import {
	createUiTheme,
	type UiColorProfile,
	type UiGlyphMode,
	type UiTheme,
} from "./theme.js";

export interface UiRuntimeOptions {
	v2Enabled: boolean;
	colorProfile: UiColorProfile;
	glyphMode: UiGlyphMode;
	theme: UiTheme;
}

const DEFAULT_OPTIONS: UiRuntimeOptions = {
	v2Enabled: true,
	colorProfile: "truecolor",
	glyphMode: "ascii",
	theme: createUiTheme({
		profile: "truecolor",
		glyphMode: "ascii",
	}),
};

let runtimeOptions: UiRuntimeOptions = { ...DEFAULT_OPTIONS };

export function setUiRuntimeOptions(
	options: Partial<Omit<UiRuntimeOptions, "theme">>,
): UiRuntimeOptions {
	const v2Enabled = options.v2Enabled ?? runtimeOptions.v2Enabled;
	const colorProfile = options.colorProfile ?? runtimeOptions.colorProfile;
	const glyphMode = options.glyphMode ?? runtimeOptions.glyphMode;
	runtimeOptions = {
		v2Enabled,
		colorProfile,
		glyphMode,
		theme: createUiTheme({ profile: colorProfile, glyphMode }),
	};
	return runtimeOptions;
}

export function getUiRuntimeOptions(): UiRuntimeOptions {
	return runtimeOptions;
}

export function resetUiRuntimeOptions(): UiRuntimeOptions {
	runtimeOptions = { ...DEFAULT_OPTIONS };
	return runtimeOptions;
}

