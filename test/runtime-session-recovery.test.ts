import { beforeEach, describe, expect, it, vi } from "vitest";

const createSessionRecoveryHookMock = vi.fn();
vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: createSessionRecoveryHookMock,
}));

describe("createRuntimeSessionRecoveryHook", () => {
	beforeEach(() => {
		createSessionRecoveryHookMock.mockReset();
		createSessionRecoveryHookMock.mockReturnValue("hook");
	});

	it("returns null when disabled", async () => {
		const { createRuntimeSessionRecoveryHook } = await import(
			"../lib/runtime/session-recovery.js"
		);

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
		const client = { id: "client" } as never;
		const { createRuntimeSessionRecoveryHook } = await import(
			"../lib/runtime/session-recovery.js"
		);

		expect(
			createRuntimeSessionRecoveryHook({
				enabled: true,
				client,
				directory: "/tmp/recovery",
				autoResume: false,
			}),
		).toBe("hook");
		expect(createSessionRecoveryHookMock).toHaveBeenCalledWith(
			{ client, directory: "/tmp/recovery" },
			{ sessionRecovery: true, autoResume: false },
		);
	});
});
