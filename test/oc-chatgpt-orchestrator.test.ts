import { describe, expect, it, vi } from "vitest";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

import {
	applyOcChatgptSync,
	planOcChatgptSync,
	runNamedBackupExport,
} from "../lib/oc-chatgpt-orchestrator.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const sourceStorage: AccountStorageV3 = {
	version: 3,
	accounts: [
		{
			email: "user@example.com",
			refreshToken: "refresh-token-1",
			accountId: "acc_1",
			organizationId: "org_1",
			lastUsed: 100,
			addedAt: 50,
		},
	],
	activeIndex: 0,
};

const destinationStorage: AccountStorageV3 = {
	version: 3,
	accounts: [
		{
			email: "dest@example.com",
			refreshToken: "refresh-token-dest",
			accountId: "acc_dest",
			organizationId: "org_dest",
			lastUsed: 10,
			addedAt: 5,
		},
	],
	activeIndex: 0,
};

describe("oc-chatgpt orchestrator", () => {
	it("returns blocked-none when target is missing", async () => {
		const previewMerge = vi.fn();
		const detection = {
			kind: "none" as const,
			reason: "missing",
			tried: [
				{
					scope: "global" as const,
					source: "default-global" as const,
					root: "C:/Users/test/.opencode",
					accountPath: "C:/Users/test/.opencode/openai-codex-accounts.json",
					backupRoot: "C:/Users/test/.opencode/backups",
				},
			],
		};
		const result = await planOcChatgptSync({
			source: sourceStorage,
			dependencies: {
				detectTarget: () => detection,
				previewMerge,
			},
		});

		expect(result).toEqual({ kind: "blocked-none", detection });
		expect(previewMerge).not.toHaveBeenCalled();
	});

	it("returns blocked-ambiguous when target is ambiguous", async () => {
		const previewMerge = vi.fn();
		const detection = {
			kind: "ambiguous" as const,
			reason: "multiple",
			candidates: [
				{
					scope: "global" as const,
					source: "default-global" as const,
					root: "C:/target-a",
					accountPath: "C:/target-a/openai-codex-accounts.json",
					backupRoot: "C:/target-a/backups",
					hasAccountArtifacts: true,
					hasSignals: true,
				},
				{
					scope: "project" as const,
					source: "project" as const,
					root: "C:/target-b",
					accountPath: "C:/target-b/openai-codex-accounts.json",
					backupRoot: "C:/target-b/backups",
					hasAccountArtifacts: true,
					hasSignals: true,
				},
			],
		};
		const result = await planOcChatgptSync({
			source: sourceStorage,
			dependencies: {
				detectTarget: () => detection,
				previewMerge,
			},
		});

		expect(result).toEqual({ kind: "blocked-ambiguous", detection });
		expect(previewMerge).not.toHaveBeenCalled();
	});

	it("returns ready preview when target is found", async () => {
		const result = await planOcChatgptSync({
			source: sourceStorage,
			destination: destinationStorage,
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/target",
						accountPath: "C:/target/openai-codex-accounts.json",
						backupRoot: "C:/target/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
			},
		});

		expect(result.kind).toBe("ready");
		if (result.kind === "ready") {
			expect(result.preview.toAdd).toHaveLength(1);
			expect(result.preview.toUpdate).toHaveLength(0);
			expect(result.preview.toSkip).toHaveLength(0);
			expect(result.preview.unchangedDestinationOnly).toHaveLength(1);
			expect(result.preview.activeSelectionBehavior).toBe(
				"preserve-destination",
			);
			expect(result.preview.merged.accounts).toHaveLength(2);
			expect(result.preview.merged.activeIndex).toBe(
				destinationStorage.activeIndex,
			);
			expect(result.payload).toEqual(result.preview.payload);
			expect(result.destination).toBe(destinationStorage);
			expect(result.target.accountPath).toContain("openai-codex-accounts.json");
		}
	});

	// chatgpt-import-06: planning must return a structured error (not throw) when
	// loading the target fails, mirroring applyOcChatgptSync's guarded behavior.
	it("returns plan-error when loading the target throws", async () => {
		const result = await planOcChatgptSync({
			source: sourceStorage,
			// destination omitted -> loadTargetStorage is invoked
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/target",
						accountPath: "C:/target/openai-codex-accounts.json",
						backupRoot: "C:/target/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
				loadTargetStorage: async () => {
					throw new Error("corrupt destination file");
				},
			},
		});

		expect(result.kind).toBe("plan-error");
		if (result.kind === "plan-error") {
			expect(result.cause).toBe("load");
			expect(String((result.error as Error).message)).toContain("corrupt destination");
			expect(result.target.accountPath).toContain("openai-codex-accounts.json");
		}
	});

	it("returns plan-error when previewing the merge throws", async () => {
		const result = await planOcChatgptSync({
			source: sourceStorage,
			destination: destinationStorage,
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/target",
						accountPath: "C:/target/openai-codex-accounts.json",
						backupRoot: "C:/target/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
				previewMerge: () => {
					throw new Error("preview boom");
				},
			},
		});

		expect(result.kind).toBe("plan-error");
		if (result.kind === "plan-error") {
			expect(result.cause).toBe("preview");
		}
	});

	it("returns applied when persist succeeds", async () => {
		const persistMerged = vi.fn(
			async () => "C:/target/openai-codex-accounts.json",
		);
		const result = await applyOcChatgptSync({
			source: sourceStorage,
			destination: destinationStorage,
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/target",
						accountPath: "C:/target/openai-codex-accounts.json",
						backupRoot: "C:/target/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
				persistMerged,
			},
		});

		expect(result.kind).toBe("applied");
		expect(persistMerged).toHaveBeenCalledOnce();
		expect(persistMerged).toHaveBeenCalledWith(
			expect.objectContaining({
				accountPath: "C:/target/openai-codex-accounts.json",
			}),
			expect.objectContaining({
				activeIndex: destinationStorage.activeIndex,
				accounts: expect.arrayContaining([
					expect.objectContaining({ accountId: "acc_dest" }),
					expect.objectContaining({ accountId: "acc_1" }),
				]),
			}),
		);
		if (result.kind === "applied") {
			expect(result.persistedPath).toBe("C:/target/openai-codex-accounts.json");
			expect(result.preview.toAdd).toHaveLength(1);
			expect(result.preview.unchangedDestinationOnly).toHaveLength(1);
		}
	});

	// Regression (chatgpt-import-01/02): the default persister writes the merged
	// secret-bearing account file to the live destination. It must do so atomically
	// (so a crash cannot truncate the live store) and with owner-only 0o600 perms
	// (the file embeds raw refresh tokens). Exercises the REAL persistMergedDefault
	// by omitting the persistMerged dependency.
	it("default persister writes the merged file atomically and 0o600", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codex-oc-persist-"));
		const accountPath = join(dir, "openai-codex-accounts.json");
		try {
			const result = await applyOcChatgptSync({
				source: sourceStorage,
				destination: destinationStorage,
				dependencies: {
					detectTarget: () => ({
						kind: "target",
						descriptor: {
							scope: "global",
							root: dir,
							accountPath,
							backupRoot: join(dir, "backups"),
							source: "default-global",
							resolution: "accounts",
						},
					}),
					// no persistMerged → real persistMergedDefault runs
				},
			});

			expect(result.kind).toBe("applied");
			if (result.kind === "applied") {
				expect(result.persistedPath).toBe(accountPath);
			}

			// File landed (atomic rename completed) and no temp file leaked behind.
			const written = JSON.parse(await readFile(accountPath, "utf-8"));
			expect(written.accounts.length).toBeGreaterThanOrEqual(2);

			if (process.platform !== "win32") {
				const mode = (await stat(accountPath)).mode & 0o777;
				expect(mode).toBe(0o600);
			}
		} finally {
			await removeWithRetry(dir, { recursive: true, force: true });
		}
	});

	// Cross-platform atomicity check: the destination must only ever appear via an
	// atomic rename. Spy on the shared node:fs promises object (the module imports
	// `promises as fs` and writes through it) with call-through, and prove the temp+
	// rename path: writeFile targets a ".tmp" sibling and rename commits that exact tmp
	// → the destination. A direct (non-atomic) write would fail the ".tmp" assertion.
	it("default persister writes via a .tmp file then renames it onto the destination", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codex-oc-persist-atomic-"));
		const accountPath = join(dir, "openai-codex-accounts.json");
		const writeFileSpy = vi.spyOn(fs, "writeFile");
		const renameSpy = vi.spyOn(fs, "rename");
		try {
			const result = await applyOcChatgptSync({
				source: sourceStorage,
				destination: destinationStorage,
				dependencies: {
					detectTarget: () => ({
						kind: "target",
						descriptor: {
							scope: "global",
							root: dir,
							accountPath,
							backupRoot: join(dir, "backups"),
							source: "default-global",
							resolution: "accounts",
						},
					}),
				},
			});
			expect(result.kind).toBe("applied");

			// writeFile wrote to a ".tmp" sibling, never directly to the destination.
			const writeTarget = String(writeFileSpy.mock.calls[0]?.[0]);
			expect(writeFileSpy).toHaveBeenCalledTimes(1);
			expect(writeTarget.endsWith(".tmp")).toBe(true);
			expect(writeTarget).not.toBe(accountPath);

			// rename committed that exact tmp → the destination.
			const renameArgs = renameSpy.mock.calls[0];
			expect(renameSpy).toHaveBeenCalledTimes(1);
			expect(String(renameArgs?.[0])).toBe(writeTarget);
			expect(String(renameArgs?.[1])).toBe(accountPath);

			// Destination is complete + parseable (rename committed) and no .tmp leaked.
			const parsed = JSON.parse(await readFile(accountPath, "utf-8"));
			expect(parsed.version).toBe(3);
			const { readdir } = await import("node:fs/promises");
			const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
			expect(leftovers).toEqual([]);
		} finally {
			writeFileSpy.mockRestore();
			renameSpy.mockRestore();
			await removeWithRetry(dir, { recursive: true, force: true });
		}
	});

	it("returns structured error for unreadable target account paths during apply", async () => {
		const persistError = Object.assign(
			new Error(
				"EACCES: permission denied, open C:/locked/openai-codex-accounts.json",
			),
			{
				code: "EACCES",
				path: "C:/locked/openai-codex-accounts.json",
			},
		);

		const result = await applyOcChatgptSync({
			source: sourceStorage,
			destination: destinationStorage,
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/locked",
						accountPath: "C:/locked/openai-codex-accounts.json",
						backupRoot: "C:/locked/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
				persistMerged: async () => {
					throw persistError;
				},
			},
		});
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toBe(persistError);
			expect(result.target.accountPath).toBe(
				"C:/locked/openai-codex-accounts.json",
			);
		}
	});

	it("returns collision when named backup export collides", async () => {
		const result = await runNamedBackupExport({
			name: "backup-2026-03-10",
			dependencies: {
				exportBackup: async () => {
					const error = new Error(
						"named backup already exists: C:/target/backups/backup-2026-03-10.json",
					) as NodeJS.ErrnoException;
					error.path = "C:/target/backups/backup-2026-03-10.json";
					throw error;
				},
			},
		});

		expect(result.kind).toBe("collision");
		if (result.kind === "collision") {
			expect(result.path).toContain("backup-2026-03-10.json");
		}
	});

	it("extracts collision paths from message-only backup errors", async () => {
		const result = await runNamedBackupExport({
			name: "backup-2026-03-11",
			dependencies: {
				exportBackup: async () => {
					throw new Error(
						"named backup already exists: C:/target/backups/backup-2026-03-11.json",
					);
				},
			},
		});

		expect(result).toEqual({
			kind: "collision",
			path: "C:/target/backups/backup-2026-03-11.json",
		});
	});

	it("returns error for non-collision backup export failures and preserves the original error", async () => {
		const backupError = Object.assign(
			new Error("EACCES: permission denied, mkdir C:/target/backups"),
			{ code: "EACCES" },
		);

		const result = await runNamedBackupExport({
			name: "backup-2026-03-12",
			dependencies: {
				exportBackup: async () => {
					throw backupError;
				},
			},
		});

		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.path).toBeUndefined();
			expect(result.error).toBe(backupError);
		}
	});

	it("passes injected loadTargetStorage through apply planning when destination is omitted", async () => {
		const loadedDestination = { ...destinationStorage, activeIndex: 0 };
		const loadTargetStorage = vi.fn(async () => loadedDestination);
		const persistMerged = vi.fn(
			async () => "C:/target/openai-codex-accounts.json",
		);
		const result = await applyOcChatgptSync({
			source: sourceStorage,
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/target",
						accountPath: "C:/target/openai-codex-accounts.json",
						backupRoot: "C:/target/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
				loadTargetStorage,
				persistMerged,
			},
		});
		expect(loadTargetStorage).toHaveBeenCalledOnce();
		expect(result.kind).toBe("applied");
	});

	it("returns structured error when loadTargetStorage throws during apply", async () => {
		const loadError = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});

		const result = await applyOcChatgptSync({
			source: sourceStorage,
			dependencies: {
				detectTarget: () => ({
					kind: "target",
					descriptor: {
						scope: "global",
						root: "C:/target",
						accountPath: "C:/target/openai-codex-accounts.json",
						backupRoot: "C:/target/backups",
						source: "default-global",
						resolution: "accounts",
					},
				}),
				loadTargetStorage: async () => {
					throw loadError;
				},
			},
		});

		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toBe(loadError);
			expect(result.target.accountPath).toBe(
				"C:/target/openai-codex-accounts.json",
			);
		}
	});
});
