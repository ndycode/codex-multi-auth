import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	isDirectRunInvocation,
	parseMcodexArgs,
	relaySignalsToChild,
	resolveMonitorInterval,
	resolveTmuxHistoryLimit,
	resolveTmuxSession,
} from "../scripts/mcodex.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN", "ENOTEMPTY"]);
async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

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

describe("mcodex direct-run gate (isDirectRunInvocation)", () => {
	const selfUrl = pathToFileURL(mcodexPath).href;

	it("matches when invoked via the real script path", () => {
		expect(isDirectRunInvocation(mcodexPath, selfUrl)).toBe(true);
	});

	it("matches when invoked via a symlink to the script (npm-bin case)", async () => {
		// npm installs bins as symlinks. The gate must canonicalize both sides
		// (realpath) or the launcher silently no-ops when run through the link.
		const { mkdtemp, symlink } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const tmp = await mkdtemp(join(tmpdir(), "mcodex-link-"));
		const link = join(tmp, "mcodex");
		try {
			await symlink(mcodexPath, link);
			expect(isDirectRunInvocation(link, selfUrl)).toBe(true);
		} catch (err) {
			// Windows without symlink privilege (EPERM): skip rather than fail.
			if ((err as NodeJS.ErrnoException).code === "EPERM") return;
			throw err;
		} finally {
			await removeWithRetry(tmp, { recursive: true, force: true });
		}
	});

	it("does not match an unrelated invocation path", () => {
		expect(
			isDirectRunInvocation(join(dirname(mcodexPath), "codex.js"), selfUrl),
		).toBe(false);
	});

	it("returns false when argv[1] is absent (imported, not run)", () => {
		expect(isDirectRunInvocation(undefined, selfUrl)).toBe(false);
	});
});

describe("mcodex signal relay (relaySignalsToChild)", () => {
	// #15 regression: a SIGTERM to the launcher used to exit the parent without
	// killing the forwarded codex.js / watch child, orphaning it. The launcher now
	// relays terminating signals to the child and tears the handlers down on close.
	// A true cross-process SIGTERM test is unreliable on Windows (process.kill maps
	// to TerminateProcess and bypasses Node's signal handler), so assert the relay
	// wiring deterministically with an injected fake process + child.
	function makeFakeChild() {
		const kill = vi.fn();
		return { kill } as unknown as import("node:child_process").ChildProcess & {
			kill: ReturnType<typeof vi.fn>;
		};
	}

	it("forwards a received signal to the child via child.kill", () => {
		const proc = new EventEmitter();
		const child = makeFakeChild();
		relaySignalsToChild(child, { proc, signals: ["SIGTERM"] });

		expect(proc.listenerCount("SIGTERM")).toBe(1);
		proc.emit("SIGTERM");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("registers SIGTERM and SIGINT by default", () => {
		const proc = new EventEmitter();
		const child = makeFakeChild();
		relaySignalsToChild(child, { proc });

		expect(proc.listenerCount("SIGTERM")).toBe(1);
		expect(proc.listenerCount("SIGINT")).toBe(1);

		proc.emit("SIGINT");
		expect(child.kill).toHaveBeenCalledWith("SIGINT");
	});

	it("removes the relay handlers when cleanup runs (no leak past child close)", () => {
		const proc = new EventEmitter();
		const child = makeFakeChild();
		const removeSignalRelays = relaySignalsToChild(child, {
			proc,
			signals: ["SIGTERM", "SIGINT"],
		});

		removeSignalRelays();
		expect(proc.listenerCount("SIGTERM")).toBe(0);
		expect(proc.listenerCount("SIGINT")).toBe(0);

		// After cleanup a late signal must not reach an already-settled child.
		proc.emit("SIGTERM");
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("swallows a child.kill failure (child already exited)", () => {
		const proc = new EventEmitter();
		const kill = vi.fn(() => {
			throw new Error("ESRCH");
		});
		const child = { kill } as unknown as import("node:child_process").ChildProcess;
		relaySignalsToChild(child, { proc, signals: ["SIGTERM"] });

		expect(() => proc.emit("SIGTERM")).not.toThrow();
		expect(kill).toHaveBeenCalledWith("SIGTERM");
	});
});
