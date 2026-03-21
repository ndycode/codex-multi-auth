import { describe, expect, it, vi } from "vitest";

const createSessionRecoveryHookMock = vi.fn();
vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: createSessionRecoveryHookMock,
}));

describe("createRuntimeSessionRecoveryHook", () => {
	it("returns null when disabled", async () => {
		const { createRuntimeSessionRecoveryHook } = await import("../lib/runtime/session-recovery.js");
		expect(
			createRuntimeSessionRecoveryHook({
				enabled: false,
				client: {} as never,
				directory: "/tmp/recovery",
				autoResume: true,
			}),
		).toBeNull();
	});

	it("forwards typed client context when enabled", async () => {
		createSessionRecoveryHookMock.mockReturnValueOnce({ handleSessionRecovery: vi.fn() });
		const client = {} as never;
		const { createRuntimeSessionRecoveryHook } = await import("../lib/runtime/session-recovery.js");
		createRuntimeSessionRecoveryHook({
			enabled: true,
			client,
			directory: "/tmp/recovery",
			autoResume: false,
		});
		expect(createSessionRecoveryHookMock).toHaveBeenCalledWith(
			{ client, directory: "/tmp/recovery" },
			{ sessionRecovery: true, autoResume: false },
		);
	});
});
