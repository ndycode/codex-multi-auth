import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseVerifyArgs,
	printVerifyUsage,
	runVerifyCommand,
	runVerifyPathsCheck,
	type VerifyCliOptions,
	type VerifyCommandDeps,
	type VerifyPathsDeps,
} from "../lib/codex-manager/commands/verify.js";
import { resolvePath } from "../lib/storage/paths.js";
import { setStoragePath } from "../lib/storage.js";

function makePathsDeps(
	overrides: Partial<VerifyPathsDeps> = {},
): VerifyPathsDeps {
	return {
		getCwd: vi.fn(() => "/mock/project"),
		findProjectRoot: vi.fn(() => "/mock/project"),
		resolveProjectStorageIdentityRoot: vi.fn(() => "/mock/project"),
		getProjectStorageKey: vi.fn(() => "project-abcdef123456"),
		getProjectConfigDir: vi.fn(() => "/mock/project/.codex"),
		getProjectGlobalConfigDir: vi.fn(() =>
			join(
				homedir(),
				".codex",
				"multi-auth",
				"projects",
				"project-abcdef123456",
			),
		),
		resolvePath: vi.fn((input: string) => {
			const lowered = input.toLowerCase();
			if (
				input.includes("etc/shadow") ||
				lowered.includes("system32") ||
				lowered.startsWith("\\\\?\\unc\\") ||
				lowered.startsWith("/etc/") ||
				lowered.includes("codex_multi_auth_sandbox_escape_probe") ||
				/^[yz]:[\\/]/i.test(input)
			) {
				throw new Error("Access denied: path must be within ...");
			}
			return input;
		}),
		...overrides,
	};
}

function createDeps(
	overrides: Partial<VerifyCommandDeps> = {},
): VerifyCommandDeps {
	return {
		parseVerifyArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad"))
				return { ok: false as const, message: "Unknown option: --bad" };
			const options: VerifyCliOptions = {
				json: args.includes("--json") || args.includes("-j"),
				paths: args.includes("--paths") || args.includes("--all"),
				flagged: args.includes("--flagged") || args.includes("--all"),
				all: args.includes("--all"),
			};
			return { ok: true as const, options };
		}),
		printVerifyUsage: vi.fn(),
		runVerifyFlagged: vi.fn(async () => 0),
		verifyPathsDeps: makePathsDeps(),
		logInfo: vi.fn(),
		logError: vi.fn(),
		...overrides,
	};
}

describe("runVerifyCommand", () => {
	it("prints usage on --help", async () => {
		const deps = createDeps();
		const result = await runVerifyCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printVerifyUsage).toHaveBeenCalled();
	});

	it("rejects unknown flag", async () => {
		const deps = createDeps();
		const result = await runVerifyCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("requires a mode flag", async () => {
		const deps = createDeps();
		const result = await runVerifyCommand([], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			expect.stringContaining("verify requires a mode"),
		);
	});

	it("runs --paths --json and emits report", async () => {
		const deps = createDeps();
		const result = await runVerifyCommand(["--paths", "--json"], deps);
		expect(result).toBe(0);
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls[0]?.[0] ?? ""),
		) as {
			command: string;
			ok: boolean;
			paths: {
				steps: Array<{ name: string; ok: boolean }>;
				sandboxTests: Array<{ name: string; ok: boolean }>;
			};
		};
		expect(payload.command).toBe("verify");
		expect(payload.ok).toBe(true);
		expect(payload.paths.steps.map((step) => step.name)).toEqual([
			"process.cwd",
			"findProjectRoot",
			"resolveProjectStorageIdentityRoot",
			"getProjectStorageKey",
			"getProjectConfigDir",
			"getProjectGlobalConfigDir",
		]);
		expect(
			payload.paths.sandboxTests.find(
				(test) => test.name === "sandbox-reject-escape",
			)?.ok,
		).toBe(true);
	});

	it("reports failure when resolvePath accepts an escape attempt", async () => {
		const pathsDeps = makePathsDeps({
			resolvePath: vi.fn((input: string) => input),
		});
		const deps = createDeps({ verifyPathsDeps: pathsDeps });
		const result = await runVerifyCommand(["--paths", "--json"], deps);
		expect(result).toBe(1);
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls[0]?.[0] ?? ""),
		) as {
			ok: boolean;
			paths: { sandboxTests: Array<{ name: string; ok: boolean }> };
		};
		expect(payload.ok).toBe(false);
		const rejectTest = payload.paths.sandboxTests.find(
			(test) => test.name === "sandbox-reject-escape",
		);
		expect(rejectTest?.ok).toBe(false);
	});

	it("delegates --flagged to runVerifyFlagged", async () => {
		const flaggedSpy = vi.fn(async () => 0);
		const deps = createDeps({ runVerifyFlagged: flaggedSpy });
		const result = await runVerifyCommand(["--flagged", "--json"], deps);
		expect(result).toBe(0);
		expect(flaggedSpy).toHaveBeenCalledTimes(1);
		expect(flaggedSpy.mock.calls[0]?.[0]).toEqual(["--json"]);
	});

	it("runs both paths and flagged under --all", async () => {
		const flaggedSpy = vi.fn(async () => 0);
		const deps = createDeps({ runVerifyFlagged: flaggedSpy });
		const result = await runVerifyCommand(["--all", "--json"], deps);
		expect(result).toBe(0);
		expect(flaggedSpy).toHaveBeenCalled();
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls.at(-1)?.[0] ?? ""),
		) as { mode: string; paths: unknown; flaggedExitCode: number };
		expect(payload.mode).toBe("all");
		expect(payload.flaggedExitCode).toBe(0);
		expect(payload.paths).toBeTruthy();
	});

	it("prints human-readable output when not in JSON mode", async () => {
		const deps = createDeps();
		const result = await runVerifyCommand(["--paths"], deps);
		expect(result).toBe(0);
		const logged = vi
			.mocked(deps.logInfo!)
			.mock.calls.map((call) => String(call[0]))
			.join("\n");
		expect(logged).toContain("verify --paths: OK");
		expect(logged).toContain("Path chain:");
		expect(logged).toContain("Sandbox tests:");
	});
});

describe("runVerifyPathsCheck", () => {
	it("records each step in order", () => {
		const deps = makePathsDeps();
		const report = runVerifyPathsCheck(deps);
		expect(report.ok).toBe(true);
		expect(report.steps.map((step) => step.name)).toEqual([
			"process.cwd",
			"findProjectRoot",
			"resolveProjectStorageIdentityRoot",
			"getProjectStorageKey",
			"getProjectConfigDir",
			"getProjectGlobalConfigDir",
		]);
	});

	it("records failure when findProjectRoot returns null", () => {
		const deps = makePathsDeps({ findProjectRoot: vi.fn(() => null) });
		const report = runVerifyPathsCheck(deps);
		expect(report.ok).toBe(false);
		const step = report.steps.find((s) => s.name === "findProjectRoot");
		expect(step?.ok).toBe(false);
	});

	it("records failure when resolveProjectStorageIdentityRoot throws", () => {
		const deps = makePathsDeps({
			resolveProjectStorageIdentityRoot: vi.fn(() => {
				throw new Error("boom");
			}),
		});
		const report = runVerifyPathsCheck(deps);
		expect(report.ok).toBe(false);
		const step = report.steps.find(
			(s) => s.name === "resolveProjectStorageIdentityRoot",
		);
		expect(step?.ok).toBe(false);
		expect(step?.error).toBe("boom");
	});
});

describe("parseVerifyArgs", () => {
	it("parses --paths", () => {
		const parsed = parseVerifyArgs(["--paths"]);
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.options.paths).toBe(true);
		expect(parsed.options.flagged).toBe(false);
	});

	it("parses --flagged", () => {
		const parsed = parseVerifyArgs(["--flagged"]);
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.options.flagged).toBe(true);
	});

	it("parses --all and sets both flags", () => {
		const parsed = parseVerifyArgs(["--all"]);
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.options.paths).toBe(true);
		expect(parsed.options.flagged).toBe(true);
		expect(parsed.options.all).toBe(true);
	});

	it("rejects unknown flag", () => {
		const parsed = parseVerifyArgs(["--wat"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toMatch(/unknown option/i);
	});

	it("rejects --paths combined with --flagged without --all", () => {
		const parsed = parseVerifyArgs(["--paths", "--flagged"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toMatch(/cannot be combined/i);
	});

	it("allows --all with extra passthrough flags", () => {
		const parsed = parseVerifyArgs(["--all", "--dry-run", "--no-restore"]);
		expect(parsed.ok).toBe(true);
	});
});

describe("printVerifyUsage", () => {
	it("logs usage", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printVerifyUsage();
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("sandbox-reject-escape probe with pathological cwd", () => {
	afterEach(() => {
		setStoragePath(null);
		vi.restoreAllMocks();
	});

	it("rejects the escape probe even when process.cwd() is the filesystem root", () => {
		// Reset storage state so resolvePath falls back to process.cwd() for
		// projectRoot, matching the production edge case the audit flagged.
		setStoragePath(null);

		const rootCwd = process.platform === "win32" ? "C:\\" : "/";
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(rootCwd);

		const deps: VerifyPathsDeps = {
			getCwd: () => rootCwd,
			findProjectRoot: () => rootCwd,
			resolveProjectStorageIdentityRoot: () => rootCwd,
			getProjectStorageKey: () => "project-rootcwd-probe",
			getProjectConfigDir: () => rootCwd,
			getProjectGlobalConfigDir: () =>
				join(homedir(), ".codex", "multi-auth", "projects", "root-probe"),
			// Delegate to the real resolvePath so we exercise the actual
			// sandbox gate instead of a test double.
			resolvePath,
		};

		const report = runVerifyPathsCheck(deps);

		const escapeTest = report.sandboxTests.find(
			(test) => test.name === "sandbox-reject-escape",
		);
		expect(escapeTest).toBeDefined();
		expect(escapeTest?.ok).toBe(true);

		cwdSpy.mockRestore();
	});
});
