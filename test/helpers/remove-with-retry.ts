import { promises as fs } from "node:fs";

export async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	const retryable = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!code || !retryable.has(code) || attempt === 5) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
		}
	}
}
