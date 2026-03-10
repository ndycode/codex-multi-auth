import { promises as fs } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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
			const { target } = result;
			expect(target).toBeDefined();
			if (!target) {
				throw new Error("expected error target");
			}
			expect(target.accountPath).toBe("C:/locked/openai-codex-accounts.json");
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

	it("returns collision when named backup export fails with EEXIST on a json file path", async () => {
		const result = await runNamedBackupExport({
			name: "backup-2026-03-10-code",
			dependencies: {
				exportBackup: async () => {
					const error = Object.assign(new Error("EEXIST"), {
						code: "EEXIST",
						path: "C:/target/backups/backup-2026-03-10-code.json",
					}) as NodeJS.ErrnoException;
					throw error;
				},
			},
		});

		expect(result).toEqual({
			kind: "collision",
			path: "C:/target/backups/backup-2026-03-10-code.json",
		});
	});

	it("forwards force=true to named backup export dependencies", async () => {
		const exportBackup = vi.fn(async () => "C:/target/backups/forced.json");
		const result = await runNamedBackupExport({
			name: "forced",
			force: true,
			dependencies: { exportBackup },
		});

		expect(exportBackup).toHaveBeenCalledWith("forced", { force: true });
		expect(result).toEqual({
			kind: "exported",
			path: "C:/target/backups/forced.json",
		});
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

	it("does not treat non-json EEXIST paths as backup collisions", async () => {
		const backupError = Object.assign(new Error("EEXIST"), {
			code: "EEXIST",
			path: "C:/target/backups",
		}) as NodeJS.ErrnoException;

		const result = await runNamedBackupExport({
			name: "backup-dir-collision",
			dependencies: {
				exportBackup: async () => {
					throw backupError;
				},
			},
		});

		expect(result).toEqual({
			kind: "error",
			path: undefined,
			error: backupError,
		});
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

	it("supports null source by preserving the destination snapshot during planning", async () => {
		const result = await planOcChatgptSync({
			source: null,
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
			expect(result.preview.toAdd).toHaveLength(0);
			expect(result.preview.toUpdate).toHaveLength(0);
			expect(result.preview.toSkip).toHaveLength(0);
			expect(result.preview.unchangedDestinationOnly).toHaveLength(1);
			expect(result.destination).toBe(destinationStorage);
		}
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
			const { target } = result;
			expect(target).toBeDefined();
			if (!target) {
				throw new Error("expected error target");
			}
			expect(target.accountPath).toBe("C:/target/openai-codex-accounts.json");
		}
	});

	it("returns the original apply error when recovery detection throws", async () => {
		const loadError = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});

		const detectTarget = vi
			.fn()
			.mockReturnValueOnce({
				kind: "target",
				descriptor: {
					scope: "global",
					root: "C:/target",
					accountPath: "C:/target/openai-codex-accounts.json",
					backupRoot: "C:/target/backups",
					source: "default-global",
					resolution: "accounts",
				},
			})
			.mockImplementationOnce(() => {
				throw new Error("recovery detection failed");
			});

		const result = await applyOcChatgptSync({
			source: sourceStorage,
			dependencies: {
				detectTarget,
				loadTargetStorage: async () => {
					throw loadError;
				},
			},
		});

		expect(detectTarget).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			kind: "error",
			error: loadError,
		});
	});

	it("writes apply temp files with restrictive permissions and retries transient rename failures", async () => {
		const writeFile = vi
			.spyOn(fs, "writeFile")
			.mockResolvedValue(undefined as never);
		const rename = vi
			.spyOn(fs, "rename")
			.mockRejectedValueOnce(
				Object.assign(new Error("busy"), { code: "EBUSY" }),
			)
			.mockResolvedValue(undefined as never);
		const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
		const unlink = vi.spyOn(fs, "unlink").mockResolvedValue(undefined as never);

		try {
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
				},
			});

			expect(result.kind).toBe("applied");
			expect(mkdir).toHaveBeenCalledOnce();
			expect(writeFile).toHaveBeenCalledWith(
				expect.stringMatching(/\.tmp$/),
				expect.any(String),
				{ encoding: "utf-8", mode: 0o600 },
			);
			expect(rename).toHaveBeenCalledTimes(2);
			expect(unlink).not.toHaveBeenCalled();
		} finally {
			writeFile.mockRestore();
			rename.mockRestore();
			mkdir.mockRestore();
			unlink.mockRestore();
		}
	});

	it("preserves the original apply error when recovery detection returns blocked", async () => {
		const loadError = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});

		const detectTarget = vi
			.fn()
			.mockReturnValueOnce({
				kind: "target",
				descriptor: {
					scope: "global",
					root: "C:/target",
					accountPath: "C:/target/openai-codex-accounts.json",
					backupRoot: "C:/target/backups",
					source: "default-global",
					resolution: "accounts",
				},
			})
			.mockReturnValueOnce({
				kind: "none",
				reason: "missing",
				tried: [],
			});

		const result = await applyOcChatgptSync({
			source: sourceStorage,
			dependencies: {
				detectTarget,
				loadTargetStorage: async () => {
					throw loadError;
				},
			},
		});

		expect(result).toEqual({
			kind: "error",
			error: loadError,
		});
	});
});
