import { afterEach, beforeEach, vi } from "vitest";

const homedirMock = vi.fn<() => string>();

vi.mock("node:os", async (importActual) => {
	const actual = await importActual<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => homedirMock(),
	};
});

import { redactHome } from "../lib/codex-manager/commands/debug-bundle.js";

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("debug-bundle redactHome (errors-logging-04)", () => {
	beforeEach(() => {
		homedirMock.mockReset();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
	});

	describe("posix path rules", () => {
		beforeEach(() => {
			setPlatform("linux");
			homedirMock.mockReturnValue("/home/alice");
		});

		it("redacts the home prefix with ~ at a path boundary", () => {
			expect(redactHome("/home/alice/.codex/config.json")).toBe(
				"~/.codex/config.json",
			);
		});

		it("redacts an exact home match", () => {
			expect(redactHome("/home/alice")).toBe("~");
		});

		it("does NOT redact a sibling that merely shares the prefix", () => {
			// prefix-collision: /home/alice2 must not be treated as under /home/alice.
			expect(redactHome("/home/alice2/.codex/config.json")).toBe(
				"/home/alice2/.codex/config.json",
			);
		});

		it("is case-sensitive on posix", () => {
			expect(redactHome("/HOME/Alice/.codex")).toBe("/HOME/Alice/.codex");
		});
	});

	describe("windows path rules", () => {
		beforeEach(() => {
			setPlatform("win32");
			homedirMock.mockReturnValue("C:\\Users\\Alice");
		});

		it("redacts despite case-only differences", () => {
			expect(redactHome("c:\\users\\alice\\.codex\\config.json")).toBe(
				"~\\.codex\\config.json",
			);
		});

		it("redacts the exact home regardless of case", () => {
			expect(redactHome("C:\\USERS\\ALICE")).toBe("~");
		});

		it("does NOT redact a case-insensitive sibling prefix", () => {
			expect(redactHome("c:\\users\\alice2\\.codex")).toBe(
				"c:\\users\\alice2\\.codex",
			);
		});
	});

	it("returns the value unchanged when homedir is empty", () => {
		setPlatform("linux");
		homedirMock.mockReturnValue("");
		expect(redactHome("/home/alice/.codex")).toBe("/home/alice/.codex");
	});
});
