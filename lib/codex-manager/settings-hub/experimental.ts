import { stdin as input, stdout as output } from "node:process";
import {
	applyOcChatgptSync,
	planOcChatgptSync,
	runNamedBackupExport,
} from "../../oc-chatgpt-orchestrator.js";
import { detectOcChatgptMultiAuthTarget } from "../../oc-chatgpt-target-detection.js";
import { loadAccounts, normalizeAccountStorage } from "../../storage.js";
import type { PluginConfig } from "../../types.js";
import { UI_COPY } from "../../ui/copy.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";
import { select } from "../../ui/select.js";
import { sleep } from "../../utils.js";
import { cloneBackendPluginConfig } from "../backend-settings-helpers.js";
import { formatDashboardSettingState } from "../dashboard-formatters.js";
import { promptExperimentalSettingsEntry } from "../experimental-settings-entry.js";
import { promptExperimentalSettingsMenu } from "../experimental-settings-prompt.js";
import {
	getExperimentalSelectOptions,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
} from "../experimental-settings-schema.js";
import { loadExperimentalSyncTargetState } from "../experimental-sync-target.js";
import { loadExperimentalSyncTargetEntry } from "../experimental-sync-target-entry.js";
import { readFileWithRetry } from "../settings-persist-utils.js";
import { isTtyInteractive } from "./shared.js";

export async function loadExperimentalSyncTarget(): Promise<
	| {
			kind: "blocked-ambiguous";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
	  }
	| {
			kind: "blocked-none";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
	  }
	| { kind: "error"; message: string }
	| {
			kind: "target";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
			destination: import("../../storage.js").AccountStorageV3 | null;
	  }
> {
	return loadExperimentalSyncTargetEntry({
		loadExperimentalSyncTargetState,
		detectTarget: detectOcChatgptMultiAuthTarget,
		readFileWithRetry,
		normalizeAccountStorage,
		sleep,
	});
}

/* c8 ignore start - interactive prompt flows are covered by integration tests */
export async function promptExperimentalSettings(
	initialConfig: PluginConfig,
): Promise<PluginConfig | null> {
	return promptExperimentalSettingsEntry({
		initialConfig,
		promptExperimentalSettingsMenu,
		isInteractive: isTtyInteractive,
		ui: getUiRuntimeOptions(),
		cloneBackendPluginConfig,
		select,
		getExperimentalSelectOptions,
		mapExperimentalMenuHotkey,
		mapExperimentalStatusHotkey,
		formatDashboardSettingState,
		copy: UI_COPY.settings,
		input,
		output,
		runNamedBackupExport,
		loadAccounts,
		loadExperimentalSyncTarget,
		planOcChatgptSync,
		applyOcChatgptSync,
		getTargetKind: (targetState) => (targetState as { kind: string }).kind,
		getTargetDestination: (
			targetState,
		): import("../../storage.js").AccountStorageV3 | null =>
			(
				targetState as {
					kind: string;
					destination?: import("../../storage.js").AccountStorageV3 | null;
				}
			).destination ?? null,
		getTargetDetection: (
			targetState,
		): ReturnType<typeof detectOcChatgptMultiAuthTarget> =>
			(
				targetState as {
					detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
				}
			).detection,
		getTargetErrorMessage: (targetState) =>
			(targetState as { kind: string; message?: string }).kind === "error"
				? ((targetState as { message?: string }).message ?? "Unknown error")
				: null,
		getPlanKind: (plan) => (plan as { kind: string }).kind,
		getPlanBlockedReason: (plan) => {
			const candidate = plan as {
				kind: string;
				detection?: { reason?: string };
			};
			return candidate.kind === "blocked-ambiguous"
				? `Sync blocked: ${candidate.detection?.reason ?? "unknown"}`
				: `Sync unavailable: ${candidate.detection?.reason ?? "unknown"}`;
		},
		getPlanPreview: (plan) =>
			(
				plan as {
					preview: {
						toAdd: unknown[];
						toUpdate: unknown[];
						toSkip: unknown[];
						unchangedDestinationOnly: unknown[];
						activeSelectionBehavior: string;
					};
				}
			).preview,
		getAppliedLabel: (applied) => {
			const candidate = applied as {
				kind: string;
				target?: { accountPath?: string };
				error?: unknown;
			};
			return {
				label:
					candidate.kind === "applied"
						? `Applied sync to ${candidate.target?.accountPath ?? "target"}`
						: candidate.kind === "error"
							? candidate.error instanceof Error
								? candidate.error.message
								: String(candidate.error)
							: "Sync did not apply",
				color: candidate.kind === "applied" ? "green" : "yellow",
			};
		},
	});
}
/* c8 ignore stop */
