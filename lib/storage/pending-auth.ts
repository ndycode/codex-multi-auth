import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { withRetry } from "../fs-retry.js";
import { createLogger } from "../logger.js";
import { tempPathFor } from "../temp-path.js";
import { withFileTransactionLock } from "./file-lock.js";
import { getIntentionalResetMarkerPath } from "./backup-paths.js";
import type { AccountStorageV3 } from "./public-types.js";

/**
 * Rotated OAuth credentials that could not be written to the account pool
 * (a locked or unreadable accounts file). A refresh spends the previous
 * refresh token upstream, so losing the new one with the process means the
 * account needs a re-login. Every load applies these entries until a save
 * persists them.
 */
const entrySchema = z.object({
	/** sha256 of the spent refresh token: identifies the row without storing it. */
	prior: z.string().regex(/^[0-9a-f]{64}$/),
	refreshToken: z.string().min(1),
	accessToken: z.string().min(1),
	expiresAt: z.number(),
	at: z.number(),
});
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(1000) });
type PendingAuth = z.infer<typeof entrySchema>;
const retry = { maxAttempts: 6, backoffMs: 25 };
const log = createLogger("pending-auth");

export function getPendingAuthPath(storagePath: string): string {
	return `${storagePath}.pending-auth.json`;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Only a missing file is empty. The entries are the only copy of rotated
 * tokens, so a lock that outlasts the retries or a torn/corrupt file throws:
 * a writer must never replace it with a partial list.
 */
async function read(path: string): Promise<PendingAuth[]> {
	let raw: string;
	try {
		raw = await withRetry(() => fs.readFile(path, "utf8"), retry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return fileSchema.parse(JSON.parse(raw)).entries;
}

async function write(path: string, entries: PendingAuth[]): Promise<void> {
	if (!entries.length) {
		await withRetry(() => fs.rm(path, { force: true }), retry);
		return;
	}
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = tempPathFor(path);
	try {
		await fs.writeFile(temp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600, flag: "wx" });
		await withRetry(() => fs.rename(temp, path), retry);
	} finally {
		await fs.rm(temp, { force: true }).catch(() => undefined);
	}
}

/** Record a rotated credential beside the account pool. */
export async function recordPendingAuth(
	storagePath: string,
	auth: { priorRefreshToken: string; refreshToken: string; accessToken: string; expiresAt: number; at: number },
): Promise<void> {
	const path = getPendingAuthPath(storagePath);
	await withFileTransactionLock(path, async () => {
        try {
            await fs.stat(getIntentionalResetMarkerPath(storagePath));
            throw Object.assign(new Error("Account pool was reset; rotated credentials were not retained."), {code:"ESTALE"});
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const prior = hash(auth.priorRefreshToken);
		const entries = (await read(path)).filter(
			(entry) => entry.prior !== prior && entry.prior !== hash(auth.refreshToken),
		);
		// Rotating a token that is itself only journaled: the row on disk still holds
		// the original spent token, so extend that entry rather than add one that
		// no disk row can match.
		const chained = entries.find((entry) => entry.refreshToken === auth.priorRefreshToken);
		if (chained) Object.assign(chained, { refreshToken: auth.refreshToken, accessToken: auth.accessToken, expiresAt: auth.expiresAt, at: auth.at });
		else entries.push({ prior, refreshToken: auth.refreshToken, accessToken: auth.accessToken, expiresAt: auth.expiresAt, at: auth.at });
		await write(path, entries);
	});
}

/** Overlay pending rotated credentials on rows that still hold the spent token. */
export async function applyPendingAuth(
	storagePath: string,
	storage: AccountStorageV3 | null,
): Promise<AccountStorageV3 | null> {
	if (!storage) return storage;
	let entries: PendingAuth[];
	try {
		entries = await read(getPendingAuthPath(storagePath));
	} catch (error) {
		// Loading must still work; the file is left untouched for a later load.
		log.error("Pending rotated credentials could not be read; affected accounts may need a re-login if this persists", {
			path: getPendingAuthPath(storagePath),
			code: typeof (error as NodeJS.ErrnoException).code === "string" && /^[A-Z_]{1,40}$/.test((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "INVALID_PENDING_AUTH",
		});
		return storage;
	}
	if (!entries.length) return storage;
	for (const account of storage.accounts) {
		const entry = account.refreshToken ? entries.find((item) => item.prior === hash(account.refreshToken)) : undefined;
		if (!entry) continue;
		account.refreshToken = entry.refreshToken;
		account.accessToken = entry.accessToken;
		account.expiresAt = entry.expiresAt;
		delete account.authInvalidatedAt;
		delete account.authInvalidationErrorCode;
		if (account.cooldownReason === "auth-failure") {
			delete account.coolingDownUntil;
			delete account.cooldownReason;
		}
	}
	return storage;
}

/** After a save, drop entries whose spent token is no longer on disk (persisted or superseded). */
export async function prunePendingAuth(storagePath: string, saved: AccountStorageV3): Promise<void> {
	const path = getPendingAuthPath(storagePath);
	const current = await read(path);
	if (!current.length) return;
	await withFileTransactionLock(path, async () => {
		const spent = new Set(saved.accounts.map((account) => hash(account.refreshToken)));
		const entries = await read(path);
		const remaining = entries.filter((entry) => spent.has(entry.prior));
		if (remaining.length !== entries.length) await write(path, remaining);
	});
}

/** Coordinate resets with pending credential writers, including Windows rename locks. */
export async function clearPendingAuth(storagePath: string): Promise<void> {
 const path=getPendingAuthPath(storagePath);
 await withFileTransactionLock(path,()=>withRetry(()=>fs.rm(path,{force:true}),retry));
}
