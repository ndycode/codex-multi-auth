import { describe, expect, test } from "bun:test";
import { resolveOpenTuiAuthShellBootstrap } from "../../runtime/opentui/bootstrap.js";

function createMockStream(isTTY: boolean): NodeJS.ReadStream & NodeJS.WriteStream {
	return { isTTY } as NodeJS.ReadStream & NodeJS.WriteStream;
}

describe("OpenTUI bootstrap boundaries", () => {
	test("rejects non-tty input or output streams", () => {
		expect(resolveOpenTuiAuthShellBootstrap({
			stdin: createMockStream(false),
			stdout: createMockStream(true),
			env: {},
		})).toEqual({ supported: false, reason: "stdin-not-tty" });

		expect(resolveOpenTuiAuthShellBootstrap({
			stdin: createMockStream(true),
			stdout: createMockStream(false),
			env: {},
		})).toEqual({ supported: false, reason: "stdout-not-tty" });
	});

	test("preserves host-managed ui fallback boundaries", () => {
		expect(resolveOpenTuiAuthShellBootstrap({
			stdin: createMockStream(true),
			stdout: createMockStream(true),
			env: { CODEX_TUI: "1" },
		})).toEqual({ supported: false, reason: "host-managed-ui" });

		expect(resolveOpenTuiAuthShellBootstrap({
			stdin: createMockStream(true),
			stdout: createMockStream(true),
			env: { CODEX_TUI: "1", FORCE_INTERACTIVE_MODE: "1" },
		})).toEqual({ supported: true });
	});
});
