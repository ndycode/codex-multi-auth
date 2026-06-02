import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	promises: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		rename: vi.fn(),
		rm: vi.fn(),
	},
}));

const originalFetch = global.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

import {
	__clearCacheForTesting,
	getCodexInstructions,
	getModelFamily,
	MODEL_FAMILIES,
	prewarmCodexInstructions,
	TOOL_REMAP_MESSAGE,
} from "../lib/prompts/codex.js";

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedMkdir = vi.mocked(fs.mkdir);
const mockedRename = vi.mocked(fs.rename);
const mockedRm = vi.mocked(fs.rm);

describe("Codex Prompts Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__clearCacheForTesting();
		// writeCacheAtomically uses rename + rm; default them to resolved so the
		// atomic cache write path works in tests that don't set them explicitly.
		mockedRename.mockResolvedValue(undefined);
		mockedRm.mockResolvedValue(undefined);
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

			it("should route GPT-5.4/5.5 era general models through the latest available general prompt family", () => {
				expect(getModelFamily("gpt-5.5")).toBe("gpt-5.2");
				expect(getModelFamily("gpt-5.5-pro-2026-04-23")).toBe("gpt-5.2");
				expect(getModelFamily("gpt-5.5-pro-20260423")).toBe("gpt-5.2");
				expect(getModelFamily("gpt-5.4")).toBe("gpt-5.2");
				expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.2");
				expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.2");
				expect(getModelFamily("gpt-5-mini")).toBe("gpt-5.2");
			});

		it("should detect models starting with codex-", () => {
			expect(getModelFamily("codex-mini")).toBe("gpt-5-codex");
			expect(getModelFamily("codex-latest")).toBe("gpt-5-codex");
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

			// prompts-03: a sha256 in the meta is verified against disk content.
			it("serves disk cache when the sha256 matches", async () => {
				const { createHash } = await import("node:crypto");
				const content = "trusted disk instructions";
				const digest = createHash("sha256").update(content, "utf8").digest("hex");
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "e",
							tag: "rust-v0.43.0",
							lastChecked: Date.now() - 5 * 60 * 1000,
							url: "https://example.com",
							sha256: digest,
						}));
					}
					return Promise.resolve(content);
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe(content);
				// No network fetch needed when the trusted cache is fresh.
				expect(mockFetch).not.toHaveBeenCalled();
			});

			it("discards disk cache and refetches when the sha256 mismatches", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "e",
							tag: "rust-v0.43.0",
							lastChecked: Date.now() - 5 * 60 * 1000,
							url: "https://example.com",
							sha256: "0".repeat(64), // wrong hash for the content below
						}));
					}
					return Promise.resolve("tampered disk content");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("fresh trusted instructions"),
					headers: { get: () => "new-etag" },
				});

				const result = await getCodexInstructions("gpt-5.2");
				// The corrupt cache was not served; a refetch happened.
				expect(result).toBe("fresh trusted instructions");
				expect(mockFetch).toHaveBeenCalled();
			});

			it("does not re-serve tampered cache via a 304 after an sha256 mismatch", async () => {
				// prompts-03 regression: a sha256 mismatch must force a FULL refetch
				// (no If-None-Match), so a server 304 cannot bless+re-serve the corrupt
				// disk bytes. Here the mismatch fires, the conditional header is dropped,
				// and even if the upstream still answers 304 the tampered content must
				// NOT come back — it falls through to the bundled instructions instead.
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(
							JSON.stringify({
								etag: "stale-etag",
								tag: "rust-v0.43.0",
								lastChecked: Date.now() - 5 * 60 * 1000,
								url: "https://example.com",
								sha256: "0".repeat(64), // wrong hash for the content below
							}),
						);
					}
					if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
						return Promise.resolve("bundled fallback instructions");
					}
					return Promise.resolve("tampered disk content");
				});
				const sentHeaders: Array<Record<string, string> | undefined> = [];
				mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
					sentHeaders.push(init?.headers as Record<string, string> | undefined);
					if (String(_url).includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
						});
					}
					// Upstream answers 304 — but since no If-None-Match was sent, the
					// fix must not treat the tampered disk bytes as a valid body.
					return Promise.resolve({ status: 304, ok: false });
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).not.toBe("tampered disk content");
				expect(result).toBe("bundled fallback instructions");
				// The instructions fetch must NOT carry a conditional revalidation header.
				const instructionsHeaders = sentHeaders.filter(Boolean) as Array<
					Record<string, string>
				>;
				expect(
					instructionsHeaders.some((h) => h && "If-None-Match" in h),
				).toBe(false);
			});

			// prompts-03 regression: a cached entry whose meta has NO sha256 (a
			// pre-upgrade legacy cache) is UNVERIFIED. It must not be fast-path served
			// and must not drive conditional revalidation — it forces one full 200
			// fetch to mint the first digest. The freshly-fetched body wins.
			it("forces a full GET (no fast-path serve) for a legacy cache entry missing sha256", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						// Legacy meta: has lastChecked + etag but NO sha256.
						return Promise.resolve(
							JSON.stringify({
								etag: "legacy-etag",
								tag: "rust-v0.43.0",
								lastChecked: Date.now() - 5 * 60 * 1000, // within TTL — would be served if trusted
								url: "https://example.com",
							}),
						);
					}
					return Promise.resolve("legacy disk bytes (no sha)");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("freshly minted instructions"),
					headers: { get: () => "minted-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2");
				// The legacy disk bytes were NOT served as-is; a full fetch happened.
				expect(result).toBe("freshly minted instructions");
				const rawGitHubUrls = mockFetch.mock.calls
					.map((call) => call[0])
					.filter(
						(url): url is string =>
							typeof url === "string" &&
							url.includes("raw.githubusercontent.com"),
					);
				expect(rawGitHubUrls.length).toBeGreaterThanOrEqual(1);
				expect(
					rawGitHubUrls.some((url) => url.includes("gpt_5_2_prompt.md")),
				).toBe(true);
			});

			// prompts-03 regression: the legacy (no-sha) disk bytes are still a valid
			// OFFLINE fallback. If the forced full fetch fails (network error), the old
			// bytes are served rather than dropping straight to bundled instructions.
			it("keeps a no-sha legacy cache as offline fallback when the forced refetch fails", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(
							JSON.stringify({
								etag: "legacy-etag",
								tag: "rust-v0.43.0",
								lastChecked: Date.now() - 5 * 60 * 1000,
								url: "https://example.com",
							}),
						);
					}
					if (
						typeof filePath === "string" &&
						filePath.includes("codex-instructions.md")
					) {
						return Promise.resolve("bundled fallback instructions");
					}
					return Promise.resolve("legacy disk bytes (offline)");
				});
				// The release-tag lookup succeeds, but the instructions GET fails.
				mockFetch.mockImplementation((url: string) => {
					if (String(url).includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
						});
					}
					return Promise.reject(new Error("Network error"));
				});

				const result = await getCodexInstructions("gpt-5.2");
				// Offline fallback uses the legacy disk bytes, NOT the bundled file.
				expect(result).toBe("legacy disk bytes (offline)");
			});

			// prompts-03 regression: a no-sha (unverified) entry must NOT send an
			// If-None-Match header. The metadata is cleared so the GET is a full,
			// unconditional fetch — a 304 over un-vetted bytes can never be trusted.
			it("does not send If-None-Match for a no-sha legacy cache entry", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(
							JSON.stringify({
								etag: "legacy-etag", // present, but must be ignored without a sha
								tag: "rust-v0.43.0",
								lastChecked: Date.now() - 5 * 60 * 1000,
								url: "https://example.com",
							}),
						);
					}
					return Promise.resolve("legacy disk bytes (header check)");
				});
				const sentHeaders: Array<Record<string, string> | undefined> = [];
				mockFetch.mockImplementation((url: string, init?: RequestInit) => {
					sentHeaders.push(init?.headers as Record<string, string> | undefined);
					if (String(url).includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
						});
					}
					return Promise.resolve({
						ok: true,
						text: () => Promise.resolve("unconditional fetch body"),
						headers: { get: () => "new-etag" },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("unconditional fetch body");
				const instructionsHeaders = sentHeaders.filter(Boolean) as Array<
					Record<string, string>
				>;
				expect(
					instructionsHeaders.some((h) => h && "If-None-Match" in h),
				).toBe(false);
			});
		});

		describe("GitHub fetch with ETag", () => {
			it("should fetch current Codex prompts for deprecated codex-max aliases", async () => {
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
				const rawGitHubUrls = mockFetch.mock.calls
					.map((call) => call[0])
					.filter(
						(url): url is string =>
							typeof url === "string" && url.includes("raw.githubusercontent.com"),
					);
				expect(
					rawGitHubUrls.some((url) => url.includes("gpt_5_codex_prompt.md")),
				).toBe(true);
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

			it("retries a transient EBUSY on the cache rename and still persists (windows lock)", async () => {
				// prompts-06 / windows fs: writeCacheAtomically routes its rename calls
				// through withFileOperationRetry, so a transient EBUSY from an antivirus
				// or file-indexer lock must be retried rather than turning a successful
				// fetch into a cache-write failure.
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.50.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("instructions after lock contention"),
					headers: { get: () => "fresh-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);
				// First rename throws EBUSY once, then succeeds — withFileOperationRetry
				// must absorb the transient fault.
				const ebusy = Object.assign(new Error("EBUSY: resource busy or locked"), {
					code: "EBUSY",
				});
				mockedRename.mockRejectedValueOnce(ebusy);
				mockedRename.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("instructions after lock contention");
				// At least one extra rename attempt beyond the initial failed one.
				expect(mockedRename.mock.calls.length).toBeGreaterThanOrEqual(2);
			});

			it("retries a transient EBUSY on temp-file cleanup (windows lock)", async () => {
				// prompts-06 / windows fs: writeCacheAtomically's finally cleanup routes
				// fs.rm through withFileOperationRetry, so a transient EBUSY on the temp
				// sibling is retried rather than leaking a *.tmp file.
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.51.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("instructions with rm contention"),
					headers: { get: () => "rm-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);
				mockedRename.mockResolvedValue(undefined);
				// First rm throws EBUSY once, then succeeds — withFileOperationRetry
				// must absorb the transient fault and still resolve the fetch.
				const ebusy = Object.assign(new Error("EBUSY: resource busy or locked"), {
					code: "EBUSY",
				});
				mockedRm.mockRejectedValueOnce(ebusy);
				mockedRm.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("instructions with rm contention");
				// At least one extra rm attempt beyond the initial failed one.
				expect(mockedRm.mock.calls.length).toBeGreaterThanOrEqual(2);
			});

			it("does not hang when the release API body stalls (mid-body timeout)", async () => {
				// prompts-02: the fetch AbortSignal only covers connect+headers, so a
				// release API response that stalls in .json() must be bounded by
				// withBodyTimeout rather than hanging getLatestReleaseTag() forever.
				// The JSON read rejects on timeout; the code must fall through to the
				// HTML fallback and still return a tag. Fake timers drive the bound so
				// the test does not wait the real 10s.
				vi.useFakeTimers();
				try {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValueOnce({
						ok: true,
						// Never resolves: simulates a server that sent headers then stalled.
						json: () => new Promise(() => {}),
					});
					mockFetch.mockResolvedValueOnce({
						ok: true,
						url: "https://github.com/openai/codex/releases/tag/rust-v0.52.0",
						text: () => Promise.resolve(""),
					});
					mockFetch.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve("instructions after stalled api"),
						headers: { get: () => "stall-etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					const pending = getCodexInstructions("gpt-5.2");
					// Let the stalled json() race start, then trip the body timeout.
					await vi.advanceTimersByTimeAsync(10_000);
					const result = await pending;
					expect(result).toBe("instructions after stalled api");
				} finally {
					vi.useRealTimers();
				}
			});

			it("should refresh stale cache in background when release tag changes", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				// Post prompts-03: only a VERIFIED (sha-bearing) entry takes the
				// stale-while-revalidate path. A matching sha256 makes "old content"
				// trusted, so it is served immediately while the tag change drives a
				// background refresh to "new version content". (A no-sha entry would
				// instead force a full blocking fetch and never serve the stale body.)
				const { createHash } = await import("node:crypto");
				const oldDigest = createHash("sha256")
					.update("old content", "utf8")
					.digest("hex");
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "old-etag",
							tag: "rust-v0.40.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
							sha256: oldDigest,
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
				const rawGitHubUrls = mockFetch.mock.calls
					.map((call) => call[0])
					.filter(
						(url): url is string =>
							typeof url === "string" && url.includes("raw.githubusercontent.com"),
					);
				expect(rawGitHubUrls.some((url) => url.includes("gpt_5_codex_prompt.md"))).toBe(
					true,
				);
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

			it("prewarms unique prompt families once while retaining gpt-5.1 coverage", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockImplementation((input) => {
					if (typeof input === "string" && input.includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.120.0" }),
						});
					}
					return Promise.resolve({
						ok: true,
						text: () => Promise.resolve("prewarmed content"),
						headers: { get: () => "etag" },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				prewarmCodexInstructions();

				await vi.waitFor(() => {
					const rawCalls = mockFetch.mock.calls.filter(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawCalls).toHaveLength(3);
				});

				const rawUrls = mockFetch.mock.calls
					.map((call) => call[0])
					.filter(
						(url): url is string =>
							typeof url === "string" && url.includes("raw.githubusercontent.com"),
					);
				expect(rawUrls.filter((url) => url.includes("gpt_5_2_prompt.md"))).toHaveLength(1);
				expect(rawUrls.some((url) => url.includes("gpt_5_codex_prompt.md"))).toBe(true);
				expect(rawUrls.some((url) => url.includes("gpt_5_1_prompt.md"))).toBe(true);
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

				it("should map gpt-5.4 prompts to the latest available general prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.116.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.4");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_2_prompt.md");
				});

				it("should map gpt-5.2 prompts to the latest available general prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.116.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.2");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_2_prompt.md");
				});
			});
		});
	});
