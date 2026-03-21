import { describe, expect, it, vi } from "vitest";
import {
	applyPreemptiveQuotaSettingsFromConfig,
	resolveUiRuntimeFromConfig,
} from "../lib/runtime/quota-settings.js";

describe("quota settings helpers", () => {
	it("applies preemptive quota config via dependency getters", () => {
		const configure = vi.fn();
		applyPreemptiveQuotaSettingsFromConfig({} as never, {
			configure,
			getPreemptiveQuotaEnabled: () => true,
			getPreemptiveQuotaRemainingPercent5h: () => 10,
			getPreemptiveQuotaRemainingPercent7d: () => 20,
			getPreemptiveQuotaMaxDeferralMs: () => 3000,
		});

		expect(configure).toHaveBeenCalledWith({
			enabled: true,
			remainingPercentThresholdPrimary: 10,
			remainingPercentThresholdSecondary: 20,
			maxDeferralMs: 3000,
		});
	});

	it("resolves ui runtime through provided loaders", () => {
		const loadPluginConfig = vi.fn(() => ({ a: 1 }));
		const applyUiRuntime = vi.fn(() => ({ theme: {} }));
		const result = resolveUiRuntimeFromConfig(
			loadPluginConfig as never,
			applyUiRuntime as never,
		);
		expect(loadPluginConfig).toHaveBeenCalled();
		expect(applyUiRuntime).toHaveBeenCalledWith({ a: 1 });
		expect(result).toEqual({ theme: {} });
	});
});
