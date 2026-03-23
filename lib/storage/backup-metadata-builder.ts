import type { BackupMetadata } from "../storage.js";

type Snapshot = {
	kind:
		| "accounts-primary"
		| "accounts-wal"
		| "accounts-backup"
		| "accounts-backup-history"
		| "accounts-discovered-backup"
		| "flagged-primary"
		| "flagged-backup"
		| "flagged-backup-history"
		| "flagged-discovered-backup";
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

const ACCOUNT_BACKUP_PREFERRED_KINDS = new Set<Snapshot["kind"]>([
	"accounts-discovered-backup",
	"accounts-backup-history",
	"accounts-backup",
]);

const ACCOUNT_SNAPSHOT_PRIORITY = new Map<Snapshot["kind"], number>([
	["accounts-discovered-backup", 4],
	["accounts-backup-history", 3],
	["accounts-backup", 2],
	["accounts-wal", 1],
	["accounts-primary", 0],
]);

function newestValidSnapshot(
	snapshots: Snapshot[],
	options?: {
		kinds?: ReadonlySet<Snapshot["kind"]>;
		priorities?: ReadonlyMap<Snapshot["kind"], number>;
	},
): Snapshot | undefined {
	return snapshots
		.filter(
			(snapshot) =>
				snapshot.valid &&
				(!options?.kinds || options.kinds.has(snapshot.kind)),
		)
		.sort((left, right) => {
			const rightPriority = options?.priorities?.get(right.kind) ?? 0;
			const leftPriority = options?.priorities?.get(left.kind) ?? 0;
			if (rightPriority !== leftPriority) {
				return rightPriority - leftPriority;
			}
			return (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0);
		})[0];
}

function selectLatestValidAccountPath(
	snapshots: Snapshot[],
): string | undefined {
	return (
		newestValidSnapshot(snapshots, {
			kinds: ACCOUNT_BACKUP_PREFERRED_KINDS,
			priorities: ACCOUNT_SNAPSHOT_PRIORITY,
		})?.path ??
		newestValidSnapshot(snapshots, {
			kinds: new Set<Snapshot["kind"]>(["accounts-wal"]),
			priorities: ACCOUNT_SNAPSHOT_PRIORITY,
		})?.path ??
		newestValidSnapshot(snapshots, {
			priorities: ACCOUNT_SNAPSHOT_PRIORITY,
		})?.path
	);
}

export async function buildBackupMetadata(params: {
	storagePath: string;
	flaggedPath: string;
	walPath: string;
	getAccountsBackupRecoveryCandidatesWithDiscovery: (
		path: string,
	) => Promise<string[]>;
	describeAccountSnapshot: (
		path: string,
		kind:
			| "accounts-primary"
			| "accounts-backup"
			| "accounts-backup-history"
			| "accounts-discovered-backup",
		index?: number,
	) => Promise<Snapshot>;
	describeAccountsWalSnapshot: (path: string) => Promise<Snapshot>;
	describeFlaggedSnapshot: (
		path: string,
		kind:
			| "flagged-primary"
			| "flagged-backup"
			| "flagged-backup-history"
			| "flagged-discovered-backup",
		index?: number,
	) => Promise<Snapshot>;
	buildMetadataSection: (
		storagePath: string,
		snapshots: Snapshot[],
	) => {
		storagePath: string;
		latestValidPath?: string;
		snapshotCount: number;
		validSnapshotCount: number;
		snapshots: Snapshot[];
	};
}): Promise<BackupMetadata> {
	const {
		storagePath,
		flaggedPath,
		walPath,
		getAccountsBackupRecoveryCandidatesWithDiscovery,
		describeAccountSnapshot,
		describeAccountsWalSnapshot,
		describeFlaggedSnapshot,
		buildMetadataSection,
	} = params;

	const accountCandidates =
		await getAccountsBackupRecoveryCandidatesWithDiscovery(storagePath);
	const accountSnapshots: Snapshot[] = [
		await describeAccountSnapshot(storagePath, "accounts-primary"),
		await describeAccountsWalSnapshot(walPath),
	];
	for (const [index, candidate] of accountCandidates.entries()) {
		const kind =
			candidate === `${storagePath}.bak`
				? "accounts-backup"
				: candidate.startsWith(`${storagePath}.bak.`)
					? "accounts-backup-history"
					: "accounts-discovered-backup";
		accountSnapshots.push(
			await describeAccountSnapshot(candidate, kind, index),
		);
	}

	const flaggedCandidates =
		await getAccountsBackupRecoveryCandidatesWithDiscovery(flaggedPath);
	const flaggedSnapshots: Snapshot[] = [
		await describeFlaggedSnapshot(flaggedPath, "flagged-primary"),
	];
	for (const [index, candidate] of flaggedCandidates.entries()) {
		const kind =
			candidate === `${flaggedPath}.bak`
				? "flagged-backup"
				: candidate.startsWith(`${flaggedPath}.bak.`)
					? "flagged-backup-history"
					: "flagged-discovered-backup";
		flaggedSnapshots.push(
			await describeFlaggedSnapshot(candidate, kind, index),
		);
	}

	const accountsMetadata = buildMetadataSection(storagePath, accountSnapshots);
	const flaggedMetadata = buildMetadataSection(flaggedPath, flaggedSnapshots);

	return {
		accounts: {
			...accountsMetadata,
			latestValidPath:
				selectLatestValidAccountPath(accountSnapshots) ??
				accountsMetadata.latestValidPath,
		},
		flaggedAccounts: flaggedMetadata,
	};
}
