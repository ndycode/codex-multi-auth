import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";

export async function handleRuntimeEvent(params: {
	input: { event: { type: string; properties?: unknown } };
	providerId: string;
	modelFamilies: readonly ModelFamily[];
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	hasCachedAccountManager: () => boolean;
	syncCodexCliActiveSelectionForIndex: (index: number) => Promise<void>;
	setLastCodexCliActiveSyncIndex: (index: number) => void;
	reloadAccountManagerFromDisk: () => Promise<unknown>;
	showToast: (message: string, variant: "info") => Promise<void>;
	logDebug: (message: string) => void;
	pluginName: string;
}): Promise<void> {
	try {
		const { event } = params.input;
		if (
			event.type !== "account.select" &&
			event.type !== "openai.account.select"
		) {
			return;
		}

		const props = event.properties as {
			index?: number;
			accountIndex?: number;
			provider?: string;
		};
		if (
			props.provider &&
			props.provider !== "openai" &&
			props.provider !== params.providerId
		) {
			return;
		}

		const index = props.index ?? props.accountIndex;
		if (typeof index !== "number") return;

		const storage = await params.loadAccounts();
		if (!storage || index < 0 || index >= storage.accounts.length) {
			return;
		}

		const now = Date.now();
		const account = storage.accounts[index];
		if (account) {
			account.lastUsed = now;
			account.lastSwitchReason = "rotation";
		}
		storage.activeIndex = index;
		storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
		for (const family of params.modelFamilies) {
			storage.activeIndexByFamily[family] = index;
		}

		await params.saveAccounts(storage);
		if (params.hasCachedAccountManager()) {
			await params.syncCodexCliActiveSelectionForIndex(index);
		}
		params.setLastCodexCliActiveSyncIndex(index);

		if (params.hasCachedAccountManager()) {
			await params.reloadAccountManagerFromDisk();
		}

		await params.showToast(`Switched to account ${index + 1}`, "info");
	} catch (error) {
		params.logDebug(
			`[${params.pluginName}] Event handler error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
