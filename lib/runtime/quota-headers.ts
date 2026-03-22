export type CodexQuotaWindow = {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
};

export type CodexQuotaSnapshot = {
	status: number;
	planType?: string;
	activeLimit?: number;
	primary: CodexQuotaWindow;
	secondary: CodexQuotaWindow;
};

export function parseFiniteNumberHeader(
	headers: Headers,
	name: string,
): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseFiniteIntHeader(
	headers: Headers,
	name: string,
): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseResetAtMs(
	headers: Headers,
	prefix: string,
): number | undefined {
	const resetAfterSeconds = parseFiniteIntHeader(
		headers,
		`${prefix}-reset-after-seconds`,
	);
	if (
		typeof resetAfterSeconds === "number" &&
		Number.isFinite(resetAfterSeconds) &&
		resetAfterSeconds > 0
	) {
		return Date.now() + resetAfterSeconds * 1000;
	}

	const resetAtRaw = headers.get(`${prefix}-reset-at`);
	if (!resetAtRaw) return undefined;

	const trimmed = resetAtRaw.trim();
	if (/^\d+$/.test(trimmed)) {
		const parsedNumber = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
			return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
		}
	}

	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

export function hasCodexQuotaHeaders(headers: Headers): boolean {
	const keys = [
		"x-codex-primary-used-percent",
		"x-codex-primary-window-minutes",
		"x-codex-primary-reset-at",
		"x-codex-primary-reset-after-seconds",
		"x-codex-secondary-used-percent",
		"x-codex-secondary-window-minutes",
		"x-codex-secondary-reset-at",
		"x-codex-secondary-reset-after-seconds",
	];
	return keys.some((key) => headers.get(key) !== null);
}

export function parseCodexQuotaSnapshot(
	headers: Headers,
	status: number,
): CodexQuotaSnapshot | null {
	if (!hasCodexQuotaHeaders(headers)) return null;

	const primaryPrefix = "x-codex-primary";
	const secondaryPrefix = "x-codex-secondary";
	const primary: CodexQuotaWindow = {
		usedPercent: parseFiniteNumberHeader(
			headers,
			`${primaryPrefix}-used-percent`,
		),
		windowMinutes: parseFiniteIntHeader(
			headers,
			`${primaryPrefix}-window-minutes`,
		),
		resetAtMs: parseResetAtMs(headers, primaryPrefix),
	};
	const secondary: CodexQuotaWindow = {
		usedPercent: parseFiniteNumberHeader(
			headers,
			`${secondaryPrefix}-used-percent`,
		),
		windowMinutes: parseFiniteIntHeader(
			headers,
			`${secondaryPrefix}-window-minutes`,
		),
		resetAtMs: parseResetAtMs(headers, secondaryPrefix),
	};

	const planTypeRaw = headers.get("x-codex-plan-type");
	const planType =
		planTypeRaw && planTypeRaw.trim() ? planTypeRaw.trim() : undefined;
	const activeLimit = parseFiniteIntHeader(headers, "x-codex-active-limit");

	return { status, planType, activeLimit, primary, secondary };
}

export function formatQuotaWindowLabel(
	windowMinutes: number | undefined,
): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

export function formatResetAt(
	resetAtMs: number | undefined,
): string | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0)
		return undefined;
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return undefined;

	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear() &&
		now.getMonth() === date.getMonth() &&
		now.getDate() === date.getDate();

	const time = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	if (sameDay) return time;
	const day = date.toLocaleDateString(undefined, {
		month: "short",
		day: "2-digit",
	});
	return `${time} on ${day}`;
}

export function formatCodexQuotaLine(snapshot: CodexQuotaSnapshot): string {
	const summarizeWindow = (label: string, window: CodexQuotaWindow): string => {
		const used = window.usedPercent;
		const left =
			typeof used === "number" && Number.isFinite(used)
				? Math.max(0, Math.min(100, Math.round(100 - used)))
				: undefined;
		const reset = formatResetAt(window.resetAtMs);
		let summary = label;
		if (left !== undefined) summary = `${summary} ${left}% left`;
		if (reset) summary = `${summary} (resets ${reset})`;
		return summary;
	};

	const primaryLabel = formatQuotaWindowLabel(snapshot.primary.windowMinutes);
	const secondaryLabel = formatQuotaWindowLabel(
		snapshot.secondary.windowMinutes,
	);
	const parts = [
		summarizeWindow(primaryLabel, snapshot.primary),
		summarizeWindow(secondaryLabel, snapshot.secondary),
	];
	if (snapshot.planType) parts.push(`plan:${snapshot.planType}`);
	if (
		typeof snapshot.activeLimit === "number" &&
		Number.isFinite(snapshot.activeLimit)
	) {
		parts.push(`active:${snapshot.activeLimit}`);
	}
	if (snapshot.status === 429) parts.push("rate-limited");
	return parts.join(", ");
}
