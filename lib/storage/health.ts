import { existsSync } from "node:fs";

export type StorageHealthState =
	| "healthy"
	| "empty"
	| "intentional-reset"
	| "corrupt"
	| "recoverable";

export interface StorageHealthSummary {
	state: StorageHealthState;
	path: string;
	resetMarkerPath: string;
	walPath: string;
	hasResetMarker: boolean;
	hasWal: boolean;
	details?: string;
	schemaErrors?: string[];
	recoverySource?: "wal";
}

export function createStorageHealthSummary(params: {
	state: StorageHealthState;
	path: string;
	resetMarkerPath: string;
	walPath: string;
	details?: string;
	schemaErrors?: string[];
	recoverySource?: "wal";
}): StorageHealthSummary {
	return {
		state: params.state,
		path: params.path,
		resetMarkerPath: params.resetMarkerPath,
		walPath: params.walPath,
		hasResetMarker: existsSync(params.resetMarkerPath),
		hasWal: existsSync(params.walPath),
		details: params.details,
		schemaErrors: params.schemaErrors,
		recoverySource: params.recoverySource,
	};
}
