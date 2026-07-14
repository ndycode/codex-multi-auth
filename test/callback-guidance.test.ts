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
		Object.defineProperty(process, "platform", { value: "linux" });
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

	describe("contention is only asserted when it was actually observed", () => {
		it("asserts contention on EADDRINUSE, which is hard evidence", () => {
			const text = asText(
				describeCallbackFailure("bind-failed", { bindErrorCode: "EADDRINUSE" }),
			);

			expect(text).toContain("another process already holds it");
			expect(text).toContain(`port ${AUTH_REDIRECT.port}`);
		});

		it("does not claim contention for unrelated bind errors", () => {
			const text = asText(
				describeCallbackFailure("bind-failed", { bindErrorCode: "EACCES" }),
			);

			expect(text).toContain("EACCES");
			expect(text).not.toContain("already holds it");
			expect(text).not.toContain("ss -lptn");
		});

		it("does not diagnose a cancelled or abandoned sign-in as port contention", () => {
			// A clean bind with no redirect is far more often a closed browser tab
			// than a stolen callback. Leading with a confident contention story
			// would misdiagnose the common case.
			const text = asText(describeCallbackFailure("callback-timeout"));

			expect(text).toContain("If you closed or cancelled the browser sign-in");
			expect(text).not.toContain("another process already holds it");
			// The contention explanation is offered conditionally, not asserted.
			expect(text).toContain("If you completed sign-in in the browser");
		});
	});

	describe("platform-appropriate inspection commands", () => {
		it("gives macOS lsof, never the Linux-only ss", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });

			const text = asText(describeCallbackFailure("callback-timeout"));

			expect(text).toContain("lsof -nP -iTCP:1455");
			expect(text).not.toContain("ss -lptn");
			expect(text).not.toContain("Get-NetTCPConnection");
		});

		it("gives native Linux ss, and no WSL narrative", () => {
			const text = asText(describeCallbackFailure("callback-timeout"));

			expect(text).toContain("ss -lptn");
			expect(text).not.toContain("Get-NetTCPConnection");
			// The `ss` line is labelled "Linux / WSL", so assert the absence of the
			// explanatory narrative rather than of the substring "WSL".
			expect(text).not.toContain("the browser opens on the Windows host");
			expect(text).not.toContain("can also hold port");
		});

		it("tells a Windows host that a WSL-side listener can also hold the port", () => {
			Object.defineProperty(process, "platform", { value: "win32" });

			const text = asText(
				describeCallbackFailure("bind-failed", { bindErrorCode: "EADDRINUSE" }),
			);

			expect(text).toContain("Get-NetTCPConnection");
			expect(text).toContain("inside WSL can also hold port");
			expect(text).not.toContain("lsof");
		});
	});

	describe("inside WSL", () => {
		beforeEach(() => {
			mockedIsWsl.mockReturnValue(true);
			mockedDistro.mockReturnValue("Debian");
		});

		it("explains the Windows/WSL split and offers both inspection commands", () => {
			const text = asText(describeCallbackFailure("callback-timeout"));

			expect(text).toContain("WSL (Debian)");
			expect(text).toContain("the browser opens on the Windows host");
			// The offending listener is usually on the other side of the boundary,
			// so both sides are worth checking.
			expect(text).toContain("Get-NetTCPConnection");
			expect(text).toContain("ss -lptn");
		});

		it("still explains the split when the distro name is unknown", () => {
			mockedDistro.mockReturnValue(undefined);

			const text = asText(describeCallbackFailure("callback-timeout"));

			expect(text).toContain("WSL");
			expect(text).not.toContain("WSL ()");
		});
	});
});
