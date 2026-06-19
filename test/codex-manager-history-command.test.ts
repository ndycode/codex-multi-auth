import { describe, expect, it, vi } from "vitest";
import {
	runHistoryCommand,
	type HistoryCommandDeps,
} from "../lib/codex-manager/commands/history.js";

const DIR = "/home/user/.codex/sessions";

function metaLine(
	overrides: Record<string, unknown> = {},
	timestamp = "2026-06-05T14:36:20.000Z",
): string {
	return JSON.stringify({
		timestamp,
		type: "session_meta",
		payload: {
			id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
			timestamp,
			cwd: "C:\\work\\project",
			originator: "Codex Desktop",
			cli_version: "0.140.0",
			model_provider: "openai",
			...overrides,
		},
	});
}

function userMessageLine(message: string): string {
	return JSON.stringify({
		timestamp: "2026-06-05T14:36:25.000Z",
		type: "event_msg",
		payload: { type: "user_message", message },
	});
}

interface FakeFile {
	id: string;
	content: string;
}

function rolloutPath(id: string): string {
	return `${DIR}/2026/06/05/rollout-2026-06-05T22-35-56-${id}.jsonl`;
}

function createDeps(
	files: FakeFile[],
	overrides: Partial<HistoryCommandDeps> = {},
): HistoryCommandDeps & {
	logInfo: ReturnType<typeof vi.fn>;
	logError: ReturnType<typeof vi.fn>;
} {
	const byPath = new Map<string, string>();
	for (const file of files) {
		byPath.set(rolloutPath(file.id), file.content);
	}
	const logInfo = vi.fn();
	const logError = vi.fn();
	return {
		getCodexHome: () => "/home/user/.codex",
		readDirRecursive: () => [...byPath.keys()],
		readFile: (path: string) => {
			const content = byPath.get(path);
			if (content === undefined) {
				throw new Error(`ENOENT: ${path}`);
			}
			return content;
		},
		statMtime: () => new Date("2026-01-01T00:00:00.000Z"),
		logInfo,
		logError,
		...overrides,
	};
}

function allOutput(logInfo: ReturnType<typeof vi.fn>): string {
	return logInfo.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("runHistoryCommand list", () => {
	it("lists sessions from every provider, not just the active one", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: [
					metaLine(
						{
							id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
							model_provider: "openai",
						},
						"2026-06-05T10:00:00.000Z",
					),
					userMessageLine("first openai task"),
				].join("\n"),
			},
			{
				id: "0190abcd-1234-7821-a9c2-3ffd26a11000",
				content: [
					metaLine(
						{
							id: "0190abcd-1234-7821-a9c2-3ffd26a11000",
							model_provider: "codex-multi-auth-runtime-proxy",
						},
						"2026-06-05T12:00:00.000Z",
					),
					userMessageLine("a rotated session"),
				].join("\n"),
			},
		]);

		const code = runHistoryCommand(["list"], deps);

		expect(code).toBe(0);
		const output = allOutput(deps.logInfo);
		expect(output).toContain("openai");
		expect(output).toContain("codex-multi-auth-runtime-proxy");
		expect(output).toContain("019e9836-5001-7821-a9c2-3ffd26a1199b");
		expect(output).toContain("0190abcd-1234-7821-a9c2-3ffd26a11000");
	});

	it("defaults to list when no subcommand is given", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: metaLine(),
			},
		]);

		const code = runHistoryCommand([], deps);

		expect(code).toBe(0);
		expect(allOutput(deps.logInfo)).toContain(
			"019e9836-5001-7821-a9c2-3ffd26a1199b",
		);
	});

	it("sorts most-recent first", () => {
		const deps = createDeps([
			{
				id: "00000000-0000-7821-a9c2-00000000aaaa",
				content: metaLine(
					{ id: "00000000-0000-7821-a9c2-00000000aaaa" },
					"2026-06-01T00:00:00.000Z",
				),
			},
			{
				id: "11111111-1111-7821-a9c2-11111111bbbb",
				content: metaLine(
					{ id: "11111111-1111-7821-a9c2-11111111bbbb" },
					"2026-06-10T00:00:00.000Z",
				),
			},
		]);

		const code = runHistoryCommand(["list", "--json"], deps);

		expect(code).toBe(0);
		const payload = JSON.parse(allOutput(deps.logInfo));
		expect(payload.count).toBe(2);
		expect(payload.sessions[0].id).toBe("11111111-1111-7821-a9c2-11111111bbbb");
		expect(payload.sessions[1].id).toBe("00000000-0000-7821-a9c2-00000000aaaa");
	});

	it("emits machine-readable JSON with provider field", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: metaLine({ model_provider: "codex-multi-auth-runtime-proxy" }),
			},
		]);

		const code = runHistoryCommand(["list", "--json"], deps);

		expect(code).toBe(0);
		const payload = JSON.parse(allOutput(deps.logInfo));
		expect(payload.count).toBe(1);
		expect(payload.sessions[0].provider).toBe(
			"codex-multi-auth-runtime-proxy",
		);
		// list summaries should not carry the heavier detail fields
		expect(payload.sessions[0].messages).toBeUndefined();
		expect(payload.sessions[0].cliVersion).toBeUndefined();
	});

	it("reports an empty listing without error when the sessions dir is missing", () => {
		const deps = createDeps([], { readDirRecursive: () => [] });

		const code = runHistoryCommand(["list"], deps);

		expect(code).toBe(0);
		expect(allOutput(deps.logInfo)).toContain("No local Codex sessions found");
	});

	it("treats a leading flag as a list arg (history --json with no explicit list)", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: metaLine(),
			},
		]);

		const code = runHistoryCommand(["--json"], deps);

		expect(code).toBe(0);
		expect(deps.logError).not.toHaveBeenCalled();
		const payload = JSON.parse(allOutput(deps.logInfo));
		expect(payload.count).toBe(1);
		expect(payload.sessions[0].id).toBe(
			"019e9836-5001-7821-a9c2-3ffd26a1199b",
		);
	});

	it("reports an empty listing when readDirRecursive throws (missing dir)", () => {
		// The default readDirRecursive swallows ENOENT internally, but an injected
		// one that throws must not crash the command — lock the failure path.
		const deps = createDeps([], {
			readDirRecursive: () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		});

		const code = runHistoryCommand(["list"], deps);

		expect(code).toBe(0);
		expect(allOutput(deps.logInfo)).toContain("No local Codex sessions found");
	});

	it("resolves the sessions dir from an overridden (Windows) codex home", () => {
		const sessionFile =
			"D:\\custom\\.codex\\sessions\\2026\\06\\05\\rollout-2026-06-05T22-35-56-019e9836-5001-7821-a9c2-3ffd26a1199b.jsonl";
		const seenDirs: string[] = [];
		const deps = createDeps([], {
			getCodexHome: () => "D:\\custom\\.codex",
			readDirRecursive: (dir: string) => {
				seenDirs.push(dir);
				return [sessionFile];
			},
			readFile: () => metaLine(),
		});

		const code = runHistoryCommand(["list", "--json"], deps);

		expect(code).toBe(0);
		// The command must look under <overridden-home>/sessions, not ~/.codex.
		expect(seenDirs).toContain("D:\\custom\\.codex\\sessions");
		const payload = JSON.parse(allOutput(deps.logInfo));
		expect(payload.count).toBe(1);
	});

	it("names the overridden home in the empty-listing message", () => {
		const deps = createDeps([], {
			getCodexHome: () => "D:\\custom\\.codex",
			readDirRecursive: () => [],
		});

		const code = runHistoryCommand(["list"], deps);

		expect(code).toBe(0);
		expect(allOutput(deps.logInfo)).toContain("D:\\custom\\.codex");
	});

	it("tolerates malformed JSONL lines without dropping the session", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: [
					"{ this is not valid json",
					metaLine(),
					"",
					"another broken line }",
					userMessageLine("still parsed"),
				].join("\n"),
			},
		]);

		const code = runHistoryCommand(["list", "--json"], deps);

		expect(code).toBe(0);
		const payload = JSON.parse(allOutput(deps.logInfo));
		expect(payload.count).toBe(1);
		expect(payload.sessions[0].id).toBe(
			"019e9836-5001-7821-a9c2-3ffd26a1199b",
		);
	});

	it("skips rollout files that never declare session_meta", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: userMessageLine("orphan message with no meta"),
			},
		]);

		const code = runHistoryCommand(["list", "--json"], deps);

		expect(code).toBe(0);
		const payload = JSON.parse(allOutput(deps.logInfo));
		expect(payload.count).toBe(0);
	});
});

describe("runHistoryCommand show", () => {
	it("shows provider metadata and first user messages", () => {
		const deps = createDeps([
			{
				id: "019e9836-5001-7821-a9c2-3ffd26a1199b",
				content: [
					metaLine({ model_provider: "openai" }),
					userMessageLine("message one"),
					userMessageLine("message two"),
					userMessageLine("message three"),
					userMessageLine("message four should be trimmed"),
				].join("\n"),
			},
		]);

		const code = runHistoryCommand(
			["show", "019e9836-5001-7821-a9c2-3ffd26a1199b"],
			deps,
		);

		expect(code).toBe(0);
		const output = allOutput(deps.logInfo);
		expect(output).toContain("provider:   openai");
		expect(output).toContain("message one");
		expect(output).toContain("message three");
		expect(output).not.toContain("message four should be trimmed");
	});

	it("returns an error when the session id is unknown", () => {
		const deps = createDeps([
			{ id: "019e9836-5001-7821-a9c2-3ffd26a1199b", content: metaLine() },
		]);

		const code = runHistoryCommand(["show", "does-not-exist"], deps);

		expect(code).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Session not found: does-not-exist",
		);
	});

	it("returns an error when no session id is supplied", () => {
		const deps = createDeps([]);

		const code = runHistoryCommand(["show"], deps);

		expect(code).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Missing session id. Usage: codex-multi-auth history show <session-id> [--json]",
		);
	});
});

describe("runHistoryCommand routing", () => {
	it("rejects an unknown subcommand", () => {
		const deps = createDeps([]);

		const code = runHistoryCommand(["bogus"], deps);

		expect(code).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Unknown history command: bogus",
		);
	});

	it("prints usage for --help", () => {
		const deps = createDeps([]);

		const code = runHistoryCommand(["--help"], deps);

		expect(code).toBe(0);
		expect(allOutput(deps.logInfo)).toContain(
			"Usage: codex-multi-auth history",
		);
	});
});
