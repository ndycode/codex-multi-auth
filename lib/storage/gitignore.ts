import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export async function ensureCodexGitignoreEntry(params: {
	storagePath: string;
	currentProjectRoot: string | null;
	logDebug: (message: string, details: Record<string, unknown>) => void;
	logWarn: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	const configDir = dirname(params.storagePath);
	const inferredProjectRoot = dirname(configDir);
	const candidateRoots = [
		params.currentProjectRoot,
		inferredProjectRoot,
	].filter(
		(root): root is string => typeof root === "string" && root.length > 0,
	);
	const projectRoot = candidateRoots.find((root) =>
		existsSync(join(root, ".git")),
	);
	if (!projectRoot) return;

	const gitignorePath = join(projectRoot, ".gitignore");
	try {
		let content = "";
		if (existsSync(gitignorePath)) {
			content = await fs.readFile(gitignorePath, "utf-8");
			const lines = content.split("\n").map((line) => line.trim());
			if (
				lines.includes(".codex") ||
				lines.includes(".codex/") ||
				lines.includes("/.codex") ||
				lines.includes("/.codex/")
			) {
				return;
			}
		}

		const newContent =
			content.endsWith("\n") || content === "" ? content : `${content}\n`;
		await fs.writeFile(gitignorePath, `${newContent}.codex/\n`, "utf-8");
		params.logDebug("Added .codex to .gitignore", { path: gitignorePath });
	} catch (error) {
		params.logWarn("Failed to update .gitignore", { error: String(error) });
	}
}
