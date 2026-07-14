/**
 * WSL (Windows Subsystem for Linux) detection.
 *
 * WSL reports `process.platform === "linux"`, so every platform switch in this
 * package treats it as a native Linux host. That is wrong for anything crossing
 * the Windows boundary: the default browser, the clipboard, and the loopback
 * interface that receives the OAuth callback all belong to the Windows host
 * rather than to the distro.
 */

import fs from "node:fs";

let cachedIsWsl: boolean | undefined;

function detectWsl(): boolean {
	if (process.platform !== "linux") return false;

	// Set by WSL itself; present in every interop-enabled distro shell.
	if (
		(process.env.WSL_DISTRO_NAME ?? "").length > 0 ||
		(process.env.WSL_INTEROP ?? "").length > 0
	) {
		return true;
	}

	// Fallback for shells that strip the environment (systemd units, cron).
	try {
		return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}

/**
 * Whether the current process is running inside WSL.
 *
 * The result is cached because it cannot change within a process lifetime.
 */
export function isWsl(): boolean {
	if (cachedIsWsl === undefined) {
		cachedIsWsl = detectWsl();
	}
	return cachedIsWsl;
}

/**
 * The WSL distro name (for example `Debian`), when WSL exposes it.
 *
 * @returns The distro name, or `undefined` outside WSL or when unset.
 */
export function getWslDistroName(): string | undefined {
	if (!isWsl()) return undefined;
	const name = (process.env.WSL_DISTRO_NAME ?? "").trim();
	return name.length > 0 ? name : undefined;
}

/**
 * Clear the memoized {@link isWsl} result.
 *
 * @internal Test seam — production code must not call this.
 */
export function resetWslDetectionCacheForTests(): void {
	cachedIsWsl = undefined;
}
