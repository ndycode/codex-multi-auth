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
 * Reads the package version from the repository's nearest package.json.
 *
 * Attempts to load package.json located one level above this module and returns its `version` field.
 * If the file cannot be read or parsed, returns `"0.0.0"`.
 *
 * Notes:
 * - Safe for concurrent calls (read-only filesystem access).
 * - Path resolution is OS-aware (uses the runtime module directory); behavior on Windows follows normal path semantics.
 * - This function returns only the version string and does not expose or redact tokens or other secrets.
 *
 * @returns The package `version` string from package.json, or `"0.0.0"` when unavailable.
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

/**
 * Reads and parses the on-disk update-check cache if it exists.
 *
 * Returns the parsed cache object when the cache file is present and valid JSON; returns `null` if the file is missing or cannot be read/parsed.
 *
 * Notes:
 * - This is a read-only operation and performs no file locking; concurrent writes by other processes can cause this function to return `null`.
 * - Path resolution and platform-specific semantics (Windows paths) are handled by the surrounding code that provides `CACHE_FILE`.
 * - The function does not redact or validate cache contents; callers must ensure no sensitive tokens or secrets are written to the cache.
 *
 * @returns The parsed `UpdateCheckCache`, or `null` if absent or unreadable.
 */
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
 * Persists the update check cache to disk, creating the cache directory if needed.
 *
 * Writes `cache` as prettified JSON to the configured cache file, overwriting any existing file.
 * This function swallows errors and logs a warning on failure.
 *
 * Concurrency: callers should avoid concurrent writes to the cache file (no file-locking is applied).
 * Windows: path creation uses recursive directory creation and works on Windows path semantics.
 * Security: the function does not redact tokens or secrets; callers must ensure `cache` contains no sensitive data.
 *
 * @param cache - The update check cache object to persist (lastCheck, latestVersion, currentVersion)
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
 * Parse a semantic version string into numeric core segments and prerelease identifiers.
 *
 * The function normalizes input by removing a leading `v` and dropping build metadata (the `+` suffix).
 * Non-numeric core segments are treated as `0`. Missing core segments default to `0`. Prerelease identifiers
 * are split on `.` and empty segments are ignored.
 *
 * @param version - The version string to parse (e.g., "v1.2.3-alpha.1+build.123")
 * @returns An object with `core` as `[major, minor, patch]` numbers and `prerelease` as an array of identifier strings
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
 * Determine ordering between two semver prerelease identifier arrays.
 *
 * Compares corresponding prerelease segments using numeric comparison for purely numeric segments and locale-aware lexical comparison for non-numeric segments. Missing segments are considered lower than present segments.
 *
 * @param current - The current version's prerelease segments (e.g., ["alpha", "1"])
 * @param latest - The candidate/latest version's prerelease segments
 * @returns `1` if `latest` is greater, `-1` if `current` is greater, `0` if they are equivalent
 *
 * @remarks
 * - Pure, side-effect free, and safe for concurrent use.
 * - Performs no filesystem or network operations and does not read or redact tokens.
 * - Behavior is consistent across platforms (no Windows-specific filesystem behavior).
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
 * Fetches the latest published version string for the package from the configured NPM registry.
 *
 * Safe to call concurrently — each invocation uses its own AbortController and timer.
 * Performs network I/O only (no filesystem access; Windows path semantics do not apply).
 * No authentication tokens or Authorization headers are sent; logged status codes and error
 * messages are emitted without including sensitive tokens.
 *
 * @returns The latest version string from the registry, or `null` if unavailable.
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
