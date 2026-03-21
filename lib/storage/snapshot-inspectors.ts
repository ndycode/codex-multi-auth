import type { FlaggedAccountStorageV1 } from "../storage.js";
import type { BackupSnapshotMetadata } from "./backup-metadata.js";

type SnapshotStats = {
	exists: boolean;
	bytes?: number;
	mtimeMs?: number;
};

export async function describeAccountsWalSnapshot(
	path: string,
	deps: {
		statSnapshot: (path: string) => Promise<SnapshotStats>;
		readFile: typeof import("node:fs").promises.readFile;
		isRecord: (value: unknown) => boolean;
		computeSha256: (content: string) => string;
		parseAndNormalizeStorage: (data: unknown) => {
			normalized: { accounts: unknown[] } | null;
			storedVersion?: unknown;
			schemaErrors: string[];
		};
	},
): Promise<BackupSnapshotMetadata> {
	const stats = await deps.statSnapshot(path);
	if (!stats.exists) {
		return { kind: "accounts-wal", path, exists: false, valid: false };
	}
	try {
		const raw = await deps.readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!deps.isRecord(parsed)) {
			return {
				kind: "accounts-wal",
				path,
				exists: true,
				valid: false,
				bytes: stats.bytes,
				mtimeMs: stats.mtimeMs,
			};
		}
		const entry = parsed as Partial<{
			version: 1;
			content: string;
			checksum: string;
		}>;
		if (
			entry.version !== 1 ||
			typeof entry.content !== "string" ||
			typeof entry.checksum !== "string" ||
			deps.computeSha256(entry.content) !== entry.checksum
		) {
			return {
				kind: "accounts-wal",
				path,
				exists: true,
				valid: false,
				bytes: stats.bytes,
				mtimeMs: stats.mtimeMs,
			};
		}
		const { normalized, storedVersion, schemaErrors } =
			deps.parseAndNormalizeStorage(JSON.parse(entry.content) as unknown);
		return {
			kind: "accounts-wal",
			path,
			exists: true,
			valid: !!normalized,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
			version: typeof storedVersion === "number" ? storedVersion : undefined,
			accountCount: normalized?.accounts.length,
			schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
		};
	} catch {
		return {
			kind: "accounts-wal",
			path,
			exists: true,
			valid: false,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
		};
	}
}

export async function describeFlaggedSnapshot(
	path: string,
	kind: BackupSnapshotMetadata["kind"],
	deps: {
		index?: number;
		statSnapshot: (path: string) => Promise<SnapshotStats>;
		loadFlaggedAccountsFromPath: (
			path: string,
		) => Promise<FlaggedAccountStorageV1>;
		logWarn?: (message: string, meta: Record<string, unknown>) => void;
	},
): Promise<BackupSnapshotMetadata> {
	const stats = await deps.statSnapshot(path);
	if (!stats.exists) {
		return { kind, path, index: deps.index, exists: false, valid: false };
	}
	try {
		const storage = await deps.loadFlaggedAccountsFromPath(path);
		return {
			kind,
			path,
			index: deps.index,
			exists: true,
			valid: true,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
			version: storage.version,
			flaggedCount: storage.accounts.length,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			deps.logWarn?.("Failed to inspect flagged snapshot", {
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
