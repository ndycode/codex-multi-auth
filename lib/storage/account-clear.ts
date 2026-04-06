import { promises as fs } from "node:fs";

export async function clearAccountStorageArtifacts(params: {
	path: string;
	resetMarkerPath: string;
	walPath: string;
	backupPaths: string[];
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	const clearPath = async (
		targetPath: string,
		required: boolean,
	): Promise<void> => {
		try {
			await fs.unlink(targetPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return;
			}
			if (required) {
				params.logError("Failed to clear account storage artifact", {
					path: targetPath,
					error: String(error),
				});
				throw error;
			}
			params.logError("Failed to clear account storage artifact", {
				path: targetPath,
				error: String(error),
			});
		}
	};

	await clearPath(params.path, true);
	await clearPath(params.walPath, true);
	await fs.writeFile(
		params.resetMarkerPath,
		JSON.stringify({ version: 1, createdAt: Date.now() }),
		{ encoding: "utf-8", mode: 0o600 },
	);
	for (const backupPath of params.backupPaths) {
		try {
			await clearPath(backupPath, false);
		} catch {
			// Non-critical artifacts are already logged best-effort.
		}
	}
}
