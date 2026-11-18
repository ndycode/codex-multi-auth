import { readFile } from "node:fs/promises";
import { decodeJWT } from "../auth/auth.js";
import { extractAccountEmail, extractAccountId, sanitizeEmail } from "../auth/token-utils.js";
import { getCodexCliAuthPath } from "../codex-cli/state.js";
import { withAccountStorageTransaction, type AccountStorageV3 } from "../storage.js";
import { isRecord } from "../utils.js";

/** Adopt only a newer native credential for one existing, enabled identity.
 * Never import inventory, selections, quota state, or an older mirror token.
 */
export async function syncNativeLogin(
 storage: AccountStorageV3,
 read: () => Promise<string> = () => readFile(getCodexCliAuthPath(), "utf8"),
): Promise<boolean> {
 let raw: string;
 try { raw = await read(); } catch { return false; }
 let auth: unknown;
 try { auth = JSON.parse(raw); } catch { return false; }
 if (!isRecord(auth) || !isRecord(auth.tokens)) return false;
 const {access_token: access, refresh_token: refresh, id_token: idToken} = auth.tokens;
 if (typeof access !== "string" || typeof refresh !== "string" || !refresh) return false;
 const claims = decodeJWT(access);
 const issued = claims?.iat, expires = claims?.exp;
 if (typeof issued !== "number" || !Number.isFinite(issued) || typeof expires !== "number" || !Number.isFinite(expires) || expires * 1000 <= Date.now()) return false;
 const accountId = extractAccountId(access);
 const email = sanitizeEmail(extractAccountEmail(access));
 const idEmail = typeof idToken === "string" ? sanitizeEmail(extractAccountEmail(undefined, idToken)) : undefined;
 if (idEmail && email && idEmail !== email) return false;
 if (!accountId || !email) return false;
 const candidate = (pool: AccountStorageV3) => {
  const matches = pool.accounts.filter(a => a.accountId === accountId && sanitizeEmail(a.email) === email);
  if (matches.length !== 1) return undefined;
  const a = matches[0];
  if (!a) return undefined;
  const oldIssued = a.accessToken ? decodeJWT(a.accessToken)?.iat : undefined;
  if (a.enabled === false || a.accessToken === access || typeof oldIssued !== "number" || issued <= oldIssued) return undefined;
  return a;
 };
 if (!candidate(storage)) return false;
 return withAccountStorageTransaction(async (current, persist) => {
  if (!current) return false;
  try { if (await read() !== raw) return false; } catch { return false; }
  const a = candidate(current);
  if (!a) return false;
  a.accessToken = access; a.refreshToken = refresh; a.expiresAt = expires * 1000;
  delete a.authInvalidatedAt; delete a.authInvalidationErrorCode;
  if (a.cooldownReason === "auth-failure") { delete a.cooldownReason; delete a.coolingDownUntil; }
  await persist(current);
  return true;
 });
}
