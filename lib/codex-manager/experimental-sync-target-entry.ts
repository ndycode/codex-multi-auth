import type { AccountStorageV3 } from "../storage.js";

export async function loadExperimentalSyncTargetEntry(params: {
	loadExperimentalSyncTargetState: (args: {
		detectTarget: () => ReturnType<
			typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
		>;
		readJson: (path: string) => Promise<unknown>;
		normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
	}) => Promise<
		| {
				kind: "blocked-ambiguous";
				detection: ReturnType<
					typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
				>;
		  }
		| {
				kind: "blocked-none";
				detection: ReturnType<
					typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
				>;
		  }
		| { kind: "error"; message: string }
		| {
				kind: "target";
				detection: ReturnType<
					typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
				>;
				destination: AccountStorageV3 | null;
		  }
	>;
	detectTarget: () => ReturnType<
		typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
	>;
	readFileWithRetry: (
		path: string,
		options: {
			retryableCodes: Set<string>;
			maxAttempts: number;
			sleep: (ms: number) => Promise<void>;
		},
	) => Promise<string>;
	normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
	sleep: (ms: number) => Promise<void>;
}): ReturnType<typeof params.loadExperimentalSyncTargetState> {
	return params.loadExperimentalSyncTargetState({
		detectTarget: params.detectTarget,
		readJson: async (path) =>
			JSON.parse(
				await params.readFileWithRetry(path, {
					retryableCodes: new Set([
						"EBUSY",
						"EPERM",
						"EAGAIN",
						"ENOTEMPTY",
						"EACCES",
					]),
					maxAttempts: 4,
					sleep: params.sleep,
				}),
			),
		normalizeAccountStorage: params.normalizeAccountStorage,
	});
}
