import type { AccountStorageV3 } from "../storage.js";

type ExperimentalTargetDetection = ReturnType<
	typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
>;

export type ExperimentalSyncTargetState =
	| {
			kind: "blocked-ambiguous";
			detection: ExperimentalTargetDetection;
	  }
	| {
			kind: "blocked-none";
			detection: ExperimentalTargetDetection;
	  }
	| { kind: "error"; message: string }
	| {
			kind: "target";
			detection: ExperimentalTargetDetection;
			destination: AccountStorageV3 | null;
	  };

export async function loadExperimentalSyncTargetState(deps: {
	detectTarget: () => ExperimentalTargetDetection;
	readJson: (path: string) => Promise<unknown>;
	normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
}): Promise<ExperimentalSyncTargetState> {
	const detection = deps.detectTarget();
	if (detection.kind === "ambiguous") {
		return { kind: "blocked-ambiguous", detection };
	}
	if (detection.kind === "none") {
		return { kind: "blocked-none", detection };
	}
	try {
		const raw = await deps.readJson(detection.descriptor.accountPath);
		const normalized = deps.normalizeAccountStorage(raw);
		if (!normalized) {
			return {
				kind: "error",
				message: "Invalid target account storage format",
			};
		}
		return {
			kind: "target",
			detection,
			destination: normalized,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				kind: "target",
				detection,
				destination: null,
			};
		}
		return {
			kind: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
