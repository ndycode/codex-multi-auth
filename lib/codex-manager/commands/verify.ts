import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface VerifyCliOptions {
	json: boolean;
	paths: boolean;
	flagged: boolean;
	all: boolean;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

export interface VerifyPathStep {
	name: string;
	input?: string;
	output?: string;
	ok: boolean;
	error?: string;
}

export interface VerifySandboxResult {
	name: string;
	input: string;
	rejected: boolean;
	ok: boolean;
	error?: string;
}

export interface VerifyPathsReport {
	command: "verify";
	mode: "paths";
	ok: boolean;
	steps: VerifyPathStep[];
	sandboxTests: VerifySandboxResult[];
}

export interface VerifyPathsDeps {
	getCwd: () => string;
	findProjectRoot: (startDir: string) => string | null;
	resolveProjectStorageIdentityRoot: (projectRoot: string) => string;
	getProjectStorageKey: (projectPath: string) => string;
	getProjectConfigDir: (projectPath: string) => string;
	getProjectGlobalConfigDir: (projectPath: string) => string;
	resolvePath: (input: string) => string;
}

export interface VerifyCommandDeps {
	parseVerifyArgs: (args: string[]) => ParsedArgsResult<VerifyCliOptions>;
	printVerifyUsage: () => void;
	runVerifyPaths?: (deps: VerifyPathsDeps) => VerifyPathsReport;
	runVerifyFlagged?: (args: string[]) => Promise<number>;
	verifyPathsDeps: VerifyPathsDeps;
	setStoragePath?: (path: string | null) => void;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

export function runVerifyPathsCheck(deps: VerifyPathsDeps): VerifyPathsReport {
	const steps: VerifyPathStep[] = [];
	const record = (
		name: string,
		input: string | undefined,
		fn: () => string,
	): string | undefined => {
		try {
			const output = fn();
			steps.push({
				name,
				input,
				output,
				ok: true,
			});
			return output;
		} catch (error) {
			steps.push({
				name,
				input,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	};

	const cwd = record("process.cwd", undefined, () => deps.getCwd());
	let projectRoot: string | undefined;
	if (cwd) {
		const result = deps.findProjectRoot(cwd);
		if (result) {
			projectRoot = result;
			steps.push({
				name: "findProjectRoot",
				input: cwd,
				output: projectRoot,
				ok: true,
			});
		} else {
			steps.push({
				name: "findProjectRoot",
				input: cwd,
				ok: false,
				error: "no project root detected from cwd",
			});
		}
	}

	let identityRoot: string | undefined;
	if (projectRoot) {
		identityRoot = record(
			"resolveProjectStorageIdentityRoot",
			projectRoot,
			() => deps.resolveProjectStorageIdentityRoot(projectRoot),
		);
	}

	const keyInput = identityRoot ?? projectRoot;
	let storageKey: string | undefined;
	if (keyInput) {
		storageKey = record("getProjectStorageKey", keyInput, () =>
			deps.getProjectStorageKey(keyInput),
		);
	}

	if (keyInput) {
		record("getProjectConfigDir", keyInput, () =>
			deps.getProjectConfigDir(keyInput),
		);
		record("getProjectGlobalConfigDir", keyInput, () =>
			deps.getProjectGlobalConfigDir(keyInput),
		);
	}

	const sandboxTests = runSandboxTests(deps);
	const ok =
		steps.every((step) => step.ok) &&
		sandboxTests.every((test) => test.ok) &&
		typeof storageKey === "string" &&
		storageKey.length > 0;

	return {
		command: "verify",
		mode: "paths",
		ok,
		steps,
		sandboxTests,
	};
}

function normalizeForCompare(p: string): string {
	const abs = resolve(p);
	return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function isWithinBase(baseDir: string, targetPath: string): boolean {
	const base = normalizeForCompare(baseDir);
	const target = normalizeForCompare(targetPath);
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Pick an absolute path guaranteed to be outside the three sandbox roots
 * (homedir, tmpdir, and projectRoot as detected by resolvePath's state).
 *
 * resolvePath falls back to process.cwd() when no projectRoot is set, so when
 * the caller ran `codex auth verify --paths` from `/` or any ancestor of the
 * probe target, a naive `/etc/shadow` probe reports sandbox-broken even though
 * the sandbox is working as designed. This helper builds candidates on Windows
 * (nonexistent drive letter) or POSIX (synthetic root directory) and verifies
 * they are genuinely outside every base before returning.
 *
 * Returns null when no safe candidate is available (e.g. homedir or tmpdir is
 * literally the filesystem root on a malformed system); callers treat a null
 * as "skip the escape probe" rather than a spurious failure.
 */
function pickEscapeProbePath(projectRoot: string): string | null {
	const tag = `codex_multi_auth_sandbox_escape_probe_${process.pid}`;
	const candidates: string[] =
		process.platform === "win32"
			? [
					`Z:\\__${tag}__`,
					`Y:\\__${tag}__`,
					`\\\\?\\UNC\\server-that-does-not-exist\\share\\${tag}`,
				]
			: [`/__${tag}__`, `/var/__${tag}__`, `/opt/__${tag}__`];

	for (const candidate of candidates) {
		if (
			!isWithinBase(homedir(), candidate) &&
			!isWithinBase(tmpdir(), candidate) &&
			!isWithinBase(projectRoot, candidate)
		) {
			return candidate;
		}
	}

	return null;
}

function runSandboxTests(deps: VerifyPathsDeps): VerifySandboxResult[] {
	const results: VerifySandboxResult[] = [];

	const insideHome = join(homedir(), ".codex", "multi-auth-verify-probe");
	try {
		const resolved = deps.resolvePath(insideHome);
		results.push({
			name: "sandbox-accept-home",
			input: insideHome,
			rejected: false,
			ok: resolved.length > 0,
		});
	} catch (error) {
		results.push({
			name: "sandbox-accept-home",
			input: insideHome,
			rejected: true,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const insideTmp = join(tmpdir(), "codex-multi-auth-verify-probe.tmp");
	try {
		const resolved = deps.resolvePath(insideTmp);
		results.push({
			name: "sandbox-accept-tmp",
			input: insideTmp,
			rejected: false,
			ok: resolved.length > 0,
		});
	} catch (error) {
		results.push({
			name: "sandbox-accept-tmp",
			input: insideTmp,
			rejected: true,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const projectRoot = deps.getCwd();
	const escapeAttempt = pickEscapeProbePath(projectRoot);
	if (escapeAttempt === null) {
		results.push({
			name: "sandbox-reject-escape",
			input: "",
			rejected: false,
			ok: true,
			error:
				"skipped: no candidate outside home/tmp/project could be constructed",
		});
		return results;
	}

	try {
		deps.resolvePath(escapeAttempt);
		results.push({
			name: "sandbox-reject-escape",
			input: escapeAttempt,
			rejected: false,
			ok: false,
			error: "resolvePath accepted a sandbox-escape candidate",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const looksLikeSandboxRejection = /access denied/i.test(message);
		results.push({
			name: "sandbox-reject-escape",
			input: escapeAttempt,
			rejected: true,
			ok: looksLikeSandboxRejection,
			error: looksLikeSandboxRejection ? undefined : message,
		});
	}

	return results;
}

export async function runVerifyCommand(
	args: string[],
	deps: VerifyCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;

	if (args.includes("--help") || args.includes("-h")) {
		deps.printVerifyUsage();
		return 0;
	}

	const parsed = deps.parseVerifyArgs(args);
	if (!parsed.ok) {
		logError(parsed.message);
		deps.printVerifyUsage();
		return 1;
	}
	const options = parsed.options;

	if (!options.paths && !options.flagged) {
		logError(
			"verify requires a mode: --paths (path chain self-test), --flagged (verify flagged accounts), or --all",
		);
		deps.printVerifyUsage();
		return 1;
	}

	const runner = deps.runVerifyPaths ?? runVerifyPathsCheck;
	let pathsReport: VerifyPathsReport | null = null;
	if (options.paths) {
		// Reset storage-path state so the sandbox probe and path-chain steps
		// run against a clean baseline, matching the convention used by
		// why-selected, verify-flagged, doctor, fix, and the other command
		// handlers (see lib/codex-manager/commands/*.ts setStoragePath(null)).
		if (deps.setStoragePath) {
			deps.setStoragePath(null);
		}
		pathsReport = runner(deps.verifyPathsDeps);
	}

	let flaggedExitCode: number | null = null;
	if (options.flagged) {
		if (!deps.runVerifyFlagged) {
			logError("verify --flagged delegation is not available");
			return 1;
		}
		const passthrough = args.filter(
			(arg) => arg !== "--flagged" && arg !== "--paths" && arg !== "--all",
		);
		flaggedExitCode = await deps.runVerifyFlagged(passthrough);
	}

	const pathsOk = pathsReport ? pathsReport.ok : true;
	const flaggedOk = flaggedExitCode === null || flaggedExitCode === 0;
	const overallOk = pathsOk && flaggedOk;

	if (options.json) {
		const payload: Record<string, unknown> = {
			command: "verify",
			mode: options.all ? "all" : options.paths ? "paths" : "flagged",
			ok: overallOk,
		};
		if (pathsReport) payload.paths = pathsReport;
		if (flaggedExitCode !== null) payload.flaggedExitCode = flaggedExitCode;
		logInfo(JSON.stringify(payload, null, 2));
		return overallOk ? 0 : 1;
	}

	if (!pathsReport) {
		return overallOk ? 0 : 1;
	}

	const report = pathsReport;
	logInfo(`verify --paths: ${report.ok ? "OK" : "FAIL"}`);
	logInfo("");
	logInfo("Path chain:");
	for (const step of report.steps) {
		const marker = step.ok ? "✓" : "✗";
		const details = step.ok
			? ` → ${step.output ?? ""}`
			: ` error: ${step.error ?? "unknown"}`;
		const input = step.input ? ` (in: ${step.input})` : "";
		logInfo(`  ${marker} ${step.name}${input}${details}`);
	}
	logInfo("");
	logInfo("Sandbox tests:");
	for (const test of report.sandboxTests) {
		const marker = test.ok ? "✓" : "✗";
		const rejectedLabel = test.rejected ? "rejected" : "accepted";
		logInfo(
			`  ${marker} ${test.name} (${rejectedLabel}): ${test.error ?? "ok"}`,
		);
	}

	return overallOk ? 0 : 1;
}

export function parseVerifyArgs(
	args: string[],
): ParsedArgsResult<VerifyCliOptions> {
	const options: VerifyCliOptions = {
		json: false,
		paths: false,
		flagged: false,
		all: false,
	};
	let pathsExplicit = false;
	let flaggedExplicit = false;
	for (const arg of args) {
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--paths") {
			options.paths = true;
			pathsExplicit = true;
			continue;
		}
		if (arg === "--flagged") {
			options.flagged = true;
			flaggedExplicit = true;
			continue;
		}
		if (arg === "--all") {
			options.paths = true;
			options.flagged = true;
			options.all = true;
			continue;
		}
		if (arg === "--dry-run" || arg === "-n" || arg === "--no-restore") {
			// Passed through to verify-flagged when --flagged or --all is used.
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}
	if (pathsExplicit && flaggedExplicit && !options.all) {
		return {
			ok: false,
			message:
				"--paths and --flagged cannot be combined; use --all to run both, or pick one",
		};
	}
	return { ok: true, options };
}

export function printVerifyUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth verify --paths [--json]",
			"  codex auth verify --flagged [--json] [--dry-run] [--no-restore]",
			"",
			"Options:",
			"  --paths           Self-test storage path resolution chain and resolvePath sandbox",
			"  --flagged         Verify previously-flagged accounts (delegates to verify-flagged)",
			"  --json, -j        Print machine-readable JSON output",
			"",
			"Notes:",
			"  - `codex auth verify-flagged` remains available as a back-compat alias.",
			"  - `--paths` and `--flagged` cannot be combined; use `verify-flagged` when you only need flagged checks.",
		].join("\n"),
	);
}
