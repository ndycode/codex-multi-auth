import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectOcChatgptMultiAuthTarget,
	type OcChatgptTargetDetectionResult,
} from "../lib/oc-chatgpt-target-detection.js";
import {
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
} from "../lib/storage/paths.js";

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

describe("oc-chatgpt target detection", () => {
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const originalOverride = process.env.OC_CHATGPT_MULTI_AUTH_DIR;
	const originalPlatform = process.platform;
	let workDir: string;
	let homeDir: string;

	beforeEach(async () => {
		workDir = join(
			tmpdir(),
			`oc-chatgpt-detect-${Math.random().toString(36).slice(2)}`,
		);
		homeDir = join(workDir, "home");
		await fs.mkdir(homeDir, { recursive: true });
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		delete process.env.OC_CHATGPT_MULTI_AUTH_DIR;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalOverride === undefined)
			delete process.env.OC_CHATGPT_MULTI_AUTH_DIR;
		else process.env.OC_CHATGPT_MULTI_AUTH_DIR = originalOverride;
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
		});
		await removeWithRetry(workDir, { recursive: true, force: true });
	});

	function assertTarget(
		result: OcChatgptTargetDetectionResult,
		expectedScope: "global" | "project",
		expectedRoot: string,
	): asserts result is Extract<
		OcChatgptTargetDetectionResult,
		{ kind: "target" }
	> {
		expect(result.kind).toBe("target");
		if (result.kind !== "target") return;
		expect(result.descriptor.scope).toBe(expectedScope);
		expect(result.descriptor.root).toBe(expectedRoot);
	}

	it("returns project-scoped target when only project account storage exists", async () => {
		const projectDir = join(workDir, "project-alpha");
		await fs.mkdir(join(projectDir, ".git"), { recursive: true });

		const identityRoot = resolveProjectStorageIdentityRoot(projectDir);
		const projectKey = getProjectStorageKey(identityRoot);
		const projectRoot = join(homeDir, ".opencode", "projects", projectKey);
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(
			join(projectRoot, "openai-codex-accounts.json"),
			"{}",
			"utf-8",
		);

		const result = detectOcChatgptMultiAuthTarget({ projectRoot: projectDir });
		assertTarget(result, "project", projectRoot);
		if (result.kind === "target") {
			expect(result.descriptor.accountPath).toBe(
				join(projectRoot, "openai-codex-accounts.json"),
			);
			expect(result.descriptor.backupRoot).toBe(join(projectRoot, "backups"));
			expect(result.descriptor.resolution).toBe("accounts");
		}
	});

	it("returns ambiguous when both global and project accounts exist", async () => {
		const projectDir = join(workDir, "project-beta");
		await fs.mkdir(join(projectDir, ".git"), { recursive: true });

		const identityRoot = resolveProjectStorageIdentityRoot(projectDir);
		const projectKey = getProjectStorageKey(identityRoot);
		const projectRoot = join(homeDir, ".opencode", "projects", projectKey);
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(
			join(projectRoot, "openai-codex-accounts.json"),
			"{}",
			"utf-8",
		);

		const globalRoot = join(homeDir, ".opencode");
		await fs.mkdir(globalRoot, { recursive: true });
		await fs.writeFile(
			join(globalRoot, "openai-codex-accounts.json"),
			"{}",
			"utf-8",
		);

		const result = detectOcChatgptMultiAuthTarget({ projectRoot: projectDir });
		expect(result.kind).toBe("ambiguous");
		if (result.kind === "ambiguous") {
			expect(result.candidates).toHaveLength(2);
		}
	});

	it("returns explicit target from storage signals when only the override backup root exists", async () => {
		const overrideRoot = join(workDir, "override-signals-root");
		await fs.mkdir(join(overrideRoot, "backups"), { recursive: true });

		const result = detectOcChatgptMultiAuthTarget({
			explicitRoot: overrideRoot,
		});
		assertTarget(result, "global", overrideRoot);
		if (result.kind === "target") {
			expect(result.descriptor.source).toBe("explicit");
			expect(result.descriptor.resolution).toBe("signals");
			expect(result.descriptor.accountPath).toBe(
				join(overrideRoot, "openai-codex-accounts.json"),
			);
		}
	});

	it("treats explicitRoot null as disabling the environment override", async () => {
		const overrideRoot = join(workDir, "env-override-root");
		const canonicalRoot = join(homeDir, ".opencode");
		await fs.mkdir(join(overrideRoot, "backups"), { recursive: true });
		await fs.mkdir(join(canonicalRoot, "backups"), { recursive: true });
		process.env.OC_CHATGPT_MULTI_AUTH_DIR = overrideRoot;

		const result = detectOcChatgptMultiAuthTarget({ explicitRoot: null });
		assertTarget(result, "global", canonicalRoot);
		if (result.kind === "target") {
			expect(result.descriptor.source).toBe("default-global");
		}
	});

	it("treats the explicit override as authoritative when default roots also qualify", async () => {
		const overrideRoot = join(workDir, "override-root");
		const canonicalRoot = join(homeDir, ".opencode");
		await fs.mkdir(join(overrideRoot, "backups"), { recursive: true });
		await fs.mkdir(join(canonicalRoot, "projects"), { recursive: true });
		process.env.OC_CHATGPT_MULTI_AUTH_DIR = overrideRoot;

		const result = detectOcChatgptMultiAuthTarget();
		assertTarget(result, "global", overrideRoot);
		if (result.kind === "target") {
			expect(result.descriptor.source).toBe("explicit");
			expect(result.descriptor.resolution).toBe("signals");
		}
	});

	it("keeps the canonical home root global when the home path contains a projects segment", async () => {
		const nestedHome = join(workDir, "projects", "dev-home");
		await fs.mkdir(nestedHome, { recursive: true });
		process.env.HOME = nestedHome;
		process.env.USERPROFILE = nestedHome;

		const canonicalRoot = join(nestedHome, ".opencode");
		await fs.mkdir(join(canonicalRoot, "backups"), { recursive: true });

		const result = detectOcChatgptMultiAuthTarget();
		assertTarget(result, "global", canonicalRoot);
		if (result.kind === "target") {
			expect(result.descriptor.source).toBe("default-global");
		}
	});

	it("keeps explicit roots global even when their path includes the word projects", async () => {
		const explicitRoot = join(
			workDir,
			"custom-root",
			"projects",
			"manual",
			".opencode",
		);
		await fs.mkdir(join(explicitRoot, "backups"), { recursive: true });

		const result = detectOcChatgptMultiAuthTarget({ explicitRoot });
		assertTarget(result, "global", explicitRoot);
		if (result.kind === "target") {
			expect(result.descriptor.source).toBe("explicit");
		}
	});

	it("preserves Windows drive roots and matches explicit roots after normalization", async () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const explicitRoot = "C:\\";
		const result = detectOcChatgptMultiAuthTarget({ explicitRoot });
		expect(result.kind).toBe("none");
		if (result.kind === "none") {
			expect(result.tried[0]?.root).toBe("C:\\");
		}
	});

	it("normalizes mixed Windows separators in explicit roots", () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const explicitRoot = "C:\\Users/profile\\.opencode\\";
		const result = detectOcChatgptMultiAuthTarget({ explicitRoot });
		expect(result.kind).toBe("none");
		if (result.kind === "none") {
			expect(result.tried[0]?.root).toBe(
				win32.normalize("C:\\Users\\profile\\.opencode"),
			);
		}
	});

	it("preserves UNC explicit roots after normalization", () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const explicitRoot = "\\\\server\\share\\multi-auth\\";
		const result = detectOcChatgptMultiAuthTarget({ explicitRoot });
		expect(result.kind).toBe("none");
		if (result.kind === "none") {
			expect(result.tried[0]?.root).toBe(
				win32.normalize("\\\\server\\share\\multi-auth"),
			);
		}
	});

	it("resolves relative explicit roots before target detection", async () => {
		const absoluteRoot = join(workDir, "relative-override", ".opencode");
		const relativeRoot = relative(process.cwd(), absoluteRoot);
		await fs.mkdir(join(absoluteRoot, "backups"), { recursive: true });

		const result = detectOcChatgptMultiAuthTarget({
			explicitRoot: relativeRoot,
		});
		assertTarget(result, "global", absoluteRoot);
		if (result.kind === "target") {
			expect(result.descriptor.source).toBe("explicit");
		}
	});

	it("prefers explicit override containing backup artifacts", async () => {
		const overrideRoot = join(workDir, "override-root");
		const backupsDir = join(overrideRoot, "backups");
		await fs.mkdir(backupsDir, { recursive: true });
		await fs.writeFile(
			join(backupsDir, "openai-codex-accounts.json.manual-2026-03-09"),
			"{}",
			"utf-8",
		);
		process.env.OC_CHATGPT_MULTI_AUTH_DIR = overrideRoot;

		const result = detectOcChatgptMultiAuthTarget();
		assertTarget(result, "global", overrideRoot);
		if (result.kind === "target") {
			expect(result.descriptor.resolution).toBe("accounts");
		}
	});

	it("returns none with guidance when no targets exist", () => {
		const result = detectOcChatgptMultiAuthTarget();
		expect(result.kind).toBe("none");
		if (result.kind === "none") {
			expect(result.reason).toContain("~/.opencode");
			expect(result.tried.length).toBeGreaterThan(0);
		}
	});

	it("reports exact global and project roots tried when project detection has no matches", async () => {
		const projectDir = join(workDir, "project-delta");
		await fs.mkdir(join(projectDir, ".git"), { recursive: true });

		const identityRoot = resolveProjectStorageIdentityRoot(projectDir);
		const projectKey = getProjectStorageKey(identityRoot);
		const canonicalRoot = join(homeDir, ".opencode");
		const projectRoot = join(canonicalRoot, "projects", projectKey);

		const result = detectOcChatgptMultiAuthTarget({ projectRoot: projectDir });
		expect(result.kind).toBe("none");
		if (result.kind === "none") {
			expect(result.reason).toContain("OC_CHATGPT_MULTI_AUTH_DIR");
			expect(result.tried).toEqual([
				{
					scope: "global",
					source: "default-global",
					root: canonicalRoot,
					accountPath: join(canonicalRoot, "openai-codex-accounts.json"),
					backupRoot: join(canonicalRoot, "backups"),
				},
				{
					scope: "project",
					source: "project",
					root: projectRoot,
					accountPath: join(projectRoot, "openai-codex-accounts.json"),
					backupRoot: join(projectRoot, "backups"),
				},
			]);
		}
	});

	it("returns signals resolution when only backup directory exists under explicit root", async () => {
		const explicitRoot = join(workDir, "signals-only-root");
		await fs.mkdir(join(explicitRoot, "backups"), { recursive: true });

		const result = detectOcChatgptMultiAuthTarget({ explicitRoot });
		assertTarget(result, "global", explicitRoot);
		if (result.kind === "target") {
			expect(result.descriptor.resolution).toBe("signals");
			expect(result.descriptor.backupRoot).toBe(join(explicitRoot, "backups"));
		}
	});

	it("ignores rotate and tmp artifacts when detecting account artifacts", async () => {
		const explicitRoot = join(workDir, "artifact-filter-root");
		const backupsDir = join(explicitRoot, "backups");
		await fs.mkdir(backupsDir, { recursive: true });
		await fs.writeFile(
			join(backupsDir, "openai-codex-accounts.json.rotate.1"),
			"{}",
			"utf-8",
		);
		await fs.writeFile(
			join(backupsDir, "openai-codex-accounts.json.tmp"),
			"{}",
			"utf-8",
		);
		await fs.writeFile(
			join(backupsDir, "openai-codex-accounts.json.wal"),
			"{}",
			"utf-8",
		);

		const result = detectOcChatgptMultiAuthTarget({ explicitRoot });
		assertTarget(result, "global", explicitRoot);
		if (result.kind === "target") {
			expect(result.descriptor.resolution).toBe("signals");
		}
	});
});
