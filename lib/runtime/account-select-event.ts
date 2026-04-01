import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";

type RuntimeSelectableAccount = AccountStorageV3["accounts"][number];

type RuntimeSelectionChangedPayload = {
	previousIndex: number;
	nextIndex: number;
	account: RuntimeSelectableAccount;
};

export type RuntimeAccountSelectionResult = {
	handled: true;
	changed: boolean;
	synced: boolean;
	wasDisabled: boolean;
};

let accountSelectWriteQueue: Promise<void> = Promise.resolve();

function serializeAccountSelectMutation<T>(task: () => Promise<T>): Promise<T> {
	const run = accountSelectWriteQueue.then(task, task);
	accountSelectWriteQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export async function selectRuntimeAccountIndex(input: {
	index: number;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	modelFamilies: readonly ModelFamily[];
	syncSelectedAccount?: (
		index: number,
		account: RuntimeSelectableAccount,
	) => Promise<boolean | void>;
	shouldReloadAccountManager?: () => boolean;
	reloadAccountManagerFromDisk?: () => Promise<unknown>;
	showToast?: (
		message: string,
		variant?: "info" | "success" | "warning" | "error",
	) => Promise<void>;
	onSelectionChanged?: (
		payload: RuntimeSelectionChangedPayload,
	) => Promise<void> | void;
}): Promise<RuntimeAccountSelectionResult> {
	return serializeAccountSelectMutation(async () => {
		const storage = await input.loadAccounts();
		if (!storage || input.index < 0 || input.index >= storage.accounts.length) {
			return {
				handled: true,
				changed: false,
				synced: false,
				wasDisabled: false,
			};
		}

		const account = storage.accounts[input.index];
		if (!account) {
			return {
				handled: true,
				changed: false,
				synced: false,
				wasDisabled: false,
			};
		}

		const previousIndex =
			Number.isInteger(storage.activeIndex) && storage.activeIndex >= 0
				? storage.activeIndex
				: 0;
		const changed = previousIndex !== input.index;
		const wasDisabled = account.enabled === false;
		const now = Date.now();

		account.lastUsed = now;
		account.lastSwitchReason = "rotation";
		if (wasDisabled) {
			account.enabled = true;
		}

		storage.activeIndex = input.index;
		storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
		for (const family of input.modelFamilies) {
			storage.activeIndexByFamily[family] = input.index;
		}

		await input.saveAccounts(storage);

		let synced = false;
		if (input.syncSelectedAccount) {
			const syncResult = await input.syncSelectedAccount(input.index, account);
			synced = syncResult !== false;
		}

		if (changed) {
			await input.onSelectionChanged?.({
				previousIndex,
				nextIndex: input.index,
				account,
			});
		}

		if (input.shouldReloadAccountManager?.()) {
			await input.reloadAccountManagerFromDisk?.();
		}

		await input.showToast?.(`Switched to account ${input.index + 1}`, "info");

		return {
			handled: true,
			changed,
			synced,
			wasDisabled,
		};
	});
}

export async function handleAccountSelectEvent(input: {
	event: { type: string; properties?: unknown };
	providerId: string;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	modelFamilies: readonly ModelFamily[];
	syncSelectedAccount?: (
		index: number,
		account: RuntimeSelectableAccount,
	) => Promise<boolean | void>;
	shouldReloadAccountManager?: () => boolean;
	reloadAccountManagerFromDisk?: () => Promise<unknown>;
	showToast?: (
		message: string,
		variant?: "info" | "success" | "warning" | "error",
	) => Promise<void>;
	onSelectionChanged?: (
		payload: RuntimeSelectionChangedPayload,
	) => Promise<void> | void;
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

	await selectRuntimeAccountIndex({
		index: rawIndex as number,
		loadAccounts: input.loadAccounts,
		saveAccounts: input.saveAccounts,
		modelFamilies: input.modelFamilies,
		syncSelectedAccount: input.syncSelectedAccount,
		shouldReloadAccountManager: input.shouldReloadAccountManager,
		reloadAccountManagerFromDisk: input.reloadAccountManagerFromDisk,
		showToast: input.showToast,
		onSelectionChanged: input.onSelectionChanged,
	});
	return true;
}
