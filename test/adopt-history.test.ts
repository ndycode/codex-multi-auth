import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adoptHistoryInternals,
	rolloutMetaParses,
	runAdoptHistory,
} from "../lib/codex-manager/commands/adopt-history.js";
import { RUNTIME_ROTATION_PROXY_PROVIDER_ID } from "../lib/runtime-constants.js";

const PROXY = RUNTIME_ROTATION_PROXY_PROVIDER_ID;
const NATIVE = adoptHistoryInternals.NATIVE_PROVIDER_ID;

const originalMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;

let codexHome: string;
let multiAuthDir: string;
let logs: string[];
let errors: string[];

function rolloutLine(provider: string, id: string): string {
	return `${JSON.stringify({
		timestamp: "2026-06-11T00:00:00.000Z",
		type: "session_meta",
		payload: { id, cwd: "/tmp/project", model_provider: provider },
	})}\n${JSON.stringify({ type: "turn", payload: { text: "hello" } })}\n`;
}

async function seedRollout(
	relativeDir: string,
	name: string,
	provider: string,
): Promise<string> {
	const dir = join(codexHome, "sessions", relativeDir);
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, rolloutLine(provider, name), "utf8");
	return file;
}

function deps(overrides: Parameters<typeof runAdoptHistory>[1] = {}) {
	return {
		resolveCodexHome: () => codexHome,
		isInteractive: () => false,
		logInfo: (message: string) => logs.push(message),
		logError: (message: string) => errors.push(message),
		...overrides,
	};
}

beforeEach(async () => {
	codexHome = await mkdtemp(join(tmpdir(), "adopt-history-home-"));
	multiAuthDir = await mkdtemp(join(tmpdir(), "adopt-history-data-"));
	process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
	logs = [];
	errors = [];
});

afterEach(async () => {
	if (originalMultiAuthDir === undefined) {
		delete process.env.CODEX_MULTI_AUTH_DIR;
	} else {
		process.env.CODEX_MULTI_AUTH_DIR = originalMultiAuthDir;
	}
	await rm(codexHome, { recursive: true, force: true });
	await rm(multiAuthDir, { recursive: true, force: true });
});

describe("rotation adopt-history", () => {
	it("reports matches in --dry-run without modifying files", async () => {
		const native = await seedRollout("2026/06/11", "rollout-a.jsonl", NATIVE);
		await seedRollout("2026/06/11", "rollout-b.jsonl", PROXY);
		const before = await readFile(native, "utf8");

		const code = await runAdoptHistory(["--dry-run"], deps());

		expect(code).toBe(0);
		expect(await readFile(native, "utf8")).toBe(before);
		expect(logs.join("\n")).toContain("1 of 2 session file(s)");
	});

	it("refuses to rewrite non-interactively without --yes", async () => {
		await seedRollout("2026/06/11", "rollout-a.jsonl", NATIVE);

		const code = await runAdoptHistory([], deps());

		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("--yes");
	});

	it("rewrites session files and the thread index with --yes", async () => {
		const native = await seedRollout("2026/06/11", "rollout-a.jsonl", NATIVE);
		const nested = await seedRollout("2026/06/12", "rollout-b.jsonl", NATIVE);
		await writeFile(join(codexHome, "state_5.sqlite"), "", "utf8");
		const sqlCalls: string[] = [];

		const code = await runAdoptHistory(
			["--yes"],
			deps({
				runSqlite: (dbPath, sql) => {
					sqlCalls.push(`${dbPath}::${sql}`);
					return Promise.resolve(sql.startsWith("SELECT COUNT") ? "3" : "3");
				},
			}),
		);

		expect(code).toBe(0);
		for (const file of [native, nested]) {
			const content = await readFile(file, "utf8");
			expect(content).toContain(`"model_provider":"${PROXY}"`);
			expect(content).not.toContain(`"model_provider":"${NATIVE}"`);
			expect(await rolloutMetaParses(file)).toBe(true);
		}
		expect(sqlCalls.some((call) => call.includes("UPDATE threads"))).toBe(true);
		const manifest = JSON.parse(
			await readFile(join(multiAuthDir, "history-adopt-manifest.json"), "utf8"),
		) as { direction: string; files: string[] };
		expect(manifest.direction).toBe("adopt");
		expect(manifest.files).toHaveLength(2);
	});

	it("restores native markers with --reverse", async () => {
		const file = await seedRollout("2026/06/11", "rollout-a.jsonl", PROXY);

		const code = await runAdoptHistory(["--reverse", "--yes"], deps());

		expect(code).toBe(0);
		const content = await readFile(file, "utf8");
		expect(content).toContain(`"model_provider":"${NATIVE}"`);
		expect(content).not.toContain(`"model_provider":"${PROXY}"`);
	});

	it("aborts without changes when the confirmation is declined", async () => {
		const file = await seedRollout("2026/06/11", "rollout-a.jsonl", NATIVE);
		const before = await readFile(file, "utf8");

		const code = await runAdoptHistory(
			[],
			deps({
				isInteractive: () => true,
				confirm: () => Promise.resolve(false),
			}),
		);

		expect(code).toBe(0);
		expect(await readFile(file, "utf8")).toBe(before);
		expect(logs.join("\n")).toContain("Aborted");
	});

	it("still rewrites files and prints manual SQL when sqlite3 is unavailable", async () => {
		const file = await seedRollout("2026/06/11", "rollout-a.jsonl", NATIVE);
		await writeFile(join(codexHome, "state_5.sqlite"), "", "utf8");

		const code = await runAdoptHistory(
			["--yes"],
			deps({
				runSqlite: () => Promise.reject(new Error("sqlite3 not found")),
			}),
		);

		expect(code).toBe(0);
		expect(await readFile(file, "utf8")).toContain(
			`"model_provider":"${PROXY}"`,
		);
		expect(logs.join("\n")).toContain("UPDATE threads SET model_provider");
	});

	it("rejects unknown options", async () => {
		const code = await runAdoptHistory(["--nope"], deps());
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Unknown adopt-history option");
	});

	it("picks the highest-version state database", async () => {
		await writeFile(join(codexHome, "state_4.sqlite"), "", "utf8");
		await writeFile(join(codexHome, "state_5.sqlite"), "", "utf8");
		const found = await adoptHistoryInternals.findStateDb(codexHome);
		expect(found).toBe(join(codexHome, "state_5.sqlite"));
	});
});
