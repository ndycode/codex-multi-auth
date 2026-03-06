import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { deriveUserConfigFromCodexConfig, resolveCliModelSelection } from "./codex-model-config.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const localConfigPaths = [join(repoRoot, ".codex.json"), join(repoRoot, "Codex.json")];
const scenarioTemplates = {
	legacy: join(repoRoot, "config", "codex-legacy.json"),
	modern: join(repoRoot, "config", "codex-modern.json"),
};

const pluginPackageName = "codex-multi-auth";
const DEFAULT_MATRIX_TIMEOUT_MS = 120000;

function resolveCmdScriptEntry(commandPath) {
	if (!/\.cmd$/i.test(commandPath)) {
		return null;
	}
	try {
		const raw = readFileSync(commandPath, "utf8");
		const match = raw.match(/"%dp0%\\([^"\r\n]+\.js)"/i);
		if (!match || typeof match[1] !== "string") {
			return null;
		}
		const relScriptPath = match[1].replace(/[\\/]+/g, "/");
		const scriptPath = resolve(dirname(commandPath), relScriptPath);
		return existsSync(scriptPath) ? scriptPath : null;
	} catch {
		return null;
	}
}

function buildExecutable(command) {
	const scriptEntry = resolveCmdScriptEntry(command);
	if (scriptEntry) {
		return {
			command: process.execPath,
			shell: false,
			prefixArgs: [scriptEntry],
			displayCommand: command,
		};
	}
	return { command, shell: /\.cmd$/i.test(command) };
}

export function resolveCodexExecutable() {
	const envOverride = process.env.CODEX_BIN;
	if (envOverride && envOverride.trim().length > 0) {
		const command = envOverride.trim();
		return buildExecutable(command);
	}

	if (process.platform !== "win32") {
		return { command: "codex", shell: false };
	}

	const whereResult = spawnSync("where", ["Codex"], {
		encoding: "utf8",
		windowsHide: true,
	});
	const candidates = `${whereResult.stdout ?? ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[A-Za-z]:\\.+\.(exe|cmd)$/i.test(line));

	if (candidates.length === 0) {
		return { command: "codex", shell: false };
	}

	const exactExe = candidates.find((candidate) =>
		/npm\\Codex\.exe$/i.test(candidate),
	);
	if (exactExe) {
		return { command: exactExe, shell: false };
	}

	const exactCmd = candidates.find((candidate) =>
		/npm\\Codex\.cmd$/i.test(candidate),
	);
	if (exactCmd) {
		return buildExecutable(exactCmd);
	}

	const anyCmd = candidates.find((candidate) => /\.cmd$/i.test(candidate));
	if (anyCmd) {
		return buildExecutable(anyCmd);
	}

	return { command: candidates[0], shell: false };
}

const CodexExecutable = resolveCodexExecutable();

function printUsage() {
	console.log(
		[
			"Usage: node scripts/test-model-matrix.js [options]",
			"",
			"Options:",
			"  --scenario=legacy|modern|all   Which template(s) to audit (default: all)",
			"  --smoke                         Run reduced per-model checks",
			"  --plugin=dist|package          Load plugin from local dist URI or package name (default: dist)",
			"  --max-cases=N                  Hard cap number of cases per scenario",
			"  --report-json=PATH             Write JSON report to PATH (relative to repo root)",
			"  --no-restore                   Keep generated local config files after run",
			"  -h, --help                     Show help",
		].join("\n"),
	);
}

function parseArgValue(args, name) {
	const prefix = `${name}=`;
	const hit = args.find((arg) => arg.startsWith(prefix));
	if (!hit) return undefined;
	return hit.slice(prefix.length);
}

function toFileUri(pathValue) {
	const normalized = pathValue.replace(/\\/g, "/");
	if (/^[A-Za-z]:\//.test(normalized)) {
		return `file:///${normalized}`;
	}
	if (normalized.startsWith("/")) {
		return `file://${normalized}`;
	}
	return `file:///${normalized}`;
}

let stopCodexServersQueue = Promise.resolve();
const spawnedCodexPids = new Set();

function runQuiet(command, commandArgs) {
	try {
		spawnSync(command, commandArgs, {
			stdio: "ignore",
			windowsHide: true,
		});
	} catch {
		// Ignore cleanup failures.
	}
}

export function registerSpawnedCodex(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	spawnedCodexPids.add(pid);
}

export function __resetTrackedCodexPidsForTests() {
	spawnedCodexPids.clear();
}

export function resolveMatrixTimeoutMs() {
	const parsedTimeout = Number.parseInt(process.env.CODEX_MATRIX_TIMEOUT_MS ?? String(DEFAULT_MATRIX_TIMEOUT_MS), 10);
	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
		return DEFAULT_MATRIX_TIMEOUT_MS;
	}
	return parsedTimeout;
}

function stopCodexServersInternal() {
	const tracked = [...spawnedCodexPids];
	spawnedCodexPids.clear();
	for (const pid of tracked) {
		if (process.platform === "win32") {
			runQuiet("taskkill", ["/F", "/T", "/PID", String(pid)]);
			continue;
		}
		runQuiet("kill", ["-9", String(pid)]);
	}
}

export function stopCodexServers() {
	// Avoid overlapping global process cleanup when matrix scripts are run concurrently.
	stopCodexServersQueue = stopCodexServersQueue.then(async () => {
		stopCodexServersInternal();
	});
	return stopCodexServersQueue;
}

function normalizePluginList(value, pluginRef) {
	const entries = Array.isArray(value) ? value.filter(Boolean) : [];
	const filtered = entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		return !entry.startsWith(pluginPackageName);
	});
	return [...filtered, pluginRef];
}

function enumerateCases(models, smoke, maxCases) {
	const modelEntries = Object.entries(models).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	const cases = [];

	for (const [modelId, modelDef] of modelEntries) {
		const variants =
			modelDef && typeof modelDef === "object" && modelDef !== null
				? modelDef.variants
				: undefined;
		const variantNames =
			variants && typeof variants === "object"
				? Object.keys(variants).sort()
				: [];

		cases.push({ model: modelId, variant: undefined });
		for (const variant of variantNames) {
			cases.push({ model: modelId, variant });
		}
	}

	let selected = cases;
	if (smoke) {
		const reduced = [];
		for (const [modelId, modelDef] of modelEntries) {
			reduced.push({ model: modelId, variant: undefined });
			const variants =
				modelDef && typeof modelDef === "object" && modelDef !== null
					? modelDef.variants
					: undefined;
			const variantNames =
				variants && typeof variants === "object"
					? Object.keys(variants).sort()
					: [];
			if (variantNames.length > 0) {
				if (variantNames.includes("high")) {
					reduced.push({ model: modelId, variant: "high" });
				} else if (variantNames.includes("medium")) {
					reduced.push({ model: modelId, variant: "medium" });
				} else {
					reduced.push({ model: modelId, variant: variantNames[0] });
				}
			}
		}
		selected = reduced;
	}

	if (maxCases > 0 && selected.length > maxCases) {
		return selected.slice(0, maxCases);
	}
	return selected;
}

function buildModelCaseArgs(caseInfo, index, userConfig) {
	const token = `MODEL_MATRIX_OK_${index}`;
	const prompt = `Reply with exactly ${token} and nothing else.`;
	const requestedModel =
		caseInfo.variant && !caseInfo.model.toLowerCase().endsWith(`-${caseInfo.variant}`)
			? `${caseInfo.model}-${caseInfo.variant}`
			: caseInfo.model;
	const selection = resolveCliModelSelection(requestedModel, { userConfig });
	const args = [
		"exec",
		prompt,
		"--model",
		selection.model,
		"--json",
		"--skip-git-repo-check",
	];
	for (const entry of selection.configEntries) {
		args.push("-c", `${entry.key}="${entry.value}"`);
	}
	return { token, args };
}

export function __buildModelCaseArgsForTests(caseInfo, index, userConfig) {
	return buildModelCaseArgs(caseInfo, index, userConfig);
}

function executeModelCase(caseInfo, index, userConfig) {
	const { token, args } = buildModelCaseArgs(caseInfo, index, userConfig);

	const timeoutMs = resolveMatrixTimeoutMs();
	const commandArgs = [...(CodexExecutable.prefixArgs ?? []), ...args];
	const finalized = spawnSync(CodexExecutable.command, commandArgs, {
		cwd: repoRoot,
		encoding: "utf8",
		windowsHide: true,
		shell: CodexExecutable.shell,
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		env: {
			...process.env,
			ENABLE_PLUGIN_REQUEST_LOGGING: "0",
			CODEX_PLUGIN_LOG_BODIES: "0",
			DEBUG_CODEX_PLUGIN: "0",
		},
	});

	if (finalized.error && finalized.error.code === "ETIMEDOUT") {
		return {
			...caseInfo,
			ok: false,
			exitCode: 124,
			hasToken: false,
			output: `Timed out after ${timeoutMs}ms`,
		};
	}

	const combinedOutput = `${finalized.stdout ?? ""}\n${finalized.stderr ?? ""}`.trim();
	const hasToken = combinedOutput.includes(token);
	const exitCode = finalized.status ?? 1;
	const ok = exitCode === 0 && hasToken;

	return {
		...caseInfo,
		ok,
		exitCode,
		hasToken,
		output: combinedOutput,
	};
}

async function readJson(pathValue) {
	return JSON.parse(await readFile(pathValue, "utf8"));
}

async function writeJson(pathValue, value) {
	await writeFile(pathValue, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function backupLocalConfigs() {
	const backups = new Map();
	for (const configPath of localConfigPaths) {
		if (existsSync(configPath)) {
			backups.set(configPath, await readFile(configPath, "utf8"));
		} else {
			backups.set(configPath, null);
		}
	}
	return backups;
}

async function restoreLocalConfigs(backups) {
	for (const [configPath, content] of backups.entries()) {
		if (content === null) {
			if (existsSync(configPath)) {
				await rm(configPath, { force: true });
			}
			continue;
		}
		await writeFile(configPath, content, "utf8");
	}
}

function resolvePluginReference(mode) {
	if (mode === "package") {
		return pluginPackageName;
	}
	const distEntry = join(repoRoot, "dist", "index.js");
	if (!existsSync(distEntry)) {
		throw new Error(
			`dist build missing at ${distEntry}. Run 'npm run build' before matrix audit.`,
		);
	}
	return toFileUri(join(repoRoot, "dist"));
}

async function prepareScenarioConfig(templatePath, pluginRef) {
	const config = await readJson(templatePath);
	config.plugin = normalizePluginList(config.plugin, pluginRef);
	for (const configPath of localConfigPaths) {
		await writeJson(configPath, config);
	}
	return config;
}

async function runScenario(scenario, options) {
	const templatePath = scenarioTemplates[scenario];
	if (!templatePath || !existsSync(templatePath)) {
		throw new Error(`Template not found for scenario '${scenario}': ${templatePath}`);
	}

	const config = await prepareScenarioConfig(templatePath, options.pluginRef);
	const models = config?.provider?.openai?.models;
	if (!models || typeof models !== "object") {
		throw new Error(`Scenario '${scenario}' has no provider.openai.models object`);
	}
	const userConfig = deriveUserConfigFromCodexConfig(config);

	const cases = enumerateCases(models, options.smoke, options.maxCases);
	console.log(`\n=== ${scenario.toUpperCase()} (${cases.length} cases) ===`);

	const results = [];
	for (let i = 0; i < cases.length; i += 1) {
		const caseInfo = cases[i];
		const result = executeModelCase(
			caseInfo,
			i + 1,
			userConfig,
		);
		results.push(result);
		const variantLabel = result.variant ? ` [variant=${result.variant}]` : "";
		if (result.ok) {
			console.log(`PASS  ${result.model}${variantLabel}`);
		} else {
			console.log(`FAIL  ${result.model}${variantLabel} (exit=${result.exitCode}, token=${result.hasToken})`);
			const tail = result.output.split(/\r?\n/).slice(-12).join("\n");
			if (tail.trim().length > 0) {
				console.log(tail);
			}
		}
	}

	return results;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
		return;
	}

	const scenarioValue = parseArgValue(args, "--scenario") ?? "all";
	const smoke = args.includes("--smoke");
	const pluginMode = parseArgValue(args, "--plugin") ?? "dist";
	const noRestore = args.includes("--no-restore");
	const maxCasesRaw = parseArgValue(args, "--max-cases");
	const maxCases = maxCasesRaw ? Number.parseInt(maxCasesRaw, 10) : 0;
	const reportJsonPathRaw = parseArgValue(args, "--report-json");
	const reportJsonPath = reportJsonPathRaw
		? resolve(repoRoot, reportJsonPathRaw)
		: undefined;

	if (!["all", "legacy", "modern"].includes(scenarioValue)) {
		throw new Error(`Invalid --scenario value '${scenarioValue}'. Use legacy, modern, or all.`);
	}
	if (!["dist", "package"].includes(pluginMode)) {
		throw new Error(`Invalid --plugin value '${pluginMode}'. Use dist or package.`);
	}
	if (Number.isNaN(maxCases) || maxCases < 0) {
		throw new Error(`Invalid --max-cases value '${maxCasesRaw}'. Use a non-negative integer.`);
	}

	const pluginRef = resolvePluginReference(pluginMode);
	const scenarios =
		scenarioValue === "all" ? ["legacy", "modern"] : [scenarioValue];

	console.log("Codex Model Matrix Audit");
	console.log(`Repo: ${repoRoot}`);
	console.log(`Scenarios: ${scenarios.join(", ")}`);
	console.log(`Mode: ${smoke ? "smoke" : "full"}`);
	console.log(`Plugin: ${pluginRef}`);
	console.log(`Codex command: ${CodexExecutable.displayCommand ?? CodexExecutable.command}`);

	const backups = await backupLocalConfigs();
	const allResults = [];
	try {
		for (let i = 0; i < scenarios.length; i += 1) {
			const scenario = scenarios[i];
			await stopCodexServers();
			const scenarioResults = await runScenario(scenario, {
				smoke,
				maxCases,
				pluginRef,
			});
			allResults.push(...scenarioResults.map((item) => ({ ...item, scenario })));
		}
	} finally {
		if (!noRestore) {
			await restoreLocalConfigs(backups);
		}
	}

	const failed = allResults.filter((result) => !result.ok);
	const passed = allResults.length - failed.length;
	console.log("\n=== SUMMARY ===");
	console.log(`Total: ${allResults.length}`);
	console.log(`Passed: ${passed}`);
	console.log(`Failed: ${failed.length}`);

	if (reportJsonPath) {
		const report = {
			generatedAt: new Date().toISOString(),
			repoRoot,
			scenarios,
			mode: smoke ? "smoke" : "full",
			plugin: pluginRef,
			CodexCommand: CodexExecutable.displayCommand ?? CodexExecutable.command,
			totals: {
				total: allResults.length,
				passed,
				failed: failed.length,
			},
			results: allResults,
		};
		await mkdir(dirname(reportJsonPath), { recursive: true });
		await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(`Report written: ${reportJsonPath}`);
	}

	if (failed.length > 0) {
		console.log("\nFailed cases:");
		for (const result of failed) {
			const variantLabel = result.variant ? ` [variant=${result.variant}]` : "";
			console.log(`- ${result.scenario}: ${result.model}${variantLabel}`);
		}
		process.exitCode = 1;
	}
}

const isDirectRun =
	process.argv.length > 1 &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
	main().catch((error) => {
		console.error(
			`Model matrix audit failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}


