import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeCallbackFailure } from "../lib/auth/callback-guidance.js";
import { AUTH_REDIRECT } from "../lib/auth/auth.js";
import { getWslDistroName, isWsl } from "../lib/wsl.js";

vi.mock("../lib/wsl.js", () => ({
	isWsl: vi.fn(() => false),
	getWslDistroName: vi.fn(() => undefined),
}));

const mockedIsWsl = vi.mocked(isWsl);
const mockedDistro = vi.mocked(getWslDistroName);

function asText(lines: string[]): string {
	return lines.join("\n");
}

describe("describeCallbackFailure", () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
		vi.clearAllMocks();
		mockedIsWsl.mockReturnValue(false);
		mockedDistro.mockReturnValue(undefined);
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("always offers the device-code flow, which needs no callback port", () => {
		for (const reason of ["bind-failed", "callback-timeout"] as const) {
			expect(asText(describeCallbackFailure(reason))).toContain(
				"--device-auth",
			);
		}
	});

	it("names port contention when the bind actually failed with EADDRINUSE", () => {
		const text = asText(
			describeCallbackFailure("bind-failed", { bindErrorCode: "EADDRINUSE" }),
		);

		expect(text).toContain(`port ${AUTH_REDIRECT.port}`);
		expect(text).toContain("already holds it");
	});

	it("does not claim contention for unrelated bind errors", () => {
		const text = asText(
			describeCallbackFailure("bind-failed", { bindErrorCode: "EACCES" }),
		);

		expect(text).toContain("EACCES");
		expect(text).not.toContain("already holds it");
		expect(text).not.toContain("Get-NetTCPConnection");
	});

	it("treats a silent callback timeout as contention", () => {
		// A clean bind that never receives a redirect is the exact signature of a
		// listener on the other side of the Windows/WSL boundary taking the callback.
		const text = asText(describeCallbackFailure("callback-timeout"));

		expect(text).toContain("No OAuth callback arrived");
		expect(text).toContain(`port ${AUTH_REDIRECT.port}`);
	});

	it("explains the Windows/WSL split and names the distro when inside WSL", () => {
		mockedIsWsl.mockReturnValue(true);
		mockedDistro.mockReturnValue("Debian");

		const text = asText(describeCallbackFailure("callback-timeout"));

		expect(text).toContain("WSL (Debian)");
		expect(text).toContain("the browser opens on the Windows host");
		// Both sides are worth inspecting, so both commands are offered.
		expect(text).toContain("Get-NetTCPConnection");
		expect(text).toContain("ss -lptn");
	});

	it("still explains the split inside WSL when the distro name is unknown", () => {
		mockedIsWsl.mockReturnValue(true);

		const text = asText(describeCallbackFailure("callback-timeout"));

		expect(text).toContain("WSL");
		expect(text).not.toContain("WSL ()");
	});

	it("points a Windows host at the reciprocal WSL conflict", () => {
		Object.defineProperty(process, "platform", { value: "win32" });

		const text = asText(
			describeCallbackFailure("bind-failed", { bindErrorCode: "EADDRINUSE" }),
		);

		expect(text).toContain("Get-NetTCPConnection");
		expect(text).toContain("inside WSL can also hold it");
	});
});
