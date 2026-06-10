export type BackupSnapshotKind =
	| "accounts-primary"
	| "accounts-wal"
	| "accounts-backup"
	| "accounts-backup-history"
	| "accounts-discovered-backup"
	| "flagged-primary"
	| "flagged-backup"
	| "flagged-backup-history"
	| "flagged-discovered-backup";

export type BackupSnapshotMetadata = {
	kind: BackupSnapshotKind;
	path: string;
	index?: number;
	exists: boolean;
	valid: boolean;
	bytes?: number;
	mtimeMs?: number;
	version?: number;
	accountCount?: number;
	flaggedCount?: number;
	schemaErrors?: string[];
};

export type BackupMetadataSection = {
	storagePath: string;
	latestValidPath?: string;
	snapshotCount: number;
	validSnapshotCount: number;
	snapshots: BackupSnapshotMetadata[];
};

type RestoreReason = "empty-storage" | "intentional-reset" | "missing-storage";

export type BackupMetadata = {
	accounts: BackupMetadataSection;
	flaggedAccounts: BackupMetadataSection;
};

export type RestoreAssessment = {
	storagePath: string;
	restoreEligible: boolean;
	restoreReason?: RestoreReason;
	latestSnapshot?: BackupSnapshotMetadata;
	backupMetadata: BackupMetadata;
};

export function latestValidSnapshot(
	snapshots: BackupSnapshotMetadata[],
): BackupSnapshotMetadata | undefined {
	return snapshots
		.filter((snapshot) => snapshot.valid)
		.sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))[0];
}

export function buildMetadataSection(
	storagePath: string,
	snapshots: BackupSnapshotMetadata[],
): BackupMetadataSection {
	const latestValid = latestValidSnapshot(snapshots);
	return {
		storagePath,
		latestValidPath: latestValid?.path,
		snapshotCount: snapshots.length,
		validSnapshotCount: snapshots.filter((snapshot) => snapshot.valid).length,
		snapshots,
	};
}

export type SnapshotStats = {
	exists: boolean;
	bytes?: number;
	mtimeMs?: number;
};
