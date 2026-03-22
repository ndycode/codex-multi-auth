import type { PluginConfig } from "../types.js";
import type { ExperimentalSettingsPromptDeps } from "./experimental-settings-prompt.js";

export async function promptExperimentalSettingsEntry<TTargetState>(
	params: {
		initialConfig: PluginConfig;
		promptExperimentalSettingsMenu: (
			args: ExperimentalSettingsPromptDeps<TTargetState>,
		) => Promise<PluginConfig | null>;
	} & ExperimentalSettingsPromptDeps<TTargetState>,
): Promise<PluginConfig | null> {
	return params.promptExperimentalSettingsMenu({
		initialConfig: params.initialConfig,
		isInteractive: params.isInteractive,
		ui: params.ui,
		cloneBackendPluginConfig: params.cloneBackendPluginConfig,
		select: params.select,
		getExperimentalSelectOptions: params.getExperimentalSelectOptions,
		mapExperimentalMenuHotkey: params.mapExperimentalMenuHotkey,
		mapExperimentalStatusHotkey: params.mapExperimentalStatusHotkey,
		formatDashboardSettingState: params.formatDashboardSettingState,
		copy: params.copy,
		input: params.input,
		output: params.output,
		runNamedBackupExport: params.runNamedBackupExport,
		loadAccounts: params.loadAccounts,
		loadExperimentalSyncTarget: params.loadExperimentalSyncTarget,
		planOcChatgptSync: params.planOcChatgptSync,
		applyOcChatgptSync: params.applyOcChatgptSync,
		getTargetKind: params.getTargetKind,
		getTargetDestination: params.getTargetDestination,
		getTargetDetection: params.getTargetDetection,
		getTargetErrorMessage: params.getTargetErrorMessage,
		getPlanKind: params.getPlanKind,
		getPlanBlockedReason: params.getPlanBlockedReason,
		getPlanPreview: params.getPlanPreview,
		getAppliedLabel: params.getAppliedLabel,
	});
}
