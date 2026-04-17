import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { DEFAULT_PLUGIN_CONFIG, getRoutingMutexMode } from "../lib/config.js";
import type { PluginConfig } from "../lib/types.js";

describe("routingMutex config flag", () => {
	const ORIGINAL_ENV = process.env.CODEX_AUTH_ROUTING_MUTEX;

	beforeEach(() => {
		delete process.env.CODEX_AUTH_ROUTING_MUTEX;
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.CODEX_AUTH_ROUTING_MUTEX;
		} else {
			process.env.CODEX_AUTH_ROUTING_MUTEX = ORIGINAL_ENV;
		}
	});

	it("defaults to legacy in DEFAULT_PLUGIN_CONFIG", () => {
		expect(DEFAULT_PLUGIN_CONFIG.routingMutex).toBe("legacy");
	});

	it("getRoutingMutexMode returns legacy when config is undefined", () => {
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			routingMutex: undefined,
		};
		expect(getRoutingMutexMode(cfg)).toBe("legacy");
	});

	it("getRoutingMutexMode respects explicit enabled in config", () => {
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			routingMutex: "enabled",
		};
		expect(getRoutingMutexMode(cfg)).toBe("enabled");
	});

	it("env var CODEX_AUTH_ROUTING_MUTEX=enabled overrides config", () => {
		process.env.CODEX_AUTH_ROUTING_MUTEX = "enabled";
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			routingMutex: "legacy",
		};
		expect(getRoutingMutexMode(cfg)).toBe("enabled");
	});

	it("env var CODEX_AUTH_ROUTING_MUTEX=legacy overrides config", () => {
		process.env.CODEX_AUTH_ROUTING_MUTEX = "legacy";
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			routingMutex: "enabled",
		};
		expect(getRoutingMutexMode(cfg)).toBe("legacy");
	});

	it("rejects unknown env values and falls back to config", () => {
		process.env.CODEX_AUTH_ROUTING_MUTEX = "bogus-mode";
		const cfg: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			routingMutex: "enabled",
		};
		expect(getRoutingMutexMode(cfg)).toBe("enabled");
	});
});
