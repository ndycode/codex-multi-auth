import type { DashboardAccountSortMode } from "../dashboard-settings.js";

export function formatDashboardSettingState(value: boolean): string {
	return value ? "[x]" : "[ ]";
}

export function formatMenuSortMode(mode: DashboardAccountSortMode): string {
	return mode === "ready-first" ? "Ready-First" : "Manual";
}

export function formatMenuLayoutMode(
	mode: "compact-details" | "expanded-rows",
): string {
	return mode === "expanded-rows" ? "Expanded Rows" : "Compact + Details Pane";
}

export function formatMenuQuotaTtl(ttlMs: number): string {
	if (ttlMs >= 60_000 && ttlMs % 60_000 === 0) {
		return `${Math.round(ttlMs / 60_000)}m`;
	}
	if (ttlMs >= 1_000 && ttlMs % 1_000 === 0) {
		return `${Math.round(ttlMs / 1_000)}s`;
	}
	return `${ttlMs}ms`;
}
