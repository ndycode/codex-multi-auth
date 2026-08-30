import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());

/** A ci.yml step reduced to what the ordering guards need to reason about. */
interface WorkflowStep {
	run: string;
	conditional: boolean;
}

function readWorkflow(name: string): string {
	// Normalize CRLF -> LF so the job-boundary matching in extractJobBlock works
	// on Windows checkouts (autocrlf), where the raw file uses `\r\n` and the
	// `:\n` boundary regex would otherwise never match, over-capturing to EOF.
	return readFileSync(
		join(projectRoot, ".github", "workflows", name),
		"utf-8",
	).replace(/\r\n/g, "\n");
}

function readPackageScripts(): Record<string, string> {
	const raw = readFileSync(join(projectRoot, "package.json"), "utf-8");
	const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
	return parsed.scripts ?? {};
}

// A top-level job key: exactly two spaces of indent, then a bare `name:` with
// nothing after it but an optional comment. Underscores and uppercase are legal
// in GitHub job ids, so the character class must accept them — a narrower class
// silently runs past the boundary and makes every extracted block over-capture
// into the following jobs.
const JOB_KEY_PATTERN = /\n {2}([A-Za-z0-9_][\w-]*):[ \t]*(?:#[^\n]*)?\n/;

function listJobs(workflow: string): string[] {
	const jobsAt = workflow.indexOf("\njobs:\n");
	const body = jobsAt === -1 ? workflow : workflow.slice(jobsAt);
	const scanner = new RegExp(JOB_KEY_PATTERN.source, "g");
	const names: string[] = [];
	let match = scanner.exec(body);
	while (match !== null) {
		const name = match[1];
		if (name !== undefined) {
			names.push(name);
		}
		// Rewind over the trailing newline the match consumed, so two job keys
		// on consecutive lines are both found.
		scanner.lastIndex = Math.max(scanner.lastIndex - 1, match.index + 1);
		match = scanner.exec(body);
	}
	return names;
}

function extractJobBlock(workflow: string, jobName: string): string {
	const start = workflow.indexOf(`\n  ${jobName}:`);
	if (start === -1) {
		throw new Error(`Missing workflow job: ${jobName}`);
	}
	const rest = workflow.slice(start + 1);
	const nextAt = rest.search(JOB_KEY_PATTERN);
	return nextAt === -1 ? rest : rest.slice(0, nextAt + 1);
}

/**
 * Pull the `run:` payload out of a single step, covering both the inline form
 * (`run: npm run build`) and the block-scalar form (`run: |` plus indented
 * lines). Anchoring on the YAML key position is what makes this immune to
 * commented-out steps and to command text that merely appears inside another
 * step's heredoc — a plain substring search treats both as a real build.
 */
function extractRun(step: string): string {
	const block = step.match(
		/^(?: {6}- | {8})run: [|>][-+]?[ \t]*\n((?: {10}[^\n]*(?:\n|$))*)/m,
	);
	if (block) {
		return block[1] ?? "";
	}
	const inline = step.match(/^(?: {6}- | {8})run:[ \t]+([^\n]*)$/m);
	return inline?.[1] ?? "";
}

function extractSteps(jobBlock: string): WorkflowStep[] {
	const stepsAt = jobBlock.search(/\n {4}steps:[ \t]*\n/);
	if (stepsAt === -1) {
		return [];
	}
	return jobBlock
		.slice(stepsAt)
		.split(/\n {6}- /)
		.slice(1)
		.map((chunk) => {
			const step = `      - ${chunk}`;
			return {
				run: extractRun(step),
				// A step guarded by `if:` may be skipped at runtime, so it cannot
				// be counted on to have produced dist for a later step.
				conditional: /^ {8}if:/m.test(step),
			};
		});
}

function buildsGeneratedDist(command: string): boolean {
	return /(?:^|&&|\|\||;)\s*npm run build\b/.test(command);
}

describe("CI workflow parity", () => {
	// Audit roadmap §4.4.1: ci.yml and pr-ci.yml were consolidated into a
	// single workflow. The old parity checks now assert the consolidated
	// workflow covers both events.
	it("is the single consolidated workflow (pr-ci.yml removed) covering push and PR", () => {
		const ci = readWorkflow("ci.yml");

		expect(
			existsSync(join(projectRoot, ".github", "workflows", "pr-ci.yml")),
		).toBe(false);
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

	// scripts/codex-multi-auth.js dynamically imports ../dist/lib/codex-manager.js
	// and tsconfig.scripts.json typechecks it with checkJs, so `typecheck:scripts`
	// fails with TS2307 whenever dist has not been generated. The build belongs in
	// the script itself rather than in individual CI steps: that covers CI jobs,
	// clean local checkouts and git hooks in one place, and it matches every other
	// dist-dependent script here (pack:check, coverage, bench:runtime-path,
	// generate:schema all start with `npm run build &&`).
	it("builds generated dist inside the typecheck:scripts script", () => {
		const scripts = readPackageScripts();
		const typecheckScripts = scripts["typecheck:scripts"] ?? "";

		expect(typecheckScripts).toContain("tsc -p tsconfig.scripts.json");
		expect(
			buildsGeneratedDist(typecheckScripts),
			"typecheck:scripts must build generated dist before running tsc",
		).toBe(true);
	});

	// Backstop for the guard above, derived over every job rather than a fixed
	// list, so a new job (or a reordered `validate`) is covered automatically.
	// While typecheck:scripts self-builds this holds trivially; it becomes the
	// load-bearing check the moment that build is removed from the script.
	it("guarantees generated dist at every ci.yml script typecheck call site", () => {
		const ci = readWorkflow("ci.yml");
		const selfBuilds = buildsGeneratedDist(
			readPackageScripts()["typecheck:scripts"] ?? "",
		);

		let callSites = 0;
		for (const jobName of listJobs(ci)) {
			const steps = extractSteps(extractJobBlock(ci, jobName));
			const typecheckAt = steps.findIndex((step) =>
				step.run.includes("npm run typecheck:scripts"),
			);
			if (typecheckAt === -1) {
				continue;
			}
			callSites += 1;
			if (selfBuilds) {
				continue;
			}
			const builtEarlier = steps
				.slice(0, typecheckAt)
				.some((step) => !step.conditional && buildsGeneratedDist(step.run));
			expect(
				builtEarlier,
				`${jobName}: typecheck:scripts runs without a preceding unconditional build`,
			).toBe(true);
		}

		// Proves the parser actually reached the call sites: release-harness,
		// scripts-windows and validate. Without this, a boundary or step-parsing
		// regression would make the loop above silently vacuous.
		expect(
			callSites,
			"expected at least three typecheck:scripts call sites in ci.yml",
		).toBeGreaterThanOrEqual(3);
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
