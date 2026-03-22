import { describe, expect, it, vi } from "vitest";
import { createRuntimeSessionRecoveryHook } from "../lib/runtime/session-recovery.js";

vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: vi.fn(() => "hook"),
}));

describe("createRuntimeSessionRecoveryHook", () => {
	it("returns null when session recovery is disabled", () => {
		expect(
			createRuntimeSessionRecoveryHook({
				enabled: false,
				client: {},
				directory: "/repo",
				autoResume: true,
			}),
		).toBeNull();
	});

	it("creates the recovery hook when enabled", async () => {
		const recovery = await import("../lib/recovery.js");

		expect(
			createRuntimeSessionRecoveryHook({
				enabled: true,
				client: { id: "client" },
				directory: "/repo",
				autoResume: false,
			}),
		).toBe("hook");
		expect(recovery.createSessionRecoveryHook).toHaveBeenCalledWith(
			{ client: { id: "client" }, directory: "/repo" },
			{ sessionRecovery: true, autoResume: false },
		);
	});
});
