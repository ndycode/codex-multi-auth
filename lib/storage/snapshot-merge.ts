import type { AccountMetadataV3, AccountStorageV3 } from "./public-types.js";
import { getAccountIdentityKey } from "./identity.js";
import { isRecord } from "../utils.js";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function conflict(): never {
    throw Object.assign(Error("Account storage changed concurrently; reload before saving."), { code: "ESTALE" });
}
function mergeValue(base: unknown, disk: unknown, local: unknown): unknown {
    if (equal(base, local) || equal(disk, local))
        return structuredClone(disk);
    if (equal(base, disk))
        return structuredClone(local);
    if (base === undefined && isRecord(disk) && isRecord(local)) base = {};
    if (isRecord(base) && isRecord(disk) && isRecord(local)) {
        const result: Record<string, unknown> = Object.create(null);
        for (const key of new Set([...Object.keys(base), ...Object.keys(disk), ...Object.keys(local)])) {
            const value = mergeValue(base[key], disk[key], local[key]);
            if (value !== undefined)
                result[key] = value;
        }
        return result;
    }
    return conflict();
}
type Workspace = NonNullable<AccountMetadataV3["workspaces"]>[number];
const byId = (rows: Workspace[] | undefined) => new Map((rows ?? []).map(row => [row.id, row]));
/**
 * Merge workspaces by id, never by array position. Fields changed on one side
 * win; enabled/disabledAt move as one unit, and when both sides changed it an
 * intentional re-enable wins over a disable. Other two-sided edits conflict.
 * Removal follows the account rule: a record removed on either side stays
 * removed.
 */
function mergeWorkspaces(base: AccountMetadataV3, disk: AccountMetadataV3, local: AccountMetadataV3): Pick<AccountMetadataV3, "workspaces" | "currentWorkspaceIndex"> {
    const before = byId(base.workspaces), onDisk = byId(disk.workspaces), next = byId(local.workspaces);
    const ids = [...onDisk.keys(), ...[...next.keys()].filter(id => !onDisk.has(id) && !before.has(id))];
    const workspaces: Workspace[] = [];
    for (const id of ids) {
        const b = before.get(id), d = onDisk.get(id), l = next.get(id);
        if (!d || !l) {
            // Present on one side only: an addition survives, a removal wins.
            const added = d ?? l;
            if (!b && added) workspaces.push(structuredClone(added));
            continue;
        }
        const state = (row: Workspace | undefined) => ({ enabled: row?.enabled, disabledAt: row?.disabledAt });
        const stateSource = equal(state(b), state(l)) ? d : equal(state(b), state(d)) ? l : d.enabled !== false ? d : l.enabled !== false ? l : (d.disabledAt ?? 0) >= (l.disabledAt ?? 0) ? d : l;
        const pick = (row: Workspace) => ({ ...row, enabled: stateSource.enabled, disabledAt: stateSource.disabledAt });
        const merged = mergeValue(b ? pick(b) : undefined, pick(d), pick(l)) as Workspace;
        if (merged.disabledAt === undefined) delete merged.disabledAt;
        workspaces.push(merged);
    }
    const currentId = (row: AccountMetadataV3) => row.workspaces?.[row.currentWorkspaceIndex ?? 0]?.id;
    const chosen = currentId(local) !== currentId(base) ? currentId(local) : currentId(disk);
    let index = workspaces.findIndex(row => row.id === chosen);
    if (index < 0 || workspaces[index]?.enabled === false) {
        const enabled = workspaces.findIndex(row => row.enabled !== false);
        index = enabled >= 0 ? enabled : Math.max(index, 0);
    }
    const untracked = [base, disk, local].every(row => row.currentWorkspaceIndex === undefined);
    return { workspaces, currentWorkspaceIndex: untracked && index === 0 ? undefined : index };
}
type CooldownRow = Pick<AccountMetadataV3, "coolingDownUntil" | "cooldownReason" | "refreshToken">;
/**
 * Preserve concurrent cooldown observations while allowing an unchanged blocker to clear.
 * An auth-failure cooldown belongs to the credential it was recorded against: once
 * the merge keeps a different refresh token (e.g. we won a single-use refresh the
 * other process lost with invalid_grant), that side's auth blocker is obsolete.
 * Other cooldown reasons are observations about the account and are kept.
 */
export function mergeAccountCooldown(base: CooldownRow, disk: CooldownRow, local: CooldownRow): Pick<AccountMetadataV3, "coolingDownUntil" | "cooldownReason"> {
    const keptToken = local.refreshToken === base.refreshToken ? disk.refreshToken : local.refreshToken;
    const current = (row: CooldownRow): CooldownRow => row.cooldownReason === "auth-failure" && row.refreshToken !== keptToken
        ? { ...row, coolingDownUntil: undefined, cooldownReason: undefined } : row;
    disk = current(disk);
    local = current(local);
    const cleared = base.coolingDownUntil !== undefined && (
        (disk.coolingDownUntil === undefined && (local.coolingDownUntil === undefined || local.coolingDownUntil === base.coolingDownUntil)) ||
        (local.coolingDownUntil === undefined && disk.coolingDownUntil === base.coolingDownUntil));
    const cooldown = (disk.coolingDownUntil ?? 0) >= (local.coolingDownUntil ?? 0) ? disk : local;
    return { coolingDownUntil: cleared ? undefined : cooldown.coolingDownUntil, cooldownReason: cleared ? undefined : cooldown.cooldownReason };
}
/** Runtime observations commute; user-owned edits retain conflict detection. */
function mergeRuntimeAccount(base: AccountMetadataV3, disk: AccountMetadataV3, local: AccountMetadataV3): AccountMetadataV3 {
    const limits: Record<string, number> = {};
    for (const key of new Set([...Object.keys(disk.rateLimitResetTimes ?? {}), ...Object.keys(local.rateLimitResetTimes ?? {})])) {
        const before = base.rateLimitResetTimes?.[key], a = disk.rateLimitResetTimes?.[key], b = local.rateLimitResetTimes?.[key];
        // An explicit clear is an operation, not a new observation.
        const clear = before !== undefined && ((a === undefined && b === before) || (b === undefined && a === before) || (a === undefined && b === undefined));
        const value = clear ? undefined : Math.max(a ?? 0, b ?? 0);
        if (value !== undefined) limits[key] = value;
    }
    const runtime = {
        rateLimitResetTimes: Object.keys(limits).length ? limits : undefined,
        ...mergeAccountCooldown(base, disk, local),
        lastSwitchReason: local.lastSwitchReason ?? disk.lastSwitchReason,
        ...(disk.workspaces || local.workspaces ? mergeWorkspaces(base, disk, local) : {}),
    };
    // Omitted and true both mean enabled; serialization does not express a user edit.
    const normalized = (row: AccountMetadataV3) => ({...row, enabled:row.enabled === false ? false : undefined});
    return mergeValue(normalized(base), {...normalized(disk), ...runtime}, {...normalized(local), ...runtime}) as AccountMetadataV3;
}
/** Three-way persistence under the file transaction lock. Disk deletions win over stale runtime state. */
export function mergeAccountSnapshot(base: AccountStorageV3 | null, current: AccountStorageV3 | null, local: AccountStorageV3): AccountStorageV3 {
    if (!base) {
        if (!current) return structuredClone(local);
        // An unavailable initial read is not authority to replace the inventory.
        base = {version:3, accounts:[], activeIndex:0};
    }
    if (!current && base.accounts.length === 0 && "restoreReason" in base && base.restoreReason === "missing-storage")
        current = { version: 3, accounts: [], activeIndex: 0 };
    if (!current)
        return conflict();
    const aliases = new Map<string, Set<string>>();
    for (const row of [...base.accounts, ...current.accounts, ...local.accounts]) {
        const key = getAccountIdentityKey(row);
        if (!key || !row.recordId)
            continue;
        const ids = aliases.get(key) ?? new Set<string>();
        ids.add(row.recordId);
        aliases.set(key, ids);
    }
    const identity = (row: AccountMetadataV3) => {
        if (row.recordId)
            return row.recordId;
        const key = getAccountIdentityKey(row), ids = key ? aliases.get(key) : undefined;
        return ids?.size === 1 ? [...ids][0] : key;
    };
    const index = (rows: AccountMetadataV3[]) => {
        const map = new Map<string, AccountMetadataV3>();
        for (const row of rows) {
            const key = identity(row);
            if (!key || map.has(key))
                return conflict();
            map.set(key, row);
        }
        return map;
    };
    const old = index(base.accounts), disk = index(current.accounts), proposed = index(local.accounts);
    const accounts: AccountMetadataV3[] = [];
    for (const [key, row] of disk) {
        const prior = old.get(key), next = proposed.get(key);
        if (prior && !next)
            continue; // Explicit local removal of a previously known record.
        if (!prior) {
            if (next && !equal(row, next))
                conflict();
            accounts.push(structuredClone(row));
            continue;
        }
        if (!next)
            continue;
        const lastUsed = Math.max(row.lastUsed, next.lastUsed);
        const merged = mergeRuntimeAccount(prior, { ...row, lastUsed }, { ...next, lastUsed });
        accounts.push(merged);
    }
    for (const [key, row] of proposed)
        if (!old.has(key) && !disk.has(key))
            accounts.push(structuredClone(row));
    const pointer = (storage: AccountStorageV3, value: number | undefined) => { const row = value === undefined ? undefined : storage.accounts[value]; return row ? identity(row) : undefined; };
    const position = (id: string | undefined) => id === undefined ? undefined : accounts.findIndex(row => identity(row) === id);
    const pick = (before: number | undefined, onDisk: number | undefined, next: number | undefined) => {
        const oldId = pointer(base, before), diskId = pointer(current, onDisk), localId = pointer(local, next);
        return position(localId !== oldId ? localId : diskId);
    };
    // Pointer metadata must be compared by identity, never by mutable list positions.
    const fields = (storage: AccountStorageV3) => Object.fromEntries(Object.entries(storage).filter(([key]) => !["accounts", "activeIndex", "activeIndexByFamily", "pinnedAccountIndex", "restoreEligible", "restoreReason"].includes(key)));
    const result = { ...mergeValue(fields(base), fields(current), fields(local)) as Omit<AccountStorageV3, "accounts" | "activeIndex">, accounts, activeIndex: Math.max(0, pick(base.activeIndex, current.activeIndex, local.activeIndex) ?? 0) };
    result.activeIndexByFamily = {};
    for (const family of new Set([...Object.keys(base.activeIndexByFamily ?? {}), ...Object.keys(current.activeIndexByFamily ?? {}), ...Object.keys(local.activeIndexByFamily ?? {})])) {
        const f = family as keyof NonNullable<AccountStorageV3["activeIndexByFamily"]>;
        result.activeIndexByFamily[f] = Math.max(0, pick(base.activeIndexByFamily?.[f], current.activeIndexByFamily?.[f], local.activeIndexByFamily?.[f]) ?? 0);
    }
    const pinned = pick(base.pinnedAccountIndex, current.pinnedAccountIndex, local.pinnedAccountIndex);
    if (pinned !== undefined && pinned >= 0)
        result.pinnedAccountIndex = pinned;
    return result;
}

/** Save observations independently of unresolved user-edit conflicts. Inventory stays disk-owned. */
export function mergeAccountRuntimeObservations(base: AccountStorageV3, current: AccountStorageV3, local: AccountStorageV3): AccountStorageV3 {
    const observations = structuredClone(base);
    const matches = (a: AccountMetadataV3, b: AccountMetadataV3) => a.recordId && b.recordId
        ? a.recordId === b.recordId : getAccountIdentityKey(a) === getAccountIdentityKey(b);
    for (const prior of observations.accounts) {
        const next = local.accounts.find(row => matches(prior, row));
        if (!next) continue;
        prior.lastUsed = Math.max(prior.lastUsed, next.lastUsed);
        for (const field of ["rateLimitResetTimes", "coolingDownUntil", "cooldownReason", "lastSwitchReason"] as const) {
            if (next[field] === undefined) delete prior[field];
            else Object.assign(prior, { [field]: structuredClone(next[field]) });
        }
        // Preserve runtime workspace disables without committing labels or workspace selection.
        for (const workspace of prior.workspaces ?? []) {
            const updated = next.workspaces?.find(row => row.id === workspace.id);
            if (updated) { workspace.enabled = updated.enabled; workspace.disabledAt = updated.disabledAt; }
        }
    }
    return mergeAccountSnapshot(base, current, observations);
}
