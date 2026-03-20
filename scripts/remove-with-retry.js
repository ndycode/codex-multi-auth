import { promises as fs } from "node:fs";

/**
 * Retry-capable fs.rm for Windows EBUSY/EPERM/ENOTEMPTY errors.
 * Uses linear backoff (attempt * 50ms) with up to 5 retries.
 */
export async function removeWithRetry(targetPath, options) {
	const retryableCodes = new Set(["ENOTEMPTY", "EPERM", "EBUSY", "EACCES"]);
	const maxAttempts = 6;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			const shouldRetry = code !== undefined && retryableCodes.has(code);
			if (!shouldRetry || attempt === maxAttempts) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 50));
		}
	}
}
