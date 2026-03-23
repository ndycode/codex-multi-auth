import type { FlaggedAccountStorageV1 } from "../storage.js";

export async function loadFlaggedAccountsFromFile(
	path: string,
	deps: {
		readFile: typeof import("node:fs").promises.readFile;
		normalizeFlaggedStorage: (data: unknown) => FlaggedAccountStorageV1;
	},
): Promise<FlaggedAccountStorageV1> {
	const content = await deps.readFile(path, "utf-8");
	const data = JSON.parse(content) as unknown;
	return deps.normalizeFlaggedStorage(data);
}
