import { describe, expect, it, vi } from "vitest";
import { runLocaleCommand } from "../lib/codex-manager/commands/locale.js";
import { resolveOutputLocale } from "../lib/locale.js";

describe("output locale", () => {
	it("uses Chinese system locales and explicit overrides", () => {
		expect(resolveOutputLocale(undefined, { LANG: "zh_CN.UTF-8" })).toBe("zh");
		expect(resolveOutputLocale(undefined, { LANG: "en_US.UTF-8" })).toBe("en");
		expect(resolveOutputLocale("zh", { LANG: "en_US.UTF-8" })).toBe("zh");
		expect(resolveOutputLocale("zh", { CODEX_MULTI_AUTH_LOCALE: "en" })).toBe("en");
		expect(resolveOutputLocale("en", { CODEX_MULTI_AUTH_LOCALE: "auto", LANG: "zh_CN.UTF-8" })).toBe("zh");
	});

	it("reads and persists the locale setting", async () => {
		const logInfo = vi.fn();
		const saveConfig = vi.fn(async () => undefined);
		const loadConfig = vi.fn(() => ({ locale: "auto" as const }));
		expect(await runLocaleCommand(["zh"], { loadConfig, saveConfig, logInfo })).toBe(0);
		expect(saveConfig).toHaveBeenCalledWith({ locale: "zh" });
		expect(logInfo.mock.calls[0]?.[0]).toContain("zh");
	});
});
