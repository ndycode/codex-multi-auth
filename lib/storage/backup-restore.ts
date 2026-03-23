import { isAbsolute, relative } from "node:path";
import type { AccountStorageV3 } from "../storage.js";

export async function restoreAccountsFromBackupPath(
	path: string,
	options: {
		persist?: boolean;
		backupRoot: string;
		realpath: (path: string) => Promise<string>;
		loadAccountsFromPath: (path: string) => Promise<{
			normalized: AccountStorageV3 | null;
		}>;
		saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	},
): Promise<AccountStorageV3> {
	let resolvedBackupRoot: string;
	try {
		resolvedBackupRoot = await options.realpath(options.backupRoot);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`Backup root does not exist: ${options.backupRoot}`);
		}
		throw error;
	}

	let resolvedBackupPath: string;
	try {
		resolvedBackupPath = await options.realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`Backup file no longer exists: ${path}`);
		}
		throw error;
	}

	const relativePath = relative(resolvedBackupRoot, resolvedBackupPath);
	const isInsideBackupRoot =
		relativePath.length > 0 &&
		!relativePath.startsWith("..") &&
		!isAbsolute(relativePath);
	if (!isInsideBackupRoot) {
		throw new Error(
			`Backup path must stay inside ${resolvedBackupRoot}: ${path}`,
		);
	}

	const { normalized } = await (async () => {
		try {
			return await options.loadAccountsFromPath(resolvedBackupPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new Error(`Backup file no longer exists: ${path}`);
			}
			throw error;
		}
	})();

	if (!normalized || normalized.accounts.length === 0) {
		throw new Error(
			`Backup does not contain any accounts: ${resolvedBackupPath}`,
		);
	}

	if (options.persist !== false) {
		await options.saveAccounts(normalized);
	}
	return normalized;
}
