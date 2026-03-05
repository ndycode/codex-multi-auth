import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";

type SecretStorageMode = "keychain" | "plaintext" | "auto";
type EffectiveSecretStorageMode = "keychain" | "plaintext";

type KeytarModule = {
	setPassword(service: string, account: string, password: string): Promise<void>;
	getPassword(service: string, account: string): Promise<string | null>;
	deletePassword(service: string, account: string): Promise<boolean>;
};

interface DeleteAccountSecretsOptions {
	force?: boolean;
}

export interface AccountSecretRefs {
	refreshTokenRef: string;
	accessTokenRef?: string;
}

export interface AccountSecrets {
	refreshToken: string;
	accessToken?: string;
}

export interface AccountSecretRefInput {
	accountId?: string;
	email?: string;
	addedAt?: number;
	refreshToken: string;
}

const log = createLogger("token-store");
const SECRET_SERVICE = "codex-multi-auth";
const SECRET_DELETE_RETRY_CODES = new Set(["EBUSY", "EPERM", "EAGAIN"]);
const SECRET_DELETE_RETRY_ATTEMPTS = 4;
let keytarLoader: Promise<KeytarModule | null> | null = null;

function parseSecretStorageMode(value: string | undefined): SecretStorageMode {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "plaintext") return "plaintext";
	if (normalized === "auto") return "auto";
	return "keychain";
}

async function loadKeytar(): Promise<KeytarModule | null> {
	if (!keytarLoader) {
		keytarLoader = (async () => {
			try {
				const imported = (await import("keytar")) as unknown as { default?: unknown };
				const mod = (imported.default ?? imported) as KeytarModule;
				if (
					typeof mod.setPassword !== "function" ||
					typeof mod.getPassword !== "function" ||
					typeof mod.deletePassword !== "function"
				) {
					return null;
				}
				return mod;
			} catch {
				return null;
			}
		})();
	}
	return keytarLoader;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDeleteError(error: unknown): boolean {
	const maybe = error as { code?: string; status?: number; message?: string };
	if (typeof maybe.code === "string" && SECRET_DELETE_RETRY_CODES.has(maybe.code)) {
		return true;
	}
	if (typeof maybe.status === "number" && maybe.status === 429) {
		return true;
	}
	const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
	return message.includes("429") || message.includes("rate limit");
}

async function deleteSecretRefWithRetry(keytar: KeytarModule, ref: string): Promise<void> {
	for (let attempt = 0; attempt < SECRET_DELETE_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await keytar.deletePassword(SECRET_SERVICE, ref);
			return;
		} catch (error) {
			if (!isRetryableDeleteError(error) || attempt === SECRET_DELETE_RETRY_ATTEMPTS - 1) {
				throw error;
			}
			await sleep(25 * 2 ** attempt);
		}
	}
}

export async function getEffectiveSecretStorageMode(): Promise<EffectiveSecretStorageMode> {
	const configured = parseSecretStorageMode(process.env.CODEX_SECRET_STORAGE_MODE);
	if (configured === "plaintext") return "plaintext";
	if (configured === "keychain") return "keychain";
	const keytar = await loadKeytar();
	return keytar ? "keychain" : "plaintext";
}

async function getKeytarOrThrow(): Promise<KeytarModule> {
	const keytar = await loadKeytar();
	if (keytar) return keytar;
	throw new Error(
		"Keychain secret storage is required but keytar is unavailable. Install optional dependency 'keytar' or set CODEX_SECRET_STORAGE_MODE=plaintext.",
	);
}

export async function ensureSecretStorageBackendAvailable(): Promise<void> {
	const mode = await getEffectiveSecretStorageMode();
	if (mode === "plaintext") return;
	await getKeytarOrThrow();
}

export function deriveAccountSecretRef(input: AccountSecretRefInput): string {
	const normalizedEmail = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
	const normalizedAccountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
	const stableSeed = `${normalizedAccountId}|${normalizedEmail}|${input.addedAt ?? 0}`;
	const hasStableIdentity = normalizedAccountId.length > 0 || normalizedEmail.length > 0;
	const fallbackSeed = createHash("sha256")
		.update(input.refreshToken)
		.digest("hex")
		.slice(0, 16);
	const seed = hasStableIdentity ? stableSeed : fallbackSeed;
	return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

export async function persistAccountSecrets(
	baseRef: string,
	secrets: AccountSecrets,
): Promise<AccountSecretRefs | null> {
	const mode = await getEffectiveSecretStorageMode();
	if (mode === "plaintext") return null;

	const keytar = await getKeytarOrThrow();
	const refreshTokenRef = `${baseRef}:refresh`;
	await keytar.setPassword(SECRET_SERVICE, refreshTokenRef, secrets.refreshToken);

	let accessTokenRef: string | undefined;
	if (typeof secrets.accessToken === "string" && secrets.accessToken.trim().length > 0) {
		accessTokenRef = `${baseRef}:access`;
		try {
			await keytar.setPassword(SECRET_SERVICE, accessTokenRef, secrets.accessToken);
		} catch (error) {
			try {
				await deleteSecretRefWithRetry(keytar, refreshTokenRef);
			} catch (cleanupError) {
				log.warn("Failed to rollback refresh secret after access secret write failure", {
					refreshTokenRef,
					error: String(cleanupError),
				});
			}
			throw error;
		}
	}

	return {
		refreshTokenRef,
		accessTokenRef,
	};
}

export async function loadAccountSecrets(
	refs: AccountSecretRefs,
): Promise<AccountSecrets | null> {
	const mode = await getEffectiveSecretStorageMode();
	if (mode === "plaintext") return null;

	const keytar = await getKeytarOrThrow();
	const refreshToken = await keytar.getPassword(SECRET_SERVICE, refs.refreshTokenRef);
	if (!refreshToken) {
		log.warn("Missing refresh token in keychain", { ref: refs.refreshTokenRef });
		return null;
	}
	let accessToken: string | undefined;
	if (refs.accessTokenRef) {
		accessToken = (await keytar.getPassword(SECRET_SERVICE, refs.accessTokenRef)) ?? undefined;
	}
	return { refreshToken, accessToken };
}

export async function deleteAccountSecrets(
	refs: AccountSecretRefs,
	options: DeleteAccountSecretsOptions = {},
): Promise<void> {
	let keytar: KeytarModule | null = null;
	if (options.force) {
		keytar = await loadKeytar();
	} else {
		const mode = await getEffectiveSecretStorageMode();
		if (mode === "plaintext") return;
		keytar = await getKeytarOrThrow();
	}
	if (!keytar) return;

	const deleteErrors: unknown[] = [];
	try {
		await deleteSecretRefWithRetry(keytar, refs.refreshTokenRef);
	} catch (error) {
		deleteErrors.push(error);
	}
	if (refs.accessTokenRef) {
		try {
			await deleteSecretRefWithRetry(keytar, refs.accessTokenRef);
		} catch (error) {
			deleteErrors.push(error);
		}
	}
	if (deleteErrors.length > 0) {
		throw deleteErrors[0];
	}
}

export function resetSecretStoreCacheForTests(): void {
	keytarLoader = null;
}
