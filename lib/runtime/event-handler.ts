import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";
import { handleAccountSelectEvent } from "./account-select-event.js";

export function createRuntimeEventHandler<
	TLoadedStorage,
	TSavedStorage,
	TModelFamily extends string,
	TManager,
>(deps: {
	handleAccountSelectEvent: (input: {
		event: { type: string; properties?: unknown };
		providerId: string;
		loadAccounts: () => Promise<TLoadedStorage>;
		saveAccounts: (storage: TSavedStorage) => Promise<void>;
		modelFamilies: readonly TModelFamily[];
		cachedAccountManager: TManager;
		reloadAccountManagerFromDisk: () => Promise<void>;
		setLastCodexCliActiveSyncIndex: (index: number) => void;
		showToast: (
			message: string,
			variant?: "info" | "success" | "warning" | "error",
		) => Promise<void>;
	}) => Promise<boolean>;
	providerId: string;
	loadAccounts: () => Promise<TLoadedStorage>;
	saveAccounts: (storage: TSavedStorage) => Promise<void>;
	modelFamilies: readonly TModelFamily[];
	getCachedAccountManager: () => TManager;
	reloadAccountManagerFromDisk: () => Promise<void>;
	setLastCodexCliActiveSyncIndex: (index: number) => void;
	showToast: (
		message: string,
		variant?: "info" | "success" | "warning" | "error",
	) => Promise<void>;
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
				cachedAccountManager: deps.getCachedAccountManager(),
				reloadAccountManagerFromDisk: deps.reloadAccountManagerFromDisk,
				setLastCodexCliActiveSyncIndex: deps.setLastCodexCliActiveSyncIndex,
				showToast: deps.showToast,
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
	hasCachedAccountManager: () => boolean;
	syncCodexCliActiveSelectionForIndex: (index: number) => Promise<void>;
	setLastCodexCliActiveSyncIndex: (index: number) => void;
	reloadAccountManagerFromDisk: () => Promise<unknown>;
	showToast: (
		message: string,
		variant?: "info" | "success" | "warning" | "error",
	) => Promise<void>;
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
			getCachedAccountManager: () =>
				params.hasCachedAccountManager()
					? {
							syncCodexCliActiveSelectionForIndex:
								params.syncCodexCliActiveSelectionForIndex,
						}
					: null,
			reloadAccountManagerFromDisk: params.reloadAccountManagerFromDisk,
			setLastCodexCliActiveSyncIndex: params.setLastCodexCliActiveSyncIndex,
			showToast: params.showToast,
		});
	} catch (error) {
		params.logDebug(
			`[${params.pluginName}] Event handler error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
