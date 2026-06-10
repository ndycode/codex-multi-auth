import { createInterface } from "node:readline/promises";
import { formatWaitTime } from "../accounts.js";
import type {
	ApplyOcChatgptSyncOptions,
	OcChatgptSyncApplyResult,
	OcChatgptSyncPlanResult,
	PlanOcChatgptSyncOptions,
} from "../oc-chatgpt-orchestrator.js";
import type { AccountStorageV3 } from "../storage.js";
import type { PluginConfig } from "../types.js";
import type {
	MenuItem,
	select,
} from "../ui/select.js";
import { BACKEND_NUMBER_OPTION_BY_KEY } from "./backend-settings-schema.js";
import type { UiRuntimeOptions } from "../ui/runtime.js";
import type {
	ExperimentalSettingsAction,
	getExperimentalSelectOptions,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
} from "./experimental-settings-schema.js";

type ExperimentalSettingsCopy = {
	experimentalSync: string;
	experimentalBackup: string;
	experimentalRefreshGuard: string;
	experimentalRefreshInterval: string;
	experimentalDecreaseInterval: string;
	experimentalIncreaseInterval: string;
	saveAndBack: string;
	backNoSave: string;
	experimentalHelpMenu: string;
	experimentalBackupPrompt: string;
	back: string;
	experimentalHelpStatus: string;
	experimentalApplySync: string;
	experimentalHelpPreview: string;
};

export type ExperimentalSettingsPromptDeps<
	TTargetState,
> = {
	initialConfig: PluginConfig;
	isInteractive: () => boolean;
	ui: UiRuntimeOptions;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	select: typeof select;
	getExperimentalSelectOptions: typeof getExperimentalSelectOptions;
	mapExperimentalMenuHotkey: typeof mapExperimentalMenuHotkey;
	mapExperimentalStatusHotkey: typeof mapExperimentalStatusHotkey;
	formatDashboardSettingState: (enabled: boolean) => string;
	copy: ExperimentalSettingsCopy;
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	runNamedBackupExport: (args: {
		name: string;
	}) => Promise<{ kind: string; path?: string; error?: unknown }>;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadExperimentalSyncTarget: () => Promise<TTargetState>;
	planOcChatgptSync: (
		args: PlanOcChatgptSyncOptions,
	) => Promise<OcChatgptSyncPlanResult>;
	applyOcChatgptSync: (
		args: ApplyOcChatgptSyncOptions,
	) => Promise<OcChatgptSyncApplyResult>;
	getTargetKind: (targetState: TTargetState) => string;
	getTargetDestination: (targetState: TTargetState) => AccountStorageV3 | null;
	getTargetDetection: (
		targetState: TTargetState,
	) => ReturnType<
		typeof import("../oc-chatgpt-target-detection.js").detectOcChatgptMultiAuthTarget
	>;
	getTargetErrorMessage: (targetState: TTargetState) => string | null;
	getPlanKind: (plan: OcChatgptSyncPlanResult) => string;
	getPlanBlockedReason: (plan: OcChatgptSyncPlanResult) => string;
	getPlanPreview: (plan: OcChatgptSyncPlanResult) => {
		toAdd: unknown[];
		toUpdate: unknown[];
		toSkip: unknown[];
		unchangedDestinationOnly: unknown[];
		activeSelectionBehavior: string;
	};
	getAppliedLabel: (
		applied: OcChatgptSyncApplyResult,
	) => { label: string; color: MenuItem["color"] };
};

export async function promptExperimentalSettingsMenu<TTargetState>(
	params: ExperimentalSettingsPromptDeps<TTargetState>,
): Promise<PluginConfig | null> {
	if (!params.isInteractive()) return null;
	let draft = params.cloneBackendPluginConfig(params.initialConfig);
	const copy = params.copy;

	// settings-hub-01: derive the refresh-interval bounds from the single backend
	// schema entry so this panel and the backend settings panel can never diverge
	// (they previously used different min/step: 60000/60000 here vs 5000/5000 in
	// the schema). Fall back to the historical values if the schema entry is absent.
	const refreshIntervalOption = BACKEND_NUMBER_OPTION_BY_KEY.get(
		"proactiveRefreshIntervalMs",
	);
	const refreshIntervalMin = refreshIntervalOption?.min ?? 60_000;
	const refreshIntervalMax = refreshIntervalOption?.max ?? 600_000;
	const refreshIntervalStep = refreshIntervalOption?.step ?? 60_000;

	while (true) {
		const action = await params.select<ExperimentalSettingsAction>(
			[
				{
					label: copy.experimentalSync,
					value: { type: "sync" },
					color: "yellow",
				},
				{
					label: copy.experimentalBackup,
					value: { type: "backup" },
					color: "green",
				},
				{
					label: `${params.formatDashboardSettingState(draft.proactiveRefreshGuardian ?? false)} ${copy.experimentalRefreshGuard}`,
					value: { type: "toggle-refresh-guardian" },
					color: "yellow",
				},
				{
					label: `${copy.experimentalRefreshInterval}: ${formatWaitTime(draft.proactiveRefreshIntervalMs ?? 60000)}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: copy.experimentalDecreaseInterval,
					value: { type: "decrease-refresh-interval" },
					color: "yellow",
				},
				{
					label: copy.experimentalIncreaseInterval,
					value: { type: "increase-refresh-interval" },
					color: "green",
				},
				{ label: copy.saveAndBack, value: { type: "save" }, color: "green" },
				{ label: copy.backNoSave, value: { type: "back" }, color: "red" },
			],
			params.getExperimentalSelectOptions(
				params.ui,
				copy.experimentalHelpMenu,
				params.mapExperimentalMenuHotkey,
			),
		);
		const actionType = (action as { type?: string } | null)?.type;
		if (!action || actionType === "back") return null;
		if (actionType === "save") return draft;
		if (actionType === "toggle-refresh-guardian") {
			draft = {
				...draft,
				proactiveRefreshGuardian: !(draft.proactiveRefreshGuardian ?? false),
			};
			continue;
		}
		if (actionType === "decrease-refresh-interval") {
			draft = {
				...draft,
				proactiveRefreshIntervalMs: Math.max(
					refreshIntervalMin,
					(draft.proactiveRefreshIntervalMs ?? 60000) - refreshIntervalStep,
				),
			};
			continue;
		}
		if (actionType === "increase-refresh-interval") {
			draft = {
				...draft,
				proactiveRefreshIntervalMs: Math.min(
					refreshIntervalMax,
					(draft.proactiveRefreshIntervalMs ?? 60000) + refreshIntervalStep,
				),
			};
			continue;
		}
		if (actionType === "backup") {
			const prompt = createInterface({
				input: params.input,
				output: params.output,
			});
			try {
				const backupName = (
					await prompt.question(copy.experimentalBackupPrompt)
				).trim();
				if (!backupName || backupName.toLowerCase() === "q") continue;
				try {
					const backupResult = await params.runNamedBackupExport({
						name: backupName,
					});
					const backupLabel =
						backupResult.kind === "exported"
							? `Saved backup to ${backupResult.path}`
							: backupResult.kind === "collision"
								? `Backup already exists: ${backupResult.path}`
								: backupResult.error instanceof Error
									? backupResult.error.message
									: String(backupResult.error);
					await params.select<ExperimentalSettingsAction>(
						[
							{
								label: backupLabel,
								value: { type: "back" },
								disabled: true,
								hideUnavailableSuffix: true,
								color: backupResult.kind === "exported" ? "green" : "yellow",
							},
							{ label: copy.back, value: { type: "back" }, color: "red" },
						],
						params.getExperimentalSelectOptions(
							params.ui,
							copy.experimentalHelpStatus,
							params.mapExperimentalStatusHotkey,
						),
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					await params.select<ExperimentalSettingsAction>(
						[
							{
								label: message,
								value: { type: "back" },
								disabled: true,
								hideUnavailableSuffix: true,
								color: "yellow",
							},
							{ label: copy.back, value: { type: "back" }, color: "red" },
						],
						params.getExperimentalSelectOptions(
							params.ui,
							copy.experimentalHelpStatus,
							params.mapExperimentalStatusHotkey,
						),
					);
				}
			} finally {
				prompt.close();
			}
			continue;
		}

		const source = await params.loadAccounts();
		const targetState = await params.loadExperimentalSyncTarget();
		const targetError = params.getTargetErrorMessage(targetState);
		if (targetError) {
			await params.select<ExperimentalSettingsAction>(
				[
					{
						label: targetError,
						value: { type: "back" },
						disabled: true,
						hideUnavailableSuffix: true,
						color: "yellow",
					},
					{ label: copy.back, value: { type: "back" }, color: "red" },
				],
				params.getExperimentalSelectOptions(
					params.ui,
					copy.experimentalHelpStatus,
					params.mapExperimentalStatusHotkey,
				),
			);
			continue;
		}

		const targetKind = params.getTargetKind(targetState);
		const targetDetection = params.getTargetDetection(targetState);
		const plan = await params.planOcChatgptSync({
			source,
			destination:
				targetKind === "target"
					? params.getTargetDestination(targetState)
					: null,
			dependencies:
				targetKind === "target"
					? { detectTarget: () => targetDetection }
					: undefined,
		});
		if (params.getPlanKind(plan) !== "ready") {
			await params.select<ExperimentalSettingsAction>(
				[
					{
						label: params.getPlanBlockedReason(plan),
						value: { type: "back" },
						disabled: true,
						hideUnavailableSuffix: true,
						color: "yellow",
					},
					{ label: copy.back, value: { type: "back" }, color: "red" },
				],
				params.getExperimentalSelectOptions(
					params.ui,
					copy.experimentalHelpStatus,
					params.mapExperimentalStatusHotkey,
				),
			);
			continue;
		}

		const preview = params.getPlanPreview(plan);
		const review = await params.select<ExperimentalSettingsAction>(
			[
				{
					label: `Preview: add ${preview.toAdd.length} | update ${preview.toUpdate.length} | skip ${preview.toSkip.length}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: `Preserve destination-only: ${preview.unchangedDestinationOnly.length}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: `Active selection: ${preview.activeSelectionBehavior}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: copy.experimentalApplySync,
					value: { type: "apply" },
					color: "green",
				},
				{ label: copy.backNoSave, value: { type: "back" }, color: "red" },
			],
			params.getExperimentalSelectOptions(
				params.ui,
					copy.experimentalHelpPreview,
					(raw) => {
						const lower = raw.toLowerCase();
						if (lower === "q") return { type: "back" };
						if (lower === "a") return { type: "apply" };
						return undefined;
					},
				),
			);
		if (!review || (review as { type?: string }).type === "back") continue;

		const applied = await params.applyOcChatgptSync({
			source,
			destination:
				targetKind === "target"
					? params.getTargetDestination(targetState)
					: undefined,
			dependencies:
				targetKind === "target"
					? { detectTarget: () => targetDetection }
					: undefined,
		});
		const appliedLabel = params.getAppliedLabel(applied);
		await params.select<ExperimentalSettingsAction>(
			[
				{
					label: appliedLabel.label,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: appliedLabel.color,
				},
				{ label: copy.back, value: { type: "back" }, color: "red" },
			],
			params.getExperimentalSelectOptions(
				params.ui,
				copy.experimentalHelpStatus,
				params.mapExperimentalStatusHotkey,
			),
		);
	}
}
