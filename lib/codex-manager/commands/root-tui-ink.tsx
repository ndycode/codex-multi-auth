import React, { useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import type { ExistingAccountInfo } from "../../cli.js";
import type {
	RootCommandTuiAction,
	RootCommandTuiHandlers,
	RootCommandTuiUpdate,
} from "./root-tui.js";
import {
	createInitialRootTuiState,
	handleAddAccountModalInput,
	handleRootScreenInput,
	type RootTuiKeyEvent,
	type RootTuiState,
	resolveQuickSwitchNumber,
} from "./root-tui-state.js";

type StatusTone = "info" | "success" | "error";
type InkTone = "blue" | "green" | "red" | "yellow" | "cyan" | "gray";

interface RootTuiStatus {
	message: string;
	tone: StatusTone;
}

function formatDurationCompact(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
	}
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
	}
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function formatResetAt(resetAtMs: number | undefined): string {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs)) {
		return "no data";
	}
	const remaining = resetAtMs - Date.now();
	if (remaining <= 0) return "ready";
	if (remaining < 86_400_000) {
		return formatDurationCompact(remaining);
	}
	return new Date(resetAtMs).toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatLeftPercent(value: number | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "--";
	}
	return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatLastUsed(lastUsed: number | undefined): string {
	if (typeof lastUsed !== "number" || !Number.isFinite(lastUsed) || lastUsed <= 0) {
		return "unknown";
	}
	return new Date(lastUsed).toLocaleString();
}

function resolveCurrentAccountLabel(accounts: ExistingAccountInfo[]): string {
	const current = accounts.find((account) =>
		(account.currentMarkers ?? []).includes("current"),
	);
	return (
		current?.email?.trim() ||
		current?.accountLabel?.trim() ||
		current?.accountId?.trim() ||
		"none"
	);
}

function resolveAccountLabel(account: ExistingAccountInfo): string {
	return (
		account.email?.trim() ||
		account.accountLabel?.trim() ||
		account.accountId?.trim() ||
		`Account ${(resolveQuickSwitchNumber(account) ?? account.index + 1).toString()}`
	);
}

function resolveStateLabel(account: ExistingAccountInfo): string {
	const markers = new Set(account.currentMarkers ?? []);
	const parts: string[] = [];
	if (markers.has("current")) parts.push("current");
	if (markers.has("in-use")) parts.push("in use");
	if (parts.length === 0) {
		if (account.enabled === false) return "disabled";
		if (typeof account.status === "string" && account.status.trim().length > 0) {
			return account.status;
		}
		return "ready";
	}
	return parts.join(" ");
}

function stateTone(
	account: ExistingAccountInfo,
): "green" | "yellow" | "red" | "cyan" {
	const markers = new Set(account.currentMarkers ?? []);
	if (markers.has("current")) return "cyan";
	if (account.enabled === false) return "red";
	if (account.quotaRateLimited || account.quotaExhausted) return "yellow";
	return "green";
}

function toKeyEvent(input: string, key: RootTuiKeyEvent["key"]): RootTuiKeyEvent {
	return { input, key };
}

function clampCursorIndex(cursor: number, accounts: ExistingAccountInfo[]): number {
	if (accounts.length === 0) return -1;
	return Math.min(Math.max(cursor, 0), accounts.length - 1);
}

function preserveCursorIndex(
	currentState: RootTuiState,
	nextAccounts: ExistingAccountInfo[],
	focusedSourceIndex: number | undefined,
): number {
	if (nextAccounts.length === 0) return -1;
	if (typeof focusedSourceIndex === "number") {
		const nextIndex = nextAccounts.findIndex(
			(account) => account.sourceIndex === focusedSourceIndex,
		);
		if (nextIndex >= 0) return nextIndex;
	}
	return clampCursorIndex(currentState.rootCursor, nextAccounts);
}

function statusColor(tone: StatusTone): "blue" | "green" | "red" {
	if (tone === "success") return "green";
	if (tone === "error") return "red";
	return "blue";
}

function quotaTone(value: number | undefined): InkTone {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "gray";
	}
	if (value >= 70) return "green";
	if (value >= 35) return "yellow";
	return "red";
}

function formatQuotaMeter(value: number | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "░░░░░";
	}
	const bounded = Math.max(0, Math.min(100, Math.round(value)));
	const filled = Math.max(0, Math.min(5, Math.round(bounded / 20)));
	return `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
}

function makeStatus(update: RootCommandTuiUpdate, fallback: RootTuiStatus): RootTuiStatus {
	if (typeof update.statusMessage === "string" && update.statusMessage.trim().length > 0) {
		return {
			message: update.statusMessage,
			tone: update.statusTone ?? "info",
		};
	}
	return fallback;
}

function RootTuiShell(props: {
	accounts: ExistingAccountInfo[];
	state: RootTuiState;
	status: RootTuiStatus | null;
	busy: boolean;
}): React.ReactNode {
	const { accounts, state, status, busy } = props;
	const { columns, rows } = useWindowSize();
	const currentLabel = resolveCurrentAccountLabel(accounts);
	const selectedAccount = state.rootCursor >= 0 ? accounts[state.rootCursor] : undefined;
	const selectedLabel = selectedAccount ? resolveAccountLabel(selectedAccount) : "none";
	return (
		<Box width={columns} minHeight={rows} flexDirection="column" paddingX={2} paddingY={1}>
			<Box
				borderStyle="round"
				borderColor={busy ? "yellow" : "blue"}
				paddingX={1}
				paddingY={0}
				marginBottom={1}
				justifyContent="space-between"
			>
				<Box>
					<Text color="blue" bold>
						Codex
					</Text>
					<Text color="blue" bold>
						{" "}
						Multi Auth
					</Text>
				</Box>
				<Text color={busy ? "yellow" : "gray"}>{busy ? "working" : "root dashboard"}</Text>
			</Box>
			<Box
				borderStyle="round"
				borderColor="blue"
				flexDirection="column"
				paddingX={1}
				marginBottom={1}
			>
				<Text wrap="truncate-end">
					<Text color="blue">Current</Text>: <Text bold>{currentLabel}</Text>
				</Text>
				<Text wrap="truncate-end">
					<Text color="blue">Selected</Text>: <Text color="cyan">{selectedLabel}</Text>
					<Text dimColor> | {accounts.length.toString()} saved</Text>
				</Text>
			</Box>
			{state.mode === "add" ? (
				<AddAccountModal addCursor={state.addCursor} busy={busy} />
			) : (
				<RootAccountList accounts={accounts} rootCursor={state.rootCursor} width={columns} />
			)}
			<Box marginTop={1}>
				<StatusBar status={status} busy={busy} mode={state.mode} />
			</Box>
			<Box marginTop={1} flexDirection="column">
				{state.mode === "add" ? (
					<>
						<Text dimColor>Enter choose | 1/2 direct | q back</Text>
						<Text dimColor>j/k move</Text>
					</>
				) : (
					<>
						<Text dimColor>Enter or Space switch | a add | r refresh | q quit</Text>
						<Text dimColor>j/k move | gg/G jump | 1..9 quick switch</Text>
					</>
				)}
			</Box>
		</Box>
	);
}

function RootAccountList(props: {
	accounts: ExistingAccountInfo[];
	rootCursor: number;
	width: number;
}): React.ReactNode {
	const { accounts, rootCursor, width } = props;
	if (accounts.length === 0) {
		return (
			<Box flexDirection="column" flexGrow={1} justifyContent="center">
				<Text bold>No accounts saved yet</Text>
				<Text dimColor>Press a to add your first account.</Text>
				<Box flexGrow={1} />
			</Box>
		);
	}

	return (
		<Box flexDirection="column" flexGrow={1}>
			<Text color="blue" bold>
				Accounts
			</Text>
			<Box marginBottom={1} />
			{accounts.map((account, index) => (
				<AccountRow
					key={`${account.accountId ?? account.email ?? index.toString()}-${index.toString()}`}
					account={account}
					focused={index === rootCursor}
					width={width}
				/>
			))}
			<Box flexGrow={1} />
		</Box>
	);
}

function AccountRow(props: {
	account: ExistingAccountInfo;
	focused: boolean;
	width: number;
}): React.ReactNode {
	const { account, focused, width } = props;
	const quickSwitchNumber = resolveQuickSwitchNumber(account) ?? account.index + 1;
	const stateLabel = resolveStateLabel(account);
	const accountLabel = resolveAccountLabel(account);
	const accountTone = stateTone(account);
	const quota5hTone = quotaTone(account.quota5hLeftPercent);
	const quota7dTone = quotaTone(account.quota7dLeftPercent);
	return (
		<Box
			borderStyle="round"
			borderColor={focused ? "cyan" : "gray"}
			flexDirection="column"
			marginBottom={1}
			paddingX={1}
			paddingY={0}
			width={Math.max(24, width - 4)}
		>
			<Box justifyContent="space-between">
				<Text color={focused ? "cyan" : "gray"}>{focused ? "> active" : "  saved"}</Text>
				<Text color={accountTone}>{stateLabel}</Text>
			</Box>
			<Text bold={focused} wrap="truncate-end">
				[{quickSwitchNumber}] {accountLabel}
			</Text>
			<Box>
				<Text color={quota5hTone}>
					5h {formatQuotaMeter(account.quota5hLeftPercent)} {formatLeftPercent(account.quota5hLeftPercent)}
				</Text>
				<Text dimColor> | </Text>
				<Text color={quota7dTone}>
					7d {formatQuotaMeter(account.quota7dLeftPercent)} {formatLeftPercent(account.quota7dLeftPercent)}
				</Text>
			</Box>
			<Text wrap="truncate-end">
				<Text dimColor>reset </Text>
				<Text color="blue">5h {formatResetAt(account.quota5hResetAtMs)}</Text>
				<Text dimColor> | </Text>
				<Text color="blue">7d {formatResetAt(account.quota7dResetAtMs)}</Text>
			</Text>
			<Text dimColor wrap="truncate-end">
				last used {formatLastUsed(account.lastUsed)}
			</Text>
		</Box>
	);
}

function StatusBar(props: {
	status: RootTuiStatus | null;
	busy: boolean;
	mode: RootTuiState["mode"];
}): React.ReactNode {
	if (props.busy) {
		return <Text color="yellow">Working...</Text>;
	}
	if (!props.status) {
		return props.mode === "add" ? (
			<Box borderStyle="round" borderColor="yellow" paddingX={1}>
				<Text dimColor>Choose a sign-in path, or press q to go back.</Text>
			</Box>
		) : (
			<Box borderStyle="round" borderColor="blue" paddingX={1}>
				<Text dimColor>Pick an account to switch, or press a to add another one.</Text>
			</Box>
		);
	}
	return (
		<Box borderStyle="round" borderColor={statusColor(props.status.tone)} paddingX={1}>
			<Text color={statusColor(props.status.tone)}>{props.status.message}</Text>
		</Box>
	);
}

function AddAccountModal(props: {
	addCursor: number;
	busy: boolean;
}): React.ReactNode {
	const options = [
		{
			label: "1. Open browser",
			detail: "Recommended when this machine can launch the OAuth page.",
		},
		{
			label: "2. Manual paste callback URL",
			detail: "Use when browser launch is blocked or the callback must be pasted manually.",
		},
		{
			label: "Back",
			detail: "Return to the account list without starting sign-in.",
		},
	];
	return (
		<Box
			borderStyle="round"
			borderColor="green"
			flexDirection="column"
			flexGrow={1}
			justifyContent="center"
			paddingX={1}
		>
			<Text color="green" bold>
				Add Account
			</Text>
			<Box marginBottom={1} />
			<Text dimColor>Choose how to start the existing sign-in flow.</Text>
			<Box marginBottom={1} />
			{options.map((option, index) => {
				const focused = index === props.addCursor;
				return (
					<Box key={option.label} flexDirection="column" marginBottom={1}>
						<Text color={focused ? "green" : "gray"} bold={focused}>
							{focused ? "> " : "  "}
							{option.label}
						</Text>
						<Text dimColor wrap="truncate-end">
							{"   "}
							{option.detail}
						</Text>
					</Box>
				);
			})}
			{props.busy ? (
				<Box marginTop={1}>
					<Text color="yellow">Working...</Text>
				</Box>
			) : null}
		</Box>
	);
}

function RootCommandTuiInkApp(props: {
	initialAccounts: ExistingAccountInfo[];
	handlers?: RootCommandTuiHandlers;
	onAction: (action: RootCommandTuiAction) => void;
}): React.ReactNode {
	const { exit } = useApp();
	const [accounts, setAccounts] = useState<ExistingAccountInfo[]>(props.initialAccounts);
	const [state, setState] = useState<RootTuiState>(() =>
		createInitialRootTuiState(props.initialAccounts),
	);
	const [status, setStatus] = useState<RootTuiStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const finish = (action: RootCommandTuiAction) => {
		props.onAction(action);
		exit();
	};

	const applyUpdate = (
		update: RootCommandTuiUpdate,
		focusedSourceIndex: number | undefined,
		fallbackStatus: RootTuiStatus,
	) => {
		setAccounts(update.accounts);
		setState((current) => ({
			...current,
			mode: "root",
			pendingG: false,
			rootCursor: preserveCursorIndex(current, update.accounts, focusedSourceIndex),
		}));
		setStatus(makeStatus(update, fallbackStatus));
	};

	const handleAction = async (action: RootCommandTuiAction) => {
		if (action.type === "switch" && props.handlers?.onSwitch) {
			setBusy(true);
			try {
				const update = await props.handlers.onSwitch(action.accountIndex);
				const fallbackLabel =
					update.accounts.find((account) => account.sourceIndex === action.accountIndex)
						? resolveAccountLabel(
								update.accounts.find(
									(account) => account.sourceIndex === action.accountIndex,
								) ?? { index: action.accountIndex },
							)
						: `account ${String(action.accountIndex + 1)}`;
				applyUpdate(update, action.accountIndex, {
					message: `Switched to ${fallbackLabel}.`,
					tone: "success",
				});
			} catch (error) {
				const message =
					error instanceof Error && error.message.trim().length > 0
						? error.message
						: "Unable to switch accounts.";
				setStatus({ message, tone: "error" });
			} finally {
				setBusy(false);
			}
			return;
		}

		if (action.type === "refresh" && props.handlers?.onRefresh) {
			setBusy(true);
			try {
				const focusedSourceIndex =
					state.rootCursor >= 0 ? accounts[state.rootCursor]?.sourceIndex : undefined;
				const update = await props.handlers.onRefresh();
				applyUpdate(update, focusedSourceIndex, {
					message: "Refreshed account list.",
					tone: "info",
				});
			} catch (error) {
				const message =
					error instanceof Error && error.message.trim().length > 0
						? error.message
						: "Unable to refresh accounts.";
				setStatus({ message, tone: "error" });
			} finally {
				setBusy(false);
			}
			return;
		}

		finish(action);
	};

	useInput((input, key) => {
		if (busy) {
			return;
		}
		const event = toKeyEvent(input, key);
		const transition =
			state.mode === "add"
				? handleAddAccountModalInput(state, event)
				: handleRootScreenInput(state, event, accounts);
		setState(transition.state);
		if (transition.action) {
			void handleAction(transition.action);
		}
	});

	return <RootTuiShell accounts={accounts} state={state} status={status} busy={busy} />;
}

export async function promptRootCommandInkTui(
	accounts: ExistingAccountInfo[],
	handlers?: RootCommandTuiHandlers,
): Promise<RootCommandTuiAction> {
	let resolvedAction: RootCommandTuiAction | undefined;
	const app = render(
		<RootCommandTuiInkApp
			initialAccounts={accounts}
			handlers={handlers}
			onAction={(action) => {
				resolvedAction = action;
			}}
		/>,
		{ alternateScreen: true },
	);
	await app.waitUntilExit();
	return resolvedAction ?? { type: "cancel" };
}
