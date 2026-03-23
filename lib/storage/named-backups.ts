import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getNamedBackupRoot } from "../named-backup-export.js";

export interface NamedBackupSummary {
	path: string;
	fileName: string;
	accountCount: number;
	mtimeMs: number;
}

export async function collectNamedBackups(
	storagePath: string,
	deps: {
		loadAccountsFromPath: (
			path: string,
		) => Promise<{ normalized: { accounts: unknown[] } | null }>;
		logDebug: (message: string, details: Record<string, unknown>) => void;
	},
): Promise<NamedBackupSummary[]> {
	const backupRoot = getNamedBackupRoot(storagePath);
	let entries: Array<{ isFile(): boolean; name: string }>;
	try {
		entries = await fs.readdir(backupRoot, {
			withFileTypes: true,
			encoding: "utf8",
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw error;
	}

	const candidates: NamedBackupSummary[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.toLowerCase().endsWith(".json")) continue;
		const candidatePath = join(backupRoot, entry.name);
		try {
			const statsBefore = await fs.stat(candidatePath);
			const { normalized } = await deps.loadAccountsFromPath(candidatePath);
			if (!normalized || normalized.accounts.length === 0) continue;
			const statsAfter = await fs.stat(candidatePath).catch(() => null);
			if (statsAfter && statsAfter.mtimeMs !== statsBefore.mtimeMs) {
				deps.logDebug(
					"backup file changed between stat and load, mtime may be stale",
					{
						candidatePath,
						fileName: entry.name,
						beforeMtimeMs: statsBefore.mtimeMs,
						afterMtimeMs: statsAfter.mtimeMs,
					},
				);
			}
			candidates.push({
				path: candidatePath,
				fileName: entry.name,
				accountCount: normalized.accounts.length,
				mtimeMs: statsBefore.mtimeMs,
			});
		} catch (error) {
			deps.logDebug(
				"Skipping named backup candidate after loadAccountsFromPath/fs.stat failure",
				{
					candidatePath,
					fileName: entry.name,
					error:
						error instanceof Error
							? {
									message: error.message,
									stack: error.stack,
								}
							: String(error),
				},
			);
		}
	}

	candidates.sort((left, right) => {
		const mtimeDelta = right.mtimeMs - left.mtimeMs;
		if (mtimeDelta !== 0) return mtimeDelta;
		return left.fileName.localeCompare(right.fileName);
	});
	return candidates;
}
