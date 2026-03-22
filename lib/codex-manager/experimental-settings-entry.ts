import type { PluginConfig } from "../types.js";

export async function promptExperimentalSettingsEntry(params: {
	initialConfig: PluginConfig;
	promptExperimentalSettingsMenu: (args: {
		initialConfig: PluginConfig;
		isInteractive: () => boolean;
		ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>;
		cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
		select: <T>(
			items: Array<Record<string, unknown>>,
			options: Record<string, unknown>,
		) => Promise<T | null>;
		getExperimentalSelectOptions: (
			ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
			help: string,
			hotkeyMapper: (raw: string) => unknown,
		) => Record<string, unknown>;
		mapExperimentalMenuHotkey: (raw: string) => unknown;
		mapExperimentalStatusHotkey: (raw: string) => unknown;
		formatDashboardSettingState: (enabled: boolean) => string;
		copy: Record<string, string>;
		input: NodeJS.ReadStream;
		output: NodeJS.WriteStream;
		runNamedBackupExport: (args: {
			name: string;
		}) => Promise<{ kind: string; path?: string; error?: unknown }>;
		loadAccounts: () => Promise<unknown>;
		loadExperimentalSyncTarget: () => Promise<unknown>;
		planOcChatgptSync: (args: Record<string, unknown>) => Promise<unknown>;
		applyOcChatgptSync: (args: Record<string, unknown>) => Promise<unknown>;
		getTargetKind: (targetState: unknown) => string;
		getTargetDestination: (targetState: unknown) => unknown;
		getTargetDetection: (targetState: unknown) => unknown;
		getTargetErrorMessage: (targetState: unknown) => string | null;
		getPlanKind: (plan: unknown) => string;
		getPlanBlockedReason: (plan: unknown) => string;
		getPlanPreview: (plan: unknown) => {
			toAdd: unknown[];
			toUpdate: unknown[];
			toSkip: unknown[];
			unchangedDestinationOnly: unknown[];
			activeSelectionBehavior: string;
		};
		getAppliedLabel: (applied: unknown) => { label: string; color: string };
	}) => Promise<PluginConfig | null>;
	isInteractive: () => boolean;
	ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	select: <T>(
		items: Array<Record<string, unknown>>,
		options: Record<string, unknown>,
	) => Promise<T | null>;
	getExperimentalSelectOptions: (
		ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
		help: string,
		hotkeyMapper: (raw: string) => unknown,
	) => Record<string, unknown>;
	mapExperimentalMenuHotkey: (raw: string) => unknown;
	mapExperimentalStatusHotkey: (raw: string) => unknown;
	formatDashboardSettingState: (enabled: boolean) => string;
	copy: Record<string, string>;
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	runNamedBackupExport: (args: {
		name: string;
	}) => Promise<{ kind: string; path?: string; error?: unknown }>;
	loadAccounts: () => Promise<unknown>;
	loadExperimentalSyncTarget: () => Promise<unknown>;
	planOcChatgptSync: (args: Record<string, unknown>) => Promise<unknown>;
	applyOcChatgptSync: (args: Record<string, unknown>) => Promise<unknown>;
	getTargetKind: (targetState: unknown) => string;
	getTargetDestination: (targetState: unknown) => unknown;
	getTargetDetection: (targetState: unknown) => unknown;
	getTargetErrorMessage: (targetState: unknown) => string | null;
	getPlanKind: (plan: unknown) => string;
	getPlanBlockedReason: (plan: unknown) => string;
	getPlanPreview: (plan: unknown) => {
		toAdd: unknown[];
		toUpdate: unknown[];
		toSkip: unknown[];
		unchangedDestinationOnly: unknown[];
		activeSelectionBehavior: string;
	};
	getAppliedLabel: (applied: unknown) => { label: string; color: string };
}): Promise<PluginConfig | null> {
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
