import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPersistError, resolvePluginConfigSavePathKey, warnPersistFailure } from "../lib/codex-manager/settings-persist-utils.js";

describe("settings persist utils", () => {
	afterEach(() => {
		delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;
		vi.restoreAllMocks();
	});

	it("prefers explicit config path over unified settings path", async () => {
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = " /tmp/custom.json ";
		const { resolvePluginConfigSavePathKey } = await import("../lib/codex-manager/settings-persist-utils.js");
		expect(resolvePluginConfigSavePathKey()).toBe("/tmp/custom.json");
	});

	it("formats persist errors consistently", () => {
		expect(formatPersistError(new Error("boom"))).toBe("boom");
		expect(formatPersistError("bad")).toBe("bad");
	});

	it("warns with scope-aware message", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		warnPersistFailure("settings", new Error("disk locked"));
		expect(warn).toHaveBeenCalledWith("Settings save failed (settings) after retries: disk locked");
	});
});
