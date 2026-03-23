import { promises as fs } from "node:fs";

export async function clearAccountStorageArtifacts(params: {
	path: string;
	resetMarkerPath: string;
	walPath: string;
	backupPaths: string[];
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	await fs.writeFile(
		params.resetMarkerPath,
		JSON.stringify({ version: 1, createdAt: Date.now() }),
		{ encoding: "utf-8", mode: 0o600 },
	);
	const clearPath = async (targetPath: string): Promise<void> => {
		try {
			await fs.unlink(targetPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				params.logError("Failed to clear account storage artifact", {
					path: targetPath,
					error: String(error),
				});
			}
		}
	};

	try {
		await Promise.all([
			clearPath(params.path),
			clearPath(params.walPath),
			...params.backupPaths.map(clearPath),
		]);
	} catch {
		// Individual path cleanup is already best-effort with per-artifact logging.
	}
}
