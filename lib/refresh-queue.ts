/**
 * Refresh Queue Module
 *
 * Prevents race conditions when multiple concurrent requests try to refresh
 * the same account's token simultaneously. Instead of firing parallel refresh
 * requests, subsequent callers await the existing in-flight refresh.
 *
 * Ported from antigravity-auth refresh-queue.ts pattern.
 */

import { refreshAccessToken } from "./auth/auth.js";
import type { TokenResult } from "./types.js";
import { createLogger } from "./logger.js";
import {
  REFRESH_LEASE_BYPASS_REASON_WAIT_TIMEOUT,
  RefreshLeaseCoordinator,
} from "./refresh-lease.js";
import { isAbortError } from "./utils.js";

const log = createLogger("refresh-queue");

/**
 * Entry representing an in-flight token refresh operation.
 */
interface RefreshEntry {
  promise: Promise<TokenResult>;
  startedAt: number;
  stage: "acquire" | "refresh";
  generation: number;
  staleWarningLogged?: boolean;
}

/**
 * Manages queued token refresh operations to prevent race conditions.
 *
 * When multiple concurrent requests need to refresh the same account's token,
 * only the first request triggers the actual refresh. Subsequent requests
 * await the same promise, ensuring:
 * - No duplicate refresh API calls for the same refresh token
 * - Consistent token state across all waiting callers
 * - Reduced load on OpenAI's token endpoint
 *
 * Token Rotation Handling:
 * When OpenAI rotates the refresh token during a refresh operation, we maintain
 * a mapping from old token → new token. This ensures that requests arriving with
 * either the old or new token will find the in-flight refresh and not trigger
 * duplicate refreshes.
 *
 * @example
 * ```typescript
 * const queue = new RefreshQueue();
 *
 * // These three concurrent calls will only trigger ONE actual refresh
 * const [result1, result2, result3] = await Promise.all([
 *   queue.refresh(refreshToken),
 *   queue.refresh(refreshToken),
 *   queue.refresh(refreshToken),
 * ]);
 *
 * // All three get the same result
 * console.log(result1 === result2); // true (same object reference)
 * ```
 */
export class RefreshQueue {
  private pending: Map<string, RefreshEntry> = new Map();
  private readonly leaseCoordinator: RefreshLeaseCoordinator;
  private nextGeneration = 0;
  
  /**
   * Maps old refresh tokens to new tokens after rotation.
   * This allows lookups with either old or new token to find the same entry.
   * Format: oldToken → newToken
   */
  private tokenRotationMap: Map<string, string> = new Map();

  /**
   * Age threshold for stale pending refresh operations.
   */
  private readonly maxEntryAgeMs: number;

  /**
   * Create a new RefreshQueue instance.
   * @param maxEntryAgeMs - Maximum age for pending entries before cleanup (default: 30s)
   */
  constructor(
    maxEntryAgeMs: number = 30_000,
    leaseCoordinator: RefreshLeaseCoordinator = RefreshLeaseCoordinator.fromEnvironment(),
  ) {
    this.maxEntryAgeMs = maxEntryAgeMs;
    this.leaseCoordinator = leaseCoordinator;
  }

  /**
   * Refresh a token, deduplicating concurrent requests for the same refresh token.
   *
   * If a refresh is already in-flight for this token, returns the existing promise.
   * Otherwise, initiates a new refresh and caches the promise for other callers.
   *
   * @param refreshToken - The refresh token to use
   * @returns Token result (success with new tokens, or failure)
   */
  async refresh(refreshToken: string): Promise<TokenResult> {
    this.cleanup();

    // Check for existing in-flight refresh (direct match)
    const existing = this.pending.get(refreshToken);
    if (existing) {
      log.info("Reusing in-flight refresh for token", {
        tokenSuffix: refreshToken.slice(-6),
        waitingMs: Date.now() - existing.startedAt,
      });
      return existing.promise;
    }

    // Check if this token was rotated FROM another token that's still refreshing
    // This handles: Request A starts with oldToken, gets newToken, Request B arrives with newToken
    const rotatedFrom = this.findOriginalToken(refreshToken);
    if (rotatedFrom) {
      const originalEntry = this.pending.get(rotatedFrom);
      if (originalEntry) {
        log.info("Reusing in-flight refresh via rotation mapping", {
          newTokenSuffix: refreshToken.slice(-6),
          originalTokenSuffix: rotatedFrom.slice(-6),
          waitingMs: Date.now() - originalEntry.startedAt,
        });
        return originalEntry.promise;
      }
    }

    // Start a new refresh immediately so local state reflects "in-flight"
    // without waiting on cross-process lease checks.
    const startedAt = Date.now();
    const generation = ++this.nextGeneration;
    const markStage = (stage: "acquire" | "refresh") => {
      const entry = this.pending.get(refreshToken);
      if (!entry || entry.generation !== generation) return;
      entry.stage = stage;
      entry.startedAt = Date.now();
      entry.staleWarningLogged = false;
    };
    const getSupersedingPromise = (): Promise<TokenResult> | undefined => {
      const current = this.pending.get(refreshToken);
      if (!current || current.generation === generation) {
        return undefined;
      }
      log.info("Refresh generation superseded; joining newer in-flight refresh", {
        tokenSuffix: refreshToken.slice(-6),
        staleGeneration: generation,
        activeGeneration: current.generation,
      });
      return current.promise;
    };
    const promise = (async (): Promise<TokenResult> => {
      let lease: Awaited<ReturnType<RefreshLeaseCoordinator["acquire"]>>;
      try {
        lease = await this.leaseCoordinator.acquire(refreshToken);
      } catch (error) {
        log.warn("Refresh lease acquire failed; falling back to local refresh", {
          tokenSuffix: refreshToken.slice(-6),
          error: (error as Error)?.message ?? String(error),
        });
        const supersedingPromise = getSupersedingPromise();
        if (supersedingPromise) {
          return supersedingPromise;
        }
        markStage("refresh");
        return this.executeRefreshWithRotationTracking(refreshToken);
      }
      if (lease.role === "follower" && lease.result) {
        log.info("Using refresh result from cross-process lease", {
          tokenSuffix: refreshToken.slice(-6),
        });
        return lease.result;
      }
      if (
        lease.role === "bypass" &&
        lease.reason === REFRESH_LEASE_BYPASS_REASON_WAIT_TIMEOUT
      ) {
        const supersedingPromise = getSupersedingPromise();
        if (supersedingPromise) {
          return supersedingPromise;
        }
        log.warn("Refresh lease timed out; refusing fail-open token refresh", {
          tokenSuffix: refreshToken.slice(-6),
          waitPolicy: "fail-closed",
        });
        return {
          type: "failed",
          reason: "unknown",
          message: "Refresh lease timeout; retry shortly",
        };
      }

      try {
        const supersedingPromise = getSupersedingPromise();
        if (supersedingPromise) {
          return supersedingPromise;
        }
        markStage("refresh");
        const result = await this.executeRefreshWithRotationTracking(refreshToken);
        try {
          await lease.release(result);
        } catch (error) {
          log.warn("Failed to publish lease refresh result", {
            tokenSuffix: refreshToken.slice(-6),
            error: (error as Error)?.message ?? String(error),
          });
        }
        return result;
      } finally {
        try {
          await lease.release();
        } catch (error) {
          log.warn("Failed to release refresh lease", {
            tokenSuffix: refreshToken.slice(-6),
            error: (error as Error)?.message ?? String(error),
          });
        }
      }
    })();
    this.pending.set(refreshToken, {
      promise,
      startedAt,
      stage: "acquire",
      generation,
    });

    try {
      return await promise;
    } finally {
      const entry = this.pending.get(refreshToken);
      if (!entry || entry.generation === generation) {
        this.pending.delete(refreshToken);
        this.cleanupRotationMapping(refreshToken);
      }
    }
  }

  private findOriginalToken(newToken: string): string | undefined {
    for (const [oldToken, mappedNewToken] of this.tokenRotationMap.entries()) {
      if (mappedNewToken === newToken) {
        return oldToken;
      }
    }
    return undefined;
  }

  private cleanupRotationMapping(token: string): void {
    this.tokenRotationMap.delete(token);
    for (const [oldToken, newToken] of this.tokenRotationMap.entries()) {
      if (newToken === token) {
        this.tokenRotationMap.delete(oldToken);
      }
    }
  }

  private async executeRefreshWithRotationTracking(refreshToken: string): Promise<TokenResult> {
    const result = await this.executeRefresh(refreshToken);
    
    if (result.type === "success" && result.refresh !== refreshToken) {
      this.tokenRotationMap.set(refreshToken, result.refresh);
      log.info("Token rotated during refresh", {
        oldTokenSuffix: refreshToken.slice(-6),
        newTokenSuffix: result.refresh.slice(-6),
      });
    }
    
    return result;
  }

  /**
   * Execute the actual refresh and log results.
   */
  private async executeRefresh(refreshToken: string): Promise<TokenResult> {
    const startTime = Date.now();
    log.info("Starting token refresh", { tokenSuffix: refreshToken.slice(-6) });
    const timeoutMs = Math.max(1_000, this.maxEntryAgeMs);
    const timeoutController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutErrorMessage = `Refresh timeout after ${timeoutMs}ms`;
      const timeoutPromise = new Promise<TokenResult>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(timeoutErrorMessage) as Error & { code?: string };
          timeoutError.name = "AbortError";
          timeoutError.code = "ABORT_ERR";
          timeoutController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
      const refreshPromise = refreshAccessToken(refreshToken, {
        signal: timeoutController.signal,
      });
      const result = await Promise.race([refreshPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      if (result.type === "success") {
        log.info("Token refresh succeeded", {
          tokenSuffix: refreshToken.slice(-6),
          durationMs: duration,
        });
      } else {
        log.warn("Token refresh failed", {
          tokenSuffix: refreshToken.slice(-6),
          reason: result.reason,
          durationMs: duration,
        });
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      if (isAbortError(error)) {
        log.warn("Token refresh aborted", {
          tokenSuffix: refreshToken.slice(-6),
          error: (error as Error)?.message ?? String(error),
          durationMs: duration,
        });
        return {
          type: "failed",
          reason: "unknown",
          message: (error as Error)?.message ?? "Refresh aborted",
        };
      }
      log.error("Token refresh threw exception", {
        tokenSuffix: refreshToken.slice(-6),
        error: (error as Error)?.message ?? String(error),
        durationMs: duration,
      });

      return {
        type: "failed",
        reason: "network_error",
        message: (error as Error)?.message ?? "Unknown error during refresh",
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Cleanup stale entries that have been pending too long.
   * Acquire-stage entries are evicted to prevent deadlocked refresh lanes.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending.entries()) {
      const ageMs = now - entry.startedAt;
      if (ageMs <= this.maxEntryAgeMs) continue;
      if (entry.stage === "acquire") {
        log.warn("Evicting stale refresh entry during lease acquire stage", {
          tokenSuffix: token.slice(-6),
          ageMs,
        });
        this.pending.delete(token);
        this.cleanupRotationMapping(token);
        continue;
      }
      if (!entry.staleWarningLogged) {
        log.warn("Refresh entry exceeded stale warning threshold", {
          tokenSuffix: token.slice(-6),
          ageMs,
        });
        entry.staleWarningLogged = true;
      }
    }
  }

  /**
   * Check if there's an in-flight refresh for a given token.
   * @param refreshToken - The refresh token to check
   * @returns True if refresh is in progress
   */
  isRefreshing(refreshToken: string): boolean {
    return this.pending.has(refreshToken);
  }

  /**
   * Get the number of pending refresh operations.
   * Useful for debugging and monitoring.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Clear all pending entries (primarily for testing).
   */
  clear(): void {
    this.pending.clear();
    this.tokenRotationMap.clear();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let refreshQueueInstance: RefreshQueue | null = null;

/**
 * Get the singleton RefreshQueue instance.
 * @param maxEntryAgeMs - Maximum age for pending entries (only used on first call)
 * @returns The global RefreshQueue instance
 */
export function getRefreshQueue(maxEntryAgeMs?: number): RefreshQueue {
  if (!refreshQueueInstance) {
    refreshQueueInstance = new RefreshQueue(maxEntryAgeMs);
  }
  return refreshQueueInstance;
}

/**
 * Reset the singleton instance (primarily for testing).
 */
export function resetRefreshQueue(): void {
  refreshQueueInstance?.clear();
  refreshQueueInstance = null;
}

/**
 * Convenience function to refresh a token using the singleton queue.
 * @param refreshToken - The refresh token to use
 * @returns Token result
 */
export async function queuedRefresh(refreshToken: string): Promise<TokenResult> {
  return getRefreshQueue().refresh(refreshToken);
}
