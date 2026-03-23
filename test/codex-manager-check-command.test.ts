import { describe, expect, it, vi } from "vitest";
import {
	type CheckCommandDeps,
	runCheckCommand,
} from "../lib/codex-manager/commands/check.js";

describe("runCheckCommand", () => {
	it("runs health check with live probing enabled", async () => {
		const deps: CheckCommandDeps = {
			runHealthCheck: vi.fn(async () => undefined),
		};

		const result = await runCheckCommand(deps);

		expect(result).toBe(0);
		expect(deps.runHealthCheck).toHaveBeenCalledTimes(1);
		expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true });
	});

	it("propagates rejection from runHealthCheck", async () => {
		const error = new Error("probe failed");
		const deps: CheckCommandDeps = {
			runHealthCheck: vi.fn(async () => {
				throw error;
			}),
		};

		await expect(runCheckCommand(deps)).rejects.toThrow("probe failed");
		expect(deps.runHealthCheck).toHaveBeenCalledTimes(1);
		expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true });
	});
});
