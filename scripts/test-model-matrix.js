#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const localConfigPaths = [join(repoRoot, ".codex.json"), join(repoRoot, "Codex.json")];
const scenarioTemplates = {
	legacy: join(repoRoot, "config", "Codex-legacy.json"),
	modern: join(repoRoot, "config", "Codex-modern.json"),
};

const defaultPromptPrefix = "Reply exactly:";
const modelProviderId = "openai";
const pluginPackageName = "codex-multi-auth";

function resolveCodexExecutable() {
	const envOverride = process.env.CODEX_BIN;
	if (envOverride && envOverride.trim().length > 0) {
		const command = envOverride.trim();
		return { command, shell: /\.cmd$/i.test(command) };
	}

	if (process.platform !== "win32") {
		return { command: "Codex", shell: false };
	}

	const whereResult = spawnSync("where", ["Codex"], {
		encoding: "utf8",
		windowsHide: true,
	});
	const candidates = `${whereResult.stdout ?? ""}\n${whereResult.stderr ?? ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (candidates.length === 0) {
		return { command: "Codex", shell: false };
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
		return { command: exactCmd, shell: true };
	}

	const anyCmd = candidates.find((candidate) => /\.cmd$/i.test(candidate));
	if (anyCmd) {
		return { command: anyCmd, shell: true };
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

function stopCodexServers() {
	if (process.platform === "win32") {
		runQuiet("taskkill", ["/F", "/IM", "Codex.exe"]);
	}
	runQuiet("pkill", ["-f", "Codex"]);
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

function executeModelCase(caseInfo, index, port) {
	const token = `MODEL_MATRIX_OK_${index}`;
	const message = `${defaultPromptPrefix} ${token}`;
	const args = [
		"run",
		message,
		"--model",
		`${modelProviderId}/${caseInfo.model}`,
		"--port",
		String(port),
	];
	if (caseInfo.variant) {
		args.push("--variant", caseInfo.variant);
	}

	const finalized = spawnSync(CodexExecutable.command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		windowsHide: true,
		shell: CodexExecutable.shell,
		env: {
			...process.env,
			ENABLE_PLUGIN_REQUEST_LOGGING: "0",
			CODEX_PLUGIN_LOG_BODIES: "0",
			DEBUG_CODEX_PLUGIN: "0",
		},
	});

	const combinedOutput = `${finalized.stdout ?? ""}\n${finalized.stderr ?? ""}`.trim();
	const hasToken = combinedOutput.includes(token);
	const hasFatalError = /ProviderModelNotFoundError|Model not found/i.test(combinedOutput);
	const exitCode = finalized.status ?? 1;
	const ok = exitCode === 0 && hasToken && !hasFatalError;

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

	const cases = enumerateCases(models, options.smoke, options.maxCases);
	console.log(`\n=== ${scenario.toUpperCase()} (${cases.length} cases) ===`);

	const results = [];
	for (let i = 0; i < cases.length; i += 1) {
		const caseInfo = cases[i];
		const result = executeModelCase(
			caseInfo,
			i + 1,
			options.portStart + i,
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
	console.log(`Codex command: ${CodexExecutable.command}`);

	const backups = await backupLocalConfigs();
	const allResults = [];
	try {
		for (let i = 0; i < scenarios.length; i += 1) {
			const scenario = scenarios[i];
			stopCodexServers();
			const scenarioResults = await runScenario(scenario, {
				smoke,
				maxCases,
				pluginRef,
				portStart: 47000 + i * 500,
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
			CodexCommand: CodexExecutable.command,
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

main().catch((error) => {
	console.error(
		`Model matrix audit failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});


