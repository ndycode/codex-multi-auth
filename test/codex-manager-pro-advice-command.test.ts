import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildProHandoffMarkdown,
	discoverDossierCandidates,
	parseProAdviceArgs,
	runProAdviceCommand,
} from "../lib/codex-manager/commands/pro-advice.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { TokenResult } from "../lib/types.js";
import { withFileOperationRetry } from "../scripts/install-codex-auth-utils.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "codex-pro-advice-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0).map((root) =>
			withFileOperationRetry(() => rm(root, { recursive: true, force: true })),
		),
	);
});

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "pro@example.com",
				accountId: "acc_pro",
				refreshToken: "refresh-pro",
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
}

function tokenSuccess(): TokenResult {
	return {
		type: "success",
		access: "access-pro",
		refresh: "refresh-pro",
		expires: Date.now() + 60_000,
		multiAccount: true,
	};
}

describe("codex auth pro-advice command", () => {
	it("parses public flags", () => {
		expect(
			parseProAdviceArgs([
				"--mode",
				"web",
				"--handoff",
				"HANDOFF.md",
				"--advice=ADVICE.md",
				"--no-tui",
				"--json",
			]),
		).toEqual({
			ok: true,
			options: {
				mode: "web",
				handoffPath: "HANDOFF.md",
				advicePath: "ADVICE.md",
				noTui: true,
				json: true,
				timeoutMs: 1_800_000,
			},
		});
		expect(parseProAdviceArgs(["--mode", "web"])).toEqual({
			ok: true,
			options: {
				mode: "web",
				handoffPath: "PRO_HANDOFF.md",
				advicePath: "PRO_ADVICE.md",
				noTui: false,
				json: false,
				timeoutMs: 1_800_000,
			},
		});
	});

	it("discovers dossier candidates by priority", async () => {
		const root = await createTempRoot();
		await writeFile(join(root, "PRO_ADVICE.md"), "old\n", "utf8");
		await writeFile(join(root, "APP_DB_DOSSIER.md"), "db\n", "utf8");
		await writeFile(join(root, "APP_DOSSIER.md"), "app\n", "utf8");
		await writeFile(join(root, "README.md"), "readme\n", "utf8");

		const candidates = await discoverDossierCandidates(root);

		expect(candidates.map((candidate) => candidate.relativePath)).toEqual([
			"PRO_ADVICE.md",
			"APP_DB_DOSSIER.md",
			"APP_DOSSIER.md",
		]);
	});

	it("generates frontmatter and required output contract", () => {
		const markdown = buildProHandoffMarkdown({
			repoRoot: "/tmp/example",
			createdAt: new Date("2026-04-30T00:00:00.000Z"),
			selectedInputs: [
				{
					path: "/tmp/example/APP_DOSSIER.md",
					relativePath: "APP_DOSSIER.md",
					priority: 40,
					content: "# App Dossier\n\nGrounded repo notes.\n",
				},
			],
		});

		expect(markdown).toContain('kind: "codex-pro-advice-handoff"');
		expect(markdown).toContain('repo: "example"');
		expect(markdown).toContain('created_at: "2026-04-30T00:00:00.000Z"');
		expect(markdown).toContain('  - "APP_DOSSIER.md"');
		expect(markdown).toContain("## Required Output Contract");
		expect(markdown).toContain("Codex Implementation Prompt");
		expect(markdown).toContain("# App Dossier");
		expect(markdown).toContain("Grounded repo notes.");
	});

	it("writes prompt files and deterministic JSON in manual non-TTY mode when no dossiers exist", async () => {
		const root = await createTempRoot();
		const infos: string[] = [];
		const errors: string[] = [];

		await expect(
			runProAdviceCommand(["--mode", "manual", "--no-tui", "--json"], {
				cwd: () => root,
				now: () => new Date("2026-04-30T00:00:00.000Z"),
				isTty: () => false,
				logInfo: (message) => infos.push(message),
				logError: (message) => errors.push(message),
			}),
		).resolves.toBe(1);

		expect(errors).toEqual([]);
		expect(await readFile(join(root, "PRO_HANDOFF.md"), "utf8")).toContain(
			"codex-pro-advice-handoff",
		);
		expect(await readFile(join(root, "PRO_DOSSIER_PROMPT.md"), "utf8")).toContain(
			"$dossier",
		);
		expect(await readFile(join(root, "PRO_DOSSIER_DB_PROMPT.md"), "utf8")).toContain(
			"$dossier-db",
		);
		const finalPayload = JSON.parse(infos.at(-1) ?? "{}");
		expect(finalPayload).toMatchObject({
			command: "pro-advice",
			ok: false,
		});
		expect(finalPayload.error).toContain("Manual mode wrote the handoff");
	});

	it("submits and polls a background response with a managed account", async () => {
		const root = await createTempRoot();
		await writeFile(join(root, "APP_DOSSIER.md"), "# dossier\n", "utf8");
		const infos: string[] = [];
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "resp_1", status: "queued" }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "resp_1",
						status: "completed",
						output_text: "# Findings\n\nok\n",
					}),
					{ status: 200 },
				),
			);

		await expect(
			runProAdviceCommand(["--json"], {
				cwd: () => root,
				now: () => new Date("2026-04-30T00:00:00.000Z"),
				isTty: () => false,
				loadAccounts: async () => createStorage(),
				resolveActiveIndex: () => 0,
				refreshAccessToken: async () => tokenSuccess(),
				fetch: fetchMock,
				logInfo: (message) => infos.push(message),
				logError: vi.fn(),
			}),
		).resolves.toBe(0);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await readFile(join(root, "PRO_ADVICE.md"), "utf8")).toContain(
			"# Findings",
		);
		const finalPayload = JSON.parse(infos.at(-1) ?? "{}");
		expect(finalPayload).toMatchObject({
			command: "pro-advice",
			ok: true,
			mode: "auto",
			responseId: "resp_1",
		});
	});

	it("falls back to manual advice when entitlement fails", async () => {
		const root = await createTempRoot();
		await writeFile(join(root, "APP_DOSSIER.md"), "# dossier\n", "utf8");
		await writeFile(join(root, "PRO_ADVICE.md"), "# Manual\n\nsaved\n", "utf8");
		const infos: string[] = [];
		const errors: string[] = [];
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error: { message: "model entitlement required" } }),
				{ status: 403 },
			),
		);

		await expect(
			runProAdviceCommand([], {
				cwd: () => root,
				isTty: () => false,
				loadAccounts: async () => createStorage(),
				resolveActiveIndex: () => 0,
				refreshAccessToken: async () => tokenSuccess(),
				fetch: fetchMock,
				logInfo: (message) => infos.push(message),
				logError: (message) => errors.push(message),
			}),
		).resolves.toBe(0);

		expect(errors.join("\n")).toContain("model entitlement required");
		expect(infos.join("\n")).toContain("Falling back to manual GPT-5.5 Pro handoff.");
		expect(infos.join("\n")).toContain("Saved Pro advice:");
		const handoff = await readFile(join(root, "PRO_HANDOFF.md"), "utf8");
		expect(handoff).toContain("APP_DOSSIER.md");
		expect(handoff).not.toContain("# Manual");
	});

	it("guides ChatGPT web handoff with the active pool account", async () => {
		const root = await createTempRoot();
		await writeFile(join(root, "APP_DOSSIER.md"), "# dossier\n", "utf8");
		const infos: string[] = [];
		const errors: string[] = [];

		await expect(
			runProAdviceCommand(["--mode", "web", "--no-tui", "--json"], {
				cwd: () => root,
				now: () => new Date("2026-04-30T00:00:00.000Z"),
				isTty: () => false,
				loadAccounts: async () => createStorage(),
				resolveActiveIndex: () => 0,
				logInfo: (message) => infos.push(message),
				logError: (message) => errors.push(message),
			}),
		).resolves.toBe(1);

		expect(errors).toEqual([]);
		expect(infos.join("\n")).toContain("Active pool account: pro@example.com / acc_pro");
		expect(infos.join("\n")).toContain("https://chatgpt.com/");
		const finalPayload = JSON.parse(infos.at(-1) ?? "{}");
		expect(finalPayload).toMatchObject({
			command: "pro-advice",
			ok: false,
		});
		expect(finalPayload.error).toContain("Web-assisted mode wrote the handoff");
	});

	it("falls back to ChatGPT web when Codex account rejects GPT-5.5 Pro", async () => {
		const root = await createTempRoot();
		await writeFile(join(root, "APP_DOSSIER.md"), "# dossier\n", "utf8");
		const infos: string[] = [];
		const errors: string[] = [];
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					detail:
						"The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
				}),
				{ status: 400 },
			),
		);

		await expect(
			runProAdviceCommand(["--no-tui"], {
				cwd: () => root,
				now: () => new Date("2026-04-30T00:00:00.000Z"),
				isTty: () => false,
				loadAccounts: async () => createStorage(),
				resolveActiveIndex: () => 0,
				refreshAccessToken: async () => tokenSuccess(),
				fetch: fetchMock,
				logInfo: (message) => infos.push(message),
				logError: (message) => errors.push(message),
			}),
		).resolves.toBe(1);

		expect(errors.join("\n")).toContain("not supported");
		expect(infos.join("\n")).toContain("Falling back to ChatGPT web-assisted");
		expect(infos.join("\n")).toContain("Active pool account: pro@example.com / acc_pro");
	});
});
