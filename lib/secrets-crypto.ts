import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	scryptSync,
} from "node:crypto";

const ENCRYPTED_PREFIX = "enc:";
const LEGACY_ENCRYPTED_VERSION = "v1";
const ENCRYPTED_VERSION = "v2";
const AES_KEY_LENGTH = 32;
const AES_GCM_IV_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const SCRYPT_SALT_LENGTH = 16;

export interface SecretEncryptionKeys {
	primary: string | null;
	previous: string | null;
}

function deriveLegacyAesKey(input: string): Buffer {
	return createHash("sha256").update(input, "utf8").digest();
}

function deriveAesKey(input: string, salt: Buffer): Buffer {
	// Intentionally synchronous: callers use this in short-lived local encryption
	// paths where deterministic blocking behavior is preferred.
	return scryptSync(input, salt, AES_KEY_LENGTH);
}

type SecretEnvelope = {
	version: "v1";
	iv: Buffer;
	tag: Buffer;
	ciphertext: Buffer;
	salt: null;
} | {
	version: "v2";
	iv: Buffer;
	tag: Buffer;
	ciphertext: Buffer;
	salt: Buffer;
};

function decodeBase64Part(value: string): Buffer | null {
	try {
		const decoded = Buffer.from(value, "base64");
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}

function parseEnvelope(value: string): SecretEnvelope | null {
	if (!value.startsWith(ENCRYPTED_PREFIX)) return null;
	const payload = value.slice(ENCRYPTED_PREFIX.length);
	const versionSeparator = payload.indexOf(":");
	if (versionSeparator <= 0 || versionSeparator === payload.length - 1) return null;
	const versionPart = payload.slice(0, versionSeparator);
	const remainder = payload.slice(versionSeparator + 1);

	if (versionPart === LEGACY_ENCRYPTED_VERSION) {
		const [ivPart, tagPart, cipherPart] = remainder.split(":", 3);
		if (!ivPart || !tagPart || !cipherPart) return null;
		const iv = decodeBase64Part(ivPart);
		const tag = decodeBase64Part(tagPart);
		const ciphertext = decodeBase64Part(cipherPart);
		if (!iv || !tag || !ciphertext) return null;
		if (iv.length !== AES_GCM_IV_LENGTH) return null;
		if (tag.length !== AES_GCM_TAG_LENGTH) return null;
		return {
			version: "v1",
			iv,
			tag,
			ciphertext,
			salt: null,
		};
	}

	if (versionPart === ENCRYPTED_VERSION) {
		const [saltPart, ivPart, tagPart, cipherPart] = remainder.split(":", 4);
		if (!saltPart || !ivPart || !tagPart || !cipherPart) return null;
		const salt = decodeBase64Part(saltPart);
		const iv = decodeBase64Part(ivPart);
		const tag = decodeBase64Part(tagPart);
		const ciphertext = decodeBase64Part(cipherPart);
		if (!salt || !iv || !tag || !ciphertext) return null;
		if (salt.length !== SCRYPT_SALT_LENGTH) return null;
		if (iv.length !== AES_GCM_IV_LENGTH) return null;
		if (tag.length !== AES_GCM_TAG_LENGTH) return null;
		return {
			version: "v2",
			salt,
			iv,
			tag,
			ciphertext,
		};
	}

	return null;
}

export function isEncryptedSecret(value: string): boolean {
	return parseEnvelope(value) !== null;
}

export function encryptSecret(value: string, keyMaterial: string): string {
	if (!value) return value;
	if (isEncryptedSecret(value)) return value;

	const salt = randomBytes(SCRYPT_SALT_LENGTH);
	const key = deriveAesKey(keyMaterial, salt);
	const iv = randomBytes(AES_GCM_IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(Buffer.from(value, "utf8")),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return `${ENCRYPTED_PREFIX}${ENCRYPTED_VERSION}:${salt.toString("base64")}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(
	value: string,
	keys: SecretEncryptionKeys,
): { value: string; usedPreviousKey: boolean } {
	const envelope = parseEnvelope(value);
	if (!envelope) {
		return { value, usedPreviousKey: false };
	}

	const tryDecrypt = (keyMaterial: string | null): string | null => {
		if (!keyMaterial) return null;
		try {
			const key = envelope.version === "v1"
				? deriveLegacyAesKey(keyMaterial)
				: deriveAesKey(keyMaterial, envelope.salt);
			const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
			decipher.setAuthTag(envelope.tag);
			const decrypted = Buffer.concat([
				decipher.update(envelope.ciphertext),
				decipher.final(),
			]);
			return decrypted.toString("utf8");
		} catch {
			return null;
		}
	};

	const withPrimary = tryDecrypt(keys.primary);
	if (withPrimary !== null) {
		return { value: withPrimary, usedPreviousKey: false };
	}

	const withPrevious = tryDecrypt(keys.previous);
	if (withPrevious !== null) {
		return { value: withPrevious, usedPreviousKey: true };
	}

	throw new Error(`Unable to decrypt ${envelope.version} secret with configured keys`);
}

function getTrimmedEnv(name: string): string | null {
	const raw = (process.env[name] ?? "").trim();
	return raw.length > 0 ? raw : null;
}

export function getSecretEncryptionKeysFromEnv(): SecretEncryptionKeys {
	return {
		primary: getTrimmedEnv("CODEX_AUTH_ENCRYPTION_KEY"),
		previous: getTrimmedEnv("CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY"),
	};
}
