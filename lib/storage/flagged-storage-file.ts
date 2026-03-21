import type { FlaggedAccountStorageV1 } from "../storage.js";
import { sleep } from "../utils.js";

const RETRYABLE_READ_CODES = new Set(["EBUSY", "EPERM", "EAGAIN"]);

function isRetryableReadError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_READ_CODES.has(code);
}

async function readFileWithRetry(
	path: string,
	deps: {
		readFile: typeof import("node:fs").promises.readFile;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<string> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await deps.readFile(path, "utf-8");
		} catch (error) {
			if (!isRetryableReadError(error) || attempt >= 3) {
				throw error;
			}
			await (deps.sleep ?? sleep)(10 * 2 ** attempt);
		}
	}
}

export async function loadFlaggedAccountsFromFile(
	path: string,
	deps: {
		readFile: typeof import("node:fs").promises.readFile;
		normalizeFlaggedStorage: (data: unknown) => FlaggedAccountStorageV1;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<FlaggedAccountStorageV1> {
	const content = await readFileWithRetry(path, deps);
	const data = JSON.parse(content) as unknown;
	return deps.normalizeFlaggedStorage(data);
}
