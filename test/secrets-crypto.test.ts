import { describe, expect, it } from "vitest";
import {
	decryptSecret,
	encryptSecret,
	getSecretEncryptionKeysFromEnv,
	isEncryptedSecret,
} from "../lib/secrets-crypto.js";

describe("secrets crypto", () => {
	it("encrypts and decrypts with the primary key", () => {
		const encrypted = encryptSecret("refresh-token-value", "primary-key");
		expect(isEncryptedSecret(encrypted)).toBe(true);
		const decrypted = decryptSecret(encrypted, {
			primary: "primary-key",
			previous: null,
		});
		expect(decrypted).toEqual({ value: "refresh-token-value", usedPreviousKey: false });
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