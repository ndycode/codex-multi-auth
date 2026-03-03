import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ENCRYPTED_PREFIX = "enc:v1:";

export interface SecretEncryptionKeys {
	primary: string | null;
	previous: string | null;
}

function deriveAesKey(input: string): Buffer {
	return createHash("sha256").update(input, "utf8").digest();
}

function parseEnvelope(value: string): {
	iv: Buffer;
	tag: Buffer;
	ciphertext: Buffer;
} | null {
	if (!value.startsWith(ENCRYPTED_PREFIX)) return null;
	const payload = value.slice(ENCRYPTED_PREFIX.length);
	const [ivPart, tagPart, cipherPart] = payload.split(":", 3);
	if (!ivPart || !tagPart || !cipherPart) return null;
	try {
		return {
			iv: Buffer.from(ivPart, "base64"),
			tag: Buffer.from(tagPart, "base64"),
			ciphertext: Buffer.from(cipherPart, "base64"),
		};
	} catch {
		return null;
	}
}

export function isEncryptedSecret(value: string): boolean {
	return value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptSecret(value: string, keyMaterial: string): string {
	if (!value) return value;
	if (isEncryptedSecret(value)) return value;

	const key = deriveAesKey(keyMaterial);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(Buffer.from(value, "utf8")),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return `${ENCRYPTED_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
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
			const key = deriveAesKey(keyMaterial);
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

	throw new Error("Unable to decrypt secret with configured keys");
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
