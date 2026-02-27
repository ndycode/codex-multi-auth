import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { getCodexCacheDir } from "./runtime-paths.js";

const log = createLogger("update-checker");

const PACKAGE_NAME = "codex-multi-auth";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_DIR = getCodexCacheDir();
const CACHE_FILE = join(CACHE_DIR, "update-check-cache.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

/**
 * Reads the package.json located one directory above this module and returns its version string.
 *
 * The function performs a synchronous file read and parse; if the file cannot be accessed or parsed it returns "0.0.0".
 * It uses import.meta.dirname when available and falls back to __dirname for environments where that is required (including Windows/CommonJS interop).
 *
 * Concurrency: the synchronous filesystem call blocks the event loop briefly but is safe to invoke from multiple callers.
 *
 * @returns The package version string, or "0.0.0" when the version cannot be determined.
 */
function getCurrentVersion(): string {
  try {
    const packageJsonPath = join(import.meta.dirname ?? __dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    return packageJson.version;
  } catch {
    return "0.0.0";
  }
}

function loadCache(): UpdateCheckCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const content = readFileSync(CACHE_FILE, "utf8");
    return JSON.parse(content) as UpdateCheckCache;
  } catch {
    return null;
  }
}

/**
 * Persists the update-check cache to disk, creating the cache directory if it does not exist.
 *
 * Writes `cache` to the configured cache file as pretty-printed JSON. On failure the error is logged and the function returns without throwing.
 *
 * @param cache - Cache object containing `lastCheck`, `latestVersion`, and `currentVersion`
 *
 * Concurrency: no locking is performed; concurrent writers may race and last write wins.
 * Windows: directory creation and file writes follow Node's fs semantics on Windows.
 * Redaction: the cache is not expected to contain sensitive tokens; logged error messages will include only the error message, not file contents.
 */
function saveCache(cache: UpdateCheckCache): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (error) {
    log.warn("Failed to save update cache", { error: (error as Error).message });
  }
}

/**
 * Parse a semantic-version string into numeric core components and prerelease segments.
 *
 * Accepts versions with an optional leading "v", build metadata (after "+"), and prerelease (after "-").
 * The core is returned as [major, minor, patch] with non-numeric or missing parts coerced to 0.
 * The prerelease is returned as an array of dot-separated segments (strings); an empty array indicates a release.
 *
 * This function is pure and safe for concurrent use. It does not access the filesystem, does not perform
 * network calls, and does not perform any token redaction or exposure.
 *
 * @param version - The semver string to parse (for example "v1.2.3", "1.2.3-alpha.1+build.5")
 * @returns An object with `core` set to numeric [major, minor, patch] and `prerelease` set to an array of prerelease segments
 */
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

/**
 * Compare two prerelease identifier arrays to determine which represents a newer prerelease.
 *
 * @param current - Prerelease segments from the current version (e.g., `["alpha", "1"]`)
 * @param latest - Prerelease segments from the latest version to compare against
 * @returns `1` if `latest` is newer than `current`, `-1` if `current` is newer, `0` if they are equivalent
 */
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

    const lexical = latestPart.localeCompare(currentPart, "en", { sensitivity: "case" });
    if (lexical > 0) return 1;
    if (lexical < 0) return -1;
  }

  return 0;
}

/**
 * Compare two semantic version strings and determine which is newer.
 *
 * @param current - The currently installed version (semver string; may start with "v" and may include build metadata)
 * @param latest - The candidate version to compare against (semver string; may start with "v" and may include build metadata)
 * @returns `1` if `latest` is newer than `current`, `-1` if `current` is newer than `latest`, `0` if they are equivalent
 *
 * Notes: pure and safe for concurrent use; does not perform I/O. Version parsing tolerates non-numeric segments by coercion. Safe on Windows filesystems and does not read or emit sensitive tokens.
 */
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

  if (!currentHasPrerelease && latestHasPrerelease) {
    return -1;
  }
  if (currentHasPrerelease && !latestHasPrerelease) {
    return 1;
  }

  return comparePrerelease(parsedCurrent.prerelease, parsedLatest.prerelease);
}

/**
 * Fetches the latest published version string for the package from the npm registry.
 *
 * Callers may invoke this concurrently; each call issues an independent HTTP request.
 * This function performs no filesystem I/O (so Windows filesystem semantics are not applicable)
 * and does not process or emit authentication tokens.
 *
 * @returns The latest version string from the registry, or `null` if the registry could not be reached, returned a non-OK response, or the version field was absent.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.debug("Failed to fetch npm registry", { status: response.status });
      return null;
    }

    const data = (await response.json()) as NpmPackageInfo;
    return data.version ?? null;
  } catch (error) {
    log.debug("Failed to check for updates", { error: (error as Error).message });
    return null;
  }
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateCommand: string;
}

export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();
  const cache = loadCache();
  const now = Date.now();

  if (!force && cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
    const hasUpdate = cache.latestVersion ? compareVersions(currentVersion, cache.latestVersion) > 0 : false;
    return {
      hasUpdate,
      currentVersion,
      latestVersion: cache.latestVersion,
      updateCommand: `npm update -g ${PACKAGE_NAME}`,
    };
  }

  const latestVersion = await fetchLatestVersion();

  saveCache({
    lastCheck: now,
    latestVersion,
    currentVersion,
  });

  const hasUpdate = latestVersion ? compareVersions(currentVersion, latestVersion) > 0 : false;

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    updateCommand: `npm update -g ${PACKAGE_NAME}`,
  };
}

export async function checkAndNotify(
  showToast?: (message: string, variant: "info" | "warning") => Promise<void>,
): Promise<void> {
  try {
    const result = await checkForUpdates();

    if (result.hasUpdate && result.latestVersion) {
      const message = `Update available: ${PACKAGE_NAME} v${result.latestVersion} (current: v${result.currentVersion})`;
      log.info(message);

      if (showToast) {
        await showToast(
          `Plugin update available: v${result.latestVersion}. Run: ${result.updateCommand}`,
          "info",
        );
      }
    }
  } catch (error) {
    log.debug("Update check failed", { error: (error as Error).message });
  }
}

export function clearUpdateCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      writeFileSync(CACHE_FILE, "{}", "utf8");
    }
  } catch {
    // Ignore errors
  }
}
