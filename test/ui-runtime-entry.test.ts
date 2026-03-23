import { describe, expect, it, vi } from "vitest";
import { resolveUiRuntimeEntry } from "../lib/runtime/ui-runtime-entry.js";

describe("ui runtime entry", () => {
	it("passes loader and apply callback through to the ui runtime resolver", () => {
		const loadPluginConfig = vi.fn(() => ({ a: 1 }));
		const resolveUiRuntimeFromConfig = vi.fn(() => ({ theme: {} }));
		const applyUiRuntimeFromConfig = vi.fn(() => ({ theme: {} }));

		const result = resolveUiRuntimeEntry({
			loadPluginConfig: loadPluginConfig as never,
			resolveUiRuntimeFromConfig: resolveUiRuntimeFromConfig as never,
			applyUiRuntimeFromConfig: applyUiRuntimeFromConfig as never,
		});

		expect(resolveUiRuntimeFromConfig).toHaveBeenCalledWith(
			loadPluginConfig,
			applyUiRuntimeFromConfig,
		);
		expect(result).toEqual({ theme: {} });
	});
});
