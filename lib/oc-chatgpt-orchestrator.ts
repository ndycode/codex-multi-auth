import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { withFileOperationRetry } from "./fs-retry.js";
import {
	type OcChatgptMergePreview,
	type OcChatgptPreviewPayload,
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
import { tempPathFor } from "./temp-path.js";

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
	payload: OcChatgptPreviewPayload;
	destination: AccountStorageV3 | null;
};

// chatgpt-import-06: a structured error result so planOcChatgptSync can report a
// failure to load/preview the target (e.g. a corrupt destination file) the same
// way applyOcChatgptSync already does, instead of throwing an uncaught error out
// of the planning step.
type OcChatgptSyncPlanError = {
	kind: "plan-error";
	target: OcChatgptTargetDescriptor;
	error: unknown;
	cause: "load" | "preview";
};

export type OcChatgptSyncPlanResult =
	| OcChatgptSyncPlanReady
	| BlockedDetection
	| OcChatgptSyncPlanError;

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
	let destination: AccountStorageV3 | null;
	try {
		destination =
			options.destination === undefined
				? await (
						options.dependencies?.loadTargetStorage ?? loadTargetStorageDefault
					)(descriptor)
				: options.destination;
	} catch (error) {
		// chatgpt-import-06: a corrupt/unreadable destination must not throw out of
		// planning; return a structured error like applyOcChatgptSync does.
		return { kind: "plan-error", target: descriptor, error, cause: "load" };
	}

	let preview: OcChatgptMergePreview;
	try {
		preview = previewMerge({
			source: options.source,
			destination,
		});
	} catch (error) {
		return { kind: "plan-error", target: descriptor, error, cause: "preview" };
	}

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
			target: OcChatgptTargetDescriptor;
			error: unknown;
	  };

async function persistMergedDefault(
	target: OcChatgptTargetDescriptor,
	merged: AccountStorageV3,
): Promise<string> {
	const path = target.accountPath;
	// The merged file embeds raw refresh tokens for every account and overwrites the
	// live, watched account store. Write atomically (temp + rename) at mode 0o600 so a
	// crash mid-write cannot truncate the destination and the secrets are never created
	// at the process umask. Create the parent at 0o700 too (matching auth-01) so the
	// directory is not world-listable — otherwise other users could enumerate the
	// filenames, including the `.tmp` intermediary that briefly holds the same secrets.
	const dir = dirname(path);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	// mkdir's `mode` is ignored on an already-existing dir and on win32; on POSIX
	// re-assert 0o700 so a pre-existing loose-perm dir is tightened (matches the
	// refresh-lease hardening). win32 relies on the user-profile ACL like the main
	// account store does — POSIX bits are not enforced there.
	if (process.platform !== "win32") {
		await fs.chmod(dir, 0o700).catch(() => undefined);
	}
	const tempPath = tempPathFor(path);
	const content = `${JSON.stringify(merged, null, 2)}\n`;
	try {
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		if (process.platform !== "win32") {
			await fs.chmod(tempPath, 0o600).catch(() => undefined);
		}
		// Route the atomic rename through withFileOperationRetry: on Windows the
		// destination is a live, watched store, so a concurrent reader/indexer can
		// hold it briefly and surface EBUSY/EPERM/ENOTEMPTY/EACCES. Retrying with
		// backoff turns a transient lock into a successful merge instead of a
		// spurious error (mirrors the account-save path).
		await withFileOperationRetry(() => fs.rename(tempPath, path));
	} finally {
		try {
			// Route cleanup through withFileOperationRetry too: if the rename failed
			// and a transient Windows EBUSY/EPERM lingers, a single-shot unlink would
			// leave a secret-bearing .tmp next to the live account store. force:true
			// keeps ENOENT (rename already consumed it) a no-op.
			await withFileOperationRetry(() => fs.rm(tempPath, { force: true }));
		} catch {
			// Best-effort temp cleanup; rename success removes it, ENOENT is expected.
		}
	}
	return path;
}

export async function applyOcChatgptSync(
	options: ApplyOcChatgptSyncOptions,
): Promise<OcChatgptSyncApplyResult> {
	const dependencies = options.dependencies ?? {};
	try {
		const plan = await planOcChatgptSync({
			source: options.source,
			destination: options.destination,
			detectOptions: options.detectOptions,
			dependencies: {
				detectTarget: dependencies.detectTarget,
				previewMerge: dependencies.previewMerge,
				loadTargetStorage: dependencies.loadTargetStorage,
			},
		});

		if (plan.kind === "plan-error") {
			// Map the structured planning error onto the apply error variant.
			return { kind: "error", target: plan.target, error: plan.error };
		}
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
		const detection =
			dependencies.detectTarget?.(options.detectOptions) ??
			detectOcChatgptMultiAuthTarget(options.detectOptions);
		const blocked = mapDetectionToBlocked(detection);
		if (blocked) {
			return blocked;
		}
		if (detection.kind !== "target") {
			throw new Error("Unexpected oc target detection result");
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
		asErr.path.trim().length > 0
	) {
		return asErr.path;
	}
	const message = (asErr?.message ?? "").trim();
	if (message.length === 0) return undefined;
	const match = message.match(/already exists: (?<path>.+)$/i);
	if (match?.groups?.path) {
		return match.groups.path.trim();
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
