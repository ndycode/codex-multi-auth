const MAX_LABEL_VISIBLE_CHARS = 72;

const ANSI_CSI_SEQUENCE_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_SEQUENCE_REGEX = /\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1b[@-Z\\-_]/g;
const CONTROL_CHARACTER_REGEX = /[\u0000-\u001f\u007f]/g;

type TerminalStream = Pick<NodeJS.WriteStream, "isTTY" | "write">;

function stripTerminalSequences(value: string): string {
	return value
		.replace(ANSI_OSC_SEQUENCE_REGEX, " ")
		.replace(ANSI_CSI_SEQUENCE_REGEX, " ")
		.replace(ANSI_ESCAPE_SEQUENCE_REGEX, " ")
		.replace(CONTROL_CHARACTER_REGEX, (char) => (/\s/.test(char) ? " " : ""));
}

function truncateVisibleText(value: string, maxVisibleChars: number): string {
	if (maxVisibleChars <= 0) return "";
	const visibleChars = Array.from(value);
	if (visibleChars.length <= maxVisibleChars) {
		return value;
	}
	if (maxVisibleChars <= 3) {
		return ".".repeat(maxVisibleChars);
	}
	return `${visibleChars.slice(0, maxVisibleChars - 3).join("").trimEnd()}...`;
}

export function sanitizeDirectCliInjectionLabel(
	label: string,
	maxVisibleChars: number = MAX_LABEL_VISIBLE_CHARS,
): string {
	const normalized = stripTerminalSequences(String(label))
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return "";
	return truncateVisibleText(normalized, maxVisibleChars);
}

export function formatDirectCliInjectionSignal(label: string): string {
	const sanitized = sanitizeDirectCliInjectionLabel(label);
	return sanitized.length > 0 ? `${sanitized} injected` : "injected";
}

function writeToStream(stream: TerminalStream | undefined, text: string): boolean {
	if (!stream?.isTTY) return false;
	try {
		stream.write(text);
		return true;
	} catch {
		return false;
	}
}

function writeTerminalTitle(stream: TerminalStream | undefined, text: string): boolean {
	return writeToStream(stream, `\x1b]0;${text}\x07`);
}

function writeBanner(stream: TerminalStream | undefined, text: string): boolean {
	return writeToStream(stream, `${text}\n`);
}

export function announceDirectCliInjection(
	label: string,
	options: {
		banner?: boolean;
		title?: boolean;
		bannerStream?: TerminalStream;
		titleStream?: TerminalStream;
	} = {},
): boolean {
	const signal = formatDirectCliInjectionSignal(label);
	let wrote = false;

	if (options.banner !== false) {
		wrote = writeBanner(options.bannerStream ?? process.stderr, signal) || wrote;
	}
	if (options.title !== false) {
		wrote = writeTerminalTitle(options.titleStream ?? process.stdout, signal) || wrote;
	}

	return wrote;
}
