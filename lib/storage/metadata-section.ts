export function latestValidSnapshot<
	TSnapshot extends { valid: boolean; mtimeMs?: number },
>(snapshots: TSnapshot[]): TSnapshot | undefined {
	return snapshots
		.filter((snapshot) => snapshot.valid)
		.sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))[0];
}

export function buildMetadataSection<
	TSnapshot extends { path: string; valid: boolean; mtimeMs?: number },
>(
	storagePath: string,
	snapshots: TSnapshot[],
): {
	storagePath: string;
	latestValidPath?: string;
	snapshotCount: number;
	validSnapshotCount: number;
	snapshots: TSnapshot[];
} {
	const latestValid = latestValidSnapshot(snapshots);
	return {
		storagePath,
		latestValidPath: latestValid?.path,
		snapshotCount: snapshots.length,
		validSnapshotCount: snapshots.filter((snapshot) => snapshot.valid).length,
		snapshots,
	};
}
