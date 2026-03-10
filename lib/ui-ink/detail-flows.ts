import { createElement, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, type RenderOptions } from "ink";
import type { AuthAccountViewModel } from "../codex-manager/auth-ui-controller.js";
import {
	InkShellFrame,
	InkShellPanel,
	InkShellRow,
	createInkShellTheme,
	type InkShellTone,
} from "./layout.js";
import {
	resolveInkAuthShellBootstrap,
	type InkAuthShellEnvironment,
} from "./bootstrap.js";

type InkChoiceValue = string;

interface InkChoiceItem {
	value: InkChoiceValue;
	label: string;
	detail?: string;
	tone: InkShellTone;
	hotkeys?: string[];
}

interface PromptInkChoiceOptions extends InkAuthShellEnvironment {
	title: string;
	panelTitle?: string;
	subtitle?: string;
	status?: string;
	statusTone?: InkShellTone;
	footer: string;
	items: InkChoiceItem[];
	cancelValue?: InkChoiceValue | null;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

interface InkChoiceAppProps extends PromptInkChoiceOptions {
	onResolve: (value: InkChoiceValue | null) => void;
}

function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

function formatAccountTitle(account: AuthAccountViewModel): string {
	const accountNumber = account.quickSwitchNumber ?? (account.index + 1);
	const base = account.email ?? account.accountLabel ?? account.accountId ?? `Account ${accountNumber}`;
	return `${accountNumber}. ${base}`;
}

function formatAccountSubtitle(account: AuthAccountViewModel): string {
	const status = account.status ?? "unknown";
	const parts = [
		`Added: ${formatDate(account.addedAt)}`,
		`Used: ${formatRelativeTime(account.lastUsed)}`,
		`Status: ${status}`,
	];
	if (account.quotaSummary) {
		parts.push(`Limits: ${account.quotaSummary}`);
	}
	return parts.join(" | ");
}

function InkChoiceApp(props: InkChoiceAppProps) {
	const { exit } = useApp();
	const theme = createInkShellTheme();
	const [cursor, setCursor] = useState(0);

	const resolve = (value: InkChoiceValue | null) => {
		props.onResolve(value);
		exit();
	};

	useInput((input, key) => {
		if (key.upArrow) {
			setCursor((current) => (current + props.items.length - 1) % props.items.length);
			return;
		}
		if (key.downArrow) {
			setCursor((current) => (current + 1) % props.items.length);
			return;
		}

		const lower = input.toLowerCase();
		if (key.escape || lower === "q") {
			resolve(props.cancelValue ?? null);
			return;
		}
		for (const item of props.items) {
			if (item.hotkeys?.includes(lower)) {
				resolve(item.value);
				return;
			}
		}
		if (key.return) {
			resolve(props.items[cursor]?.value ?? props.cancelValue ?? null);
		}
	});

	return createElement(
		InkShellFrame,
		{
			title: props.title,
			subtitle: props.subtitle,
			status: props.status,
			statusTone: props.statusTone,
			footer: props.footer,
			theme,
		},
		createElement(
			InkShellPanel,
			{ title: props.panelTitle ?? props.title, theme },
			createElement(
				Box,
				{ flexDirection: "column" },
				...props.items.map((item, index) =>
					createElement(InkShellRow, {
						key: `${item.value}:${index}`,
						label: item.label,
						detail: item.detail,
						active: index === cursor,
						tone: item.tone,
						theme,
					}),
				),
			),
		),
	);
}

async function promptInkChoice(options: PromptInkChoiceOptions): Promise<InkChoiceValue | null> {
	const support = resolveInkAuthShellBootstrap(options);
	if (!support.supported) return null;

	return await new Promise<InkChoiceValue | null>((resolve) => {
		let settled = false;
		const finish = (value: InkChoiceValue | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const renderOptions: RenderOptions = {
			stdin: options.stdin ?? process.stdin,
			stdout: options.stdout ?? process.stdout,
			stderr: options.stderr ?? process.stderr,
			debug: options.debug ?? false,
			patchConsole: options.patchConsole ?? false,
			exitOnCtrlC: options.exitOnCtrlC ?? false,
		};

		render(createElement(InkChoiceApp, { ...options, onResolve: finish }), renderOptions);
	});
}

interface PromptInkTextConfirmOptions extends InkAuthShellEnvironment {
	title: string;
	panelTitle?: string;
	subtitle?: string;
	status?: string;
	statusTone?: InkShellTone;
	prompt: string;
	confirmText: string;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

interface InkTextConfirmAppProps extends PromptInkTextConfirmOptions {
	onResolve: (value: boolean | null) => void;
}

function InkTextConfirmApp(props: InkTextConfirmAppProps) {
	const { exit } = useApp();
	const theme = createInkShellTheme();
	const [value, setValue] = useState("");
	const valueRef = useRef("");
	const confirmText = props.confirmText.toUpperCase();
	const current = value.toUpperCase();
	const ready = current === confirmText;

	const resolve = (result: boolean | null) => {
		props.onResolve(result);
		exit();
	};

	useInput((input, key) => {
		const lower = input.toLowerCase();
		if (key.escape || lower === "q") {
			resolve(false);
			return;
		}
		if (key.backspace || key.delete) {
			const nextValue = valueRef.current.slice(0, -1);
			valueRef.current = nextValue;
			setValue(nextValue);
			return;
		}
		if (key.return) {
			if (valueRef.current.toUpperCase() === confirmText) {
				resolve(true);
			}
			return;
		}
		if (!input || key.ctrl || key.meta) return;
		const nextLetters = input.toUpperCase().replace(/[^A-Z]/g, "");
		if (nextLetters.length === 0) return;
		const nextValue = `${valueRef.current}${nextLetters}`.slice(0, confirmText.length);
		valueRef.current = nextValue;
		setValue(nextValue);
		if (nextValue.toUpperCase() === confirmText) {
			resolve(true);
		}
	});

	return createElement(
		InkShellFrame,
		{
			title: props.title,
			subtitle: props.subtitle,
			status: props.status ?? (ready ? "Confirmation ready" : `Type ${confirmText}`),
			statusTone: props.statusTone ?? (ready ? "success" : "warning"),
			footer: `Type ${confirmText} then Enter | Backspace delete | Q Back`,
			theme,
		},
		createElement(
			InkShellPanel,
			{ title: props.panelTitle ?? props.title, theme },
			createElement(Text, { color: theme.textColor }, props.prompt),
			createElement(Box, { marginTop: 1, flexDirection: "column" },
				createElement(Text, { color: theme.mutedColor }, `Required: ${confirmText}`),
				createElement(Text, { color: ready ? theme.successColor : theme.headingColor, bold: true }, `Typed: ${current || "_"}`),
			),
		),
	);
}

async function promptInkTextConfirm(options: PromptInkTextConfirmOptions): Promise<boolean | null> {
	const support = resolveInkAuthShellBootstrap(options);
	if (!support.supported) return null;

	return await new Promise<boolean | null>((resolve) => {
		let settled = false;
		const finish = (value: boolean | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const renderOptions: RenderOptions = {
			stdin: options.stdin ?? process.stdin,
			stdout: options.stdout ?? process.stdout,
			stderr: options.stderr ?? process.stderr,
			debug: options.debug ?? false,
			patchConsole: options.patchConsole ?? false,
			exitOnCtrlC: options.exitOnCtrlC ?? false,
		};

		render(createElement(InkTextConfirmApp, { ...options, onResolve: finish }), renderOptions);
	});
}

export type InkAccountDetailAction = "back" | "delete" | "refresh" | "toggle" | "set-current" | "cancel";

export interface PromptInkAccountDetailsOptions extends InkAuthShellEnvironment {
	account: AuthAccountViewModel;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

export async function promptInkAccountDetails(
	options: PromptInkAccountDetailsOptions,
): Promise<InkAccountDetailAction | null> {
	const account = options.account;
	const action = await promptInkChoice({
		...options,
		title: formatAccountTitle(account),
		panelTitle: "Account Details",
		subtitle: formatAccountSubtitle(account),
		footer: "Up/Down Move | Enter Select | S Use | R Sign In | E Toggle | D Delete | Q Back",
		items: [
			{ value: "back", label: "Back", tone: "muted", hotkeys: ["b"] },
			{
				value: "toggle",
				label: account.enabled === false ? "Enable Account" : "Disable Account",
				detail: account.enabled === false ? "Bring this account back into rotation" : "Keep this account out of rotation until re-enabled",
				tone: account.enabled === false ? "success" : "warning",
				hotkeys: ["e", "t", "x"],
			},
			{
				value: "set-current",
				label: "Set As Current",
				detail: "Switch active selection to this saved account",
				tone: "success",
				hotkeys: ["s"],
			},
			{
				value: "refresh",
				label: "Re-Login",
				detail: "Refresh this account via the OAuth sign-in flow",
				tone: "success",
				hotkeys: ["r"],
			},
			{
				value: "delete",
				label: "Delete Account",
				detail: "Remove this saved account from the current pool",
				tone: "danger",
				hotkeys: ["d"],
			},
		],
		cancelValue: "cancel",
	});
	return (action as InkAccountDetailAction | null) ?? null;
}

export interface PromptInkRestoreForLoginOptions extends InkAuthShellEnvironment {
	reasonText: string;
	snapshotInfo: string;
	snapshotCount: number;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

export async function promptInkRestoreForLogin(
	options: PromptInkRestoreForLoginOptions,
): Promise<boolean | null> {
	const action = await promptInkChoice({
		...options,
		title: "Restore saved accounts before signing in?",
		panelTitle: "Recovery Available",
		subtitle: `${options.reasonText}\n${options.snapshotInfo}`,
		status: "Backup snapshot ready",
		statusTone: "warning",
		footer: "Up/Down Move | Enter Select | R Restore | S Continue | Q Continue",
		items: [
			{
				value: "restore",
				label: `Restore ${options.snapshotCount} saved account${options.snapshotCount === 1 ? "" : "s"}`,
				detail: "Use the latest recovery snapshot before opening the dashboard",
				tone: "success",
				hotkeys: ["r"],
			},
			{
				value: "continue",
				label: "Continue to sign in",
				detail: "Skip restore and open the normal login flow",
				tone: "warning",
				hotkeys: ["s"],
			},
		],
		cancelValue: "continue",
	});
	if (action === null) return null;
	return action === "restore";
}

export interface PromptInkAccountConfirmOptions extends InkAuthShellEnvironment {
	account: AuthAccountViewModel;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

export async function promptInkConfirmAccountRefresh(
	options: PromptInkAccountConfirmOptions,
): Promise<boolean | null> {
	const action = await promptInkChoice({
		...options,
		title: "Confirm Re-Login",
		panelTitle: "Re-Login Account",
		subtitle: `Re-authenticate ${formatAccountTitle(options.account)}?\n${formatAccountSubtitle(options.account)}`,
		status: "OAuth will open next",
		statusTone: "accent",
		footer: "Up/Down Move | Enter Select | R Confirm | Q Back",
		items: [
			{
				value: "refresh",
				label: "Re-Login Now",
				detail: "Start a fresh OAuth sign-in for this account",
				tone: "success",
				hotkeys: ["r"],
			},
			{
				value: "back",
				label: "Go Back",
				detail: "Return to account details without changing anything",
				tone: "muted",
				hotkeys: ["b"],
			},
		],
		cancelValue: "back",
	});
	if (action === null) return null;
	return action === "refresh";
}

export async function promptInkConfirmAccountDelete(
	options: PromptInkAccountConfirmOptions,
): Promise<boolean | null> {
	return await promptInkTextConfirm({
		...options,
		title: "Confirm Account Deletion",
		panelTitle: "Delete Account",
		subtitle: `${formatAccountTitle(options.account)}\n${formatAccountSubtitle(options.account)}`,
		status: "Destructive action",
		statusTone: "danger",
		prompt: "Type DELETE to remove this saved account from the active pool.",
		confirmText: "DELETE",
	});
}

export async function promptInkConfirmDeleteAll(
	options: InkAuthShellEnvironment & {
		stdin?: NodeJS.ReadStream;
		stdout?: NodeJS.WriteStream;
		stderr?: NodeJS.WriteStream;
		debug?: boolean;
		patchConsole?: boolean;
		exitOnCtrlC?: boolean;
	},
): Promise<boolean | null> {
	return await promptInkTextConfirm({
		...options,
		title: "Confirm Delete All Accounts",
		panelTitle: "Delete All Accounts",
		subtitle: "This clears the current saved account pool. Recovery snapshots remain separate.",
		status: "Destructive action",
		statusTone: "danger",
		prompt: "Type DELETE to remove all saved accounts from the active pool.",
		confirmText: "DELETE",
	});
}
