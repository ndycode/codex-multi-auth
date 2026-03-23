export function isCacheLikeBackupArtifactName(entryName: string): boolean {
	return entryName.toLowerCase().includes(".cache");
}
