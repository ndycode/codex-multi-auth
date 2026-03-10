import { createElement, type ReactNode } from "react";
import { Box, Text } from "ink";
import { getUiRuntimeOptions } from "../ui/runtime.js";

export type InkShellTone = "normal" | "success" | "warning" | "danger" | "accent" | "muted";

export interface InkShellTheme {
	borderColor: string;
	sectionBorderColor: string;
	headingColor: string;
	textColor: string;
	mutedColor: string;
	accentColor: string;
	successColor: string;
	warningColor: string;
	dangerColor: string;
	focusTextColor: string;
	focusBackgroundColor: string;
}

const GREEN_THEME: InkShellTheme = {
	borderColor: "#22c55e",
	sectionBorderColor: "#15803d",
	headingColor: "#f0fdf4",
	textColor: "#dcfce7",
	mutedColor: "#94a3b8",
	accentColor: "#4ade80",
	successColor: "#4ade80",
	warningColor: "#f59e0b",
	dangerColor: "#ef4444",
	focusTextColor: "#f8fafc",
	focusBackgroundColor: "#166534",
};

const BLUE_THEME: InkShellTheme = {
	borderColor: "#3b82f6",
	sectionBorderColor: "#2563eb",
	headingColor: "#eff6ff",
	textColor: "#dbeafe",
	mutedColor: "#94a3b8",
	accentColor: "#22d3ee",
	successColor: "#60a5fa",
	warningColor: "#f59e0b",
	dangerColor: "#ef4444",
	focusTextColor: "#f8fafc",
	focusBackgroundColor: "#1d4ed8",
};

export function createInkShellTheme(): InkShellTheme {
	const ui = getUiRuntimeOptions();
	return ui.palette === "blue" ? BLUE_THEME : GREEN_THEME;
}

function colorForTone(theme: InkShellTheme, tone: InkShellTone): string {
	switch (tone) {
		case "success":
			return theme.successColor;
		case "warning":
			return theme.warningColor;
		case "danger":
			return theme.dangerColor;
		case "accent":
			return theme.accentColor;
		case "muted":
			return theme.mutedColor;
		default:
			return theme.textColor;
	}
}

export interface InkShellFrameProps {
	title: string;
	subtitle?: string;
	status?: string;
	statusTone?: InkShellTone;
	footer?: string;
	theme: InkShellTheme;
	children?: ReactNode;
}

export function InkShellFrame(props: InkShellFrameProps) {
	return createElement(
		Box,
		{
			flexDirection: "column",
			borderStyle: "round",
			borderColor: props.theme.borderColor,
			paddingX: 1,
			paddingY: 0,
		},
		createElement(
			Box,
			{ justifyContent: "space-between" },
			createElement(Text, { color: props.theme.headingColor, bold: true }, props.title),
			props.status
				? createElement(Text, { color: colorForTone(props.theme, props.statusTone ?? "accent"), bold: true }, props.status)
				: null,
		),
		props.subtitle
			? createElement(Text, { color: props.theme.mutedColor }, props.subtitle)
			: null,
		createElement(Box, { marginTop: 1, flexDirection: "column" }, props.children),
		props.footer
			? createElement(
				Box,
				{ marginTop: 1 },
				createElement(Text, { color: props.theme.mutedColor }, props.footer),
			)
			: null,
	);
}

export interface InkShellSectionTabProps {
	label: string;
	active?: boolean;
	tone?: InkShellTone;
	theme: InkShellTheme;
}

export function InkShellSectionTab(props: InkShellSectionTabProps) {
	if (props.active) {
		return createElement(
			Text,
			{
				backgroundColor: props.theme.focusBackgroundColor,
				color: props.theme.focusTextColor,
				bold: true,
			},
			` ${props.label} `,
		);
	}

	return createElement(
		Text,
		{ color: colorForTone(props.theme, props.tone ?? "muted") },
		` ${props.label} `,
	);
}

export interface InkShellRowProps {
	label: string;
	detail?: string;
	active?: boolean;
	tone?: InkShellTone;
	theme: InkShellTheme;
}

export function InkShellRow(props: InkShellRowProps) {
	const color = colorForTone(props.theme, props.tone ?? "normal");
	if (props.active) {
		return createElement(
			Box,
			{ flexDirection: "column", marginBottom: 1 },
			createElement(
				Text,
				{
					backgroundColor: props.theme.focusBackgroundColor,
					color: props.theme.focusTextColor,
					bold: true,
				},
				` ${props.label} `,
			),
			props.detail
				? createElement(
					Text,
					{ color: props.theme.focusTextColor },
					` ${props.detail}`,
				)
				: null,
		);
	}

	return createElement(
		Box,
		{ flexDirection: "column", marginBottom: 1 },
		createElement(Text, { color }, props.label),
		props.detail
			? createElement(Text, { color: props.theme.mutedColor }, props.detail)
			: null,
	);
}

export interface InkShellPanelProps {
	title: string;
	theme: InkShellTheme;
	children?: ReactNode;
}

export function InkShellPanel(props: InkShellPanelProps) {
	return createElement(
		Box,
		{
			flexDirection: "column",
			borderStyle: "round",
			borderColor: props.theme.sectionBorderColor,
			paddingX: 1,
			paddingY: 0,
		},
		createElement(Text, { color: props.theme.headingColor, bold: true }, props.title),
		createElement(Box, { flexDirection: "column", marginTop: 1 }, props.children),
	);
}
