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
		).toThrow("Unable to decrypt v2 secret with configured keys");
	});

	it("throws when both configured keys are null for encrypted payloads", () => {
		const encrypted = encryptSecret("secret", "correct-key");
		expect(() =>
			decryptSecret(encrypted, {
				primary: null,
				previous: null,
			}),
		).toThrow("Unable to decrypt v2 secret with configured keys");
	});

	it("recognizes legacy and current encrypted prefixes", () => {
		const legacyEncrypted = createLegacyEncryptedSecret("legacy-token", "legacy-key");
		const currentEncrypted = encryptSecret("current-token", "current-key");
		expect(isEncryptedSecret(legacyEncrypted)).toBe(true);
		expect(isEncryptedSecret(currentEncrypted)).toBe(true);
		expect(isEncryptedSecret("enc:v3:abc:def:ghi:jkl")).toBe(false);
	});

	it("reads and trims encryption keys from env", () => {
		const previousPrimary = process.env.CODEX_AUTH_ENCRYPTION_KEY;
		const previousSecondary = process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY;
		try {
			process.env.CODEX_AUTH_ENCRYPTION_KEY = "  key-a  ";
			process.env.CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY = "\tkey-b\n";
			expect(getSecretEncryptionKeysFromEnv()).toEqual({
				primary: "key-a",
				previous: "key-b",
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
});
