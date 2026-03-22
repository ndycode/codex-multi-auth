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
	// Keep the last synchronously assigned state as a fallback until enterWith()
	// has propagated through the current async chain. This is intentionally a
	// best-effort bridge for immediate reads; callers should still set state
	// before spawning child work and treat AsyncLocalStorage as the source of truth.
	return storagePathStateContext.getStore() ?? currentStorageState;
}

export function setStoragePathState(state: StoragePathState): void {
	currentStorageState = state;
	storagePathStateContext.enterWith(state);
}
