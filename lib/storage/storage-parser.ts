import { promises as fs } from "node:fs";
import {
	AnyAccountStorageSchema,
	getValidationErrors,
	safeParseJson,
} from "../schemas.js";
import { withFileOperationRetry } from "../fs-retry.js";
import type { AccountStorageV3 } from "../storage.js";

export function parseAndNormalizeStorage(
	data: unknown,
	normalizeAccountStorage: (data: unknown) => AccountStorageV3 | null,
	isRecord: (value: unknown) => value is Record<string, unknown>,
): {
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
} {
	const schemaErrors = getValidationErrors(AnyAccountStorageSchema, data);
	const normalized = normalizeAccountStorage(data);
	const storedVersion = isRecord(data)
		? (data as { version?: unknown }).version
		: undefined;
	return { normalized, storedVersion, schemaErrors };
}

/**
 * Load account storage from disk through the Zod-guarded JSON boundary.
 *
 * Semantics:
 * - `fs.readFile` errors (ENOENT, etc.) still propagate unchanged.
 * - `SyntaxError` from `JSON.parse` is also re-thrown unchanged. Callers in
 *   `lib/storage.ts` (`loadAccountsInternal`, `loadAccountsFromJournal`,
 *   `diagnoseStorageHealth`, backup recovery) rely on `SyntaxError` to trigger
 *   WAL / backup recovery paths. Converting parse failures to `null` would
 *   silently skip recovery and is explicitly preserved as a throw contract.
 * - On happy path, Zod is the authoritative normalizer: `AnyAccountStorageSchema`
 *   validates the on-disk shape before `parseAndNormalizeStorage` runs.
 * - When JSON parses cleanly but violates `AnyAccountStorageSchema`, we still
 *   fall back through the TS-side `normalizeAccountStorage` so legacy
 *   unknown-shape files can be surfaced with schema warnings (non-zero
 *   `schemaErrors`).
 */
export async function loadAccountsFromPath(
	path: string,
	deps: {
		normalizeAccountStorage: (data: unknown) => AccountStorageV3 | null;
		isRecord: (value: unknown) => value is Record<string, unknown>;
	},
): Promise<{
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
}> {
	// Retry only transient FS lock errors (EBUSY/EPERM/EACCES/…) on the primary
	// read so a momentary Windows lock doesn't fall through to WAL/backup recovery
	// (storage-01). ENOENT is not a retryable code, so the missing-file contract is
	// unchanged; JSON.parse runs outside the retry, so the SyntaxError → recovery
	// contract documented above is also preserved.
	const content = await withFileOperationRetry(() => fs.readFile(path, "utf-8"));

	// Run the Zod-guarded JSON boundary first. Returns null on either a
	// `SyntaxError` or a schema mismatch; we disambiguate below so the
	// `SyntaxError` contract keeps propagating to callers that rely on it
	// for WAL / backup recovery.
	const validated = safeParseJson(
		content,
		AnyAccountStorageSchema,
		"storage-parser.loadAccountsFromPath",
	);
	if (validated !== null) {
		return parseAndNormalizeStorage(
			validated,
			deps.normalizeAccountStorage,
			deps.isRecord,
		);
	}

	// `validated === null`: either SyntaxError or schema mismatch.
	// A raw JSON.parse distinguishes them: SyntaxError propagates to preserve
	// existing recovery semantics; otherwise fall through to the TS normalizer
	// (legacy unknown-shape path, surfaced via `schemaErrors`).
	const data = JSON.parse(content) as unknown;
	return parseAndNormalizeStorage(
		data,
		deps.normalizeAccountStorage,
		deps.isRecord,
	);
}
