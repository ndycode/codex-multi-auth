import { expect, it } from "vitest";
import {
	RuntimeCapabilityFailures,
	classifyCapabilityFailure,
} from "../lib/runtime/runtime-capability-failures.js";
it("learns scoped failures without treating arbitrary bad requests or auth failures as capabilities", () => {
	expect(
		classifyCapabilityFailure(404, {
			error: { code: "model_not_found", param: "model" },
		}),
	).toBe("model");
	expect(
		classifyCapabilityFailure(400, {
			error: { code: "unsupported_value", param: "reasoning.effort" },
		}),
	).toBe("effort");
	expect(
		classifyCapabilityFailure(400, {
			error: { code: "invalid_value", param: "service_tier" },
		}),
	).toBe("tier");
	for (const status of [401, 429, 500])
		expect(
			classifyCapabilityFailure(status, { error: { code: "model_not_found" } }),
		).toBeNull();
	expect(
		classifyCapabilityFailure(400, {
			error: { code: "invalid_value", param: "input" },
		}),
	).toBeNull();
	expect(
		classifyCapabilityFailure(403, { error: { code: "permission_denied" } }),
	).toBeNull();
});
it("keeps rejection memory per credential, model and setting and retries after expiry", () => {
	let now = 0;
	const failures = new RuntimeCapabilityFailures(() => now, 100);
	failures.record("a", "shared", "effort", "high");
	expect(failures.supports("a", "shared", "high")).toBe(false);
	expect(failures.supports("b", "shared", "high")).toBe(true);
	expect(failures.supports("a", "shared", "low")).toBe(true);
	expect(failures.supports("a", "other", "high")).toBe(true);
	now = 101;
	expect(failures.supports("a", "shared", "high")).toBe(true);
});
it("normalizes Fast/Priority and does not block Standard", () => {
	const failures = new RuntimeCapabilityFailures();
	failures.record("a", "shared", "tier", "low", "priority");
	expect(failures.supports("a", "shared", "low", "fast")).toBe(false);
	expect(failures.supports("a", "shared", "low", "default")).toBe(true);
});
it("does not suppress a working effort/speed combination when another combination is rejected", () => {
	const failures = new RuntimeCapabilityFailures();
	failures.record("a", "shared", "effort", "high", "priority");
	expect(failures.supports("a", "shared", "high", "fast")).toBe(false);
	expect(failures.supports("a", "shared", "high", "default")).toBe(true);
	failures.record("a", "shared", "tier", "max", "priority");
	expect(failures.supports("a", "shared", "low", "priority")).toBe(true);
});
