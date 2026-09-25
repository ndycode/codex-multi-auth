import { AsyncLocalStorage } from "node:async_hooks";

export type StoragePathState = {
	currentStoragePath: string | null;
	currentLegacyProjectStoragePath: string | null;
	currentLegacyWorktreeStoragePath: string | null;
	currentProjectRoot: string | null;
};

type StoragePathStateContext = {
	state: StoragePathState;
	directGeneration: number;
};

const storagePathStateContext = new AsyncLocalStorage<StoragePathStateContext>();

// `setStoragePathDirect` is an explicit override used by callers that need a
// path to win over an async context created before the override. Keep its
// generation separate so a stale context cannot replace the direct path when
// control returns to a previously-created async resource. Scoped contexts
// created after the override still win while they are active.
let directStorageStateOverride: StoragePathState | undefined;
let directStorageGeneration = 0;

let currentStorageState: StoragePathState = {
	currentStoragePath: null,
	currentLegacyProjectStoragePath: null,
	currentLegacyWorktreeStoragePath: null,
	currentProjectRoot: null,
};

export function getStoragePathState(): StoragePathState {
	const context = storagePathStateContext.getStore();
	if (directStorageStateOverride !== undefined) {
		if (context?.directGeneration === directStorageGeneration) {
			return context.state;
		}
		return directStorageStateOverride;
	}
	// Keep the last synchronously assigned state as a fallback until enterWith()
	// has propagated through the current async chain. This is intentionally a
	// best-effort bridge for immediate reads; callers should still set state
	// before spawning child work and treat AsyncLocalStorage as the source of truth.
	return context?.state ?? currentStorageState;
}

export function setStoragePathState(state: StoragePathState): void {
	currentStorageState = state;
	directStorageStateOverride = undefined;
	storagePathStateContext.enterWith({
		state,
		directGeneration: directStorageGeneration,
	});
}

export function setStoragePathDirectState(state: StoragePathState): void {
	currentStorageState = state;
	directStorageStateOverride = state;
	directStorageGeneration += 1;
	storagePathStateContext.enterWith({
		state,
		directGeneration: directStorageGeneration,
	});
}

export async function runWithStoragePathState<T>(
	state: StoragePathState,
	fn: () => T | Promise<T>,
): Promise<T> {
	return await storagePathStateContext.run(
		{ state, directGeneration: directStorageGeneration },
		fn,
	);
}

/** Temporarily use the shared pool without mutating the caller or sibling async scopes. */
export function runWithGlobalStoragePath<T>(fn: () => T | Promise<T>): Promise<T> {
	return runWithStoragePathState({
		currentStoragePath: null,
		currentLegacyProjectStoragePath: null,
		currentLegacyWorktreeStoragePath: null,
		currentProjectRoot: null,
	}, fn);
}
