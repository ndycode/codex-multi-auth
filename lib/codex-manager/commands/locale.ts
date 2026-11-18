import {
	localeName,
	normalizeOutputLocaleSetting,
	resolveOutputLocale,
	type OutputLocaleSetting,
} from "../../locale.js";

export interface LocaleCommandDeps {
	loadConfig: () => { locale?: OutputLocaleSetting };
	saveConfig: (patch: { locale: OutputLocaleSetting }) => Promise<void>;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

export async function runLocaleCommand(
	args: string[],
	deps: LocaleCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const requested = args[0]?.trim();
	if (args.length > 1 || requested === "--help" || requested === "-h") {
		logInfo("Usage: codex-multi-auth config locale [auto|en|zh]");
		return requested === "--help" || requested === "-h" ? 0 : 1;
	}
	if (!requested) {
		const configured = deps.loadConfig().locale ?? "auto";
		const effective = resolveOutputLocale(configured);
		logInfo(`Locale: ${configured} (effective: ${localeName(effective)})`);
		return 0;
	}
	const locale = normalizeOutputLocaleSetting(requested);
	if (!locale) {
		logError(`Unsupported locale: ${requested}. Choose auto, en, or zh.`);
		return 1;
	}
	await deps.saveConfig({ locale });
	const effective = resolveOutputLocale(locale);
	logInfo(`Locale saved: ${locale} (effective: ${localeName(effective)})`);
	return 0;
}
