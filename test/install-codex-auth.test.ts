import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = "scripts/install-codex-auth.js";
const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("install-codex-auth script", () => {
  it("uses lowercase config template filenames", () => {
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain('"codex-legacy.json"');
    expect(content).toContain('"codex-modern.json"');
    expect(content).not.toContain('"Codex-legacy.json"');
    expect(content).not.toContain('"Codex-modern.json"');
  });

	it("uses collision-resistant backup suffix", () => {
		const content = readFileSync(scriptPath, "utf8");
		expect(content).toContain("process.pid");
		expect(content).toContain("Math.random().toString(36)");
	});

	it("dry-run does not create global config on disk", () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-install-dryrun-"));
		tempRoots.push(home);
		const env = { ...process.env, HOME: home, USERPROFILE: home };

		const result = spawnSync(process.execPath, [scriptPath, "--dry-run", "--modern"], {
			env,
			encoding: "utf8",
			windowsHide: true,
		});

		expect(result.status).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("[dry-run]");
		const configPath = path.join(home, ".config", "Codex", "config.json");
		expect(existsSync(configPath)).toBe(false);
	});
});
