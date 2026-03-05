import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decryptSecret,
	encryptSecret,
	getSecretEncryptionKeysFromEnv,
	isEncryptedSecret,
} from "../lib/secrets-crypto.js";

function createLegacyEncryptedSecret(value: string, keyMaterial: string): string {
	const key = createHash("sha256").update(keyMaterial, "utf8").digest();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(Buffer.from(value, "utf8")),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

describe("secrets crypto", () => {
	it("encrypts and decrypts with the primary key", () => {
		const encrypted = encryptSecret("refresh-token-value", "primary-key");
		expect(encrypted.startsWith("enc:v2:")).toBe(true);
		expect(isEncryptedSecret(encrypted)).toBe(true);
		const decrypted = decryptSecret(encrypted, {
			primary: "primary-key",
			previous: null,
		});
		expect(decrypted).toEqual({ value: "refresh-token-value", usedPreviousKey: false });
	});

	it("decrypts legacy v1 envelopes for backward compatibility", () => {
		const encrypted = createLegacyEncryptedSecret("legacy-token", "legacy-key");
		const decrypted = decryptSecret(encrypted, {
			primary: "legacy-key",
			previous: null,
		});
		expect(decrypted).toEqual({ value: "legacy-token", usedPreviousKey: false });
	});

	it("uses previous key when primary cannot decrypt", () => {
		const encrypted = encryptSecret("access-token-value", "old-key");
		const decrypted = decryptSecret(encrypted, {
			primary: "new-key",
			previous: "old-key",
		});
		expect(decrypted).toEqual({ value: "access-token-value", usedPreviousKey: true });
	});

	it("throws when no configured key can decrypt envelope", () => {
		const encrypted = encryptSecret("secret", "correct-key");
		expect(() =>
			decryptSecret(encrypted, {
				primary: "wrong-key",
				previous: null,
			}),
		).toThrow("Unable to decrypt secret with configured keys");
	});

	it("recognizes legacy and current encrypted prefixes", () => {
		expect(isEncryptedSecret("enc:v1:abc:def:ghi")).toBe(true);
		expect(isEncryptedSecret("enc:v2:abc:def:ghi:jkl")).toBe(true);
		expect(isEncryptedSecret("enc:v3:abc:def:ghi:jkl")).toBe(false);
	});

	it("re-encrypts malformed prefixed plaintext inputs", () => {
		const malformed = "enc:v2:not-a-valid-envelope";
		const encrypted = encryptSecret(malformed, "0123456789abcdef0123456789abcdef");
		expect(encrypted).not.toBe(malformed);
		expect(encrypted.startsWith("enc:v2:")).toBe(true);
		const decrypted = decryptSecret(encrypted, {
			primary: "0123456789abcdef0123456789abcdef",
			previous: null,
		});
		expect(decrypted.value).toBe(malformed);
	});

	it("reads and trims encryption keys from env", () => {
		const previousPrimary = process.env.CODEX_AUTH_ENCRYPTION_KEY;
		const previousSecondary = process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY;
		try {
			process.env.CODEX_AUTH_ENCRYPTION_KEY = "  0123456789abcdef0123456789abcdef  ";
			process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY = "\tfedcba9876543210fedcba9876543210\n";
			expect(getSecretEncryptionKeysFromEnv()).toEqual({
				primary: "0123456789abcdef0123456789abcdef",
				previous: "fedcba9876543210fedcba9876543210",
			});
		} finally {
			if (previousPrimary === undefined) {
				delete process.env.CODEX_AUTH_ENCRYPTION_KEY;
			} else {
				process.env.CODEX_AUTH_ENCRYPTION_KEY = previousPrimary;
			}
			if (previousSecondary === undefined) {
				delete process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY;
			} else {
				process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY = previousSecondary;
			}
		}
	});

	it("rejects weak key material from environment", () => {
		const previousPrimary = process.env.CODEX_AUTH_ENCRYPTION_KEY;
		const previousSecondary = process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY;
		try {
			process.env.CODEX_AUTH_ENCRYPTION_KEY = "short";
			delete process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY;
			expect(() => getSecretEncryptionKeysFromEnv()).toThrow(
				"CODEX_AUTH_ENCRYPTION_KEY must contain at least 32 bytes of key material",
			);

			process.env.CODEX_AUTH_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
			process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY = "tiny";
			expect(() => getSecretEncryptionKeysFromEnv()).toThrow(
				"CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY must contain at least 32 bytes of key material",
			);
		} finally {
			if (previousPrimary === undefined) {
				delete process.env.CODEX_AUTH_ENCRYPTION_KEY;
			} else {
				process.env.CODEX_AUTH_ENCRYPTION_KEY = previousPrimary;
			}
			if (previousSecondary === undefined) {
				delete process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY;
			} else {
				process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY = previousSecondary;
			}
		}
	});
});
