import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function mockKeytar(module: {
	setPassword: (service: string, account: string, password: string) => Promise<void>;
	getPassword: (service: string, account: string) => Promise<string | null>;
	deletePassword: (service: string, account: string) => Promise<boolean>;
}): void {
	vi.doMock("keytar", () => ({
		...module,
		default: module,
	}));
}

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

	it("supports CommonJS default export interop for keytar", async () => {
		const secrets = new Map<string, string>();
		mockKeytar({
			setPassword: async (_service: string, account: string, password: string) => {
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => secrets.delete(account),
		});

		process.env.CODEX_SECRET_STORAGE_MODE = "keychain";
		const tokenStore = await import("../lib/secrets/token-store.js");
		await tokenStore.ensureSecretStorageBackendAvailable();

		const refs = await tokenStore.persistAccountSecrets("acct-cjs", {
			refreshToken: "refresh-cjs",
			accessToken: "access-cjs",
		});
		expect(refs).toEqual({
			refreshTokenRef: "acct-cjs:refresh",
			accessTokenRef: "acct-cjs:access",
		});
		expect(
			await tokenStore.loadAccountSecrets({
				refreshTokenRef: "acct-cjs:refresh",
				accessTokenRef: "acct-cjs:access",
			}),
		).toEqual({
			refreshToken: "refresh-cjs",
			accessToken: "access-cjs",
		});
	});

	it("stores and loads secrets through keytar in keychain mode", async () => {
		const secrets = new Map<string, string>();
		mockKeytar({
			setPassword: async (_service: string, account: string, password: string) => {
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => secrets.delete(account),
		});

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

	it("handles concurrent keychain writes for the same account ref without torn secrets", async () => {
		const secrets = new Map<string, string>();
		const refreshGate = createDeferred<void>();
		let refreshCallCount = 0;

		mockKeytar({
			setPassword: async (_service: string, account: string, password: string) => {
				if (account === "acct-1:refresh") {
					refreshCallCount += 1;
					if (refreshCallCount === 1) {
						await refreshGate.promise;
					}
				}
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => secrets.delete(account),
		});

		process.env.CODEX_SECRET_STORAGE_MODE = "keychain";
		const tokenStore = await import("../lib/secrets/token-store.js");
		await tokenStore.ensureSecretStorageBackendAvailable();

		const firstWrite = tokenStore.persistAccountSecrets("acct-1", {
			refreshToken: "refresh-token-a",
			accessToken: "access-token-a",
		});
		const secondWrite = tokenStore.persistAccountSecrets("acct-1", {
			refreshToken: "refresh-token-b",
			accessToken: "access-token-b",
		});
		await Promise.resolve();
		refreshGate.resolve();

		const [firstRefs, secondRefs] = await Promise.all([firstWrite, secondWrite]);
		expect(firstRefs).toEqual({
			refreshTokenRef: "acct-1:refresh",
			accessTokenRef: "acct-1:access",
		});
		expect(secondRefs).toEqual(firstRefs);

		const loaded = await tokenStore.loadAccountSecrets({
			refreshTokenRef: "acct-1:refresh",
			accessTokenRef: "acct-1:access",
		});
		expect(loaded).toBeDefined();
		const signature = `${loaded?.refreshToken}|${loaded?.accessToken}`;
		expect(new Set(["refresh-token-a|access-token-a", "refresh-token-b|access-token-b"]).has(signature)).toBe(
			true,
		);
	});

	it("rolls back refresh ref when access ref persistence fails", async () => {
		const secrets = new Map<string, string>();
		const deletedRefs: string[] = [];
		mockKeytar({
			setPassword: async (_service: string, account: string, password: string) => {
				if (account === "acct-rollback:access") {
					const error = new Error("access write failed") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => {
				deletedRefs.push(account);
				secrets.delete(account);
				return true;
			},
		});

		process.env.CODEX_SECRET_STORAGE_MODE = "keychain";
		const tokenStore = await import("../lib/secrets/token-store.js");
		await tokenStore.ensureSecretStorageBackendAvailable();

		await expect(
			tokenStore.persistAccountSecrets("acct-rollback", {
				refreshToken: "refresh-token",
				accessToken: "access-token",
			}),
		).rejects.toThrow("access write failed");
		expect(deletedRefs).toContain("acct-rollback:refresh");
		expect(secrets.has("acct-rollback:refresh")).toBe(false);
	});

	it("deleteAccountSecrets cleans up both refresh and access refs", async () => {
		const secrets = new Map<string, string>();
		const deletedRefs: string[] = [];
		mockKeytar({
			setPassword: async (_service: string, account: string, password: string) => {
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => {
				deletedRefs.push(account);
				secrets.delete(account);
				return true;
			},
		});

		process.env.CODEX_SECRET_STORAGE_MODE = "keychain";
		const tokenStore = await import("../lib/secrets/token-store.js");
		await tokenStore.ensureSecretStorageBackendAvailable();
		await tokenStore.persistAccountSecrets("acct-delete", {
			refreshToken: "refresh-token",
			accessToken: "access-token",
		});

		await tokenStore.deleteAccountSecrets({
			refreshTokenRef: "acct-delete:refresh",
			accessTokenRef: "acct-delete:access",
		});
		expect(deletedRefs).toEqual(expect.arrayContaining(["acct-delete:refresh", "acct-delete:access"]));
		expect(secrets.has("acct-delete:refresh")).toBe(false);
		expect(secrets.has("acct-delete:access")).toBe(false);
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

	it("falls back to token-derived refs when account identity is missing", async () => {
		process.env.CODEX_SECRET_STORAGE_MODE = "plaintext";
		const tokenStore = await import("../lib/secrets/token-store.js");
		const first = tokenStore.deriveAccountSecretRef({
			refreshToken: "rt_identity_missing_a",
		});
		const second = tokenStore.deriveAccountSecretRef({
			refreshToken: "rt_identity_missing_b",
		});
		expect(first).not.toBe(second);
	});
});
