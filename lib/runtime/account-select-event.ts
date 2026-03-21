import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";

export async function handleAccountSelectEvent(input: {
	event: { type: string; properties?: unknown };
	providerId: string;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	modelFamilies: readonly ModelFamily[];
	cachedAccountManager: {
		syncCodexCliActiveSelectionForIndex(index: number): Promise<void>;
	} | null;
	reloadAccountManagerFromDisk: () => Promise<unknown>;
	setLastCodexCliActiveSyncIndex: (index: number) => void;
	showToast: (
		message: string,
		variant?: "info" | "success" | "warning" | "error",
	) => Promise<void>;
}): Promise<boolean> {
	const { event } = input;
	if (
		event.type !== "account.select" &&
		event.type !== "openai.account.select"
	) {
		return false;
	}

	const props = event.properties as {
		index?: number;
		accountIndex?: number;
		provider?: string;
	};
	if (
		props.provider &&
		props.provider !== "openai" &&
		props.provider !== input.providerId
	) {
		return false;
	}

	const index = props.index ?? props.accountIndex;
	if (typeof index !== "number") return false;

	const storage = await input.loadAccounts();
	if (!storage || index < 0 || index >= storage.accounts.length) {
		return false;
	}

	const now = Date.now();
	const account = storage.accounts[index];
	if (account) {
		account.lastUsed = now;
		account.lastSwitchReason = "rotation";
	}
	storage.activeIndex = index;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of input.modelFamilies) {
		storage.activeIndexByFamily[family] = index;
	}

	await input.saveAccounts(storage);
	if (input.cachedAccountManager) {
		await input.cachedAccountManager.syncCodexCliActiveSelectionForIndex(index);
	}
	input.setLastCodexCliActiveSyncIndex(index);

	if (input.cachedAccountManager) {
		await input.reloadAccountManagerFromDisk();
	}

	await input.showToast(`Switched to account ${index + 1}`, "info");
	return true;
}
