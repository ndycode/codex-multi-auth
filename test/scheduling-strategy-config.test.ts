import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { DEFAULT_PLUGIN_CONFIG, getSchedulingStrategy } from "../lib/config.js";
import type { PluginConfig } from "../lib/types.js";

describe("schedulingStrategy config flag (issue #509)", () => {
	const ORIGINAL_ENV = process.env.CODEX_AUTH_SCHEDULING_STRATEGY;

	beforeEach(() => {
		delete process.env.CODEX_AUTH_SCHEDULING_STRATEGY;
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.CODEX_AUTH_SCHEDULING_STRATEGY;
		} else {
			process.env.CODEX_AUTH_SCHEDULING_STRATEGY = ORIGINAL_ENV;
		}
	});

	it("defaults to hybrid in DEFAULT_PLUGIN_CONFIG", () => {
		expect(DEFAULT_PLUGIN_CONFIG.schedulingStrategy).toBe("hybrid");
	});

	it("getSchedulingStrategy returns hybrid when config is undefined", () => {
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			schedulingStrategy: undefined,
		};
		expect(getSchedulingStrategy(cfg)).toBe("hybrid");
	});

	it("getSchedulingStrategy respects explicit sequential in config", () => {
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			schedulingStrategy: "sequential",
		};
		expect(getSchedulingStrategy(cfg)).toBe("sequential");
	});

	it("env var CODEX_AUTH_SCHEDULING_STRATEGY=sequential overrides config", () => {
		process.env.CODEX_AUTH_SCHEDULING_STRATEGY = "sequential";
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			schedulingStrategy: "hybrid",
		};
		expect(getSchedulingStrategy(cfg)).toBe("sequential");
	});

	it("env var CODEX_AUTH_SCHEDULING_STRATEGY=hybrid overrides config", () => {
		process.env.CODEX_AUTH_SCHEDULING_STRATEGY = "hybrid";
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			schedulingStrategy: "sequential",
		};
		expect(getSchedulingStrategy(cfg)).toBe("hybrid");
	});

	it("rejects unknown env values and falls back to config", () => {
		process.env.CODEX_AUTH_SCHEDULING_STRATEGY = "bogus-mode";
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			schedulingStrategy: "sequential",
		};
		expect(getSchedulingStrategy(cfg)).toBe("sequential");
	});
});
