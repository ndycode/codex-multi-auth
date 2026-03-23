import { describe, expect, it, vi } from "vitest";
import { applyLoaderRuntimeSetup } from "../lib/runtime/loader-setup.js";

describe("loader runtime setup", () => {
	it("applies runtime setup steps in the existing order", () => {
		const calls: string[] = [];
		const pluginConfig = { a: 1 } as never;

		applyLoaderRuntimeSetup({
			pluginConfig,
			applyUiRuntimeFromConfig: () => {
				calls.push("ui");
			},
			applyAccountStorageScope: () => {
				calls.push("scope");
			},
			ensureSessionAffinity: () => {
				calls.push("session");
			},
			ensureRefreshGuardian: () => {
				calls.push("guardian");
			},
			applyPreemptiveQuotaSettings: () => {
				calls.push("quota");
			},
		});

		expect(calls).toEqual(["ui", "scope", "session", "guardian", "quota"]);
	});
});
