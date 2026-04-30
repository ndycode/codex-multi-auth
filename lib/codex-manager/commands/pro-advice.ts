import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	readFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { CODEX_BASE_URL } from "../../constants.js";
import { queuedRefresh } from "../../refresh-queue.js";
import type { AccountStorageV3 } from "../../storage.js";
import { createCodexHeaders } from "../../request/fetch-helpers.js";
import type { TokenResult } from "../../types.js";

const DEFAULT_MODEL = "gpt-5.5-pro";
const DEFAULT_HANDOFF_FILE = "PRO_HANDOFF.md";
const DEFAULT_ADVICE_FILE = "PRO_ADVICE.md";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2_500;
const MAX_SCAN_DEPTH = 4;

export interface ProAdviceOptions {
	mode: "auto" | "manual";
	handoffPath: string;
	advicePath: string;
	noTui: boolean;
	json: boolean;
	task?: string;
	timeoutMs: number;
}

export interface DossierCandidate {
	path: string;
	relativePath: string;
	priority: number;
	content?: string;
}

export interface ProAdviceDeps {
	cwd?: () => string;
	now?: () => Date;
	isTty?: () => boolean;
	loadAccounts?: () => Promise<AccountStorageV3 | null>;
	resolveActiveIndex?: (storage: AccountStorageV3) => number;
	refreshAccessToken?: (refreshToken: string) => Promise<TokenResult>;
	fetch?: typeof fetch;
	createReadline?: () => Interface;
	spawnCodex?: (command: string, args: string[]) => { pid?: number };
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

type ParseResult =
	| { ok: true; options: ProAdviceOptions }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

type AdviceResult =
	| { ok: true; advicePath: string; responseId?: string; mode: "auto" | "manual" }
	| { ok: false; error: string; status?: number; responseId?: string };

function printProAdviceUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth pro-advice [--mode auto|manual] [--handoff <path>] [--advice <path>] [--no-tui] [--json]",
			"",
			"Behavior:",
			"  - Discovers dossier markdown in the current codebase",
			"  - Writes PRO_HANDOFF.md with a required GPT-5.5 Pro output contract",
			"  - Auto mode uses official background Responses when an entitled managed account is available",
			"  - Manual mode saves the handoff and accepts pasted or existing PRO_ADVICE.md output",
			"  - It does not automate ChatGPT web sessions, cookies, or browser polling",
		].join("\n"),
	);
}

export function parseProAdviceArgs(args: string[]): ParseResult {
	const options: ProAdviceOptions = {
		mode: "auto",
		handoffPath: DEFAULT_HANDOFF_FILE,
		advicePath: DEFAULT_ADVICE_FILE,
		noTui: false,
		json: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { ok: false, reason: "help" };
		}
		if (arg === "--mode") {
			const value = args[i + 1];
			if (value !== "auto" && value !== "manual") {
				return {
					ok: false,
					reason: "error",
					message: "--mode expects auto or manual",
				};
			}
			options.mode = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--mode=")) {
			const value = arg.slice("--mode=".length);
			if (value !== "auto" && value !== "manual") {
				return {
					ok: false,
					reason: "error",
					message: "--mode expects auto or manual",
				};
			}
			options.mode = value;
			continue;
		}
		if (arg === "--handoff") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					reason: "error",
					message: "Missing value for --handoff",
				};
			}
			options.handoffPath = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--handoff=")) {
			const value = arg.slice("--handoff=".length).trim();
			if (!value) {
				return {
					ok: false,
					reason: "error",
					message: "Missing value for --handoff",
				};
			}
			options.handoffPath = value;
			continue;
		}
		if (arg === "--advice") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					reason: "error",
					message: "Missing value for --advice",
				};
			}
			options.advicePath = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--advice=")) {
			const value = arg.slice("--advice=".length).trim();
			if (!value) {
				return {
					ok: false,
					reason: "error",
					message: "Missing value for --advice",
				};
			}
			options.advicePath = value;
			continue;
		}
		if (arg === "--no-tui") {
			options.noTui = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		return {
			ok: false,
			reason: "error",
			message: `Unknown pro-advice option: ${arg}`,
		};
	}

	return { ok: true, options };
}

function normalizePath(root: string, value: string): string {
	return resolve(root, value);
}

function sameResolvedPath(left: string, right: string): boolean {
	const leftResolved = resolve(left);
	const rightResolved = resolve(right);
	if (process.platform === "win32") {
		return leftResolved.toLowerCase() === rightResolved.toLowerCase();
	}
	return leftResolved === rightResolved;
}

function isMarkdownFile(path: string): boolean {
	return extname(path).toLowerCase() === ".md";
}

function scoreDossier(relativePath: string): number | null {
	const normalized = relativePath.replace(/\\/g, "/");
	const name = basename(normalized).toLowerCase();
	if (name === "pro_handoff.md") return 10;
	if (name === "pro_advice.md") return 20;
	if (/^[a-z0-9._-]+_db_dossier\.md$/i.test(name)) return 30;
	if (/^[a-z0-9._-]+_dossier\.md$/i.test(name)) return 40;
	if (/dossier/i.test(name) && !normalized.includes("/")) return 50;
	if (/^docs\/.*dossier.*\.md$/i.test(normalized)) return 60;
	return null;
}

async function scanMarkdown(
	root: string,
	dir: string,
	depth: number,
	out: DossierCandidate[],
): Promise<void> {
	if (depth > MAX_SCAN_DEPTH) return;
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
			continue;
		}
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) {
			await scanMarkdown(root, absolute, depth + 1, out);
			continue;
		}
		if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;
		const relativePath = relative(root, absolute);
		const priority = scoreDossier(relativePath);
		if (priority === null) continue;
		out.push({ path: absolute, relativePath, priority });
	}
}

export async function discoverDossierCandidates(
	root: string,
): Promise<DossierCandidate[]> {
	const out: DossierCandidate[] = [];
	await scanMarkdown(root, root, 0, out);
	return out.sort(
		(left, right) =>
			left.priority - right.priority ||
			left.relativePath.localeCompare(right.relativePath),
	);
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function defaultTask(repoName: string): string {
	return `Review the selected ${repoName} dossier inputs as GPT-5.5 Pro and produce implementation advice for Codex.`;
}

export function buildDossierPromptFiles(repoName: string): Record<string, string> {
	return {
		"PRO_DOSSIER_PROMPT.md": [
			"# Dossier Prompt",
			"",
			"Run `$dossier` in this repository.",
			"",
			"Produce one root markdown artifact based on actual code inspection.",
			"Cover runtime surfaces, subsystems, data boundaries, developer workflows, risks, drift, and uncertainty.",
			`Repository: ${repoName}`,
			"",
		].join("\n"),
		"PRO_DOSSIER_DB_PROMPT.md": [
			"# Database Dossier Prompt",
			"",
			"Run `$dossier-db` for this project only if live database MCP access is available.",
			"",
			"Inspect the live schema through MCP and produce one root markdown artifact.",
			"Call out blocked or incomplete MCP access explicitly instead of filling gaps from repo docs.",
			`Repository: ${repoName}`,
			"",
		].join("\n"),
	};
}

export function buildProHandoffMarkdown(params: {
	repoRoot: string;
	createdAt: Date;
	selectedInputs: DossierCandidate[];
	task?: string;
}): string {
	const repo = basename(params.repoRoot);
	const task = params.task ?? defaultTask(repo);
	const selected = params.selectedInputs.map((candidate) =>
		candidate.relativePath.replace(/\\/g, "/"),
	);
	const frontmatter = [
		"---",
		'kind: "codex-pro-advice-handoff"',
		'version: "1"',
		`repo: ${yamlString(repo)}`,
		`created_at: ${yamlString(params.createdAt.toISOString())}`,
		"selected_inputs:",
		...(selected.length > 0
			? selected.map((input) => `  - ${yamlString(input)}`)
			: ["  - null"]),
		`task: ${yamlString(task)}`,
		"required_output:",
		'  - "findings"',
		'  - "recommended_plan"',
		'  - "codex_implementation_prompt"',
		"---",
		"",
	];

	const sections = [
		"# GPT-5.5 Pro Handoff",
		"",
		"## Task",
		"",
		task,
		"",
		"## Required Output Contract",
		"",
		"Return markdown with exactly these sections:",
		"",
		"1. Findings",
		"2. Recommended Plan",
		"3. Codex Implementation Prompt",
		"",
		"The implementation prompt must be copy-pasteable into a fresh Codex session and must include scope, files or areas to inspect, constraints, verification commands, and non-goals.",
		"",
		"## Selected Inputs",
		"",
	];

	if (params.selectedInputs.length === 0) {
		sections.push(
			"No dossier markdown was selected. Use the prompt files generated next to this handoff to create dossier inputs first.",
			"",
		);
	} else {
		for (const candidate of params.selectedInputs) {
			sections.push(`### ${candidate.relativePath.replace(/\\/g, "/")}`, "");
			sections.push(`Source path: \`${candidate.relativePath.replace(/\\/g, "/")}\``, "");
			if (typeof candidate.content === "string" && candidate.content.length > 0) {
				sections.push("````markdown", candidate.content.trimEnd(), "````", "");
			} else {
				sections.push("_Content unavailable in this handoff._", "");
			}
		}
	}

	sections.push(
		"## Pro Instructions",
		"",
		"Act as a senior implementation advisor. Ground conclusions in the selected dossier contents. Do not assume access to private browser sessions or ChatGPT web cookies. If a required fact is missing, mark it as an uncertainty and recommend the smallest verification step.",
		"",
	);

	return `${frontmatter.join("\n")}${sections.join("\n")}`;
}

async function ensureParentDir(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await ensureParentDir(filePath);
	await writeFile(filePath, content, "utf8");
}

async function readIfExists(path: string): Promise<string | null> {
	if (!existsSync(path)) return null;
	const stats = await stat(path).catch(() => null);
	if (!stats?.isFile()) return null;
	return readFile(path, "utf8");
}

function extractResponseText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const record = payload as Record<string, unknown>;
	if (typeof record.output_text === "string") return record.output_text;
	const output = Array.isArray(record.output) ? record.output : [];
	const chunks: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const itemRecord = item as Record<string, unknown>;
		const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
		for (const contentItem of content) {
			if (!contentItem || typeof contentItem !== "object") continue;
			const contentRecord = contentItem as Record<string, unknown>;
			if (typeof contentRecord.text === "string") {
				chunks.push(contentRecord.text);
			}
		}
	}
	return chunks.join("\n").trim();
}

function extractError(payload: unknown, fallback: string): string {
	if (!payload || typeof payload !== "object") return fallback;
	const record = payload as Record<string, unknown>;
	const error = record.error;
	if (error && typeof error === "object") {
		const nested = error as Record<string, unknown>;
		if (typeof nested.message === "string") return nested.message;
		if (typeof nested.code === "string") return nested.code;
	}
	if (typeof record.message === "string") return record.message;
	return fallback;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text().catch(() => "");
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { error: { message: text } };
	}
}

function responseStatus(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const status = (payload as Record<string, unknown>).status;
	return typeof status === "string" ? status : "";
}

function responseId(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const id = (payload as Record<string, unknown>).id;
	return typeof id === "string" ? id : undefined;
}

async function getManagedAccess(deps: ProAdviceDeps): Promise<{
	accountId: string;
	accessToken: string;
}> {
	if (!deps.loadAccounts || !deps.resolveActiveIndex) {
		throw new Error("Auto mode requires account storage dependencies.");
	}
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		throw new Error("No managed Codex accounts are configured. Run `codex auth login` or use --mode manual.");
	}
	const index = deps.resolveActiveIndex(storage);
	const account = storage.accounts[index];
	if (!account) {
		throw new Error("Active account index is out of range.");
	}
	const refresh = deps.refreshAccessToken ?? queuedRefresh;
	const token = await refresh(account.refreshToken);
	if (token.type !== "success") {
		throw new Error(token.message ?? token.reason ?? "Token refresh failed.");
	}
	const accountId = account.accountId;
	if (!accountId) {
		throw new Error("Active account has no ChatGPT account id. Re-login or use --mode manual.");
	}
	return { accountId, accessToken: token.access };
}

async function submitBackgroundAdvice(params: {
	handoff: string;
	advicePath: string;
	deps: ProAdviceDeps;
	options: ProAdviceOptions;
}): Promise<AdviceResult> {
	const fetchImpl = params.deps.fetch ?? fetch;
	const startedAt = Date.now();
	const access = await getManagedAccess(params.deps);
	const headers = createCodexHeaders(undefined, access.accountId, access.accessToken, {
		model: DEFAULT_MODEL,
	});
	headers.set("content-type", "application/json");
	headers.set("accept", "application/json");
	const body = {
		model: DEFAULT_MODEL,
		background: true,
		input: [
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: params.handoff,
					},
				],
			},
		],
	};

	const created = await fetchImpl(`${CODEX_BASE_URL}/codex/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const createdPayload = await parseJsonResponse(created);
	const responseIdValue = responseId(createdPayload);
	if (!created.ok) {
		return {
			ok: false,
			status: created.status,
			responseId: responseIdValue,
			error: extractError(createdPayload, `Background response failed with HTTP ${created.status}`),
		};
	}

	let latestPayload = createdPayload;
	while (Date.now() - startedAt < params.options.timeoutMs) {
		const status = responseStatus(latestPayload);
		if (status === "completed" || (!status && extractResponseText(latestPayload))) {
			const text = extractResponseText(latestPayload);
			if (!text) {
				return {
					ok: false,
					responseId: responseIdValue,
					error: "Background response completed without text output.",
				};
			}
			await writeTextFile(params.advicePath, text);
			return {
				ok: true,
				mode: "auto",
				advicePath: params.advicePath,
				responseId: responseIdValue,
			};
		}
		if (status === "failed" || status === "cancelled" || status === "expired") {
			return {
				ok: false,
				responseId: responseIdValue,
				error: extractError(latestPayload, `Background response ${status}.`),
			};
		}
		if (!responseIdValue) {
			return {
				ok: false,
				error: "Background response did not return an id to poll.",
			};
		}
		await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
		const polled = await fetchImpl(
			`${CODEX_BASE_URL}/codex/responses/${encodeURIComponent(responseIdValue)}`,
			{ method: "GET", headers },
		);
		latestPayload = await parseJsonResponse(polled);
		if (!polled.ok) {
			return {
				ok: false,
				status: polled.status,
				responseId: responseIdValue,
				error: extractError(latestPayload, `Polling failed with HTTP ${polled.status}`),
			};
		}
	}

	if (responseIdValue) {
		await fetchImpl(
			`${CODEX_BASE_URL}/codex/responses/${encodeURIComponent(responseIdValue)}/cancel`,
			{ method: "POST", headers },
		).catch(() => undefined);
	}
	return {
		ok: false,
		responseId: responseIdValue,
		error: "Timed out waiting for background Pro advice.",
	};
}

async function askLine(rl: Interface, question: string): Promise<string> {
	return (await rl.question(question)).trim();
}

async function runManualAdvice(params: {
	advicePath: string;
	deps: ProAdviceDeps;
	noTui: boolean;
}): Promise<AdviceResult> {
	const existing = await readIfExists(params.advicePath);
	if (existing?.trim()) {
		return { ok: true, mode: "manual", advicePath: params.advicePath };
	}
	if (params.noTui) {
		return {
			ok: false,
			error: `Manual mode wrote the handoff. Paste GPT-5.5 Pro output into ${params.advicePath}.`,
		};
	}

	const rl =
		params.deps.createReadline?.() ??
		createInterface({ input: defaultInput, output: defaultOutput });
	try {
		const pasted = await askLine(
			rl,
			"Paste GPT-5.5 Pro output, or press Enter after saving PRO_ADVICE.md: ",
		);
		const latest = await readIfExists(params.advicePath);
		if (latest?.trim()) {
			return { ok: true, mode: "manual", advicePath: params.advicePath };
		}
		if (!pasted.trim()) {
			return {
				ok: false,
				error: `No advice was provided. Save GPT-5.5 Pro output to ${params.advicePath}.`,
			};
		}
		await writeTextFile(params.advicePath, `${pasted.trim()}\n`);
		return { ok: true, mode: "manual", advicePath: params.advicePath };
	} finally {
		rl.close();
	}
}

function buildLaunchCommand(advicePath: string): { command: string; args: string[]; prompt: string } {
	const prompt = [
		`Read ${advicePath}.`,
		"Follow the Codex Implementation Prompt section exactly.",
		"Verify the resulting change with the commands requested in that advice.",
	].join(" ");
	return { command: "codex", args: [prompt], prompt };
}

async function maybeLaunchCodex(params: {
	advicePath: string;
	deps: ProAdviceDeps;
	noTui: boolean;
	logInfo: (message: string) => void;
}): Promise<void> {
	const command = buildLaunchCommand(params.advicePath);
	if (params.noTui || params.deps.isTty?.() === false) {
		params.logInfo(`Launch command: ${command.command} ${JSON.stringify(command.args[0])}`);
		return;
	}
	const rl =
		params.deps.createReadline?.() ??
		createInterface({ input: defaultInput, output: defaultOutput });
	try {
		const answer = await askLine(rl, "Launch a new Codex session with this plan? [y/N] ");
		if (!/^y(es)?$/i.test(answer)) return;
		const launcher =
			params.deps.spawnCodex ??
			((cmd: string, args: string[]) =>
				spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }));
		launcher(command.command, command.args);
	} finally {
		rl.close();
	}
}

function jsonLog(logInfo: (message: string) => void, payload: unknown): void {
	logInfo(JSON.stringify(payload));
}

export async function runProAdviceCommand(
	args: string[],
	deps: ProAdviceDeps = {},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const parsed = parseProAdviceArgs(args);
	if (!parsed.ok) {
		if (parsed.reason === "help") {
			printProAdviceUsage(logInfo);
			return 0;
		}
		logError(parsed.message);
		return 1;
	}
	const options = parsed.options;
	const repoRoot = deps.cwd?.() ?? process.cwd();
	const handoffPath = normalizePath(repoRoot, options.handoffPath);
	const advicePath = normalizePath(repoRoot, options.advicePath);
	const candidates = await discoverDossierCandidates(repoRoot);
	const selectedInputs = candidates.filter((candidate) =>
		!candidate.relativePath.replace(/\\/g, "/").startsWith("docs/releases/") &&
		!sameResolvedPath(candidate.path, handoffPath) &&
		!sameResolvedPath(candidate.path, advicePath),
	);

	if (selectedInputs.length === 0) {
		const prompts = buildDossierPromptFiles(basename(repoRoot));
		for (const [fileName, content] of Object.entries(prompts)) {
			await writeTextFile(join(repoRoot, fileName), content);
		}
	}

	const selectedInputsWithContent = await Promise.all(
		selectedInputs.map(async (candidate) => ({
			...candidate,
			content: await readFile(candidate.path, "utf8").catch(() => ""),
		})),
	);

	const handoff = buildProHandoffMarkdown({
		repoRoot,
		createdAt: deps.now?.() ?? new Date(),
		selectedInputs: selectedInputsWithContent,
		task: options.task,
	});
	await writeTextFile(handoffPath, handoff);

	if (options.json) {
		jsonLog(logInfo, {
			command: "pro-advice",
			event: "handoff-written",
			handoffPath,
			advicePath,
			inputs: selectedInputs.map((candidate) => candidate.relativePath),
		});
	} else {
		logInfo(`Wrote handoff: ${handoffPath}`);
		if (selectedInputs.length === 0) {
			logInfo("No dossier inputs found. Wrote PRO_DOSSIER_PROMPT.md and PRO_DOSSIER_DB_PROMPT.md.");
		}
	}

	let result: AdviceResult;
	if (options.mode === "auto") {
		result = await submitBackgroundAdvice({
			handoff,
			advicePath,
			deps,
			options,
		}).catch((error: unknown) => ({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}));
		if (!result.ok) {
			if (!options.json) {
				logError(`Auto advice failed: ${result.error}`);
				logInfo("Falling back to manual GPT-5.5 Pro handoff.");
			}
			result = await runManualAdvice({
				advicePath,
				deps,
				noTui: options.noTui || !deps.isTty?.(),
			});
		}
	} else {
		result = await runManualAdvice({
			advicePath,
			deps,
			noTui: options.noTui || !deps.isTty?.(),
		});
	}

	if (!result.ok) {
		if (options.json) {
			jsonLog(logInfo, {
				command: "pro-advice",
				ok: false,
				error: result.error,
				handoffPath,
				advicePath,
			});
		} else {
			logError(result.error);
		}
		return 1;
	}

	if (options.json) {
		jsonLog(logInfo, {
			command: "pro-advice",
			ok: true,
			mode: result.mode,
			handoffPath,
			advicePath: result.advicePath,
			responseId: result.responseId,
		});
		return 0;
	}

	logInfo(`Saved Pro advice: ${result.advicePath}`);
	await maybeLaunchCodex({
		advicePath: result.advicePath,
		deps,
		noTui: options.noTui,
		logInfo,
	});
	return 0;
}
