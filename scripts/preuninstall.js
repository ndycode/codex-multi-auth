#!/usr/bin/env node

// @ts-check

import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
	isCiEnvironment,
	resolveInstallPaths,
	removePluginFromList,
	withFileOperationRetry,
} from "./install-codex-auth-utils.js";

async function loadAppBindModule() {
	try {
		return await import("../dist/lib/runtime/app-bind.js");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
}

function defaultPreuninstallLog(message) {
	console.error(`codex-multi-auth: ${message}`);
}

/**
 * @param {{
 *   unbindCodexApp?: (dryRun: boolean) => Promise<void>,
 *   removeLauncher?: (options: { dryRun: boolean, log: (m: string) => void }) => Promise<void>,
 *   removePluginFromConfig?: (dryRun: boolean, log: (m: string) => void) => Promise<{ bunLockState: "safe" | "uncertain" }>,
 *   clearCache?: (dryRun: boolean, log: (m: string) => void, bunLockSafe: boolean) => Promise<void>,
 *   log?: (message: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   dryRun?: boolean,
 * }} [deps]
 */
export async function runPreuninstallCleanup(deps = {}) {
	const log = deps.log ?? defaultPreuninstallLog;
	const env = deps.env ?? process.env;
	const home =
		deps.home ??
		(deps.env
			? env.HOME || env.USERPROFILE || ""
			: undefined);
	const dryRun = deps.dryRun ?? process.argv.includes("--dry-run");

	if (isCiEnvironment(env)) {
		return 0;
	}

	/** @type {"safe" | "uncertain"} */
	let bunLockState = "uncertain";

	// Unbind Codex app runtime rotation (reverses install-time/first-run bind)
	try {
		if (deps.unbindCodexApp) {
			await deps.unbindCodexApp(dryRun);
		} else {
			const appBindModule = await loadAppBindModule();
			if (
				appBindModule &&
				typeof appBindModule.unbindCodexAppRuntimeRotation === "function"
			) {
				if (dryRun) {
					log("[dry-run] Would unbind Codex app runtime rotation");
				} else {
					await appBindModule.unbindCodexAppRuntimeRotation();
				}
			}
		}
	} catch (error) {
		log(
			`app unbind skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Remove OS-level launcher (reverses install-time/first-run launcher install)
	try {
		if (deps.removeLauncher) {
			await deps.removeLauncher({ dryRun, log });
		} else {
			const launcherModule = await import("./codex-app-launcher.js");
			if (typeof launcherModule.installCodexAppLauncher === "function") {
				await launcherModule.installCodexAppLauncher({ remove: true, dryRun, log });
			}
		}
	} catch (error) {
		log(
			`launcher removal skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Remove plugin entry from Codex.json and track whether we're certain that
	// no other plugins remain. bun.lock is shared across all Codex plugins, so
	// it's only safe to delete when:
	//   - File ENOENT             → safe (nothing to protect)
	//   - Parse error / read fail → uncertain (be conservative)
	//   - File ok, no plugins[]   → uncertain (we don't know what's installed)
	//   - File ok, plugins[]=[]   → safe
	//   - File ok, plugins[]≠[]   → uncertain
	try {
		if (deps.removePluginFromConfig) {
			const result = await deps.removePluginFromConfig(dryRun, log);
			if (result && typeof result === "object" && "bunLockState" in result) {
				bunLockState = result.bunLockState === "safe" ? "safe" : "uncertain";
			}
		} else {
			const paths = resolveInstallPaths(
				process.platform,
				env,
				home || undefined,
			);
			try {
				const raw = await withFileOperationRetry(() =>
					readFile(paths.configPath, "utf8"),
				);
				const config = JSON.parse(raw);
				if (Array.isArray(config.plugins)) {
					const next = removePluginFromList(config.plugins);
					bunLockState = next.length === 0 ? "safe" : "uncertain";
					if (dryRun) {
						log(
							`[dry-run] Would remove codex-multi-auth from ${paths.configPath}`,
						);
					} else {
						config.plugins = next;
						await withFileOperationRetry(() =>
							writeFile(
								paths.configPath,
								JSON.stringify(config, null, "\t") + "\n",
								"utf8",
							),
						);
					}
				} else if (dryRun) {
					log(
						`[dry-run] Would remove codex-multi-auth from ${paths.configPath}`,
					);
				}
			} catch (fileError) {
				const code =
					fileError &&
					typeof fileError === "object" &&
					"code" in fileError
						? fileError.code
						: undefined;
				if (code === "ENOENT") {
					bunLockState = "safe";
					if (dryRun) {
						log(
							`[dry-run] Would remove codex-multi-auth from ${paths.configPath}`,
						);
					}
				} else {
					log(
						`config cleanup skipped: ${fileError instanceof Error ? fileError.message : String(fileError)}`,
					);
				}
			}
		}
	} catch (error) {
		log(
			`config cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const bunLockSafe = bunLockState === "safe";

	// Clear plugin cache dirs
	try {
		if (deps.clearCache) {
			await deps.clearCache(dryRun, log, bunLockSafe);
		} else {
			const paths = resolveInstallPaths(
				process.platform,
				env,
				home || undefined,
			);
			if (dryRun) {
				log(`[dry-run] Would remove ${paths.cacheNodeModules}`);
				if (bunLockSafe) {
					log(`[dry-run] Would remove ${paths.cacheBunLock}`);
				} else {
					log(
						`[dry-run] Would skip ${paths.cacheBunLock} (other plugins still installed)`,
					);
				}
			} else {
				try {
					await withFileOperationRetry(() =>
						rm(paths.cacheNodeModules, { recursive: true, force: true }),
					);
					if (bunLockSafe) {
						await withFileOperationRetry(() =>
							rm(paths.cacheBunLock, { force: true }),
						);
					}
				} catch (error) {
					log(
						`cache clear skipped: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	} catch (error) {
		log(
			`cache clear skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return 0;
}

async function main() {
	return runPreuninstallCleanup();
}

function normalizeExitCode(exitCode) {
	return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
		? exitCode
		: 0;
}

const isDirectRun = (() => {
	try {
		return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	main()
		.then((exitCode) => {
			process.exitCode = normalizeExitCode(exitCode);
		})
		.catch((error) => {
			defaultPreuninstallLog(
				`preuninstall cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 0;
		});
}
