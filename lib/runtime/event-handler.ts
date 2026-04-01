import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";
import { handleAccountSelectEvent } from "./account-select-event.js";

type RuntimeSelectableAccount = AccountStorageV3["accounts"][number];
type RuntimeSelectionChangedPayload = {
	previousIndex: number;
	nextIndex: number;
	account: RuntimeSelectableAccount;
};

export function createRuntimeEventHandler<
	TLoadedStorage extends AccountStorageV3 | null,
	TSavedStorage extends AccountStorageV3,
	TModelFamily extends string,
>(deps: {
	handleAccountSelectEvent: (input: {
		event: { type: string; properties?: unknown };
		providerId: string;
		loadAccounts: () => Promise<TLoadedStorage>;
		saveAccounts: (storage: TSavedStorage) => Promise<void>;
		modelFamilies: readonly TModelFamily[];
		syncSelectedAccount?: (
			index: number,
			account: RuntimeSelectableAccount,
		) => Promise<boolean | void>;
		shouldReloadAccountManager?: () => boolean;
		reloadAccountManagerFromDisk?: () => Promise<void>;
		showToast?: (
			message: string,
			variant?: "info" | "success" | "warning" | "error",
		) => Promise<void>;
		onSelectionChanged?: (
			payload: RuntimeSelectionChangedPayload,
		) => Promise<void> | void;
	}) => Promise<boolean>;
	providerId: string;
	loadAccounts: () => Promise<TLoadedStorage>;
	saveAccounts: (storage: TSavedStorage) => Promise<void>;
	modelFamilies: readonly TModelFamily[];
	syncSelectedAccount?: (
		index: number,
		account: RuntimeSelectableAccount,
	) => Promise<boolean | void>;
	shouldReloadAccountManager?: () => boolean;
	reloadAccountManagerFromDisk?: () => Promise<void>;
	showToast?: (
		message: string,
		variant?: "info" | "success" | "warning" | "error",
	) => Promise<void>;
	onSelectionChanged?: (
		payload: RuntimeSelectionChangedPayload,
	) => Promise<void> | void;
	logDebug: (message: string) => void;
	pluginName: string;
}) {
	return async (input: { event: { type: string; properties?: unknown } }) => {
		try {
			const handled = await deps.handleAccountSelectEvent({
				event: input.event,
				providerId: deps.providerId,
				loadAccounts: deps.loadAccounts,
				saveAccounts: deps.saveAccounts,
				modelFamilies: deps.modelFamilies,
				syncSelectedAccount: deps.syncSelectedAccount,
				shouldReloadAccountManager: deps.shouldReloadAccountManager,
				reloadAccountManagerFromDisk: deps.reloadAccountManagerFromDisk,
				showToast: deps.showToast,
				onSelectionChanged: deps.onSelectionChanged,
			});
			if (handled) return;
		} catch (error) {
			deps.logDebug(
				`[${deps.pluginName}] Event handler error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
}

export async function handleRuntimeEvent(params: {
	input: { event: { type: string; properties?: unknown } };
	providerId: string;
	modelFamilies: readonly ModelFamily[];
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
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
	logDebug: (message: string) => void;
	pluginName: string;
}): Promise<void> {
	try {
		await handleAccountSelectEvent({
			event: params.input.event,
			providerId: params.providerId,
			loadAccounts: params.loadAccounts,
			saveAccounts: params.saveAccounts,
			modelFamilies: params.modelFamilies,
			syncSelectedAccount: params.syncSelectedAccount,
			shouldReloadAccountManager: params.shouldReloadAccountManager,
			reloadAccountManagerFromDisk: params.reloadAccountManagerFromDisk,
			showToast: params.showToast,
			onSelectionChanged: params.onSelectionChanged,
		});
	} catch (error) {
		params.logDebug(
			`[${params.pluginName}] Event handler error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
