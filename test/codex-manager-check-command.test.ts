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
		expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true });
	});
});
