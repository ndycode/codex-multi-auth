import { existsSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AccountStorageV3 } from "../storage.js";

const EXPORT_RENAME_MAX_ATTEMPTS = 4;
const EXPORT_RENAME_BASE_DELAY_MS = 25;

async function renameExportFileWithRetry(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	for (let attempt = 0; attempt < EXPORT_RENAME_MAX_ATTEMPTS; attempt += 1) {
		try {
			await fs.rename(sourcePath, destinationPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const canRetry =
				(code === "EPERM" || code === "EBUSY" || code === "EAGAIN") &&
				attempt + 1 < EXPORT_RENAME_MAX_ATTEMPTS;
			if (!canRetry) {
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, EXPORT_RENAME_BASE_DELAY_MS * 2 ** attempt),
			);
		}
	}
}

export async function exportAccountsToFile(params: {
	resolvedPath: string;
	force: boolean;
	storage: AccountStorageV3 | null;
	beforeCommit?: (resolvedPath: string) => Promise<void> | void;
	logInfo: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	if (!params.force && existsSync(params.resolvedPath)) {
		throw new Error(`File already exists: ${params.resolvedPath}`);
	}
	if (!params.storage || params.storage.accounts.length === 0) {
		throw new Error("No accounts to export");
	}

	await fs.mkdir(dirname(params.resolvedPath), { recursive: true });
	await params.beforeCommit?.(params.resolvedPath);
	if (!params.force && existsSync(params.resolvedPath)) {
		throw new Error(`File already exists: ${params.resolvedPath}`);
	}

	const content = JSON.stringify(
		{
			version: params.storage.version,
			accounts: params.storage.accounts,
			activeIndex: params.storage.activeIndex,
			activeIndexByFamily: params.storage.activeIndexByFamily,
		},
		null,
		2,
	);
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${params.resolvedPath}.${uniqueSuffix}.tmp`;
	try {
		await fs.writeFile(tempPath, content, {
			encoding: "utf-8",
			mode: 0o600,
		});
		await renameExportFileWithRetry(tempPath, params.resolvedPath);
	} catch (error) {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Ignore cleanup failures for staged export files.
		}
		throw error;
	}
	params.logInfo("Exported accounts", {
		path: params.resolvedPath,
		count: params.storage.accounts.length,
	});
}

export async function readImportFile(params: {
	resolvedPath: string;
	normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
}): Promise<AccountStorageV3> {
	if (!existsSync(params.resolvedPath)) {
		throw new Error(`Import file not found: ${params.resolvedPath}`);
	}

	const content = await fs.readFile(params.resolvedPath, "utf-8");
	let imported: unknown;
	try {
		imported = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in import file: ${params.resolvedPath}`);
	}

	const normalized = params.normalizeAccountStorage(imported);
	if (!normalized) {
		throw new Error("Invalid account storage format");
	}
	return normalized;
}

export function mergeImportedAccounts(params: {
	existing: AccountStorageV3 | null;
	imported: AccountStorageV3;
	maxAccounts: number;
	deduplicateAccounts: (
		accounts: AccountStorageV3["accounts"],
	) => AccountStorageV3["accounts"];
}): {
	newStorage: AccountStorageV3;
	imported: number;
	total: number;
	skipped: number;
} {
	const existingAccounts = params.existing?.accounts ?? [];
	const existingActiveIndex = params.existing?.activeIndex ?? 0;
	const merged = [...existingAccounts, ...params.imported.accounts];

	if (merged.length > params.maxAccounts) {
		const deduped = params.deduplicateAccounts(merged);
		if (deduped.length > params.maxAccounts) {
			throw new Error(
				`Import would exceed maximum of ${params.maxAccounts} accounts (would have ${deduped.length})`,
			);
		}
	}

	const deduplicatedAccounts = params.deduplicateAccounts(merged);
	const newStorage: AccountStorageV3 = {
		version: 3,
		accounts: deduplicatedAccounts,
		activeIndex: existingActiveIndex,
		activeIndexByFamily: params.existing?.activeIndexByFamily,
	};
	const importedCount = deduplicatedAccounts.length - existingAccounts.length;
	const skippedCount = params.imported.accounts.length - importedCount;
	return {
		newStorage,
		imported: importedCount,
		total: deduplicatedAccounts.length,
		skipped: skippedCount,
	};
}
