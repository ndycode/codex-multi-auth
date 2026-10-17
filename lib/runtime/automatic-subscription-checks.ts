import { getStoragePathState, runWithStoragePathState } from "../storage/path-state.js";
import { AccountManager, resolveAccountRecordId } from "../accounts.js";
import { getAccountPolicyKey, loadAccountPolicyStore } from "../account-policy.js";
import { getStoragePath, type AccountMetadataV3 } from "../storage.js";
import { fetchCodexQuotaSnapshot, type CodexQuotaSnapshot } from "../quota-probe.js";
import { loadQuotaCache, saveQuotaCache } from "../quota-cache.js";
import { updateQuotaCacheForWorkspace } from "../codex-manager/quota-cache-helpers.js";
import { createNativeAccountStorageReader } from "./native-account-storage.js";
import { ensureFreshAccessToken } from "./rotation-token-refresh.js";
import { automaticCheckWorkspaceId, runAutomaticAccountChecks } from "./automatic-account-checks.js";
import { logWarn } from "../logger.js";
type Observer = (account: AccountMetadataV3, snapshot: CodexQuotaSnapshot, accounts: AccountMetadataV3[], workspaceId: string) => Promise<void> | void;
/** Captures this router's pool; reads only verified primary credentials, never API/ZDR entries. */
export function createAutomaticSubscriptionCheck(observe?: Observer) {
    const path = getStoragePath(), storageState = getStoragePathState();
    const read = createNativeAccountStorageReader(undefined, path);
    const onQuota: Observer = observe ?? (async (account, snapshot, accounts, workspaceId) => {
        const cache = await loadQuotaCache();
        const baseline = structuredClone(cache);
        updateQuotaCacheForWorkspace(cache, account, workspaceId, snapshot, accounts);
        await saveQuotaCache(cache, baseline);
    });
    return (signal: AbortSignal) => runWithStoragePathState(storageState, () => runAutomaticAccountChecks({
        path: `${path}.automatic-checks.json`, signal, loadPolicies: loadAccountPolicyStore,
        loadAccounts: async () => { const snapshot = await read(); return snapshot.verified ? snapshot.storage : null; },
        check: async (storage, index) => {
            const manager = new AccountManager(undefined, storage);
            const account = manager.getAccountByIndex(index);
            const stored = storage.accounts[index];
            const targetId = stored && automaticCheckWorkspaceId(stored);
            if (!account || !targetId || signal.aborted)
                return;
            const fresh = await ensureFreshAccessToken({ accountManager: manager, account, family: "codex", model: null, now: Date.now(), tokenRefreshSkewMs: 60000, tokenInvalidationCooldownMs: 300000 });
            try {
                if (!fresh.ok || signal.aborted)
                    return;
                // A refresh is an I/O boundary: revalidate removal, policy, auth and workspace changes.
                const disk = await read();
                const current = disk.verified ? disk.storage?.accounts.find(row => resolveAccountRecordId(row) === resolveAccountRecordId(fresh.account)) : undefined;
                const policy = current ? (await loadAccountPolicyStore()).accounts[getAccountPolicyKey(current)] : undefined;
                if (!disk.storage || !current || current.refreshToken !== fresh.account.refreshToken || current.accessToken !== fresh.accessToken || !policy?.autoPrime || policy.paused || policy.drained || policy.emergencyOnly || current.enabled === false || current.authInvalidatedAt || (current.coolingDownUntil ?? 0) > Date.now())
                    return;
                if (automaticCheckWorkspaceId(current) !== targetId || signal.aborted)
                    return;
                const snapshot = await fetchCodexQuotaSnapshot({ accountId: targetId, accessToken: fresh.accessToken, primeUnusedSubscription: true, signal });
                if (snapshot.primingFailure)
                    logWarn("Automatic first-use completion was not confirmed; retry deferred until the next check.");
                await onQuota(current, snapshot, disk.storage.accounts, targetId);
            }
            finally {
                await manager.flushPendingSave();
            }
        },
    }));
}
