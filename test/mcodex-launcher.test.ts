import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	parseMcodexArgs,
	resolveMonitorInterval,
	resolveTmuxHistoryLimit,
	resolveTmuxSession,
} from "../scripts/mcodex.js";

// H1 regression: scripts/mcodex was a `#!/usr/bin/env bash` script shipped as a
// Windows bin. npm's generated mcodex.cmd/.ps1 shim invoked bare `bash`; when a WSL
// stub resolved before git-bash on PATH the launcher died with
// HCS_E_SERVICE_NOT_AVAILABLE. It is now a node entry (scripts/mcodex.js) with zero
// bash dependency. These tests exercise the node launcher's arg/env parsing and the
// injection-hardening validation that the bash prologue used to own.

const testFileDir = dirname(fileURLToPath(import.meta.url));
const mcodexPath = join(testFileDir, "..", "scripts", "mcodex.js");

function captureWarnings(run: (warn: (message: string) => void) => string): {
	value: string;
	warnings: string[];
} {
	const warnings: string[] = [];
	const value = run((message) => warnings.push(message));
	return { value, warnings };
}

describe("mcodex monitor-interval hardening", () => {
	it("passes through a valid integer interval", () => {
		expect(resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "10" })).toBe("10");
	});

	it("passes through a valid fractional interval", () => {
		expect(resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "2.5" })).toBe("2.5");
	});

	it("falls back to 5 when unset or empty", () => {
		expect(resolveMonitorInterval({})).toBe("5");
		expect(resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "" })).toBe("5");
	});

	it("neutralizes a command-injection payload to the safe default", () => {
		const { value, warnings } = captureWarnings((warn) =>
			resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "5; touch PWNED" }, warn),
		);
		expect(value).toBe("5");
		expect(warnings.join("\n")).toMatch(/invalid MCODEX_MONITOR_INTERVAL/);
	});

	it("neutralizes shell metacharacters and substitutions", () => {
		expect(resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "$(echo evil)" }, () => {})).toBe("5");
		expect(resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "`id`" }, () => {})).toBe("5");
		expect(resolveMonitorInterval({ MCODEX_MONITOR_INTERVAL: "5 && rm -rf ~" }, () => {})).toBe("5");
	});
});

describe("mcodex tmux-history-limit hardening", () => {
	it("passes through a valid integer", () => {
		expect(resolveTmuxHistoryLimit({ MCODEX_TMUX_HISTORY_LIMIT: "12345" })).toBe("12345");
	});

	it("falls back to 50000 when unset or empty", () => {
		expect(resolveTmuxHistoryLimit({})).toBe("50000");
		expect(resolveTmuxHistoryLimit({ MCODEX_TMUX_HISTORY_LIMIT: "" })).toBe("50000");
	});

	it("rejects fractional and metacharacter values", () => {
		expect(resolveTmuxHistoryLimit({ MCODEX_TMUX_HISTORY_LIMIT: "2.5" }, () => {})).toBe("50000");
		const { value, warnings } = captureWarnings((warn) =>
			resolveTmuxHistoryLimit({ MCODEX_TMUX_HISTORY_LIMIT: "50000; rm -rf ~" }, warn),
		);
		expect(value).toBe("50000");
		expect(warnings.join("\n")).toMatch(/invalid MCODEX_TMUX_HISTORY_LIMIT/);
	});
});

describe("mcodex session + arg parsing", () => {
	it("defaults the tmux session and honors an override", () => {
		expect(resolveTmuxSession({})).toBe("mcodex");
		expect(resolveTmuxSession({ MCODEX_TMUX_SESSION: "work" })).toBe("work");
	});

	it("routes a plain invocation to the forward mode with all args", () => {
		const parsed = parseMcodexArgs(["exec", "--model", "gpt-5.3-codex"]);
		expect(parsed.mode).toBe("forward");
		expect(parsed.liveAccounts).toBe(false);
		expect(parsed.forwardArgs).toEqual(["exec", "--model", "gpt-5.3-codex"]);
	});

	it("parses --monitor with no passthrough args", () => {
		const parsed = parseMcodexArgs(["--monitor"]);
		expect(parsed.mode).toBe("monitor");
		expect(parsed.forwardArgs).toEqual([]);
	});

	it("parses --tmux and -t, consuming --live-accounts only after the flag", () => {
		const longForm = parseMcodexArgs(["--tmux", "--live-accounts", "exec"]);
		expect(longForm.mode).toBe("tmux");
		expect(longForm.liveAccounts).toBe(true);
		expect(longForm.forwardArgs).toEqual(["exec"]);

		const shortForm = parseMcodexArgs(["-t", "resume"]);
		expect(shortForm.mode).toBe("tmux");
		expect(shortForm.liveAccounts).toBe(false);
		expect(shortForm.forwardArgs).toEqual(["resume"]);
	});

	it("does not treat --live-accounts as a mode on its own", () => {
		const parsed = parseMcodexArgs(["--live-accounts"]);
		expect(parsed.mode).toBe("forward");
		expect(parsed.forwardArgs).toEqual(["--live-accounts"]);
	});
});

describe("mcodex ships as a node entry, not bash", () => {
	it("uses a node shebang so npm's Windows shim never invokes bash", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(mcodexPath, "utf8");
		expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
		expect(source).not.toContain("#!/usr/bin/env bash");
	});
});
