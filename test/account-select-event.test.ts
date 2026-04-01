import { describe, expect, it, vi } from "vitest";
import { handleAccountSelectEvent } from "../lib/runtime/account-select-event.js";

function createStorage() {
	return {
		version: 3 as const,
		activeIndex: 0,
		activeIndexByFamily: {} as Record<string, number>,
		accounts: [
			{ refreshToken: "refresh-0", email: "zero@example.com" },
			{ refreshToken: "refresh-1", email: "one@example.com" },
		],
	};
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("handleAccountSelectEvent", () => {
	it("returns false for events owned by a different provider", async () => {
		const loadAccounts = vi.fn();

		const handled = await handleAccountSelectEvent({
			event: {
				type: "account.select",
				properties: { provider: "other", index: 0 },
			},
			providerId: "codex",
			loadAccounts,
			saveAccounts: vi.fn(),
			modelFamilies: ["codex"],
			syncSelectedAccount: vi.fn(),
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(),
			showToast: vi.fn(),
		});

		expect(handled).toBe(false);
		expect(loadAccounts).not.toHaveBeenCalled();
	});

	it.each([
		["missing properties", undefined],
		["NaN index", { index: Number.NaN }],
		["fractional index", { index: 1.5 }],
	])("ignores invalid %s without touching storage", async (_label, properties) => {
		const loadAccounts = vi.fn();
		const saveAccounts = vi.fn();

		const handled = await handleAccountSelectEvent({
			event: { type: "account.select", properties },
			providerId: "openai",
			loadAccounts,
			saveAccounts,
			modelFamilies: ["codex"],
			syncSelectedAccount: vi.fn(),
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(),
			showToast: vi.fn(),
		});

		expect(handled).toBe(true);
		expect(loadAccounts).not.toHaveBeenCalled();
		expect(saveAccounts).not.toHaveBeenCalled();
	});

	it("syncs the selected account and reloads the manager after save", async () => {
		const loadAccounts = vi.fn(async () => createStorage());
		const syncSelectedAccount = vi.fn(async () => true);
		const reloadAccountManagerFromDisk = vi.fn(async () => {});
		const showToast = vi.fn(async () => {});
		const onSelectionChanged = vi.fn();
		const saveAccounts = vi.fn(async () => {});

		const handled = await handleAccountSelectEvent({
			event: { type: "account.select", properties: { index: 1 } },
			providerId: "openai",
			loadAccounts,
			saveAccounts,
			modelFamilies: ["codex"],
			syncSelectedAccount,
			shouldReloadAccountManager: () => true,
			reloadAccountManagerFromDisk,
			showToast,
			onSelectionChanged,
		});

		expect(handled).toBe(true);
		expect(syncSelectedAccount).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ email: "one@example.com" }),
		);
		expect(reloadAccountManagerFromDisk).toHaveBeenCalledTimes(1);
		expect(onSelectionChanged).toHaveBeenCalledWith(
			expect.objectContaining({ previousIndex: 0, nextIndex: 1 }),
		);
	});

	it("re-enables disabled selected accounts before persisting", async () => {
		const storage = createStorage();
		storage.accounts[1] = {
			...storage.accounts[1],
			enabled: false,
		};
		const saveAccounts = vi.fn(async () => {});

		await handleAccountSelectEvent({
			event: { type: "account.select", properties: { index: 1 } },
			providerId: "openai",
			loadAccounts: vi.fn(async () => storage),
			saveAccounts,
			modelFamilies: ["codex"],
			syncSelectedAccount: vi.fn(async () => true),
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(async () => {}),
			showToast: vi.fn(async () => {}),
		});

		expect(saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				activeIndex: 1,
				accounts: expect.arrayContaining([
					expect.objectContaining({ email: "one@example.com", enabled: true }),
				]),
			}),
		);
	});

	it("does not clear selection state when re-selecting the active index", async () => {
		const onSelectionChanged = vi.fn();

		await handleAccountSelectEvent({
			event: { type: "account.select", properties: { index: 0 } },
			providerId: "openai",
			loadAccounts: vi.fn(async () => createStorage()),
			saveAccounts: vi.fn(async () => {}),
			modelFamilies: ["codex"],
			syncSelectedAccount: vi.fn(async () => true),
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(async () => {}),
			showToast: vi.fn(async () => {}),
			onSelectionChanged,
		});

		expect(onSelectionChanged).not.toHaveBeenCalled();
	});

	it("serializes concurrent account.select writes", async () => {
		let currentStorage = createStorage();
		const firstSaveStarted = createDeferred<void>();
		const releaseFirstSave = createDeferred<void>();
		const loadAccounts = vi.fn(async () => structuredClone(currentStorage));
		const saveAccounts = vi.fn(async (storage: typeof currentStorage) => {
			currentStorage = structuredClone(storage);
			if (saveAccounts.mock.calls.length === 1) {
				firstSaveStarted.resolve();
				await releaseFirstSave.promise;
			}
		});

		const baseInput = {
			providerId: "openai",
			loadAccounts,
			saveAccounts,
			modelFamilies: ["codex"] as const,
			syncSelectedAccount: vi.fn(async () => true),
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(async () => {}),
			showToast: vi.fn(async () => {}),
		};

		const first = handleAccountSelectEvent({
			...baseInput,
			event: { type: "account.select", properties: { index: 0 } },
		});
		await firstSaveStarted.promise;

		const second = handleAccountSelectEvent({
			...baseInput,
			event: { type: "account.select", properties: { index: 1 } },
		});

		await Promise.resolve();
		expect(loadAccounts).toHaveBeenCalledTimes(1);

		releaseFirstSave.resolve();
		await Promise.all([first, second]);

		expect(loadAccounts).toHaveBeenCalledTimes(2);
		expect(saveAccounts).toHaveBeenCalledTimes(2);
		expect(currentStorage.activeIndex).toBe(1);
		expect(currentStorage.activeIndexByFamily.codex).toBe(1);
	});
});
