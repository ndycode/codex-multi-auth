import { join } from "node:path";

export const RUNTIME_ROTATION_PROXY_PROVIDER_ID =
	"codex-multi-auth-runtime-proxy" as const;

export const APP_RUNTIME_HELPER_STATUS_FILE =
	"runtime-rotation-app-helper.json" as const;

/** Immutable launcher metadata used to verify ownership before stopping a helper. */
export const APP_RUNTIME_HELPER_OWNER_FILE =
	"runtime-rotation-app-helper-owner.json" as const;

/**
 * The one place the per-PID filename shape is written down:
 * `<base-without-.json>.<pid>.json`, matched case-insensitively with the PID
 * captured. Status files and owner files share that shape, and so does the
 * launcher-side sweep in `scripts/codex.js` — that file re-derives the pattern
 * from the same two constants because it has to keep working before `dist/` is
 * built, so a change to the shape here is a change there too.
 */
export function runtimeHelperPerPidPattern(baseName: string): RegExp {
	const prefix = baseName.replace(/\.json$/i, "");
	return new RegExp(
		`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.json$`,
		"i",
	);
}

/**
 * Every path a helper status record can live at: the per-PID files
 * (`runtime-rotation-app-helper.<pid>.json`, one per helper) plus the
 * un-suffixed legacy shared path from before the per-PID change, which is
 * still read so a pre-upgrade helper stays visible. The filename contract
 * lives here, next to the constant it derives from, so every reader agrees
 * on it; callers supply the directory listing so this stays pure and their
 * own error handling for the `readdir` stays theirs.
 */
export function listRuntimeHelperStatusPaths(
	baseDir: string,
	entries: readonly string[],
): string[] {
	const perPidPattern = runtimeHelperPerPidPattern(
		APP_RUNTIME_HELPER_STATUS_FILE,
	);
	return [
		...entries
			.filter((name) => perPidPattern.test(name))
			.map((name) => join(baseDir, name)),
		join(baseDir, APP_RUNTIME_HELPER_STATUS_FILE),
	];
}

/**
 * Owner files paired with the helper PID they belong to. Unbind used to
 * enumerate status files only, so an owner file whose status record had
 * already been removed could never be rediscovered and accumulated under the
 * multi-auth root forever (#666). Enumerating both is what lets a cleanup pass
 * reclaim an owner file that outlived its status record.
 */
export function listRuntimeHelperOwnerPaths(
	baseDir: string,
	entries: readonly string[],
): { path: string; pid: number }[] {
	const perPidPattern = runtimeHelperPerPidPattern(
		APP_RUNTIME_HELPER_OWNER_FILE,
	);
	const owners: { path: string; pid: number }[] = [];
	for (const name of entries) {
		const match = perPidPattern.exec(name);
		const captured = match?.[1];
		if (captured === undefined) continue;
		const pid = Number.parseInt(captured, 10);
		if (!Number.isInteger(pid) || pid < 1) continue;
		owners.push({ path: join(baseDir, name), pid });
	}
	return owners;
}

/** Marker shared by config binding and desktop-auth sync protection. */
export const NATIVE_PROVIDER_BEGIN = "# codex-multi-auth native provider begin";
export function hasNativeProviderConfig(content: string): boolean {
	return content.split(/\r?\n/).some(line => line.trim() === NATIVE_PROVIDER_BEGIN);
}
