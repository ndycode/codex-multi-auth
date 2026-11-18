import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getApiRoutesPath } from "../api-route-store.js";
import { withRetry } from "../fs-retry.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { withFileTransactionLock } from "./file-lock.js";
import { withStorageLock } from "./transactions.js";

const retry = { maxAttempts: 6, backoffMs: 25 };

/**
 * Remove the files beside the account pool that hold raw API keys or
 * per-account runtime state. `clearAccounts` only touches the account pool, so
 * `uninstall --clear-accounts` and the dashboard reset call this as well.
 */
export async function clearCredentialSidecars(): Promise<void> {
	const routes = getApiRoutesPath();
	const dir = getCodexMultiAuthDir();
	// Same locks as saveApiRoutes, so a concurrent menu save cannot resurrect keys.
	await withStorageLock(() =>
		withFileTransactionLock(routes, async () => {
			await withRetry(() => fs.rm(routes, { force: true }), retry);
			const leases = join(dir, "api-probe-locks");
			try {
				const stat = await fs.lstat(leases);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Invalid API probe lease directory; manual repair required");
				// Detach while publication is excluded; never recursively delete a
				// canonical directory that a replacement owner can populate.
				await withRetry(() => fs.rename(leases, join(dir, `api-probe-locks.wiped-${randomUUID()}`)), retry);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}),
	);
	// Each writer read-modify-writes under its file lock; deleting under the same
	// lock stops an in-flight refresh or redemption renaming its old state (and a
	// last-resort policy) back after the reset.
	for (const path of [
		join(dir, "reset-credits.json"),
		join(dir, "api-capability-probes.json"),
		join(dir, "automatic-api-checks.json"),
	]) {
		await withFileTransactionLock(path, () =>
			withRetry(() => fs.rm(path, { force: true }), retry),
		);
	}
	// Also finish deletion after an interrupted earlier wipe. These unique paths
	// can contain old holders/candidates, but never a new canonical lease.
	let leftovers: string[];
	try {
		leftovers = await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		leftovers = [];
	}
	for (const entry of leftovers) {
		if (/^api-probe-locks\.wiped-[a-f0-9-]{36}$/.test(entry))
			await withRetry(() => fs.rm(join(dir, entry), { recursive: true, force: true }), retry);
	}
	// Per-account timestamps only; their writers take no lock and hold no secrets.
	const activity = join(dir, "inference-activity");
	await withRetry(() => fs.rm(activity, { recursive: true, force: true }), retry);
}

/**
 * Clear the account pool and the credential sidecars. The sidecars are removed
 * even when the pool clear fails (e.g. a lasting Windows EBUSY), so raw API
 * keys never survive a reset; the first failure is rethrown afterwards.
 */
export async function clearAccountsAndCredentialSidecars(clearPool: () => Promise<void>): Promise<void> {
	let failure: unknown;
	let failed = false;
	for (const step of [clearPool, clearCredentialSidecars]) {
		try {
			await step();
		} catch (error) {
			if (!failed) failure = error;
			failed = true;
		}
	}
	if (failed) throw failure;
}
