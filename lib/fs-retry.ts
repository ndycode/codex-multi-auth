export const FILE_RETRY_CODES = new Set([
	"EBUSY",
	"EPERM",
	"EAGAIN",
	"ENOTEMPTY",
	"EACCES",
]);
export const FILE_RETRY_MAX_ATTEMPTS = 6;
export const FILE_RETRY_BASE_DELAY_MS = 25;
export const FILE_RETRY_JITTER_MS = 20;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryFileOperation(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		FILE_RETRY_CODES.has(error.code)
	);
}

export async function withFileOperationRetry<T>(
	operation: () => Promise<T>,
): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!shouldRetryFileOperation(error) || attempt >= FILE_RETRY_MAX_ATTEMPTS) {
				throw error;
			}
			const delayMs =
				FILE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) +
				Math.floor(Math.random() * FILE_RETRY_JITTER_MS);
			await sleep(delayMs);
		}
	}
}
