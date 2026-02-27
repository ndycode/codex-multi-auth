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

    const lexical = latestPart.localeCompare(currentPart, "en", { sensitivity: "case" });
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

  if (!currentHasPrerelease && latestHasPrerelease) {
    return -1;
  }
  if (currentHasPrerelease && !latestHasPrerelease) {
    return 1;
  }

  return comparePrerelease(parsedCurrent.prerelease, parsedLatest.prerelease);
}

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
