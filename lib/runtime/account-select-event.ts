import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";

let accountSelectWriteQueue: Promise<void> = Promise.resolve();

function serializeAccountSelectMutation<T>(
	task: () => Promise<T>,
): Promise<T> {
	const run = accountSelectWriteQueue.then(task, task);
	accountSelectWriteQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export async function handleAccountSelectEvent(input: {
	event: { type: string; properties?: unknown };
	providerId: string;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	modelFamilies: readonly ModelFamily[];
	getCachedAccountManager: () => {
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

	const props =
		typeof event.properties === "object" && event.properties !== null
			? (event.properties as {
					index?: unknown;
					accountIndex?: unknown;
					provider?: unknown;
				})
			: {};
	const provider =
		typeof props.provider === "string" ? props.provider : undefined;
	if (provider && provider !== "openai" && provider !== input.providerId) {
		return false;
	}

	const rawIndex = props.index ?? props.accountIndex;
	if (!Number.isInteger(rawIndex)) return true;
	const index = rawIndex as number;

	return serializeAccountSelectMutation(async () => {
		const storage = await input.loadAccounts();
		if (!storage || index < 0 || index >= storage.accounts.length) {
			return true;
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
		const manager = input.getCachedAccountManager();
		if (manager) {
			await manager.syncCodexCliActiveSelectionForIndex(index);
		}
		input.setLastCodexCliActiveSyncIndex(index);

		if (input.getCachedAccountManager()) {
			await input.reloadAccountManagerFromDisk();
		}

		await input.showToast(`Switched to account ${index + 1}`, "info");
		return true;
	});
}
