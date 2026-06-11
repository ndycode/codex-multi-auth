import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";
import { getCodexCacheDir } from "./runtime-paths.js";
import { tempPathFor } from "./temp-path.js";

const log = createLogger("update-notice");

const PACKAGE_NAME = "codex-multi-auth";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_DIR = getCodexCacheDir();
const CACHE_FILE = join(CACHE_DIR, "update-check-cache.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const RETRYABLE_WRITE_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

let updateCacheWriteQueue: Promise<void> = Promise.resolve();
let cachedPackageRoot: string | undefined;

interface UpdateCheckCache {
	lastCheck: number;
	latestVersion: string | null;
	currentVersion: string;
}

interface NpmPackageInfo {
	version: string;
	name: string;
}

interface ParsedSemver {
	core: [number, number, number];
	prerelease: string[];
}

export interface UpdateCheckResult {
	hasUpdate: boolean;
	currentVersion: string;
	latestVersion: string | null;
	updateCommand: string;
}

function enqueueUpdateCacheWrite(writeTask: () => void | Promise<void>): Promise<void> {
	const queued = updateCacheWriteQueue.catch(() => undefined).then(writeTask);
	updateCacheWriteQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

function delay(ms: number): Promise<void> {
	const normalizedDelay = Math.max(0, Math.floor(ms));
	if (normalizedDelay === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, normalizedDelay);
		timeout.unref?.();
	});
}

async function writeCacheContents(serialized: string): Promise<void> {
	let tempPath: string | null = null;
	let wroteTemp = false;
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
		tempPath = tempPathFor(CACHE_FILE);
		let lastError: Error | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				writeFileSync(tempPath, serialized, "utf8");
				renameSync(tempPath, CACHE_FILE);
				wroteTemp = false;
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				lastError = error as Error;
				wroteTemp = true;
				if (!RETRYABLE_WRITE_ERRORS.has(code) || attempt >= 3) {
					throw error;
				}
				await delay(15 * (2 ** attempt));
			}
		}
		if (lastError) throw lastError;
	} finally {
		if (wroteTemp && tempPath) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Best-effort temp cleanup.
			}
		}
	}
}

function getModuleDir(): string {
	return typeof import.meta.dirname === "string"
		? import.meta.dirname
		: dirname(fileURLToPath(import.meta.url));
}

export function resolvePackageRootFromModuleDir(moduleDir: string): string {
	let current = moduleDir;
	for (let depth = 0; depth < 8; depth++) {
		const packageJsonPath = join(current, "package.json");
		try {
			if (existsSync(packageJsonPath)) {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
					name?: string;
				};
				if (packageJson.name === PACKAGE_NAME) return current;
			}
		} catch {
			// Keep walking; malformed metadata should not break startup notices.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return join(moduleDir, "..");
}

function getPackageRoot(): string {
	cachedPackageRoot ??= resolvePackageRootFromModuleDir(getModuleDir());
	return cachedPackageRoot;
}

function getCurrentVersion(): string {
	try {
		const packageJsonPath = join(getPackageRoot(), "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			version: string;
		};
		return packageJson.version;
	} catch (error) {
		log.debug("Failed to read current package version", {
			error: error instanceof Error ? error.message : String(error),
		});
		return "0.0.0";
	}
}

function loadCache(): UpdateCheckCache | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;
		const content = readFileSync(CACHE_FILE, "utf8");
		return JSON.parse(content) as UpdateCheckCache;
	} catch (error) {
		log.debug("Failed to load update cache", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function saveCache(cache: UpdateCheckCache): Promise<void> {
	await enqueueUpdateCacheWrite(async () => {
		try {
			await writeCacheContents(JSON.stringify(cache, null, 2));
		} catch (error) {
			log.warn("Failed to save update cache", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function parseSemver(version: string): ParsedSemver {
	const normalized = version.trim().replace(/^v/i, "");
	const [withoutBuild] = normalized.split("+");
	const [corePart = "0.0.0", prereleasePart] = (withoutBuild ?? "0.0.0").split("-", 2);
	const [majorRaw = "0", minorRaw = "0", patchRaw = "0"] = corePart.split(".");

	const toSafeInt = (value: string): number => {
		if (!/^\d+$/.test(value)) return 0;
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	};

	return {
		core: [toSafeInt(majorRaw), toSafeInt(minorRaw), toSafeInt(patchRaw)],
		prerelease:
			prereleasePart && prereleasePart.trim().length > 0
				? prereleasePart.split(".").filter((segment) => segment.length > 0)
				: [],
	};
}

function comparePrerelease(current: string[], latest: string[]): number {
	const maxLen = Math.max(current.length, latest.length);

	for (let i = 0; i < maxLen; i++) {
		const currentPart = current[i];
		const latestPart = latest[i];

		if (currentPart === undefined && latestPart === undefined) return 0;
		if (currentPart === undefined) return 1;
		if (latestPart === undefined) return -1;
		if (currentPart === latestPart) continue;

		const currentIsNumeric = /^\d+$/.test(currentPart);
		const latestIsNumeric = /^\d+$/.test(latestPart);
		if (currentIsNumeric && latestIsNumeric) {
			const currentNum = Number.parseInt(currentPart, 10);
			const latestNum = Number.parseInt(latestPart, 10);
			if (latestNum > currentNum) return 1;
			if (latestNum < currentNum) return -1;
			continue;
		}
		if (currentIsNumeric && !latestIsNumeric) return 1;
		if (!currentIsNumeric && latestIsNumeric) return -1;

		const lexical = latestPart.localeCompare(currentPart, "en", {
			sensitivity: "case",
		});
		if (lexical > 0) return 1;
		if (lexical < 0) return -1;
	}

	return 0;
}

function compareVersions(current: string, latest: string): number {
	const parsedCurrent = parseSemver(current);
	const parsedLatest = parseSemver(latest);

	for (let i = 0; i < parsedCurrent.core.length; i++) {
		const currentPart = parsedCurrent.core[i] ?? 0;
		const latestPart = parsedLatest.core[i] ?? 0;
		if (latestPart > currentPart) return 1;
		if (latestPart < currentPart) return -1;
	}

	const currentHasPrerelease = parsedCurrent.prerelease.length > 0;
	const latestHasPrerelease = parsedLatest.prerelease.length > 0;
	if (!currentHasPrerelease && latestHasPrerelease) return -1;
	if (currentHasPrerelease && !latestHasPrerelease) return 1;
	return comparePrerelease(parsedCurrent.prerelease, parsedLatest.prerelease);
}

async function fetchLatestVersion(
	timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(NPM_REGISTRY_URL, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});

			if (!response.ok) {
				log.debug("Failed to fetch npm registry", { status: response.status });
				return null;
			}

			const data = (await response.json()) as NpmPackageInfo;
			return data.name === PACKAGE_NAME ? data.version ?? null : null;
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		log.debug("Failed to check for updates", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function buildManualUpdateCommand(): string {
	return `npm install -g ${PACKAGE_NAME}@latest`;
}

export function formatManualUpdateNotice(result: UpdateCheckResult): string {
	return [
		`codex-multi-auth update available: v${result.latestVersion}`,
		`current: v${result.currentVersion}`,
		`run: ${result.updateCommand}`,
	].join("; ");
}

export async function checkForUpdates(
	force = false,
	fetchTimeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<UpdateCheckResult> {
	const currentVersion = getCurrentVersion();
	const cache = loadCache();
	const now = Date.now();
	const updateCommand = buildManualUpdateCommand();

	if (
		!force &&
		cache &&
		cache.currentVersion === currentVersion &&
		now - cache.lastCheck < CHECK_INTERVAL_MS
	) {
		const hasUpdate = cache.latestVersion
			? compareVersions(currentVersion, cache.latestVersion) > 0
			: false;
		return {
			hasUpdate,
			currentVersion,
			latestVersion: cache.latestVersion,
			updateCommand,
		};
	}

	const latestVersion = await fetchLatestVersion(fetchTimeoutMs);
	await saveCache({
		lastCheck: now,
		latestVersion,
		currentVersion,
	});

	const hasUpdate = latestVersion
		? compareVersions(currentVersion, latestVersion) > 0
		: false;

	return {
		hasUpdate,
		currentVersion,
		latestVersion,
		updateCommand,
	};
}

export async function checkAndNotify(
	showToast?: (message: string, variant: "info" | "warning") => Promise<void>,
): Promise<void> {
	try {
		const result = await checkForUpdates();

		if (result.hasUpdate && result.latestVersion) {
			const message = formatManualUpdateNotice(result);
			log.info(message);

			if (showToast) {
				await showToast(
					`Plugin update available: v${result.latestVersion}. Run: ${result.updateCommand}`,
					"info",
				);
			}
		}
	} catch (error) {
		log.debug("Update notice check failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function clearUpdateCache(): void {
	void enqueueUpdateCacheWrite(async () => {
		try {
			if (existsSync(CACHE_FILE)) {
				await writeCacheContents("{}");
			}
		} catch {
			// Ignore errors.
		}
	});
}
