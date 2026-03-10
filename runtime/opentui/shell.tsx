import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, createMemo, createSignal } from "solid-js";
import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	loadDashboardDisplaySettings,
	saveDashboardDisplaySettings,
	type DashboardDisplaySettings,
} from "../../lib/dashboard-settings.js";
import { measureShell, truncateText, wrapText } from "./layout";
import {
	buildSettingsToggleNote,
	buildSettingsSavedNote,
	clampCurrentAccountIndex,
	cloneShellSettings,
	DASHBOARD_SECTION_INDEX,
	resolveSection,
	statusBadgesEnabled,
	settingsDraftDirty,
	SHELL_SECTIONS,
	type ShellStateSlice,
} from "./sections";

type FocusRegion = "nav" | "content";

export interface ShellState extends ShellStateSlice {
	activeRegion: FocusRegion;
	actionIndex: number;
	unlockedSectionIndex: number;
	statusNote: string;
}

interface OpenTuiShellProofProps {
	initialState?: ShellState;
	initialSettings?: DashboardDisplaySettings;
}

const SHELL_TOKENS = {
	colors: {
		background: "#0b1316",
		header: "#111c20",
		footer: "#111c20",
		panel: "#132127",
		panelFocus: "#1b2d34",
		border: "#34505a",
		focus: "#d28a29",
		text: "#e9f1eb",
		muted: "#9db0b1",
		accent: "#f1ba68",
		success: "#9fca84",
	},
} as const;

const FOCUS_ORDER: readonly FocusRegion[] = ["nav", "content"];

function clampIndex(index: number, total: number): number {
	if (total <= 0) return 0;
	if (index < 0) return total - 1;
	if (index >= total) return 0;
	return index;
}


function moveRegion(current: FocusRegion, step: number): FocusRegion {
	const currentIndex = FOCUS_ORDER.indexOf(current);
	const nextIndex = clampIndex(currentIndex + step, FOCUS_ORDER.length);
	return FOCUS_ORDER[nextIndex] ?? "nav";
}

function clampSectionIndex(index: number, unlockedSectionIndex: number): number {
	const total = Math.max(1, Math.min(SHELL_SECTIONS.length, unlockedSectionIndex + 1));
	return clampIndex(index, total);
}

function createDashboardState(
	statusNote = "Dashboard ready. Choose Add New Account, Account Workspace, Run Health Check, or Settings to start.",
	settings: DashboardDisplaySettings = DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
): ShellState {
	const persistedSettings = cloneShellSettings(settings);
	return {
		activeRegion: "content",
		sectionIndex: DASHBOARD_SECTION_INDEX,
		actionIndex: 0,
		unlockedSectionIndex: DASHBOARD_SECTION_INDEX,
		statusNote,
		persistedSettings,
		settingsDraft: cloneShellSettings(persistedSettings),
		currentAccountIndex: 0,
	};
}

function resolveEscapeStatusNote(state: ShellState): string {
	const current = resolveSection(state);
	if (current.id === "settings") {
		return settingsDraftDirty(state)
			? "Settings cancelled. Saved value kept."
			: "Settings closed. Back on the dashboard.";
	}
	if (current.id === "add-account" || current.id === "auth-choice") {
		return "Sign-in cancelled. Back on the dashboard.";
	}
	if (current.id === "workspace") {
		return "Account workspace closed. Back on the dashboard.";
	}
	if (current.id === "health") {
		return "Health check closed. Back on the dashboard.";
	}
	return "Dashboard ready. Choose Add New Account, Account Workspace, Run Health Check, or Settings to start.";
}

export function createInitialShellState(
	settings: DashboardDisplaySettings = DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
): ShellState {
	return createDashboardState(undefined, settings);
}

export async function loadInitialShellState(): Promise<ShellState> {
	const settings = await loadDashboardDisplaySettings();
	return createInitialShellState(settings);
}

export async function persistShellSettings(state: ShellState): Promise<ShellState> {
	const nextSettings = cloneShellSettings(state.settingsDraft);
	await saveDashboardDisplaySettings(nextSettings);
	const persistedSettings = await loadDashboardDisplaySettings();
	return {
		...createDashboardState(buildSettingsSavedNote(persistedSettings), persistedSettings),
		currentAccountIndex: clampCurrentAccountIndex(state.currentAccountIndex),
	};
}

export async function applyShellEvent(
	state: ShellState,
	event: Pick<KeyEvent, "name" | "shift" | "preventDefault">,
): Promise<ShellState> {
	if (event.name === "return" && state.activeRegion === "content") {
		const currentAction = resolveSection(state).actions[state.actionIndex];
		if (currentAction?.type === "save-settings") {
			event.preventDefault();
			try {
				return await persistShellSettings(state);
			} catch (error) {
				return {
					...state,
					statusNote:
						error instanceof Error
							? `Settings save failed. ${error.message}`
							: "Settings save failed. Try again.",
				};
			}
		}
	}

	const nextState = applyShellKey(state, event.name, event.shift);
	if (nextState === state) {
		return state;
	}
	event.preventDefault();
	return nextState;
}

export function applyShellKey(state: ShellState, keyName: string, shift = false): ShellState {
	switch (keyName) {
		case "tab":
			return {
				...state,
				activeRegion: moveRegion(state.activeRegion, shift ? -1 : 1),
			};
		case "left":
			return { ...state, activeRegion: "nav" };
		case "right":
			return { ...state, activeRegion: "content" };
		case "escape":
			if (
				state.sectionIndex !== DASHBOARD_SECTION_INDEX ||
				state.unlockedSectionIndex !== DASHBOARD_SECTION_INDEX ||
				state.actionIndex !== 0 ||
				state.activeRegion !== "content"
			) {
				return {
					...createDashboardState(resolveEscapeStatusNote(state), state.persistedSettings),
					currentAccountIndex: clampCurrentAccountIndex(state.currentAccountIndex),
				};
			}
			return {
				...createDashboardState(undefined, state.persistedSettings),
				currentAccountIndex: clampCurrentAccountIndex(state.currentAccountIndex),
			};
		case "up": {
			if (state.activeRegion === "nav") {
				return {
					...state,
					sectionIndex: clampSectionIndex(state.sectionIndex - 1, state.unlockedSectionIndex),
					actionIndex: 0,
				};
			}
			return {
				...state,
				actionIndex: clampIndex(state.actionIndex - 1, resolveSection(state).actions.length),
			};
		}
		case "down": {
			if (state.activeRegion === "nav") {
				return {
					...state,
					sectionIndex: clampSectionIndex(state.sectionIndex + 1, state.unlockedSectionIndex),
					actionIndex: 0,
				};
			}
			return {
				...state,
				actionIndex: clampIndex(state.actionIndex + 1, resolveSection(state).actions.length),
			};
		}
		case "return": {
			if (state.activeRegion === "nav") {
				return {
					...state,
					activeRegion: "content",
					statusNote: resolveSection(state).enterNote,
				};
			}
			const action = resolveSection(state).actions[state.actionIndex];
			if (!action) {
				return state;
			}
			if (action.type === "cancel-dashboard") {
				return {
					...createDashboardState(action.note, state.persistedSettings),
					currentAccountIndex: clampCurrentAccountIndex(state.currentAccountIndex),
				};
			}
			if (action.type === "open-section") {
				const nextSectionIndex = clampIndex(action.targetSectionIndex ?? state.sectionIndex, SHELL_SECTIONS.length);
				return {
					...state,
					sectionIndex: nextSectionIndex,
					actionIndex: 0,
					unlockedSectionIndex: Math.max(state.unlockedSectionIndex, nextSectionIndex),
					statusNote: action.note,
				};
			}
			if (action.type === "toggle-status-badges") {
				const nextDraft = cloneShellSettings(state.settingsDraft);
				nextDraft.menuShowStatusBadge = !statusBadgesEnabled(state.settingsDraft);
				return {
					...state,
					settingsDraft: nextDraft,
					statusNote: buildSettingsToggleNote(nextDraft),
				};
			}
			if (action.type === "save-settings") {
				return state;
			}
			if (action.type === "set-current-account") {
				return {
					...state,
					currentAccountIndex: clampCurrentAccountIndex(action.targetAccountIndex ?? state.currentAccountIndex),
					statusNote: action.note,
				};
			}
			return {
				...state,
				statusNote: action.note,
			};
		}
		default:
			return state;
	}
}

export function OpenTuiShellProof(props: OpenTuiShellProofProps = {}) {
	const dimensions = useTerminalDimensions();
	const metrics = createMemo(() => measureShell(dimensions().width, dimensions().height));
	const initialState = props.initialState ?? createInitialShellState(props.initialSettings);
	const [activeRegion, setActiveRegion] = createSignal<FocusRegion>(initialState.activeRegion);
	const [sectionIndex, setSectionIndex] = createSignal(initialState.sectionIndex);
	const [actionIndex, setActionIndex] = createSignal(initialState.actionIndex);
	const [unlockedSectionIndex, setUnlockedSectionIndex] = createSignal(initialState.unlockedSectionIndex);
	const [statusNote, setStatusNote] = createSignal(initialState.statusNote);
	const [persistedSettings, setPersistedSettings] = createSignal(initialState.persistedSettings);
	const [settingsDraft, setSettingsDraft] = createSignal(initialState.settingsDraft);
	const [currentAccountIndex, setCurrentAccountIndex] = createSignal(initialState.currentAccountIndex);

	const readShellState = (): ShellState => ({
		activeRegion: activeRegion(),
		sectionIndex: sectionIndex(),
		actionIndex: actionIndex(),
		unlockedSectionIndex: unlockedSectionIndex(),
		statusNote: statusNote(),
		persistedSettings: persistedSettings(),
		settingsDraft: settingsDraft(),
		currentAccountIndex: currentAccountIndex(),
	});

	const writeShellState = (nextState: ShellState) => {
		setActiveRegion(nextState.activeRegion);
		setSectionIndex(nextState.sectionIndex);
		setActionIndex(nextState.actionIndex);
		setUnlockedSectionIndex(nextState.unlockedSectionIndex);
		setStatusNote(nextState.statusNote);
		setPersistedSettings(nextState.persistedSettings);
		setSettingsDraft(nextState.settingsDraft);
		setCurrentAccountIndex(nextState.currentAccountIndex);
	};

	const currentSection = createMemo(() => resolveSection(readShellState()));

	const headerRows = createMemo(() => {
		const shell = metrics();
		const current = currentSection();
		const rows = [
			truncateText("OpenTUI Dashboard Slice", shell.width - 2),
			truncateText(
				`Focus ${activeRegion() === "nav" ? "navigation" : "actions"} | ${shell.layoutLabel} | ${shell.width}x${shell.height}`,
				shell.width - 2,
			),
		];
		if (!shell.compact) {
			rows.push(truncateText(`Current screen: ${current.label}`, shell.width - 2));
		}
		return rows;
	});

	const navRows = createMemo(() => {
		const shell = metrics();
		const labelWidth = Math.max(8, shell.navInnerWidth - 2);
		return SHELL_SECTIONS.map((section, index) => {
			const isSelected = index === sectionIndex();
			const isLocked = index > unlockedSectionIndex();
			const prefix = isLocked
				? "- "
				: isSelected
					? (activeRegion() === "nav" ? "> " : "* ")
					: "  ";
			const label = shell.compact ? section.shortLabel : section.label;
			return truncateText(`${prefix}${label}`, labelWidth + 2);
		}).slice(0, shell.navInnerHeight);
	});

	const contentRows = createMemo(() => {
		const shell = metrics();
		const section = currentSection();
		const rows: string[] = [];
		const preludeRows = [
			...wrapText(`${section.label} | Step ${sectionIndex() + 1} of ${SHELL_SECTIONS.length}`, shell.contentInnerWidth),
			...wrapText(section.summary, shell.contentInnerWidth),
			...wrapText(section.detail, shell.contentInnerWidth),
			...(section.detailRows ?? []).flatMap((row) => wrapText(row, shell.contentInnerWidth)),
		];
		const renderedActions = section.actions.map((action, index) => {
			const isSelected = index === actionIndex();
			const prefix = isSelected ? (activeRegion() === "content" ? "> " : "* ") : "  ";
			return truncateText(`${prefix}${action.label}`, shell.contentInnerWidth);
		});
		const maxPreludeRows = Math.max(1, shell.contentInnerHeight - renderedActions.length - 1);
		rows.push(...preludeRows.slice(0, maxPreludeRows));
		rows.push(...renderedActions);
		if (rows.length < shell.contentInnerHeight) {
			rows.push(truncateText(`Note: ${statusNote()}`, shell.contentInnerWidth));
		}
		return rows.slice(0, shell.contentInnerHeight);
	});

	const footerRows = createMemo(() => {
	const shell = metrics();
	const current = currentSection();
	const focusHelp = activeRegion() === "nav"
		? "Help: Arrows move screens | Enter opens actions"
		: current.id === "dashboard"
			? "Help: Arrows move actions | Enter opens add, workspace, check, or settings"
			: current.id === "add-account"
				? "Help: Arrows move actions | Enter opens auth choice | Esc dashboard"
				: current.id === "workspace"
					? "Help: Arrows move actions | Enter sets current or opens check | Esc dashboard"
					: current.id === "health"
						? "Help: Arrows move actions | Enter returns to workspace or dashboard | Esc dashboard"
						: current.id === "settings"
							? "Help: Arrows move actions | Enter toggles, saves, or cancels | Esc dashboard"
							: "Help: Arrows move actions | Enter previews auth path | Esc dashboard";
		const keys = shell.compact
			? "Keys: Tab switch | Esc dashboard"
			: "Keys: Tab switch | Left/Right move | Esc dashboard";
		const rows = [
			truncateText(focusHelp, shell.width - 2),
			truncateText(shell.compact ? `Note: ${statusNote()}` : keys, shell.width - 2),
		];
		if (!shell.compact) {
			rows.push(truncateText(`Note: ${statusNote()}`, shell.width - 2));
		}
		return rows;
	});

	const handleKeyDown = async (event: KeyEvent) => {
		const currentState = readShellState();
		const nextState = await applyShellEvent(currentState, event);
		if (nextState === currentState) return;
		writeShellState(nextState);
	};

	const handleShellKeyDown = (event: KeyEvent) => {
		void handleKeyDown(event);
	};

	return (
		<box
			width={metrics().width}
			height={metrics().height}
			backgroundColor={SHELL_TOKENS.colors.background}
			flexDirection="column"
		>
			<textarea
				focused
				width={1}
				height={1}
				position="absolute"
				top={0}
				left={0}
				opacity={0}
				onKeyDown={handleShellKeyDown}
			/>

			<box
				height={metrics().headerHeight}
				backgroundColor={SHELL_TOKENS.colors.header}
				paddingLeft={1}
				flexDirection="column"
			>
				<For each={headerRows()}>
					{(row, index) => (
						<text fg={index() === 0 ? SHELL_TOKENS.colors.accent : SHELL_TOKENS.colors.muted}>
							{row}
						</text>
					)}
				</For>
			</box>

			<box
				flexGrow={1}
				flexDirection={metrics().compact ? "column" : "row"}
				columnGap={1}
				rowGap={1}
			>
				<box
					width={metrics().compact ? undefined : metrics().navWidth}
					height={metrics().compact ? metrics().navHeight : undefined}
					border
					title="Navigation"
					backgroundColor={activeRegion() === "nav" ? SHELL_TOKENS.colors.panelFocus : SHELL_TOKENS.colors.panel}
					borderColor={activeRegion() === "nav" ? SHELL_TOKENS.colors.focus : SHELL_TOKENS.colors.border}
					flexDirection="column"
				>
					<For each={navRows()}>{(row) => <text fg={SHELL_TOKENS.colors.text}>{row}</text>}</For>
				</box>

				<box
					flexGrow={1}
					height={metrics().compact ? metrics().contentHeight : undefined}
					border
					title="Content"
					backgroundColor={activeRegion() === "content" ? SHELL_TOKENS.colors.panelFocus : SHELL_TOKENS.colors.panel}
					borderColor={activeRegion() === "content" ? SHELL_TOKENS.colors.focus : SHELL_TOKENS.colors.border}
					flexDirection="column"
				>
					<For each={contentRows()}>
						{(row, index) => (
							<text fg={index() >= contentRows().length - 1 ? SHELL_TOKENS.colors.success : SHELL_TOKENS.colors.text}>
								{row}
							</text>
						)}
					</For>
				</box>
			</box>

			<box
				height={metrics().footerHeight}
				backgroundColor={SHELL_TOKENS.colors.footer}
				paddingLeft={1}
				flexDirection="column"
			>
				<For each={footerRows()}>
					{(row, index) => (
						<text fg={index() === footerRows().length - 1 ? SHELL_TOKENS.colors.accent : SHELL_TOKENS.colors.muted}>
							{row}
						</text>
					)}
				</For>
			</box>
		</box>
	);
}
