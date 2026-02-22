import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

vi.mock("node:fs", () => ({
	promises: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

const originalFetch = global.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

import { getModelFamily, getCodexInstructions, MODEL_FAMILIES, TOOL_REMAP_MESSAGE, __clearCacheForTesting } from "../lib/prompts/codex.js";

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedMkdir = vi.mocked(fs.mkdir);

describe("Codex Prompts Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__clearCacheForTesting();
		mockFetch = vi.fn();
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

		describe("MODEL_FAMILIES constant", () => {
			it("should export all model families", () => {
				expect(MODEL_FAMILIES).toContain("gpt-5-codex");
				expect(MODEL_FAMILIES).toContain("codex-max");
				expect(MODEL_FAMILIES).toContain("codex");
				expect(MODEL_FAMILIES).toContain("gpt-5.2");
				expect(MODEL_FAMILIES).toContain("gpt-5.1");
			});

			it("should be a readonly array", () => {
				expect(Array.isArray(MODEL_FAMILIES)).toBe(true);
				expect(MODEL_FAMILIES.length).toBe(5);
			});
		});

	describe("TOOL_REMAP_MESSAGE constant", () => {
		it("should contain apply_patch replacement instruction", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("apply_patch/applyPatch are Codex names");
			expect(TOOL_REMAP_MESSAGE).toContain("patch");
			expect(TOOL_REMAP_MESSAGE).toContain("edit");
		});

		it("should contain update_plan replacement instruction", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("UPDATE_PLAN DOES NOT EXIST");
			expect(TOOL_REMAP_MESSAGE).toContain("todowrite");
		});

		it("should list available tools", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("write");
			expect(TOOL_REMAP_MESSAGE).toContain("edit");
			expect(TOOL_REMAP_MESSAGE).toContain("read");
			expect(TOOL_REMAP_MESSAGE).toContain("bash");
			expect(TOOL_REMAP_MESSAGE).toContain("grep");
		});
	});

		describe("getModelFamily", () => {
			it("should detect gpt-5.3-codex-spark", () => {
				expect(getModelFamily("gpt-5.3-codex-spark")).toBe("gpt-5-codex");
			});

			it("should detect gpt-5.3-codex with space separator", () => {
				expect(getModelFamily("gpt 5.3 codex")).toBe("gpt-5-codex");
			});

			it("should detect gpt-5.2-codex with space separator", () => {
				expect(getModelFamily("gpt 5.2 codex")).toBe("gpt-5-codex");
			});

			it("should classify gpt-5 codex mini aliases under gpt-5-codex family", () => {
				expect(getModelFamily("gpt-5-codex-mini-low")).toBe("gpt-5-codex");
				expect(getModelFamily("gpt-5.1-codex-mini-low")).toBe("gpt-5-codex");
			});

		it("should detect models starting with codex-", () => {
			expect(getModelFamily("codex-mini")).toBe("codex");
			expect(getModelFamily("codex-latest")).toBe("codex");
		});
	});

	describe("getCodexInstructions", () => {
		describe("Memory cache behavior", () => {
			it("should return cached content within TTL", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("cached instructions");
				});

				const first = await getCodexInstructions("gpt-5.1-codex");
				const second = await getCodexInstructions("gpt-5.1-codex");
				
				expect(first).toBe("cached instructions");
				expect(second).toBe(first);
			});
		});

		describe("Disk cache with TTL", () => {
			it("should use disk cache if within TTL", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("disk cached instructions");
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("disk cached instructions");
			});
		});

		describe("GitHub fetch with ETag", () => {
			it("should fetch from GitHub API for latest release tag", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.50.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("new instructions from github"),
					headers: { get: () => "new-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("codex-max");
				expect(result).toBe("new instructions from github");
				expect(mockFetch).toHaveBeenCalledTimes(2);
			});

			it("should handle 304 Not Modified response", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "existing-etag",
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("disk cached content");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					status: 304,
					ok: false,
				});

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toBe("disk cached content");
			});

			it("should refresh stale cache in background when release tag changes", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "old-etag",
							tag: "rust-v0.40.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("old content");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.50.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("new version content"),
					headers: { get: () => "new-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const first = await getCodexInstructions("gpt-5.1-codex");
				expect(first).toBe("old content");
				await new Promise((resolve) => setTimeout(resolve, 0));
				const second = await getCodexInstructions("gpt-5.1-codex");
				expect(second).toBe("new version content");
			});
		});

		describe("GitHub HTML fallback", () => {
			it("should fall back to HTML releases page when API fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status: 403,
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					url: "https://github.com/openai/codex/releases/tag/rust-v0.45.0",
					text: () => Promise.resolve(""),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("fallback instructions"),
					headers: { get: () => "fallback-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2-codex");
				expect(result).toBe("fallback instructions");
			});

			it("should parse tag from HTML content if URL parsing fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status: 500,
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					url: "https://github.com/openai/codex/releases/latest",
					text: () => Promise.resolve('<a href="/openai/codex/releases/tag/rust-v0.47.0">Release</a>'),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("html parsed instructions"),
					headers: { get: () => "html-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("codex");
				expect(result).toBe("html parsed instructions");
			});

		it("should fall back to bundled when HTML fallback page request fails", async () => {
			mockedReadFile.mockImplementation((filePath) => {
				if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
					return Promise.resolve("bundled fallback content");
				}
				return Promise.reject(new Error("ENOENT"));
			});
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 403,
			});
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const result = await getCodexInstructions("gpt-5.2");
			expect(result).toBe("bundled fallback content");
		});

		it("should fall back to bundled when both URL parsing and HTML regex fail", async () => {
			mockedReadFile.mockImplementation((filePath) => {
				if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
					return Promise.resolve("bundled fallback for regex fail");
				}
				return Promise.reject(new Error("ENOENT"));
			});
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 403,
			});
			mockFetch.mockResolvedValueOnce({
				ok: true,
				url: "https://github.com/openai/codex/releases/latest",
				text: () => Promise.resolve("no matching content here"),
			});

			const result = await getCodexInstructions("gpt-5.1");
			expect(result).toBe("bundled fallback for regex fail");
		});
	});

		describe("Fallback behavior", () => {
			it("should fall back to disk cache on fetch error", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached",
							tag: "old",
							lastChecked: oldTimestamp,
						}));
					}
					return Promise.resolve("fallback disk content");
				});
				mockFetch.mockRejectedValue(new Error("Network error"));

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toBe("fallback disk content");
			});

			it("should fall back to disk cache on HTTP error response", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached",
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
						}));
					}
					return Promise.resolve("disk cache fallback");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status: 500,
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("disk cache fallback");
			});

			it("should fall back to bundled instructions when all else fails", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
						return Promise.resolve("bundled fallback instructions");
					}
					throw new Error("ENOENT");
				});
				mockFetch.mockRejectedValue(new Error("Network error"));

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toBe("bundled fallback instructions");
			});
		});

		describe("Cache size management", () => {
			it("should handle multiple model families without exceeding cache size", async () => {
				mockedReadFile.mockResolvedValue("instructions");
				
				for (const family of MODEL_FAMILIES) {
					const result = await getCodexInstructions(family);
					expect(result).toBeDefined();
				}
			});

			it("should evict oldest entry when cache exceeds max size", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("cached instructions");
				});

				for (let i = 0; i < 55; i++) {
					await getCodexInstructions(`test-model-${i}`);
				}
				
				const result = await getCodexInstructions("gpt-5.1-codex");
				expect(result).toBe("cached instructions");
			});
		});

			describe("Model family mapping", () => {
				it("should use correct prompt file for each model family", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
					text: () => Promise.resolve("content"),
					headers: { get: () => "etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				await getCodexInstructions("gpt-5-codex");
				
				const fetchCalls = mockFetch.mock.calls;
				const rawGitHubCall = fetchCalls.find(call => 
					typeof call[0] === "string" && call[0].includes("raw.githubusercontent.com")
				);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});

				it("should map gpt-5.3-codex prompts to the current codex prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.98.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.3-codex");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});

				it("should map gpt-5.3-codex-spark prompts to the current codex prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.101.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.3-codex-spark");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});
			});
		});
	});
