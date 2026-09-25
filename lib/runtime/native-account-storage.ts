import { stat } from "node:fs/promises";
import { getStoragePath, normalizeAccountStorage, type AccountStorageV3 } from "../storage.js";
import { loadAccountsFromPath } from "../storage/storage-parser.js";
import { applyPendingAuth } from "../storage/pending-auth.js";
import { isRecord } from "../utils.js";
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
                        lastSuccess = Date.now();
                        // The pending journal can change without touching the primary.
                        return { storage: await applyPendingAuth(path, structuredClone(cached)), verified: true };
                    }
                }
                const storage = read ? await read() : (await loadAccountsFromPath(path, { normalizeAccountStorage, isRecord })).normalized;
                cached = structuredClone(storage);
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
                    return { storage: Date.now() - lastSuccess < 2000 ? await applyPendingAuth(path, structuredClone(cached)) : null, verified: false, transientFailure: true, routingAvailable: cached !== null && Date.now() - lastSuccess < 30000 };
                }
                cached = null;
                signature = undefined;
                return { storage: null, verified: false };
            }
        })().finally(() => { pending = undefined; });
        return pending;
    };
}
