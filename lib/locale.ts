export type OutputLocale = "en" | "zh";
export type OutputLocaleSetting = OutputLocale | "auto";

const SUPPORTED_LOCALES = new Set<OutputLocaleSetting>(["auto", "en", "zh"]);

/** Resolve an explicit locale, environment override, or system language. */
export function resolveOutputLocale(
	requested?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): OutputLocale {
	const configured = requested?.trim().toLowerCase();
	const value = (env.CODEX_MULTI_AUTH_LOCALE?.trim() || configured || "auto")
		.trim()
		.toLowerCase();
	if (value === "en" || value.startsWith("en-")) return "en";
	if (value === "zh" || value.startsWith("zh-")) return "zh";
	if (value !== "" && value !== "auto" && SUPPORTED_LOCALES.has(value as OutputLocaleSetting)) {
		return value === "zh" ? "zh" : "en";
	}
	const system = [env.LC_ALL, env.LC_MESSAGES, env.LANG]
		.find((candidate) => typeof candidate === "string" && candidate.trim())
		?.toLowerCase() ?? "";
	return system.startsWith("zh") ? "zh" : "en";
}

export function normalizeOutputLocaleSetting(value: string): OutputLocaleSetting | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto") return "auto";
	if (normalized === "en" || normalized.startsWith("en-")) return "en";
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
	return null;
}

export function localized(
	locale: OutputLocale,
	en: string,
	zh: string,
): string {
	return locale === "zh" ? zh : en;
}

export function localeName(locale: OutputLocale): string {
	return locale === "zh" ? "中文" : "English";
}
