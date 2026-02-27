import { afterEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";

const scriptPath = path.resolve(process.cwd(), "scripts", "repo-hygiene.js");
const requiredGitignore = [
	"tmp",
	".tmp",
	"coverage/",
	"dist/",
	"node_modules/",
	".omx/",
	".opencode/",
	".sisyphus/",
	"task_plan.md",
	"findings.md",
	"progress.md",
	"test-results.md",
].join("\n");

function runRepoHygiene(args: string[]) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		encoding: "utf-8",
	});
}

function makeRepoFixture() {
	const root = mkdtempSync(path.join(tmpdir(), "repo-hygiene-"));
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	return root;
}

describe("repo-hygiene script", () => {
	let fixtureRoot: string | null = null;

	afterEach(async () => {
		if (!fixtureRoot) {
			return;
		}
		await fs.rm(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = null;
	});

	it("supports dry-run cleanup without deleting files", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), requiredGitignore);
		await fs.writeFile(path.join(root, ".tmp-audit.json"), "{}");

		const result = runRepoHygiene(["clean", "--mode", "aggressive", "--root", root, "--dry-run"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("[dry-run] delete .tmp-audit.json");

		await expect(fs.stat(path.join(root, ".tmp-audit.json"))).resolves.toBeDefined();
	});

	it("cleans allowlisted root trash while preserving source directories", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), requiredGitignore);
		await fs.mkdir(path.join(root, "lib"), { recursive: true });
		await fs.writeFile(path.join(root, "lib", "keep.ts"), "export const keep = true;\n");
		await fs.mkdir(path.join(root, "test", "tmp"), { recursive: true });
		await fs.writeFile(path.join(root, "test", "tmp", "dummy.json"), "{}");
		await fs.mkdir(path.join(root, "coverage"), { recursive: true });
		await fs.writeFile(path.join(root, "coverage", "index.html"), "coverage");
		await fs.writeFile(path.join(root, "tmp-pr4-unresolved-audit.txt"), "trash");

		const result = runRepoHygiene(["clean", "--mode", "aggressive", "--root", root]);
		expect(result.status).toBe(0);

		await expect(fs.stat(path.join(root, "lib", "keep.ts"))).resolves.toBeDefined();
		await expect(fs.stat(path.join(root, "coverage"))).rejects.toThrow();
		await expect(fs.stat(path.join(root, "tmp-pr4-unresolved-audit.txt"))).rejects.toThrow();
		await expect(fs.stat(path.join(root, "test", "tmp"))).rejects.toThrow();
	});

	it("fails check when tracked scratch files are committed", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), requiredGitignore);
		await fs.writeFile(path.join(root, "task_plan.md"), "temp plan\n");
		execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["add", "-f", "task_plan.md"], { cwd: root, stdio: "ignore" });

		const result = runRepoHygiene(["check", "--root", root]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("tracked scratch files present");
		expect(result.stderr).toContain("task_plan.md");
	});

	it("fails check when required .gitignore patterns are missing", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");

		const result = runRepoHygiene(["check", "--root", root]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("missing required .gitignore patterns");
	});

	it("passes check for clean repo fixtures", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), requiredGitignore);
		execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "ignore" });

		const result = runRepoHygiene(["check", "--root", root]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("repo-hygiene check passed");
	});

	it("handles CRLF git ls-files output in tracked scratch detection", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), requiredGitignore.replaceAll("\n", "\r\n"));
		await fs.writeFile(path.join(root, "task_plan.md"), "temp plan\r\n");
		execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["add", "-f", "task_plan.md"], { cwd: root, stdio: "ignore" });

		const result = runRepoHygiene(["check", "--root", root]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("task_plan.md");
	});

	it("fails check when git is unavailable for ls-files", async () => {
		fixtureRoot = makeRepoFixture();
		const root = fixtureRoot;
		await fs.writeFile(path.join(root, ".gitignore"), requiredGitignore);

		const originalPath = process.env.PATH ?? "";
		process.env.PATH = "";
		const result = runRepoHygiene(["check", "--root", root]);
		process.env.PATH = originalPath;

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("git ls-files failed in getTrackedPaths");
	});
});
