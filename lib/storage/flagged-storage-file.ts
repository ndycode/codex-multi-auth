import { FlaggedAccountStorageV1Schema, safeParseJson } from "../schemas.js";
import type { FlaggedAccountStorageV1 } from "./public-types.js";
import { sleep } from "../utils.js";

// Include EPERM: on Windows, antivirus + file-indexing briefly take an
// exclusive lock on recently-written files, producing EPERM on the reader's
// next open. The write side of this module already retries EBUSY/EPERM, so
// the read side must match or the flagged-state reader fails prematurely and
// triggers unnecessary empty/backup fallbacks (AUDIT-M05 / E-08).
const RETRYABLE_READ_CODES = new Set(["EBUSY", "EPERM", "EAGAIN"]);

function isRetryableReadError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_READ_CODES.has(code);
}

export async function readFileWithRetry(
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
	// Fail-closed JSON boundary: Zod is the primary validator. On happy path
	// the validated payload flows straight to the TS normalizer (Zod wins).
	// On schema or syntax failure we fall through to `JSON.parse` so:
	//   - structurally-unknown legacy payloads still reach the normalizer, and
	//   - `SyntaxError` continues to propagate to outer callers in
	//     `flagged-storage-io.ts`, which log + fall back to backups.
	const validated = safeParseJson(
		content,
		FlaggedAccountStorageV1Schema,
		"storage.loadFlaggedAccountsFromFile",
	);
	if (validated !== null) {
		return deps.normalizeFlaggedStorage(validated);
	}
	const data = JSON.parse(content) as unknown;
	return deps.normalizeFlaggedStorage(data);
}
