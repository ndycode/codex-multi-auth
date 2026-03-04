import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("token store", () => {
	const originalMode = process.env.CODEX_SECRET_STORAGE_MODE;

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		if (originalMode === undefined) {
			delete process.env.CODEX_SECRET_STORAGE_MODE;
		} else {
			process.env.CODEX_SECRET_STORAGE_MODE = originalMode;
		}
		vi.doUnmock("keytar");
		vi.restoreAllMocks();
	});

	it("returns plaintext mode when explicitly configured", async () => {
		process.env.CODEX_SECRET_STORAGE_MODE = "plaintext";
		const tokenStore = await import("../lib/secrets/token-store.js");
		expect(await tokenStore.getEffectiveSecretStorageMode()).toBe("plaintext");
		expect(
			await tokenStore.persistAccountSecrets("acct-1", {
				refreshToken: "refresh-token",
				accessToken: "access-token",
			}),
		).toBeNull();
	});

	it("stores and loads secrets through keytar in keychain mode", async () => {
		const secrets = new Map<string, string>();
		vi.doMock("keytar", () => ({
			setPassword: async (_service: string, account: string, password: string) => {
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => secrets.delete(account),
		}));

		process.env.CODEX_SECRET_STORAGE_MODE = "keychain";
		const tokenStore = await import("../lib/secrets/token-store.js");

		await tokenStore.ensureSecretStorageBackendAvailable();
		const refs = await tokenStore.persistAccountSecrets("acct-1", {
			refreshToken: "refresh-token",
			accessToken: "access-token",
		});
		expect(refs).toEqual({
			refreshTokenRef: "acct-1:refresh",
			accessTokenRef: "acct-1:access",
		});

		const loaded = await tokenStore.loadAccountSecrets({
			refreshTokenRef: "acct-1:refresh",
			accessTokenRef: "acct-1:access",
		});
		expect(loaded).toEqual({
			refreshToken: "refresh-token",
			accessToken: "access-token",
		});
	});

	it("derives stable secret refs from account identity", async () => {
		process.env.CODEX_SECRET_STORAGE_MODE = "plaintext";
		const tokenStore = await import("../lib/secrets/token-store.js");
		const first = tokenStore.deriveAccountSecretRef({
			accountId: "acct_123",
			email: "USER@example.com",
			addedAt: 100,
			refreshToken: "rt_1",
		});
		const second = tokenStore.deriveAccountSecretRef({
			accountId: "acct_123",
			email: "user@example.com",
			addedAt: 100,
			refreshToken: "rt_2",
		});
		expect(first).toBe(second);
	});
});
