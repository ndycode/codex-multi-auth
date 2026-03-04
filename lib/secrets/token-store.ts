import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";

type SecretStorageMode = "keychain" | "plaintext" | "auto";
type EffectiveSecretStorageMode = "keychain" | "plaintext";

type KeytarModule = {
	setPassword(service: string, account: string, password: string): Promise<void>;
	getPassword(service: string, account: string): Promise<string | null>;
	deletePassword(service: string, account: string): Promise<boolean>;
};

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
				const mod = (await import("keytar")) as unknown as KeytarModule;
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
	const fallbackSeed = createHash("sha256")
		.update(input.refreshToken)
		.digest("hex")
		.slice(0, 16);
	const seed = stableSeed.trim().length > 0 ? stableSeed : fallbackSeed;
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
		await keytar.setPassword(SECRET_SERVICE, accessTokenRef, secrets.accessToken);
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

export async function deleteAccountSecrets(refs: AccountSecretRefs): Promise<void> {
	const mode = await getEffectiveSecretStorageMode();
	if (mode === "plaintext") return;

	const keytar = await getKeytarOrThrow();
	await keytar.deletePassword(SECRET_SERVICE, refs.refreshTokenRef);
	if (refs.accessTokenRef) {
		await keytar.deletePassword(SECRET_SERVICE, refs.accessTokenRef);
	}
}

export function resetSecretStoreCacheForTests(): void {
	keytarLoader = null;
}
