import { getStoragePathState, runWithStoragePathState } from "../storage/path-state.js";
import { join } from "node:path";
import { AccountManager, resolveAccountRecordId } from "../accounts.js";
import { getAccountPolicyKey, loadAccountPolicyStore } from "../account-policy.js";
import { getStoragePath, type AccountMetadataV3 } from "../storage.js";
import { fetchCodexQuotaSnapshot, type CodexQuotaSnapshot } from "../quota-probe.js";
import { loadQuotaCache, saveQuotaCache } from "../quota-cache.js";
import { updateQuotaCacheForAccount } from "../codex-manager/quota-cache-helpers.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { withFileTransactionLock } from "../storage/file-lock.js";
import { createNativeAccountStorageReader } from "./native-account-storage.js";
import { ensureFreshAccessToken } from "./rotation-token-refresh.js";
import { workspaceModelScopes } from "./workspace-model-scopes.js";
import { runAutomaticAccountChecks } from "./automatic-account-checks.js";
import { logWarn } from "../logger.js";
type Observer = (account: AccountMetadataV3, snapshot: CodexQuotaSnapshot, accounts: AccountMetadataV3[]) => Promise<void> | void;
/** Captures this router's pool; reads only verified primary credentials, never API/ZDR entries. */
export function createAutomaticSubscriptionCheck(observe?: Observer) {
    const path = getStoragePath(), storageState = getStoragePathState();
    const read = createNativeAccountStorageReader(undefined, path);
    const quotaPath = join(getCodexMultiAuthDir(), "quota-cache.json");
    const onQuota: Observer = observe ?? (async (account, snapshot, accounts) => withFileTransactionLock(quotaPath, async () => {
        const cache = await loadQuotaCache();
        updateQuotaCacheForAccount(cache, account, snapshot, accounts);
        await saveQuotaCache(cache);
    }));
    return (signal: AbortSignal) => runWithStoragePathState(storageState, () => runAutomaticAccountChecks({
        path: `${path}.automatic-checks.json`, signal, loadPolicies: loadAccountPolicyStore,
        loadAccounts: async () => { const snapshot = await read(); return snapshot.verified ? snapshot.storage : null; },
        check: async (storage, index) => {
            const manager = new AccountManager(undefined, storage);
            const account = manager.getAccountByIndex(index);
            if (!account || !workspaceModelScopes(account).some(s => s.bound && s.routable) || signal.aborted)
                return;
            const fresh = await ensureFreshAccessToken({ accountManager: manager, account, family: "codex", model: null, now: Date.now(), tokenRefreshSkewMs: 60000, tokenInvalidationCooldownMs: 300000 });
            try {
                if (!fresh.ok || signal.aborted)
                    return;
                // A refresh is an I/O boundary: revalidate removal, policy, auth and workspace changes.
                const disk = await read();
                const current = disk.verified ? disk.storage?.accounts.find(row => resolveAccountRecordId(row) === resolveAccountRecordId(fresh.account)) : undefined;
                const policy = current ? (await loadAccountPolicyStore()).accounts[getAccountPolicyKey(current)] : undefined;
                if (!disk.storage || !current || current.refreshToken !== fresh.account.refreshToken || current.accessToken !== fresh.accessToken || !policy?.autoPrime || policy.paused || policy.drained || current.enabled === false || current.authInvalidatedAt || (current.coolingDownUntil ?? 0) > Date.now())
                    return;
                const bound = workspaceModelScopes(fresh.account).find(s => s.bound && s.routable);
                if (!bound || (current.accountId && current.accountId !== bound.accountId) || current.workspaces?.some(w => w.id === bound.accountId && w.enabled === false) || signal.aborted)
                    return;
                const snapshot = await fetchCodexQuotaSnapshot({ accountId: bound.accountId, accessToken: fresh.accessToken, primeUnusedSubscription: true, signal });
                if (snapshot.primingFailure)
                    logWarn("Automatic first-use completion was not confirmed; retry deferred until the next check.");
                await onQuota(current, snapshot, disk.storage.accounts);
            }
            finally {
                await manager.flushPendingSave();
            }
        },
    }));
}
