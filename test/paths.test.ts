import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	statSync: vi.fn(),
}));

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	getConfigDir,
	getProjectConfigDir,
	getProjectGlobalConfigDir,
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
	isProjectDirectory,
	findProjectRoot,
	resolvePath,
} from "../lib/storage/paths.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedStatSync = vi.mocked(statSync);

function buildMockStat({
	isDirectory,
	isFile,
}: {
	isDirectory: boolean;
	isFile: boolean;
}): ReturnType<typeof statSync> {
	return {
		isDirectory: () => isDirectory,
		isFile: () => isFile,
	} as unknown as ReturnType<typeof statSync>;
}

describe("Storage Paths Module", () => {
	const _origCODEX_HOME = process.env.CODEX_HOME;
	const _origCODEX_MULTI_AUTH_DIR = process.env.CODEX_MULTI_AUTH_DIR;

	beforeEach(() => {
		delete process.env.CODEX_HOME;
		delete process.env.CODEX_MULTI_AUTH_DIR;
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
		if (_origCODEX_HOME !== undefined) process.env.CODEX_HOME = _origCODEX_HOME; else delete process.env.CODEX_HOME;
		if (_origCODEX_MULTI_AUTH_DIR !== undefined) process.env.CODEX_MULTI_AUTH_DIR = _origCODEX_MULTI_AUTH_DIR; else delete process.env.CODEX_MULTI_AUTH_DIR;
	});

	describe("getConfigDir", () => {
		it("should return ~/.codex/multi-auth", () => {
			const result = getConfigDir();
			expect(result).toBe(path.join(homedir(), ".codex", "multi-auth"));
		});

		it("uses explicit CODEX_MULTI_AUTH_DIR when provided", () => {
			process.env.CODEX_MULTI_AUTH_DIR = "/custom/multi-auth";
			const result = getConfigDir();
			expect(result).toBe("/custom/multi-auth");
		});

		it("falls back to legacy codex home dir with storage when primary has none", () => {
			const primary = path.join(homedir(), ".codex", "multi-auth");
			const fallback = path.join(homedir(), "DevTools", "config", "codex", "multi-auth");

			mockedExistsSync.mockImplementation((candidate) => {
				if (typeof candidate !== "string") return false;
				if (candidate === path.join(primary, "openai-codex-accounts.json")) return false;
				if (candidate === path.join(primary, "settings.json")) return false;
				if (candidate === path.join(primary, "config.json")) return false;
				if (candidate === path.join(primary, "dashboard-settings.json")) return false;
				if (candidate === path.join(primary, "projects")) return false;
				return candidate === path.join(fallback, "openai-codex-accounts.json");
			});

			const result = getConfigDir();
			expect(result).toBe(fallback);
		});

		it("prefers fallback with accounts when primary only has non-account signals", () => {
			const primary = path.join(homedir(), ".codex", "multi-auth");
			const fallback = path.join(homedir(), "DevTools", "config", "codex", "multi-auth");

			mockedExistsSync.mockImplementation((candidate) => {
				if (typeof candidate !== "string") return false;
				if (candidate === path.join(primary, "settings.json")) return true;
				if (candidate === path.join(primary, "openai-codex-accounts.json")) return false;
				if (candidate === path.join(primary, "codex-accounts.json")) return false;
				if (candidate === path.join(primary, "config.json")) return false;
				if (candidate === path.join(primary, "dashboard-settings.json")) return false;
				if (candidate === path.join(primary, "projects")) return false;
				return candidate === path.join(fallback, "openai-codex-accounts.json");
			});

			const result = getConfigDir();
			expect(result).toBe(fallback);
		});

		it("prefers Windows fallback with accounts when primary only has non-account signals", () => {
			const originalHome = process.env.HOME;
			const originalUserProfile = process.env.USERPROFILE;
			const originalCodexHome = process.env.CODEX_HOME;
			process.env.HOME = "C:\\Users\\test";
			process.env.USERPROFILE = "C:\\Users\\test";
			process.env.CODEX_HOME = "C:\\Users\\test\\.codex";
			const primary = path.win32.join("C:\\Users\\test\\.codex", "multi-auth");
			const fallback = path.win32.join("C:\\Users\\test", "DevTools", "config", "codex", "multi-auth");
			const normalizePath = (input: string) => path.win32.normalize(input.replace(/\//g, "\\"));

			mockedExistsSync.mockImplementation((candidate) => {
				if (typeof candidate !== "string") return false;
				const normalizedCandidate = normalizePath(candidate);
				if (normalizedCandidate === normalizePath(path.win32.join(primary, "settings.json"))) return true;
				if (normalizedCandidate === normalizePath(path.win32.join(primary, "openai-codex-accounts.json"))) return false;
				if (normalizedCandidate === normalizePath(path.win32.join(primary, "codex-accounts.json"))) return false;
				if (normalizedCandidate === normalizePath(path.win32.join(primary, "config.json"))) return false;
				if (normalizedCandidate === normalizePath(path.win32.join(primary, "dashboard-settings.json"))) return false;
				if (normalizedCandidate === normalizePath(path.win32.join(primary, "projects"))) return false;
				return normalizedCandidate === normalizePath(path.win32.join(fallback, "openai-codex-accounts.json"));
			});

			try {
				const result = getConfigDir();
				expect(normalizePath(result)).toBe(normalizePath(fallback));
			} finally {
				if (originalHome === undefined) delete process.env.HOME;
				else process.env.HOME = originalHome;
				if (originalUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = originalUserProfile;
				if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
				else process.env.CODEX_HOME = originalCodexHome;
			}
		});

	});

	describe("getProjectConfigDir", () => {
		it("should return project path with .codex appended", () => {
			const projectPath = "/home/user/myproject";
			const result = getProjectConfigDir(projectPath);
			expect(result).toBe(path.join(projectPath, ".codex"));
		});

		it("should handle Windows-style paths", () => {
			const projectPath = "C:\\Users\\test\\project";
			const result = getProjectConfigDir(projectPath);
			expect(result).toBe(path.join(projectPath, ".codex"));
		});
	});

	describe("getProjectStorageKey", () => {
		it("returns deterministic key for same project path", () => {
			const projectPath = "/home/user/myproject";
			const first = getProjectStorageKey(projectPath);
			const second = getProjectStorageKey(projectPath);
			expect(first).toBe(second);
			expect(first).toMatch(/^myproject-[a-f0-9]{12}$/);
		});
	});

		describe("getProjectGlobalConfigDir", () => {
			it("returns ~/.codex/multi-auth/projects/<key>", () => {
				const projectPath = "/home/user/myproject";
				const result = getProjectGlobalConfigDir(projectPath);
				expect(result).toContain(path.join(homedir(), ".codex", "multi-auth", "projects"));
				expect(result).toContain("myproject-");
			});
		});

		describe("resolveProjectStorageIdentityRoot", () => {
			it("returns project root for standard .git directory repos", () => {
				const projectRoot = "/repo/main";
				mockedExistsSync.mockImplementation((candidate) => {
					return candidate === path.join(projectRoot, ".git");
				});
				mockedStatSync.mockImplementation((candidate) => {
					expect(candidate).toBe(path.join(projectRoot, ".git"));
					return buildMockStat({ isDirectory: true, isFile: false });
				});

				const resolved = resolveProjectStorageIdentityRoot(projectRoot);

				expect(resolved).toBe(projectRoot);
				expect(mockedReadFileSync).not.toHaveBeenCalled();
			});

			it("returns shared repository root for linked git worktrees", () => {
				const projectRoot = path.resolve("repo", "worktrees", "pr-8");
				const gitEntry = path.join(projectRoot, ".git");
				const worktreeGitDir = path.resolve("repo", ".git", "worktrees", "pr-8");
				const commondirFile = path.join(worktreeGitDir, "commondir");
				const sharedRepoRoot = path.resolve("repo");
				const sharedGitDir = path.join(sharedRepoRoot, ".git");
				const normalize = (value: string) =>
					process.platform === "win32" ? value.toLowerCase() : value;

				mockedExistsSync.mockImplementation((candidate) => {
					if (typeof candidate !== "string") return false;
					const normalizedCandidate = normalize(candidate);
					if (normalizedCandidate === normalize(gitEntry)) return true;
					if (normalizedCandidate === normalize(commondirFile)) return true;
					if (normalizedCandidate === normalize(sharedGitDir)) return true;
					return false;
				});
				mockedStatSync.mockImplementation((candidate) => {
					expect(normalize(String(candidate))).toBe(normalize(gitEntry));
					return buildMockStat({ isDirectory: false, isFile: true });
				});
				mockedReadFileSync.mockImplementation((candidate) => {
					if (typeof candidate !== "string") {
						throw new Error(`Unexpected read path: ${String(candidate)}`);
					}
					const normalizedCandidate = normalize(candidate);
					if (normalizedCandidate === normalize(gitEntry)) {
						return `gitdir: ${worktreeGitDir}\n`;
					}
					if (normalizedCandidate === normalize(commondirFile)) {
						return "../..\n";
					}
					throw new Error(`Unexpected read path: ${String(candidate)}`);
				});

				const resolved = resolveProjectStorageIdentityRoot(projectRoot);

				expect(resolved).toBe(sharedRepoRoot);
			});

			it("keeps project root when .git file does not point to worktrees", () => {
				const projectRoot = "/repo/submodule";
				const gitEntry = path.join(projectRoot, ".git");
				mockedExistsSync.mockImplementation((candidate) => candidate === gitEntry);
				mockedStatSync.mockImplementation((candidate) => {
					expect(candidate).toBe(gitEntry);
					return buildMockStat({ isDirectory: false, isFile: true });
				});
				mockedReadFileSync.mockImplementation((candidate) => {
					expect(candidate).toBe(gitEntry);
					return "gitdir: /repo/.git/modules/submodule\n";
				});

				const resolved = resolveProjectStorageIdentityRoot(projectRoot);

				expect(resolved).toBe(projectRoot);
			});
		});

	describe("isProjectDirectory", () => {
		const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".codex"];

		it.each(markers)("should return true when %s exists", (marker) => {
			mockedExistsSync.mockImplementation((p) => {
				return typeof p === "string" && p.endsWith(marker);
			});
			const result = isProjectDirectory("/test/project");
			expect(result).toBe(true);
		});

		it("should return false when no project markers exist", () => {
			mockedExistsSync.mockReturnValue(false);
			const result = isProjectDirectory("/test/random");
			expect(result).toBe(false);
		});

		it("should check multiple markers", () => {
			mockedExistsSync.mockReturnValue(false);
			isProjectDirectory("/test/dir");
			expect(mockedExistsSync).toHaveBeenCalledTimes(markers.length);
		});
	});

	describe("findProjectRoot", () => {
		it("should return the directory if it is a project root", () => {
			mockedExistsSync.mockImplementation((p) => {
				return typeof p === "string" && p.includes(".git");
			});
			const result = findProjectRoot("/home/user/myproject");
			expect(result).toBe("/home/user/myproject");
		});

		it("should walk up the directory tree to find project root", () => {
			mockedExistsSync.mockImplementation((p) => {
				return typeof p === "string" && p === path.join("/home/user", ".git");
			});
			const result = findProjectRoot("/home/user/myproject/src/lib");
			expect(result).toBe("/home/user");
		});

		it("should return null when no project root found", () => {
			mockedExistsSync.mockReturnValue(false);
			const result = findProjectRoot("/some/random/path");
			expect(result).toBeNull();
		});

		it("should handle root directory correctly", () => {
			mockedExistsSync.mockReturnValue(false);
			const root = path.parse(process.cwd()).root;
			const result = findProjectRoot(root);
			expect(result).toBeNull();
		});

		it("should stop at filesystem root", () => {
			mockedExistsSync.mockReturnValue(false);
			const callCount = mockedExistsSync.mock.calls.length;
			findProjectRoot("/a/b/c/d/e");
			expect(mockedExistsSync.mock.calls.length).toBeGreaterThan(callCount);
		});
	});

	describe("resolvePath", () => {
		it("should expand tilde to home directory", () => {
			const result = resolvePath("~/.codex/config.json");
			expect(result).toBe(path.join(homedir(), ".codex/config.json"));
		});

		it("should resolve relative paths", () => {
			const cwd = process.cwd();
			const result = resolvePath("./test.json");
			expect(result).toBe(path.resolve(cwd, "./test.json"));
		});

		it("should accept paths within home directory", () => {
			const homePath = path.join(homedir(), "projects", "myapp");
			expect(() => resolvePath(homePath)).not.toThrow();
		});

		it("should accept paths within current working directory", () => {
			const cwdPath = path.join(process.cwd(), "subdir", "file.txt");
			expect(() => resolvePath(cwdPath)).not.toThrow();
		});

		it("should accept paths within temp directory", () => {
			const tempPath = path.join(tmpdir(), "test-file.json");
			expect(() => resolvePath(tempPath)).not.toThrow();
		});

		it("should throw for paths outside allowed directories", () => {
			const outsidePath = "/definitely/not/allowed/path";
			
			if (process.platform === "win32") {
				return;
			}
			
			const home = homedir();
			const cwd = process.cwd();
			const tmp = tmpdir();
			
			if (!outsidePath.startsWith(home) && !outsidePath.startsWith(cwd) && !outsidePath.startsWith(tmp)) {
				expect(() => resolvePath(outsidePath)).toThrow("Access denied");
			}
		});

		it("rejects lookalike prefix paths outside home directory", () => {
			const home = homedir();
			const parent = path.dirname(home);
			const outsideLookalike = path.join(parent, `${path.basename(home)}-outside`, "file.json");
			expect(() => resolvePath(outsideLookalike)).toThrow("Access denied");
		});

		it("rejects lookalike prefix paths outside current working directory", () => {
			const cwd = process.cwd();
			const parent = path.dirname(cwd);
			const outsideLookalike = path.join(parent, `${path.basename(cwd)}-outside`, "file.json");
			const home = homedir();
			const tmp = tmpdir();
			if (
				outsideLookalike.startsWith(home) ||
				outsideLookalike.startsWith(tmp) ||
				outsideLookalike.startsWith(cwd)
			) {
				return;
			}
			expect(() => resolvePath(outsideLookalike)).toThrow("Access denied");
		});

		it("should handle tilde-only path", () => {
			const result = resolvePath("~");
			expect(result).toBe(homedir());
		});

		it("should handle paths with tilde in subdirectory", () => {
			const result = resolvePath("~/subdir/deep/path");
			expect(result).toBe(path.join(homedir(), "subdir/deep/path"));
		});
	});
});
