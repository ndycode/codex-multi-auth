import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerDebugMock, loggerWarnMock } = vi.hoisted(() => ({
	loggerDebugMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
	createLogger: vi.fn(() => ({
		debug: loggerDebugMock,
		info: vi.fn(),
		warn: loggerWarnMock,
		error: vi.fn(),
	})),
	logWarn: vi.fn(),
}));

import {
	buildNamedBackupPath,
	getNamedBackups,
	loadAccounts,
	restoreAccountsFromBackup,
	saveAccounts,
	setStoragePathDirect,
} from "../lib/storage.js";

async function removeWithRetry(
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
			if (code === "ENOENT") return;
			if (!code || !retryable.has(code) || attempt === 5) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("storage last backup restore", () => {
	const testRoot = join(
		tmpdir(),
		`codex-last-backup-${Math.random().toString(36).slice(2)}`,
	);
	let storagePath: string;

	beforeEach(async () => {
		loggerDebugMock.mockReset();
		loggerWarnMock.mockReset();
		await fs.mkdir(testRoot, { recursive: true });
		storagePath = join(testRoot, "openai-codex-accounts.json");
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await removeWithRetry(testRoot, { recursive: true, force: true });
	});

	it("returns an empty array when the named backups directory is missing", async () => {
		await expect(getNamedBackups()).resolves.toEqual([]);
	});

	it("returns an empty array when every named backup has zero accounts", async () => {
		const emptyOnePath = buildNamedBackupPath("empty-one");
		const emptyTwoPath = buildNamedBackupPath("empty-two");
		await fs.mkdir(dirname(emptyOnePath), { recursive: true });
		for (const backupPath of [emptyOnePath, emptyTwoPath]) {
			await fs.writeFile(
				backupPath,
				JSON.stringify({
					version: 3,
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
					accounts: [],
				}),
				"utf-8",
			);
		}

		await expect(getNamedBackups()).resolves.toEqual([]);
	});

	it("prefers the most recently modified valid named backup with accounts", async () => {
		const oldBackupPath = buildNamedBackupPath("backup-old");
		const newBackupPath = buildNamedBackupPath("backup-new");
		await fs.mkdir(dirname(oldBackupPath), { recursive: true });
		await fs.writeFile(
			oldBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "old-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await fs.writeFile(
			newBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{ refreshToken: "new-refresh-1", addedAt: 1, lastUsed: 1 },
					{ refreshToken: "new-refresh-2", addedAt: 2, lastUsed: 2 },
				],
			}),
			"utf-8",
		);
		await fs.utimes(oldBackupPath, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));
		await fs.utimes(newBackupPath, new Date("2026-03-02T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z"));

		const backups = await getNamedBackups();

		expect(backups[0]).toMatchObject({
			path: newBackupPath,
			fileName: "backup-new.json",
			accountCount: 2,
		});

		expect(backups.map((backup) => backup.fileName)).toEqual([
			"backup-new.json",
			"backup-old.json",
		]);
	});

	it("breaks backup mtime ties with a deterministic file-name order", async () => {
		const alphaBackupPath = buildNamedBackupPath("backup-alpha");
		const betaBackupPath = buildNamedBackupPath("backup-beta");
		await fs.mkdir(dirname(alphaBackupPath), { recursive: true });
		for (const backupPath of [betaBackupPath, alphaBackupPath]) {
			await fs.writeFile(
				backupPath,
				JSON.stringify({
					version: 3,
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
					accounts: [{ refreshToken: `${backupPath}-refresh`, addedAt: 1, lastUsed: 1 }],
				}),
				"utf-8",
			);
			await fs.utimes(
				backupPath,
				new Date("2026-03-04T00:00:00.000Z"),
				new Date("2026-03-04T00:00:00.000Z"),
			);
		}

		const backups = await getNamedBackups();

		expect(backups.map((backup) => backup.fileName)).toEqual([
			"backup-alpha.json",
			"backup-beta.json",
		]);
	});

	it("logs when a named backup changes between stat and load", async () => {
		const backupPath = buildNamedBackupPath("backup-racy");
		const initialMtime = new Date("2026-03-05T00:00:00.000Z");
		const updatedMtime = new Date("2026-03-05T00:00:05.000Z");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "racy-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await fs.utimes(backupPath, initialMtime, initialMtime);

		const originalStat = fs.stat.bind(fs);
		let targetStatCalls = 0;
		const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
			if (String(path) === backupPath) {
				targetStatCalls += 1;
				if (targetStatCalls === 2) {
					await fs.utimes(backupPath, updatedMtime, updatedMtime);
				}
			}
			return originalStat(
				path as Parameters<typeof originalStat>[0],
				options as Parameters<typeof originalStat>[1],
			);
		});

		try {
			const backups = await getNamedBackups();
			expect(backups[0]?.mtimeMs).toBe(initialMtime.getTime());
			expect(loggerDebugMock).toHaveBeenCalledWith(
				"backup file changed between stat and load, mtime may be stale",
				expect.objectContaining({
					candidatePath: backupPath,
					fileName: "backup-racy.json",
					beforeMtimeMs: initialMtime.getTime(),
					afterMtimeMs: updatedMtime.getTime(),
				}),
			);
		} finally {
			statSpy.mockRestore();
		}
	});

	it("ignores non-json files and subdirectories in the backup root", async () => {
		const backupPath = buildNamedBackupPath("real-backup");
		const backupRoot = dirname(backupPath);
		await fs.mkdir(backupRoot, { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "real-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await fs.writeFile(join(backupRoot, "sidecar.tmp"), "lock", "utf-8");
		await fs.writeFile(join(backupRoot, "notes.bak"), "ignored", "utf-8");
		await fs.mkdir(join(backupRoot, "subdir"), { recursive: true });

		const backups = await getNamedBackups();

		expect(backups).toHaveLength(1);
		expect(backups[0]?.fileName).toBe("real-backup.json");
	});

	it("skips a backup that disappears before stat and falls back to the next valid backup", async () => {
		const flakyBackupPath = buildNamedBackupPath("backup-flaky");
		const stableBackupPath = buildNamedBackupPath("backup-stable");
		await fs.mkdir(dirname(flakyBackupPath), { recursive: true });
		await fs.writeFile(
			flakyBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "flaky-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await fs.writeFile(
			stableBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "stable-refresh", addedAt: 2, lastUsed: 2 }],
			}),
			"utf-8",
		);
		await fs.utimes(flakyBackupPath, new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-03T00:00:00.000Z"));
		await fs.utimes(stableBackupPath, new Date("2026-03-02T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z"));

		const originalStat = fs.stat.bind(fs);
		const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
			if (String(path) === flakyBackupPath) {
				await removeWithRetry(flakyBackupPath, { force: true });
				const error = new Error(
					`ENOENT: no such file or directory, stat '${flakyBackupPath}'`,
				) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return originalStat(
				path as Parameters<typeof originalStat>[0],
				options as Parameters<typeof originalStat>[1],
			);
		});

		try {
			const backups = await getNamedBackups();
			expect(backups[0]).toMatchObject({
				path: stableBackupPath,
				fileName: "backup-stable.json",
				accountCount: 1,
			});
		} finally {
			statSpy.mockRestore();
		}
	});

	it("restores a named backup into active storage", async () => {
		const backupPath = buildNamedBackupPath("backup-restore");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
				accounts: [
					{ refreshToken: "refresh-1", addedAt: 1, lastUsed: 1 },
					{ refreshToken: "refresh-2", addedAt: 2, lastUsed: 2 },
				],
			}),
			"utf-8",
		);
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [{ refreshToken: "current-refresh", addedAt: 10, lastUsed: 10 }],
		});

		const restored = await restoreAccountsFromBackup(backupPath);
		const loaded = await loadAccounts();

		expect(restored.accounts).toHaveLength(2);
		expect(restored.activeIndex).toBe(1);
		expect(restored.activeIndexByFamily).toEqual(
			expect.objectContaining({ codex: 1 }),
		);
		expect(loaded?.accounts).toHaveLength(2);
		expect(loaded?.activeIndex).toBe(1);
		expect(loaded?.activeIndexByFamily).toEqual(
			expect.objectContaining({ codex: 1 }),
		);
		expect(loaded?.accounts[1]?.refreshToken).toBe("refresh-2");
	});

	it("returns restored backup data without persisting when persist is false", async () => {
		const backupPath = buildNamedBackupPath("backup-no-persist");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
				accounts: [
					{ refreshToken: "restore-1", addedAt: 1, lastUsed: 1 },
					{ refreshToken: "restore-2", addedAt: 2, lastUsed: 2 },
				],
			}),
			"utf-8",
		);
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [{ refreshToken: "current-refresh", addedAt: 10, lastUsed: 10 }],
		});

		const restored = await restoreAccountsFromBackup(backupPath, { persist: false });
		const loaded = await loadAccounts();

		expect(restored.accounts).toHaveLength(2);
		expect(restored.activeIndex).toBe(1);
		expect(restored.activeIndexByFamily).toEqual(
			expect.objectContaining({ codex: 1 }),
		);
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.refreshToken).toBe("current-refresh");
		expect(loaded?.activeIndex).toBe(0);
		expect(loaded?.activeIndexByFamily).toEqual(
			expect.objectContaining({ codex: 0 }),
		);
	});

	it("throws when the named backup has no accounts", async () => {
		const backupPath = buildNamedBackupPath("backup-empty-restore");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [],
			}),
			"utf-8",
		);

		await expect(restoreAccountsFromBackup(backupPath)).rejects.toThrow(
			"Backup does not contain any accounts",
		);
	});

	it("throws a clear error when a backup disappears before restore realpath", async () => {
		const backupPath = buildNamedBackupPath("backup-disappeared-before-restore");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "gone-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);

		const originalRealpath = fs.realpath.bind(fs);
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (path, options) => {
			if (String(path) === backupPath) {
				await removeWithRetry(backupPath, { force: true });
				const error = new Error(
					`ENOENT: no such file or directory, realpath '${backupPath}'`,
				) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return originalRealpath(
				path as Parameters<typeof originalRealpath>[0],
				options as Parameters<typeof originalRealpath>[1],
			);
		});

		try {
			await expect(restoreAccountsFromBackup(backupPath)).rejects.toThrow(
				`Backup file no longer exists: ${backupPath}`,
			);
		} finally {
			realpathSpy.mockRestore();
		}
	});

	it("throws a clear error when a backup disappears after restore realpath", async () => {
		const backupPath = buildNamedBackupPath("backup-disappeared-after-realpath");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "gone-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);

		const resolvedBackupPath = await fs.realpath(backupPath);
		const originalReadFile = fs.readFile.bind(fs);
		const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (path, options) => {
			if (String(path) === backupPath || String(path) === resolvedBackupPath) {
				await removeWithRetry(backupPath, { force: true });
				const error = new Error(
					`ENOENT: no such file or directory, open '${backupPath}'`,
				) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return originalReadFile(
				path as Parameters<typeof originalReadFile>[0],
				options as Parameters<typeof originalReadFile>[1],
			);
		});

		try {
			await expect(restoreAccountsFromBackup(backupPath)).rejects.toThrow(
				`Backup file no longer exists: ${backupPath}`,
			);
		} finally {
			readFileSpy.mockRestore();
		}
	});

	it("accepts UNC-resolved backups inside the managed root and rejects cross-share escapes", async () => {
		if (process.platform !== "win32") {
			return;
		}
		const insideBackupPath = buildNamedBackupPath("backup-unc-inside");
		const outsideBackupPath = buildNamedBackupPath("backup-unc-outside");
		const backupRoot = dirname(insideBackupPath);
		const resolvedBackupRoot = "\\\\server\\share\\codex\\backups";
		const resolvedInsideBackupPath = "\\\\server\\share\\codex\\backups\\backup-unc-inside.json";
		const resolvedOutsideBackupPath = "\\\\server\\other\\backup-unc-outside.json";
		const backupPayload = JSON.stringify({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [{ refreshToken: "unc-refresh", addedAt: 1, lastUsed: 1 }],
		});
		const originalRealpath = fs.realpath.bind(fs);
		const originalReadFile = fs.readFile.bind(fs);
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (path, options) => {
			if (String(path) === backupRoot) {
				return resolvedBackupRoot;
			}
			if (String(path) === insideBackupPath) {
				return resolvedInsideBackupPath;
			}
			if (String(path) === outsideBackupPath) {
				return resolvedOutsideBackupPath;
			}
			return originalRealpath(
				path as Parameters<typeof originalRealpath>[0],
				options as Parameters<typeof originalRealpath>[1],
			);
		});
		const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (path, options) => {
			if (String(path) === resolvedInsideBackupPath) {
				return backupPayload;
			}
			return originalReadFile(
				path as Parameters<typeof originalReadFile>[0],
				options as Parameters<typeof originalReadFile>[1],
			);
		});

		try {
			const restored = await restoreAccountsFromBackup(insideBackupPath, {
				persist: false,
			});
			expect(restored.accounts).toHaveLength(1);
			await expect(
				restoreAccountsFromBackup(outsideBackupPath, { persist: false }),
			).rejects.toThrow("Backup path must stay inside");
		} finally {
			realpathSpy.mockRestore();
			readFileSpy.mockRestore();
		}
	});

	it("rejects restore paths outside the managed named-backup root", async () => {
		const backupPath = buildNamedBackupPath("backup-inside-root");
		const escapedBackupPath = join(testRoot, "backup-outside-root.json");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			escapedBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "outside-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);

		await expect(restoreAccountsFromBackup(escapedBackupPath)).rejects.toThrow(
			"Backup path must stay inside",
		);
	});

	it("rejects the backup root directory itself as a restore target", async () => {
		const backupPath = buildNamedBackupPath("backup-root-guard");
		const backupRoot = dirname(backupPath);
		await fs.mkdir(backupRoot, { recursive: true });

		await expect(restoreAccountsFromBackup(backupRoot)).rejects.toThrow(
			"Backup path must stay inside",
		);
	});

	it("rejects a path inside the backup tree when realpath escapes outside the root", async () => {
		const linkedBackupPath = buildNamedBackupPath("backup-link");
		const backupRoot = dirname(linkedBackupPath);
		const escapedBackupPath = join(testRoot, "backup-outside-root.json");
		await fs.mkdir(backupRoot, { recursive: true });
		await fs.writeFile(
			escapedBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "outside-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);

		const originalRealpath = fs.realpath.bind(fs);
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (path, options) => {
			if (String(path) === linkedBackupPath) {
				return originalRealpath(
					escapedBackupPath as Parameters<typeof originalRealpath>[0],
					options as Parameters<typeof originalRealpath>[1],
				);
			}
			return originalRealpath(
				path as Parameters<typeof originalRealpath>[0],
				options as Parameters<typeof originalRealpath>[1],
			);
		});

		try {
			await expect(restoreAccountsFromBackup(linkedBackupPath)).rejects.toThrow(
				"Backup path must stay inside",
			);
		} finally {
			realpathSpy.mockRestore();
		}
	});

	it("throws a clear error when the backup root has never been created", async () => {
		const escapedBackupPath = join(testRoot, "backup-outside-root.json");
		await fs.writeFile(
			escapedBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "outside-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);

		await expect(restoreAccountsFromBackup(escapedBackupPath)).rejects.toThrow(
			"Backup root does not exist",
		);
	});
});
