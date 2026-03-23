import type { BackupMetadata, RestoreAssessment } from "../storage.js";

function findLatestSnapshot(backupMetadata: BackupMetadata) {
	return backupMetadata.accounts.latestValidPath
		? backupMetadata.accounts.snapshots.find(
				(snapshot) => snapshot.path === backupMetadata.accounts.latestValidPath,
			)
		: undefined;
}

export function buildRestoreAssessment(params: {
	storagePath: string;
	backupMetadata: BackupMetadata;
	hasResetMarker: boolean;
}): RestoreAssessment {
	const { storagePath, backupMetadata, hasResetMarker } = params;
	if (hasResetMarker) {
		return {
			storagePath,
			restoreEligible: false,
			restoreReason: "intentional-reset",
			backupMetadata,
		};
	}

	const primarySnapshot = backupMetadata.accounts.snapshots.find(
		(snapshot) => snapshot.kind === "accounts-primary",
	);
	if (!primarySnapshot?.exists) {
		return {
			storagePath,
			restoreEligible: true,
			restoreReason: "missing-storage",
			latestSnapshot: findLatestSnapshot(backupMetadata),
			backupMetadata,
		};
	}

	if (primarySnapshot.valid && primarySnapshot.accountCount === 0) {
		return {
			storagePath,
			restoreEligible: true,
			restoreReason: "empty-storage",
			latestSnapshot: primarySnapshot,
			backupMetadata,
		};
	}

	return {
		storagePath,
		restoreEligible: false,
		latestSnapshot: findLatestSnapshot(backupMetadata),
		backupMetadata,
	};
}
