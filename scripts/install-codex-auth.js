#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const PLUGIN_NAME = "codex-multi-auth";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
	console.log(`Usage: ${PLUGIN_NAME} [--modern|--legacy] [--dry-run] [--no-cache-clear]\n\n` +
		"Default behavior:\n" +
		"  - Installs/updates global config at ~/.config/Codex/Codex.json\n" +
		"  - Uses modern config (variants) by default\n" +
		"  - Ensures plugin is unpinned (latest)\n" +
		"  - Clears Codex plugin cache\n\n" +
		"Options:\n" +
		"  --modern           Force modern config (default)\n" +
		"  --legacy           Use legacy config (older Codex versions)\n" +
		"  --dry-run          Show actions without writing\n" +
		"  --no-cache-clear   Skip clearing Codex cache\n"
	);
	process.exit(0);
}

const useLegacy = args.has("--legacy");
const useModern = args.has("--modern") || !useLegacy;
const dryRun = args.has("--dry-run");
const skipCacheClear = args.has("--no-cache-clear");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const templatePath = join(
	repoRoot,
	"config",
	useLegacy ? "codex-legacy.json" : "codex-modern.json"
);

const configDir = join(homedir(), ".config", "Codex");
const configPath = join(configDir, "Codex.json");
const cacheDir = join(homedir(), ".cache", "Codex");
const cacheNodeModules = join(cacheDir, "node_modules", PLUGIN_NAME);
const cacheBunLock = join(cacheDir, "bun.lock");
const cachePackageJson = join(cacheDir, "package.json");

function log(message) {
	console.log(message);
}

function normalizePluginList(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];
	const filtered = entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		return entry !== PLUGIN_NAME && !entry.startsWith(`${PLUGIN_NAME}@`);
	});
	return [...filtered, PLUGIN_NAME];
}

function formatJson(obj) {
	return `${JSON.stringify(obj, null, 2)}\n`;
}

async function readJson(filePath) {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content);
}

async function backupConfig(sourcePath) {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.replace("Z", "");
	const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const backupPath = `${sourcePath}.bak-${timestamp}-${nonce}`;
	if (!dryRun) {
		await copyFile(sourcePath, backupPath);
	}
	return backupPath;
}

async function removePluginFromCachePackage() {
	if (!existsSync(cachePackageJson)) {
		return;
	}

	let cacheData;
	try {
		cacheData = await readJson(cachePackageJson);
	} catch (error) {
		log(`Warning: Could not parse ${cachePackageJson} (${error}). Skipping.`);
		return;
	}

	const sections = [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	];

	let changed = false;
	for (const section of sections) {
		const deps = cacheData?.[section];
		if (deps && typeof deps === "object" && PLUGIN_NAME in deps) {
			delete deps[PLUGIN_NAME];
			changed = true;
		}
	}

	if (!changed) {
		return;
	}

	if (dryRun) {
		log(`[dry-run] Would update ${cachePackageJson} to remove ${PLUGIN_NAME}`);
		return;
	}

	await writeFile(cachePackageJson, formatJson(cacheData), "utf-8");
}

async function clearCache() {
	if (skipCacheClear) {
		log("Skipping cache clear (--no-cache-clear).");
		return;
	}

	if (dryRun) {
		log(`[dry-run] Would remove ${cacheNodeModules}`);
		log(`[dry-run] Would remove ${cacheBunLock}`);
	} else {
		try {
			await rm(cacheNodeModules, { recursive: true, force: true });
			await rm(cacheBunLock, { force: true });
		} catch (error) {
			log(
				`Warning: Could not fully clear cache (${error instanceof Error ? error.message : String(error)}). You may need to restart Codex.`,
			);
		}
	}

	await removePluginFromCachePackage();
}

async function main() {
	if (!existsSync(templatePath)) {
		throw new Error(`Config template not found at ${templatePath}`);
	}

	const template = await readJson(templatePath);
	template.plugin = [PLUGIN_NAME];

	let nextConfig = template;
	if (existsSync(configPath)) {
		const backupPath = await backupConfig(configPath);
		log(`${dryRun ? "[dry-run] Would create backup" : "Backup created"}: ${backupPath}`);

		try {
			const existing = await readJson(configPath);
			const merged = { ...existing };
			merged.plugin = normalizePluginList(existing.plugin);
			const provider = (existing.provider && typeof existing.provider === "object")
				? { ...existing.provider }
				: {};
			const existingOpenAi = provider.openai && typeof provider.openai === "object"
				? provider.openai
				: {};
			const templateOpenAi = template.provider && typeof template.provider === "object" &&
				template.provider.openai && typeof template.provider.openai === "object"
				? template.provider.openai
				: {};
			provider.openai = { ...templateOpenAi, ...existingOpenAi };
			merged.provider = provider;
			nextConfig = merged;
		} catch (error) {
			log(`Warning: Could not parse existing config (${error}). Replacing with template.`);
			nextConfig = template;
		}
	} else {
		log("No existing config found. Creating new global config.");
	}

	if (dryRun) {
		log(`[dry-run] Would write ${configPath} using ${useLegacy ? "legacy" : "modern"} config`);
	} else {
		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, formatJson(nextConfig), "utf-8");
		log(`Wrote ${configPath} (${useLegacy ? "legacy" : "modern"} config)`);
	}

	await clearCache();

	log("\nDone. Restart Codex to (re)install the plugin.");
	log("Example: Codex");
	if (useLegacy) {
		log("Note: Legacy config requires Codex v1.0.209 or older.");
	}
}

main().catch((error) => {
	console.error(`Installer failed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});

