import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCodexGitignoreEntry } from "../lib/storage/gitignore.js";

describe("gitignore helper", () => {
	let rootDir = "";
	let projectRoot = "";

	beforeEach(async () => {
		rootDir = join(
			tmpdir(),
			`codex-gitignore-${Math.random().toString(36).slice(2)}`,
		);
		projectRoot = join(rootDir, "project");
		await fs.mkdir(join(projectRoot, ".git"), { recursive: true });
		await fs.mkdir(join(projectRoot, ".codex", "multi-auth"), {
			recursive: true,
		});
	});

	afterEach(async () => {
		await fs.rm(rootDir, { recursive: true, force: true });
	});

	it("adds .codex entry when missing", async () => {
		const logDebug = vi.fn();
		await ensureCodexGitignoreEntry({
			storagePath: join(
				projectRoot,
				".codex",
				"multi-auth",
				"openai-codex-accounts.json",
			),
			currentProjectRoot: projectRoot,
			logDebug,
			logWarn: vi.fn(),
		});

		const gitignore = await fs.readFile(
			join(projectRoot, ".gitignore"),
			"utf8",
		);
		expect(gitignore).toContain(".codex/");
		expect(logDebug).toHaveBeenCalled();
	});

	it("does not duplicate existing codex ignore entries", async () => {
		await fs.writeFile(join(projectRoot, ".gitignore"), ".codex/\n", "utf8");
		await ensureCodexGitignoreEntry({
			storagePath: join(
				projectRoot,
				".codex",
				"multi-auth",
				"openai-codex-accounts.json",
			),
			currentProjectRoot: projectRoot,
			logDebug: vi.fn(),
			logWarn: vi.fn(),
		});

		const gitignore = await fs.readFile(
			join(projectRoot, ".gitignore"),
			"utf8",
		);
		expect(gitignore).toBe(".codex/\n");
	});
});
