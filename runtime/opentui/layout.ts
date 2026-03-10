export interface ShellMetrics {
	compact: boolean;
	width: number;
	height: number;
	headerHeight: number;
	footerHeight: number;
	mainHeight: number;
	navWidth: number;
	navHeight: number;
	contentWidth: number;
	contentHeight: number;
	layoutLabel: string;
	navInnerWidth: number;
	navInnerHeight: number;
	contentInnerWidth: number;
	contentInnerHeight: number;
}

export function truncateText(value: string, width: number): string {
	if (width <= 0) return "";
	if (value.length <= width) return value;
	if (width <= 3) return value.slice(0, width);
	return `${value.slice(0, width - 3)}...`;
}

export function wrapText(value: string, width: number): string[] {
	if (width <= 0) return [""];
	const words = value.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];

	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			for (let offset = 0; offset < word.length; offset += width) {
				lines.push(word.slice(offset, offset + width));
			}
			continue;
		}

		const next = current ? `${current} ${word}` : word;
		if (next.length <= width) {
			current = next;
			continue;
		}

		if (current) lines.push(current);
		current = word;
	}

	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

export function measureShell(width: number, height: number): ShellMetrics {
	const compact = width < 60 || height < 18;
	const headerHeight = compact ? 2 : 3;
	const footerHeight = compact ? 2 : 3;
	const mainHeight = Math.max(6, height - headerHeight - footerHeight);
	const navWidth = compact ? width : Math.max(18, Math.min(28, Math.floor(width * 0.28)));
	const navHeight = compact
		? Math.max(3, Math.min(6, Math.max(3, mainHeight - 5)))
		: mainHeight;
	const contentWidth = compact ? width : Math.max(18, width - navWidth - 1);
	const contentHeight = compact
		? Math.max(2, mainHeight - navHeight - 1)
		: mainHeight;

	return {
		compact,
		width,
		height,
		headerHeight,
		footerHeight,
		mainHeight,
		navWidth,
		navHeight,
		contentWidth,
		contentHeight,
		layoutLabel: compact ? "compact stack" : "wide split",
		navInnerWidth: Math.max(10, navWidth - 4),
		navInnerHeight: Math.max(3, navHeight - 2),
		contentInnerWidth: Math.max(16, contentWidth - 4),
		contentInnerHeight: Math.max(4, contentHeight - 2),
	};
}
