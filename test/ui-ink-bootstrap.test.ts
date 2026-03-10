import { describe, expect, it } from "vitest";
import { resolveInkAuthShellBootstrap } from "../lib/ui-ink/bootstrap.js";

function createMockStream(isTTY: boolean): NodeJS.ReadStream & NodeJS.WriteStream {
	return { isTTY } as NodeJS.ReadStream & NodeJS.WriteStream;
}

describe("ink auth shell bootstrap", () => {
	it("rejects non-tty input or output streams", () => {
		expect(resolveInkAuthShellBootstrap({
			stdin: createMockStream(false),
			stdout: createMockStream(true),
			env: {},
		})).toEqual({ supported: false, reason: "stdin-not-tty" });

		expect(resolveInkAuthShellBootstrap({
			stdin: createMockStream(true),
			stdout: createMockStream(false),
			env: {},
		})).toEqual({ supported: false, reason: "stdout-not-tty" });
	});

	it("preserves host-managed ui fallback boundaries", () => {
		expect(resolveInkAuthShellBootstrap({
			stdin: createMockStream(true),
			stdout: createMockStream(true),
			env: { CODEX_TUI: "1" },
		})).toEqual({ supported: false, reason: "host-managed-ui" });

		expect(resolveInkAuthShellBootstrap({
			stdin: createMockStream(true),
			stdout: createMockStream(true),
			env: { CODEX_TUI: "1", FORCE_INTERACTIVE_MODE: "1" },
		})).toEqual({ supported: true });
	});
});
