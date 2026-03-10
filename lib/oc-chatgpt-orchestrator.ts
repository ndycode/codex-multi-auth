import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
	type OcChatgptImportPayload,
	type OcChatgptMergePreview,
	previewOcChatgptImportMerge,
} from "./oc-chatgpt-import-adapter.js";
import {
	detectOcChatgptMultiAuthTarget,
	type OcChatgptTargetAmbiguous,
	type OcChatgptTargetDescriptor,
	type OcChatgptTargetDetectionResult,
	type OcChatgptTargetNone,
} from "./oc-chatgpt-target-detection.js";
import {
	type AccountStorageV3,
	exportNamedBackup,
	normalizeAccountStorage,
} from "./storage.js";

type BlockedAmbiguous = {
	kind: "blocked-ambiguous";
	detection: OcChatgptTargetAmbiguous;
};

type BlockedNone = {
	kind: "blocked-none";
	detection: OcChatgptTargetNone;
};

type BlockedDetection = BlockedAmbiguous | BlockedNone;

type OcChatgptSyncPlanReady = {
	kind: "ready";
	target: OcChatgptTargetDescriptor;
	preview: OcChatgptMergePreview;
	payload: OcChatgptImportPayload;
	destination: AccountStorageV3 | null;
};

export type OcChatgptSyncPlanResult = OcChatgptSyncPlanReady | BlockedDetection;

type DetectOptions = {
	explicitRoot?: string | null;
	projectRoot?: string | null;
};

type PlanDependencies = {
	detectTarget?: typeof detectOcChatgptMultiAuthTarget;
	previewMerge?: typeof previewOcChatgptImportMerge;
	loadTargetStorage?: (
		target: OcChatgptTargetDescriptor,
	) => Promise<AccountStorageV3 | null>;
};

export type PlanOcChatgptSyncOptions = {
	source: AccountStorageV3 | null;
	destination?: AccountStorageV3 | null;
	detectOptions?: DetectOptions;
	dependencies?: PlanDependencies;
};

function mapDetectionToBlocked(
	detection: OcChatgptTargetDetectionResult,
): BlockedDetection | null {
	if (detection.kind === "ambiguous") {
		return { kind: "blocked-ambiguous", detection };
	}
	if (detection.kind === "none") {
		return { kind: "blocked-none", detection };
	}
	return null;
}

async function loadTargetStorageDefault(
	target: OcChatgptTargetDescriptor,
): Promise<AccountStorageV3 | null> {
	try {
		const raw = JSON.parse(await fs.readFile(target.accountPath, "utf-8"));
		return normalizeAccountStorage(raw);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return null;
		throw error;
	}
}

export async function planOcChatgptSync(
	options: PlanOcChatgptSyncOptions,
): Promise<OcChatgptSyncPlanResult> {
	const detectTarget =
		options.dependencies?.detectTarget ?? detectOcChatgptMultiAuthTarget;
	const previewMerge =
		options.dependencies?.previewMerge ?? previewOcChatgptImportMerge;

	const detection = detectTarget(options.detectOptions);
	const blocked = mapDetectionToBlocked(detection);
	if (blocked) {
		return blocked;
	}
	if (detection.kind !== "target") {
		throw new Error("Unexpected oc target detection result");
	}

	const descriptor = detection.descriptor;
	const destination =
		options.destination === undefined
			? await (
					options.dependencies?.loadTargetStorage ?? loadTargetStorageDefault
				)(descriptor)
			: options.destination;
	const preview = previewMerge({
		source: options.source,
		destination,
	});

	return {
		kind: "ready",
		target: descriptor,
		preview,
		payload: preview.payload,
		destination,
	};
}

type ApplyDependencies = PlanDependencies & {
	persistMerged?: (
		target: OcChatgptTargetDescriptor,
		merged: AccountStorageV3,
	) => Promise<string | void>;
};

export type ApplyOcChatgptSyncOptions = {
	source: AccountStorageV3 | null;
	destination?: AccountStorageV3 | null;
	detectOptions?: DetectOptions;
	dependencies?: ApplyDependencies;
};

export type OcChatgptSyncApplyResult =
	| BlockedDetection
	| {
			kind: "applied";
			target: OcChatgptTargetDescriptor;
			preview: OcChatgptMergePreview;
			merged: AccountStorageV3;
			destination: AccountStorageV3 | null;
			persistedPath?: string | void;
	  }
	| {
			kind: "error";
			target?: OcChatgptTargetDescriptor;
			error: unknown;
	  };

function isJsonFilePath(path: string): boolean {
	return path.trim().toLowerCase().endsWith(".json");
}

const PERSIST_RENAME_MAX_ATTEMPTS = 5;
const PERSIST_RENAME_BASE_DELAY_MS = 10;

async function renameWithRetry(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	for (let attempt = 0; attempt < PERSIST_RENAME_MAX_ATTEMPTS; attempt += 1) {
		try {
			await fs.rename(sourcePath, destinationPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const canRetry =
				(code === "EPERM" || code === "EBUSY" || code === "EAGAIN") &&
				attempt + 1 < PERSIST_RENAME_MAX_ATTEMPTS;
			if (!canRetry) {
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, PERSIST_RENAME_BASE_DELAY_MS * 2 ** attempt),
			);
		}
	}
}

async function persistMergedDefault(
	target: OcChatgptTargetDescriptor,
	merged: AccountStorageV3,
): Promise<string> {
	const path = target.accountPath;
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${path}.${uniqueSuffix}.tmp`;
	await fs.mkdir(dirname(path), { recursive: true });
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		await renameWithRetry(tempPath, path);
	} catch (error) {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Ignore cleanup failures for apply temp files.
		}
		throw error;
	}
	return path;
}

export async function applyOcChatgptSync(
	options: ApplyOcChatgptSyncOptions,
): Promise<OcChatgptSyncApplyResult> {
	const dependencies = options.dependencies ?? {};
	const detectTarget =
		dependencies.detectTarget ?? detectOcChatgptMultiAuthTarget;
	let plan: OcChatgptSyncPlanResult | undefined;
	try {
		plan = await planOcChatgptSync({
			source: options.source,
			destination: options.destination,
			detectOptions: options.detectOptions,
			dependencies: {
				detectTarget: detectTarget,
				previewMerge: dependencies.previewMerge,
				loadTargetStorage: dependencies.loadTargetStorage,
			},
		});

		if (plan.kind !== "ready") {
			return plan;
		}

		const persistMerged = dependencies.persistMerged ?? persistMergedDefault;
		const persistedPath = await persistMerged(plan.target, plan.preview.merged);
		return {
			kind: "applied",
			target: plan.target,
			preview: plan.preview,
			merged: plan.preview.merged,
			destination: plan.destination,
			persistedPath,
		};
	} catch (error) {
		if (plan?.kind === "ready") {
			return { kind: "error", target: plan.target, error };
		}
		let detection: OcChatgptTargetDetectionResult;
		try {
			detection = detectTarget(options.detectOptions);
		} catch {
			return { kind: "error", error };
		}
		const blocked = mapDetectionToBlocked(detection);
		if (blocked || detection.kind !== "target") {
			return { kind: "error", error };
		}
		return { kind: "error", target: detection.descriptor, error };
	}
}

type BackupDependencies = {
	exportBackup?: typeof exportNamedBackup;
};

export type RunNamedBackupExportOptions = {
	name: string;
	force?: boolean;
	dependencies?: BackupDependencies;
};

export type RunNamedBackupExportResult =
	| {
			kind: "exported";
			path: string;
	  }
	| {
			kind: "collision";
			path: string;
	  }
	| {
			kind: "error";
			path?: string;
			error: unknown;
	  };

function extractCollisionPath(error: unknown): string | undefined {
	const asErr = error as Partial<NodeJS.ErrnoException> & { message?: string };
	if (
		asErr?.code === "EEXIST" &&
		typeof asErr?.path === "string" &&
		asErr.path.trim().length > 0 &&
		isJsonFilePath(asErr.path)
	) {
		return asErr.path;
	}
	const message = (asErr?.message ?? "").trim();
	if (message.length === 0) return undefined;
	const match = message.match(/already exists: (?<path>.+)$/i);
	if (match?.groups?.path) {
		const path = match.groups.path.trim();
		return isJsonFilePath(path) ? path : undefined;
	}
	return undefined;
}

export async function runNamedBackupExport(
	options: RunNamedBackupExportOptions,
): Promise<RunNamedBackupExportResult> {
	const exportBackup = options.dependencies?.exportBackup ?? exportNamedBackup;
	try {
		const path = await exportBackup(options.name, { force: options.force });
		return { kind: "exported", path };
	} catch (error) {
		const path = extractCollisionPath(error);
		if (path) {
			return { kind: "collision", path };
		}
		return { kind: "error", path, error };
	}
}
