import { stat } from "node:fs/promises";
import { cloneTrackedAccountStorage, getStoragePath, normalizeAccountStorage, type AccountStorageV3 } from "../storage.js";
import { loadAccountsFromPath } from "../storage/storage-parser.js";
import { applyPendingAuth } from "../storage/pending-auth.js";
import { isRecord } from "../utils.js";
import { syncNativeLogin } from "./native-login-sync.js";
export interface NativeAccountSnapshot {
    storage: AccountStorageV3 | null;
    verified: boolean;
    transientFailure?: boolean;
    /** Independent client auth may retain routing for at most 30 seconds. */
    routingAvailable?: boolean;
}
/** Cache parsed primary storage only; backup recovery must never resurrect revoked credentials. */
export function createNativeAccountStorageReader(read?: () => Promise<AccountStorageV3 | null>, path = getStoragePath()): () => Promise<NativeAccountSnapshot> {
    let cached: AccountStorageV3 | null = null;
    let signature: string | undefined;
    let lastSuccess = 0;
    let pending: Promise<NativeAccountSnapshot> | undefined;
    return () => {
        if (pending)
            return pending;
        pending = (async () => {
            try {
                let nextSignature: string | undefined;
                if (!read) {
                    const info = await stat(path);
                    nextSignature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
                    if (cached && nextSignature === signature && Date.now() - Math.max(info.mtimeMs, info.ctimeMs) > 2000) {
                        let adopted = false;
                        try { adopted = path === getStoragePath() && await syncNativeLogin(await applyPendingAuth(path, cloneTrackedAccountStorage(cached)) ?? cached); } catch { /* Keep the verified cached pool when adoption is temporarily unavailable. */ }
                        if (adopted) {
                            cached = null;
                        } else {
                        lastSuccess = Date.now();
                        // The pending journal can change without touching the primary.
                        return { storage: await applyPendingAuth(path, cloneTrackedAccountStorage(cached)), verified: true };
                        }
                    }
                }
                let storage = read ? await read() : (await loadAccountsFromPath(path, { normalizeAccountStorage, isRecord })).normalized;
                let adopted = false;
                const loadedStorage = storage;
                try { adopted = !read && loadedStorage !== null && path === getStoragePath() && await syncNativeLogin(await applyPendingAuth(path, cloneTrackedAccountStorage(loadedStorage)) ?? loadedStorage); } catch { /* Keep the freshly loaded pool when adoption is temporarily unavailable. */ }
                if (adopted) {
                    storage = (await loadAccountsFromPath(path, { normalizeAccountStorage, isRecord })).normalized;
                    nextSignature = undefined;
                }
                cached = storage ? cloneTrackedAccountStorage(storage) : null;
                signature = nextSignature;
                lastSuccess = Date.now();
                // A rotated token journaled after a locked write is newer than the
                // spent one still in the primary; syncing the raw file would revert it.
                return { storage: await applyPendingAuth(path, storage), verified: true };
            }
            catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (["EBUSY", "EPERM", "EACCES"].includes(code ?? "")) {
                    // Availability grace is bounded, never refreshes its own age, and cannot
                    // authenticate a managed bearer. Retry the changed file on the next request.
                    signature = undefined;
                    return { storage: Date.now() - lastSuccess < 2000 && cached ? await applyPendingAuth(path, cloneTrackedAccountStorage(cached)) : null, verified: false, transientFailure: true, routingAvailable: cached !== null && Date.now() - lastSuccess < 30000 };
                }
                cached = null;
                signature = undefined;
                return { storage: null, verified: false };
            }
        })().finally(() => { pending = undefined; });
        return pending;
    };
}
