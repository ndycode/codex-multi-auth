import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RefreshQueue, getRefreshQueue, resetRefreshQueue, queuedRefresh } from "../lib/refresh-queue.js";
import * as authModule from "../lib/auth/auth.js";

vi.mock("../lib/auth/auth.js", () => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("RefreshQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefreshQueue();
  });

  afterEach(() => {
    resetRefreshQueue();
  });

  describe("basic refresh functionality", () => {
    it("should call refreshAccessToken for a single refresh request", async () => {
      const mockResult = {
        type: "success" as const,
        access: "new-access-token",
        refresh: "new-refresh-token",
        expires: Date.now() + 3600000,
      };
      vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

      const queue = new RefreshQueue();
      const result = await queue.refresh("test-refresh-token");

      expect(result).toEqual(mockResult);
      expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(authModule.refreshAccessToken).toHaveBeenCalledWith("test-refresh-token");
    });

    it("should return failed result when refresh fails", async () => {
      const mockResult = {
        type: "failed" as const,
        reason: "http_error" as const,
        statusCode: 401,
      };
      vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

      const queue = new RefreshQueue();
      const result = await queue.refresh("bad-token");

      expect(result.type).toBe("failed");
      if (result.type === "failed") {
        expect(result.reason).toBe("http_error");
      }
    });

    it("should catch exceptions and return network_error failure", async () => {
      vi.mocked(authModule.refreshAccessToken).mockRejectedValue(new Error("Network timeout"));

      const queue = new RefreshQueue();
      const result = await queue.refresh("test-token");

      expect(result.type).toBe("failed");
      if (result.type === "failed") {
        expect(result.reason).toBe("network_error");
        expect(result.message).toBe("Network timeout");
      }
    });
  });

  describe("deduplication of concurrent requests", () => {
    it("should deduplicate concurrent refresh requests for the same token", async () => {
      const mockResult = {
        type: "success" as const,
        access: "deduped-access",
        refresh: "deduped-refresh",
        expires: Date.now() + 3600000,
      };
      
      let resolveRefresh: (value: typeof mockResult) => void;
      const refreshPromise = new Promise<typeof mockResult>((resolve) => {
        resolveRefresh = resolve;
      });
      vi.mocked(authModule.refreshAccessToken).mockReturnValue(refreshPromise);

      const queue = new RefreshQueue();
      
      const promise1 = queue.refresh("same-token");
      const promise2 = queue.refresh("same-token");
      const promise3 = queue.refresh("same-token");

      expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);

      resolveRefresh!(mockResult);
      
      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
      expect(result1).toEqual(mockResult);
      expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);
    });

    it("should make separate calls for different tokens", async () => {
      const mockResult = {
        type: "success" as const,
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 3600000,
      };
      vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

      const queue = new RefreshQueue();
      
      await Promise.all([
        queue.refresh("token-1"),
        queue.refresh("token-2"),
        queue.refresh("token-3"),
      ]);

      expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(3);
      expect(authModule.refreshAccessToken).toHaveBeenCalledWith("token-1");
      expect(authModule.refreshAccessToken).toHaveBeenCalledWith("token-2");
      expect(authModule.refreshAccessToken).toHaveBeenCalledWith("token-3");
    });

    it("should allow new refresh after previous completes", async () => {
      const mockResult = {
        type: "success" as const,
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 3600000,
      };
      vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

      const queue = new RefreshQueue();
      
      await queue.refresh("token");
      expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);
      
      await queue.refresh("token");
      expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(2);
    });
  });

  describe("isRefreshing", () => {
    it("should return true while refresh is in progress", async () => {
      let resolveRefresh: () => void;
      const refreshPromise = new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }).then(() => ({
        type: "success" as const,
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 3600000,
      }));
      vi.mocked(authModule.refreshAccessToken).mockReturnValue(refreshPromise);

      const queue = new RefreshQueue();
      
      expect(queue.isRefreshing("token")).toBe(false);
      
      const refreshing = queue.refresh("token");
      expect(queue.isRefreshing("token")).toBe(true);
      
      resolveRefresh!();
      await refreshing;
      
      expect(queue.isRefreshing("token")).toBe(false);
    });
  });

  describe("pendingCount", () => {
    it("should track the number of pending refreshes", async () => {
      let resolvers: Array<() => void> = [];
      vi.mocked(authModule.refreshAccessToken).mockImplementation(() => {
        return new Promise((resolve) => {
          resolvers.push(() => resolve({
            type: "success",
            access: "access",
            refresh: "refresh",
            expires: Date.now() + 3600000,
          }));
        });
      });

      const queue = new RefreshQueue();
      
      expect(queue.pendingCount).toBe(0);
      
      const p1 = queue.refresh("token-1");
      expect(queue.pendingCount).toBe(1);
      
      const p2 = queue.refresh("token-2");
      expect(queue.pendingCount).toBe(2);
      
      resolvers[0]!();
      await p1;
      expect(queue.pendingCount).toBe(1);
      
      resolvers[1]!();
      await p2;
      expect(queue.pendingCount).toBe(0);
    });
  });

  describe("stale entry cleanup", () => {
    it("should clean up stale entries after maxEntryAge", async () => {
      vi.useFakeTimers();
      
      let resolveRefresh: () => void;
      const stuckPromise = new Promise<never>(() => {});
      vi.mocked(authModule.refreshAccessToken)
        .mockReturnValueOnce(stuckPromise)
        .mockResolvedValue({
          type: "success",
          access: "access",
          refresh: "refresh", 
          expires: Date.now() + 3600000,
        });

      const queue = new RefreshQueue(1000);
      
      queue.refresh("stuck-token");
      expect(queue.pendingCount).toBe(1);
      
      vi.advanceTimersByTime(1500);
      
      await queue.refresh("other-token");
      
      expect(queue.pendingCount).toBe(0);
      
      vi.useRealTimers();
    });
  });

  describe("singleton functions", () => {
    it("getRefreshQueue should return singleton instance", () => {
      const queue1 = getRefreshQueue();
      const queue2 = getRefreshQueue();
      expect(queue1).toBe(queue2);
    });

    it("resetRefreshQueue should clear the singleton", () => {
      const queue1 = getRefreshQueue();
      resetRefreshQueue();
      const queue2 = getRefreshQueue();
      expect(queue1).not.toBe(queue2);
    });

    it("queuedRefresh should use singleton queue", async () => {
      const mockResult = {
        type: "success" as const,
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 3600000,
      };
      vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

      const result = await queuedRefresh("test-token");
      
      expect(result).toEqual(mockResult);
      expect(authModule.refreshAccessToken).toHaveBeenCalledWith("test-token");
    });
  });

	describe("clear", () => {
		it("should clear all pending entries", async () => {
			vi.mocked(authModule.refreshAccessToken).mockImplementation(() => 
				new Promise(() => {})
			);

			const queue = new RefreshQueue();
			queue.refresh("token-1");
			queue.refresh("token-2");
			
			expect(queue.pendingCount).toBe(2);
			
			queue.clear();
			
			expect(queue.pendingCount).toBe(0);
		});
	});

	describe("token rotation handling", () => {
		it("should track token rotation when refresh returns different token", async () => {
			const mockResult = {
				type: "success" as const,
				access: "access",
				refresh: "new-rotated-token",
				expires: Date.now() + 3600000,
			};
			vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

			const queue = new RefreshQueue();
			
			const result = await queue.refresh("old-token");
			expect(result.type).toBe("success");
			if (result.type === "success") {
				expect(result.refresh).toBe("new-rotated-token");
			}
		});

		it("should reuse in-flight refresh via rotation mapping when new token arrives during refresh", async () => {
			let resolveRefresh: (result: { type: "success"; access: string; refresh: string; expires: number }) => void;
			const refreshPromise = new Promise<{ type: "success"; access: string; refresh: string; expires: number }>((resolve) => {
				resolveRefresh = resolve;
			});
			
			vi.mocked(authModule.refreshAccessToken)
				.mockReturnValueOnce(refreshPromise)
				.mockResolvedValue({
					type: "success",
					access: "access2",
					refresh: "another",
					expires: Date.now() + 3600000,
				});

			const queue = new RefreshQueue();
			
			const promise1 = queue.refresh("old-token");
			expect(queue.pendingCount).toBe(1);
			expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);

			resolveRefresh!({
				type: "success",
				access: "access",
				refresh: "new-rotated-token",
				expires: Date.now() + 3600000,
			});
			
			const result1 = await promise1;
			expect(result1.type).toBe("success");
		});

		it("should reuse pending refresh when request arrives with rotated new token", async () => {
			let innerResolve: (result: { type: "success"; access: string; refresh: string; expires: number }) => void;
			let callCount = 0;
			
			vi.mocked(authModule.refreshAccessToken).mockImplementation(() => {
				callCount++;
				return new Promise((resolve) => {
					if (callCount === 1) {
						innerResolve = resolve;
					} else {
						resolve({
							type: "success",
							access: "access2",
							refresh: "third-token",
							expires: Date.now() + 3600000,
						});
					}
				});
			});

			const queue = new RefreshQueue();
			
			const promise1 = queue.refresh("old-token");
			expect(queue.pendingCount).toBe(1);
			
			innerResolve!({
				type: "success",
				access: "access",
				refresh: "new-rotated-token",
				expires: Date.now() + 3600000,
			});
			
			await promise1;
			expect(queue.pendingCount).toBe(0);
		});

		it("should find original token when looking up via rotated token and reuse pending entry", async () => {
			let outerResolve: (result: { type: "success"; access: string; refresh: string; expires: number }) => void;
			let callCount = 0;
			
			vi.mocked(authModule.refreshAccessToken).mockImplementation(() => {
				callCount++;
				return new Promise((resolve) => {
					if (callCount === 1) {
						outerResolve = resolve;
					} else {
						resolve({
							type: "success",
							access: "access-other",
							refresh: "other",
							expires: Date.now() + 3600000,
						});
					}
				});
			});

			const queue = new RefreshQueue();
			
			const promise1 = queue.refresh("old-token");
			expect(queue.pendingCount).toBe(1);
			
			outerResolve!({
				type: "success",
				access: "access",
				refresh: "new-rotated-token",
				expires: Date.now() + 3600000,
			});
			
			const result = await promise1;
			expect(result.type).toBe("success");
		});

		it("should cleanup rotation mapping after refresh completes", async () => {
			const mockResult = {
				type: "success" as const,
				access: "access",
				refresh: "new-rotated-token",
				expires: Date.now() + 3600000,
			};
			vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

			const queue = new RefreshQueue();
			
			await queue.refresh("old-token");
			
			expect(queue.pendingCount).toBe(0);
			
			vi.mocked(authModule.refreshAccessToken).mockResolvedValue({
				type: "success",
				access: "access2",
				refresh: "another-token",
				expires: Date.now() + 3600000,
			});
			
			await queue.refresh("new-rotated-token");
			expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(2);
		});

		it("should cleanup when token in rotation map matches the completed token", async () => {
			const mockResult = {
				type: "success" as const,
				access: "access",
				refresh: "rotated-token",
				expires: Date.now() + 3600000,
			};
			vi.mocked(authModule.refreshAccessToken).mockResolvedValue(mockResult);

			const queue = new RefreshQueue();
			
			await queue.refresh("original-token");
			
			vi.mocked(authModule.refreshAccessToken).mockResolvedValue({
				type: "success",
				access: "access2",
				refresh: "original-token",
				expires: Date.now() + 3600000,
			});
			await queue.refresh("rotated-token");
			
			expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(2);
		});

		it("should reuse pending refresh when request arrives with rotated token via rotation map (lines 114, 134-135 coverage)", async () => {
			let outerResolve: (result: { type: "success"; access: string; refresh: string; expires: number }) => void;
			
			vi.mocked(authModule.refreshAccessToken).mockImplementation(() => {
				return new Promise((resolve) => {
					outerResolve = resolve;
				});
			});

			const queue = new RefreshQueue();
			
			const queueInternal = queue as unknown as {
				tokenRotationMap: Map<string, string>;
				pending: Map<string, { promise: Promise<unknown>; startedAt: number }>;
			};
			
			const promise1 = queue.refresh("old-token");
			expect(queue.pendingCount).toBe(1);
			
			queueInternal.tokenRotationMap.set("old-token", "new-rotated-token");
			
			const promise2 = queue.refresh("new-rotated-token");
			
			expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);
			
			outerResolve!({
				type: "success",
				access: "access",
				refresh: "new-rotated-token",
				expires: Date.now() + 3600000,
			});
			
			const [result1, result2] = await Promise.all([promise1, promise2]);
			expect(result1).toBe(result2);
		});

		it("should cleanup rotation mapping entries that point to the completed token (line 145 coverage)", async () => {
			const queue = new RefreshQueue();
			
			const queueInternal = queue as unknown as {
				tokenRotationMap: Map<string, string>;
			};
			
			queueInternal.tokenRotationMap.set("token-a", "token-b");
			queueInternal.tokenRotationMap.set("token-c", "token-b");
			
			vi.mocked(authModule.refreshAccessToken).mockResolvedValue({
				type: "success",
				access: "access",
				refresh: "token-b",
				expires: Date.now() + 3600000,
			});
			
			await queue.refresh("token-b");
			
			expect(queueInternal.tokenRotationMap.has("token-a")).toBe(false);
			expect(queueInternal.tokenRotationMap.has("token-c")).toBe(false);
		});

		it("should handle non-Error exception during refresh (line 193-200 coverage)", async () => {
			vi.mocked(authModule.refreshAccessToken).mockRejectedValue("string error");

			const queue = new RefreshQueue();
			const result = await queue.refresh("test-token");

			expect(result.type).toBe("failed");
			if (result.type === "failed") {
				expect(result.reason).toBe("network_error");
				expect(result.message).toBe("Unknown error during refresh");
			}
		});

		it("should find original token via rotation map and reuse pending entry (line 134 true branch)", async () => {
			let outerResolve: (result: { type: "success"; access: string; refresh: string; expires: number }) => void;
			
			vi.mocked(authModule.refreshAccessToken).mockImplementation(() => {
				return new Promise((resolve) => {
					outerResolve = resolve;
				});
			});

			const queue = new RefreshQueue();
			const queueInternal = queue as unknown as {
				tokenRotationMap: Map<string, string>;
			};
			
			const promise1 = queue.refresh("original-token");
			expect(queue.pendingCount).toBe(1);
			
			queueInternal.tokenRotationMap.set("unrelated-token", "some-other-token");
			queueInternal.tokenRotationMap.set("original-token", "rotated-token");
			
			const promise2 = queue.refresh("rotated-token");
			
			expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);
			expect(authModule.refreshAccessToken).toHaveBeenCalledWith("original-token");
			
			outerResolve!({
				type: "success",
				access: "access",
				refresh: "rotated-token",
				expires: Date.now() + 3600000,
			});
			
			const [result1, result2] = await Promise.all([promise1, promise2]);
			expect(result1).toBe(result2);
		});
	});
});
