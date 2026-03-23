import { promises as fs } from "node:fs";
import { AnyAccountStorageSchema, getValidationErrors } from "../schemas.js";
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
	const content = await fs.readFile(path, "utf-8");
	const data = JSON.parse(content) as unknown;
	return parseAndNormalizeStorage(
		data,
		deps.normalizeAccountStorage,
		deps.isRecord,
	);
}
