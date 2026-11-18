import { describe, expect, it, vi } from "vitest";
import { INSTALL_NOTICE, runPostinstall } from "../scripts/postinstall.js";

describe("postinstall notice", () => {
	it("prints package removal guidance in an interactive install", () => {
		const log = vi.fn();

		expect(
			runPostinstall({ env: {}, isTty: true, log }),
		).toBe(0);
		expect(log).toHaveBeenCalledWith(INSTALL_NOTICE);
		expect(INSTALL_NOTICE).toContain("npm uninstall -g codex-multi-auth");
		expect(INSTALL_NOTICE).toContain("@ndycode/codex-multi-auth");
	});

	it("stays silent in CI", () => {
		const log = vi.fn();

		expect(
			runPostinstall({ env: { CI: "1" }, isTty: true, log }),
		).toBe(0);
		expect(log).not.toHaveBeenCalled();
	});
});
