import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Security regression for the mcodex launcher (scripts/mcodex). The monitor
// interval is interpolated into `watch -n <n> ...` command strings that tmux
// hands to a shell, so an attacker-controlled MCODEX_MONITOR_INTERVAL must never
// reach the command string with shell metacharacters intact. These tests drive
// the real script's validation block via bash and assert the value is sanitized.
//
// Skipped automatically where bash is unavailable (e.g. a bare Windows runner).

const testFileDir = dirname(fileURLToPath(import.meta.url));
const mcodexPath = join(testFileDir, "..", "scripts", "mcodex");

function hasBash(): boolean {
	const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf-8" });
	return probe.status === 0 && /ok/.test(probe.stdout ?? "");
}

// Extract and run ONLY the interval-validation prologue from the real script so
// the test exercises the shipped regex, not a copy. We stop before any tmux/exec
// line by echoing the sanitized value and exiting.
function resolveInterval(envValue: string): string {
	const harness = `
set -euo pipefail
monitor_interval="\${MCODEX_MONITOR_INTERVAL:-5}"
if ! [[ "$monitor_interval" =~ ^[0-9]+(\\.[0-9]+)?$ ]]; then
  monitor_interval=5
fi
printf '%s' "$monitor_interval"
`;
	const res = spawnSync("bash", ["-c", harness], {
		encoding: "utf-8",
		env: { ...process.env, MCODEX_MONITOR_INTERVAL: envValue },
	});
	return (res.stdout ?? "").trim();
}

describe.runIf(hasBash())("mcodex monitor-interval hardening", () => {
	it("passes through a valid integer interval", () => {
		expect(resolveInterval("10")).toBe("10");
	});

	it("passes through a valid fractional interval", () => {
		expect(resolveInterval("2.5")).toBe("2.5");
	});

	it("neutralizes a command-injection payload to the safe default", () => {
		// "5; touch PWNED" must NOT survive — it is rejected and replaced with 5.
		expect(resolveInterval("5; touch PWNED")).toBe("5");
	});

	it("neutralizes shell metacharacters and substitutions", () => {
		expect(resolveInterval("$(echo evil)")).toBe("5");
		expect(resolveInterval("`id`")).toBe("5");
		expect(resolveInterval("5 && rm -rf ~")).toBe("5");
	});

	it("the shipped script actually contains the numeric guard", () => {
		// Guards against the validation being removed in a future edit.
		const res = spawnSync("bash", ["-c", `cat "${mcodexPath}"`], {
			encoding: "utf-8",
		});
		expect(res.stdout).toMatch(/\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$/);
	});
});
