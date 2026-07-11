import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());

function readWorkflow(name: string): string {
	// Normalize CRLF -> LF so the job-boundary matching in extractJobBlock works
	// on Windows checkouts (autocrlf), where the raw file uses `\r\n` and the
	// `:\n` boundary regex would otherwise never match, over-capturing to EOF.
	return readFileSync(join(projectRoot, ".github", "workflows", name), "utf-8").replace(
		/\r\n/g,
		"\n",
	);
}

function extractJobBlock(workflow: string, jobName: string): string {
	const start = workflow.indexOf(`  ${jobName}:`);
	if (start === -1) {
		throw new Error(`Missing workflow job: ${jobName}`);
	}
	const nextMatch = workflow
		.slice(start + 1)
		.match(/\n  [a-z0-9][a-z0-9-]*:\n/);
	const end = nextMatch ? start + 1 + nextMatch.index + 1 : workflow.length;
	return workflow.slice(start, end);
}

describe("CI workflow parity", () => {
	// Audit roadmap §4.4.1: ci.yml and pr-ci.yml were consolidated into a
	// single workflow. The old parity checks now assert the consolidated
	// workflow covers both events.
	it("is the single consolidated workflow (pr-ci.yml removed) covering push and PR", () => {
		const ci = readWorkflow("ci.yml");

		expect(existsSync(join(projectRoot, ".github", "workflows", "pr-ci.yml"))).toBe(
			false,
		);
		expect(ci).toContain("push:");
		expect(ci).toContain("pull_request:");
	});

	it("keeps the release harness checks for both push and PR runs", () => {
		const ci = readWorkflow("ci.yml");
		const requiredCommands = [
			"npm run typecheck:scripts",
			"npm run pack:check",
			"npm run vendor:verify",
		];

		const releaseHarnessJob = extractJobBlock(ci, "release-harness");
		const prValidationJob = extractJobBlock(ci, "validate");
		for (const command of requiredCommands) {
			expect(releaseHarnessJob).toContain(command);
			expect(prValidationJob).toContain(command);
		}
	});

	it("keeps stale-run cancellation across push and PR runs", () => {
		const ci = readWorkflow("ci.yml");

		expect(ci).toContain("concurrency:");
		expect(ci).toContain("cancel-in-progress: true");
		// PR runs must key the concurrency group on the PR number so pushes to
		// main never cancel (or get cancelled by) PR runs.
		expect(ci).toContain("github.event.pull_request.number || github.ref");
	});

	// tests-ci-05: PR CI must run coverage so the 80% threshold gates PRs, not
	// only the post-merge push-to-main run.
	it("runs coverage on PRs (not only push-to-main)", () => {
		const ci = readWorkflow("ci.yml");
		const prValidationJob = extractJobBlock(ci, "validate");

		expect(prValidationJob).toContain("github.event_name == 'pull_request'");
		expect(prValidationJob).toContain("npm run coverage");
	});

	it("keeps Windows script typecheck coverage", () => {
		const ci = readWorkflow("ci.yml");
		const windowsJob = extractJobBlock(ci, "scripts-windows");

		expect(windowsJob).toContain("runs-on: windows-latest");
		expect(windowsJob).toContain("npm run typecheck:scripts");
		// Not PR-gated: must run on push-to-main and on PRs alike.
		expect(windowsJob).not.toContain("github.event_name");
	});

	// Issue #523: validate the engines floor (node >=18) with a runtime smoke
	// job that installs the packed tarball on Node 18 without devDependencies.
	it("smoke-tests the packed CLI on the Node 18 engines floor", () => {
		const ci = readWorkflow("ci.yml");
		const builderJob = extractJobBlock(ci, "build-package");
		const smokeJob = extractJobBlock(ci, "node18-smoke");

		expect(builderJob).toContain("npm pack");
		expect(builderJob).toContain("actions/upload-artifact@");

		expect(smokeJob).toContain("needs: build-package");
		expect(smokeJob).toContain("node-version: 18.17.x");
		expect(smokeJob).toContain("actions/download-artifact@");
		expect(smokeJob).toContain("npm install -g ./codex-multi-auth-*.tgz");
		expect(smokeJob).toContain("codex-multi-auth --help");
		// The smoke job must exercise the published package, not the repo
		// working tree: no checkout and no devDependency install.
		expect(smokeJob).not.toContain("actions/checkout@");
		expect(smokeJob).not.toContain("npm ci");
	});
});
