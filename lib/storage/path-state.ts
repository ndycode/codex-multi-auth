import { AsyncLocalStorage } from "node:async_hooks";

export type StoragePathState = {
	currentStoragePath: string | null;
	currentLegacyProjectStoragePath: string | null;
	currentLegacyWorktreeStoragePath: string | null;
	currentProjectRoot: string | null;
};

const storagePathStateContext = new AsyncLocalStorage<StoragePathState>();

let currentStorageState: StoragePathState = {
	currentStoragePath: null,
	currentLegacyProjectStoragePath: null,
	currentLegacyWorktreeStoragePath: null,
	currentProjectRoot: null,
};

export function getStoragePathState(): StoragePathState {
	return storagePathStateContext.getStore() ?? currentStorageState;
}

export function setStoragePathState(state: StoragePathState): void {
	currentStorageState = state;
	storagePathStateContext.enterWith(state);
}
