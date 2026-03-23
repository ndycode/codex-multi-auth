import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const tempRoots: string[] = [];

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			await removeWithRetry(root, { recursive: true, force: true });
		}
	}
});

describe("codex-multi-auth wrapper", () => {
	it("loads the built CLI entry and forwards args with package version env", () => {
		const root = mkdtempSync(path.join(tmpdir(), "codex-multi-auth-wrapper-"));
		tempRoots.push(root);
		const scriptsDir = path.join(root, "scripts");
		const distLibDir = path.join(root, "dist", "lib");
		mkdirSync(scriptsDir, { recursive: true });
		mkdirSync(distLibDir, { recursive: true });

		copyFileSync(
			path.join(process.cwd(), "scripts", "codex-multi-auth.js"),
			path.join(scriptsDir, "codex-multi-auth.js"),
		);
		writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ version: "9.9.9-test" }, null, 2),
			"utf8",
		);
		writeFileSync(
			path.join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli(args) {",
				"  console.log('version=' + process.env.CODEX_MULTI_AUTH_CLI_VERSION);",
				"  console.log('args=' + args.join(' '));",
				"  return 0;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = spawnSync(
			process.execPath,
			[path.join(scriptsDir, "codex-multi-auth.js"), "auth", "--help"],
			{ cwd: root, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("version=9.9.9-test");
		expect(result.stdout).toContain("args=auth --help");
		const scriptText = readFileSync(
			path.join(scriptsDir, "codex-multi-auth.js"),
			"utf8",
		);
		expect(scriptText).toContain("runCodexMultiAuthCli");
	});
});
