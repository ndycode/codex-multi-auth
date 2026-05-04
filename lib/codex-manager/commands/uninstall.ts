import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { unbindCodexAppRuntimeRotation } from "../../runtime/app-bind.js";

const PLUGIN_NAME = "codex-multi-auth";

const FILE_RETRY_CODES = new Set([
	"EBUSY",
	"EPERM",
	"EAGAIN",
	"ENOTEMPTY",
	"EACCES",
]);
const FILE_RETRY_MAX_ATTEMPTS = 6;
const FILE_RETRY_BASE_DELAY_MS = 25;
const FILE_RETRY_JITTER_MS = 20;

function isRetryableFsError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" && FILE_RETRY_CODES.has(code);
}

async function withFileOperationRetry<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!isRetryableFsError(error) || attempt >= FILE_RETRY_MAX_ATTEMPTS) {
				throw error;
			}
			const jitter = Math.floor(Math.random() * FILE_RETRY_JITTER_MS);
			const delayMs = FILE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export function resolveUninstallPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
) {
	const isWindows = platform === "win32";
	const appData = (env["APPDATA"] ?? "").trim();
	const localAppData = (env["LOCALAPPDATA"] ?? appData).trim();
	const configBase = isWindows
		? appData || join(home, "AppData", "Roaming")
		: join(home, ".config");
	const cacheBase = isWindows
		? localAppData || join(home, "AppData", "Local")
		: join(home, ".cache");
	const configDir = join(configBase, "Codex");
	const cacheDir = join(cacheBase, "Codex");
	return {
		configPath: join(configDir, "Codex.json"),
		cacheNodeModules: join(cacheDir, "node_modules", PLUGIN_NAME),
		cacheBunLock: join(cacheDir, "bun.lock"),
	};
}

export function removePluginFromList(list: unknown[]): unknown[] {
	return list.filter((entry) => {
		if (typeof entry !== "string") return true;
		return entry !== PLUGIN_NAME && !entry.startsWith(`${PLUGIN_NAME}@`);
	});
}

export type UninstallCliOptions = {
	dryRun: boolean;
	json: boolean;
	clearAccounts: boolean;
};

export type ParsedUninstallArgs =
	| { ok: true; options: UninstallCliOptions }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

export function printUninstallUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]",
			"",
			"Options:",
			"  --dry-run          Show what would be removed without making changes",
			"  --json             Print machine-readable JSON output",
			"  --clear-accounts   Also remove stored account credentials (irreversible)",
			"",
			"Behavior:",
			"  Reverses all postinstall changes: unbinds Codex app, removes OS launchers,",
			"  strips plugin from Codex.json, and clears the plugin cache.",
			"  Use this to clean up residual artifacts from prior installs.",
		].join("\n"),
	);
}

export function parseUninstallArgs(args: string[]): ParsedUninstallArgs {
	const options: UninstallCliOptions = {
		dryRun: false,
		json: false,
		clearAccounts: false,
	};

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			return { ok: false, reason: "help" };
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--clear-accounts") {
			options.clearAccounts = true;
			continue;
		}
		return { ok: false, reason: "error", message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

export type UninstallCommandDeps = {
	log?: (message: string) => void;
	clearAccounts?: () => Promise<void>;
	unbind?: () => Promise<void>;
	removeLauncher?: (options: {
		remove: true;
		log: (msg: string) => void;
	}) => Promise<void>;
	paths?: ReturnType<typeof resolveUninstallPaths>;
};

async function loadDefaultLauncher(): Promise<
	| ((options: { remove: true; log: (msg: string) => void }) => Promise<void>)
	| null
> {
	try {
		const launcherModule = await import(
			new URL("../../../../scripts/codex-app-launcher.js", import.meta.url).href
		);
		if (typeof launcherModule.installCodexAppLauncher === "function") {
			return launcherModule.installCodexAppLauncher as (options: {
				remove: true;
				log: (msg: string) => void;
			}) => Promise<void>;
		}
		return null;
	} catch {
		return null;
	}
}

export async function runUninstallCommand(
	args: string[],
	deps: UninstallCommandDeps = {},
): Promise<number> {
	const parsed = parseUninstallArgs(args);
	if (!parsed.ok) {
		if (parsed.reason === "help") {
			printUninstallUsage();
			return 0;
		}
		console.error(`codex-multi-auth uninstall: ${parsed.message}`);
		console.error('Run "codex-multi-auth uninstall --help" for usage.');
		return 1;
	}

	const { dryRun, json, clearAccounts } = parsed.options;
	const log = deps.log ?? ((msg: string) => console.error(`codex-multi-auth: ${msg}`));
	const paths = deps.paths ?? resolveUninstallPaths();
	const removed: string[] = [];
	const warnings: string[] = [];
	let partialFailure = false;

	// Surface a missing --clear-accounts handler immediately. The flag is
	// documented as irreversible; silently no-oping would leave the user
	// believing tokens were removed when they were not.
	if (clearAccounts && !deps.clearAccounts) {
		const msg =
			"--clear-accounts has no effect: no clearAccounts handler is wired in this build";
		log(`warning: ${msg}`);
		warnings.push(msg);
		partialFailure = true;
	}

	// Unbind Codex app runtime rotation
	try {
		if (dryRun) {
			log("[dry-run] Would unbind Codex app runtime rotation");
		} else {
			const unbind = deps.unbind ?? unbindCodexAppRuntimeRotation;
			await unbind();
			removed.push("app-bind");
		}
	} catch (error) {
		const msg = `app unbind skipped: ${error instanceof Error ? error.message : String(error)}`;
		log(msg);
		warnings.push(msg);
		partialFailure = true;
	}

	// Remove OS-level launcher
	try {
		const removeLauncher = deps.removeLauncher ?? (await loadDefaultLauncher());
		if (removeLauncher) {
			if (dryRun) {
				log("[dry-run] Would remove OS launcher");
			} else {
				await removeLauncher({ remove: true, log });
				removed.push("launcher");
			}
		}
	} catch (error) {
		const msg = `launcher removal skipped: ${error instanceof Error ? error.message : String(error)}`;
		log(msg);
		warnings.push(msg);
		partialFailure = true;
	}

	// Remove plugin entry from Codex.json. Track whether the resulting plugin
	// list is empty so we can decide later whether removing the shared
	// bun.lock is safe.
	let configPluginsAfterRemoval: unknown[] | null = null;
	try {
		if (dryRun) {
			log(`[dry-run] Would remove ${PLUGIN_NAME} from ${paths.configPath}`);
		} else {
			try {
				const raw = await readFile(paths.configPath, "utf8");
				const config: unknown = JSON.parse(raw);
				if (
					config &&
					typeof config === "object" &&
					"plugins" in config &&
					Array.isArray((config as { plugins: unknown[] }).plugins)
				) {
					const next = removePluginFromList(
						(config as { plugins: unknown[] }).plugins,
					);
					(config as { plugins: unknown[] }).plugins = next;
					configPluginsAfterRemoval = next;
					await withFileOperationRetry(() =>
						writeFile(
							paths.configPath,
							JSON.stringify(config, null, "\t") + "\n",
							"utf8",
						),
					);
					removed.push("config-entry");
				}
			} catch (fileError) {
				const code =
					fileError && typeof fileError === "object" && "code" in fileError
						? (fileError as NodeJS.ErrnoException).code
						: undefined;
				if (code !== "ENOENT") {
					throw fileError;
				}
			}
		}
	} catch (error) {
		const msg = `config cleanup skipped: ${error instanceof Error ? error.message : String(error)}`;
		log(msg);
		warnings.push(msg);
		partialFailure = true;
	}

	// Clear plugin cache. The plugin's node_modules subdir is private to this
	// plugin, but bun.lock is shared across all Codex plugins — only remove it
	// when the Codex.json plugin list is empty (or unreadable, which we treat
	// as "no other plugins to protect").
	const bunLockSafeToRemove =
		configPluginsAfterRemoval === null ||
		configPluginsAfterRemoval.length === 0;
	try {
		if (dryRun) {
			log(`[dry-run] Would remove ${paths.cacheNodeModules}`);
			if (bunLockSafeToRemove) {
				log(`[dry-run] Would remove ${paths.cacheBunLock}`);
			} else {
				log(
					`[dry-run] Would skip ${paths.cacheBunLock} (other plugins still installed)`,
				);
			}
		} else {
			await withFileOperationRetry(() =>
				rm(paths.cacheNodeModules, { recursive: true, force: true }),
			);
			if (bunLockSafeToRemove) {
				await withFileOperationRetry(() =>
					rm(paths.cacheBunLock, { force: true }),
				);
			}
			removed.push("cache");
		}
	} catch (error) {
		const msg = `cache clear skipped: ${error instanceof Error ? error.message : String(error)}`;
		log(msg);
		warnings.push(msg);
		partialFailure = true;
	}

	// Optionally clear stored accounts
	if (clearAccounts && deps.clearAccounts) {
		try {
			if (dryRun) {
				log("[dry-run] Would clear stored account credentials");
			} else {
				await deps.clearAccounts();
				removed.push("accounts");
			}
		} catch (error) {
			const msg = `account clear skipped: ${error instanceof Error ? error.message : String(error)}`;
			log(msg);
			warnings.push(msg);
			partialFailure = true;
		}
	}

	if (json) {
		console.log(
			JSON.stringify({
				dryRun,
				removed,
				warnings,
				ok: !partialFailure,
			}),
		);
	} else if (!dryRun) {
		const summary = removed.length > 0 ? removed.join(", ") : "nothing to remove";
		log(`uninstall complete: ${summary}`);
		if (warnings.length > 0) {
			log(`warnings: ${warnings.length} step(s) skipped (see above)`);
		}
	}

	return partialFailure ? 1 : 0;
}
