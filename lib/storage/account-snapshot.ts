import type { BackupSnapshotMetadata, SnapshotStats } from "./backup-metadata.js";

/**
 * Read size and mtime metadata for a backup candidate when it exists.
 */
export async function statSnapshot(
	path: string,
	deps: {
		stat: typeof import("node:fs").promises.stat;
		logWarn: (message: string, meta: Record<string, unknown>) => void;
	},
): Promise<SnapshotStats> {
	try {
		const stats = await deps.stat(path);
		return { exists: true, bytes: stats.size, mtimeMs: stats.mtimeMs };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EBUSY" || code === "EPERM") {
			deps.logWarn("Backup candidate is locked", {
				path,
				error: String(error),
			});
			return { exists: true };
		}
		if (code !== "ENOENT") {
			deps.logWarn("Failed to stat backup candidate", {
				path,
				error: String(error),
			});
		}
		return { exists: false };
	}
}

/**
 * Build backup metadata for an account snapshot, treating ENOENT load races as invalid snapshots
 * that were present when the initial stat succeeded.
 */
export async function describeAccountSnapshot(
	path: string,
	kind: BackupSnapshotMetadata["kind"],
	deps: {
		index?: number;
		statSnapshot: (path: string) => Promise<SnapshotStats>;
		loadAccountsFromPath: (path: string) => Promise<{
			normalized: { accounts: unknown[] } | null;
			schemaErrors: string[];
			storedVersion?: unknown;
		}>;
		logWarn: (message: string, meta: Record<string, unknown>) => void;
	},
): Promise<BackupSnapshotMetadata> {
	const stats = await deps.statSnapshot(path);
	if (!stats.exists) {
		return { kind, path, index: deps.index, exists: false, valid: false };
	}
	try {
		const { normalized, schemaErrors, storedVersion } =
			await deps.loadAccountsFromPath(path);
		let resolvedStats = stats;
		for (
			let attempt = 0;
			attempt < 2 &&
			(resolvedStats.bytes === undefined || resolvedStats.mtimeMs === undefined);
			attempt += 1
		) {
			const refreshedStats = await deps.statSnapshot(path);
			if (refreshedStats.exists) {
				resolvedStats = refreshedStats;
			}
		}
		return {
			kind,
			path,
			index: deps.index,
			exists: true,
			valid: !!normalized,
			bytes: resolvedStats.bytes ?? 0,
			mtimeMs: resolvedStats.mtimeMs ?? 0,
			version: typeof storedVersion === "number" ? storedVersion : undefined,
			accountCount: normalized?.accounts.length,
			schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			deps.logWarn("Failed to inspect account snapshot", {
				path,
				error: String(error),
			});
		}
		return {
			kind,
			path,
			index: deps.index,
			exists: true,
			valid: false,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
		};
	}
}
