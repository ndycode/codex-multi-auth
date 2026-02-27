import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import {
	tool,
	type ToolContext,
	type ToolDefinition,
} from "@codex-ai/plugin/tool";

const HASHLINE_REF_REGEX = /^L([1-9]\d*)#([a-f0-9]{8})$/i;
const DEFAULT_WINDOW_LINES = 120;
const MAX_WINDOW_LINES = 400;
const LINE_PREVIEW_LIMIT = 240;
const LEGACY_TEMPLATE_PLACEHOLDER_REGEX =
	/\$\{[^}]*\b(?:TARGET_[A-Z0-9_]*|ORIGINAL_LINES|SNIPPET|START_LINE|END_LINE)\b[^}]*\}/;

type HashlineOperation =
	| "replace"
	| "insert_before"
	| "insert_after"
	| "delete";

const HASHLINE_OPERATIONS = new Set<HashlineOperation>([
	"replace",
	"insert_before",
	"insert_after",
	"delete",
]);

export interface ParsedHashlineRef {
	lineNumber: number;
	hash: string;
	raw: string;
}

interface NormalizedFileText {
	lines: string[];
	eol: string;
	hadTrailingNewline: boolean;
}

type HashlineEditFailure = {
	ok: false;
	message: string;
};

type HashlineEditSuccess = {
	ok: true;
	updatedContent: string;
	operation: HashlineOperation;
	changedStartLine: number;
	changedEndLine: number;
};

type HashlineEditResult = HashlineEditFailure | HashlineEditSuccess;

type LegacyEditFailure = {
	ok: false;
	message: string;
};

type LegacyEditSuccess = {
	ok: true;
	updatedContent: string;
	replacements: number;
};

type LegacyEditResult = LegacyEditFailure | LegacyEditSuccess;

type HashlineEditArgs = {
	lineRef?: string;
	endLineRef?: string;
	operation?: string;
	content?: string;
	newString?: string;
};

type LegacyEditArgs = {
	oldString?: string;
	newString?: string;
	replaceAll?: boolean;
};

type EditToolArgs = {
	path: string;
	oldString?: string;
	newString?: string;
	replaceAll?: boolean;
	lineRef?: string;
	endLineRef?: string;
	operation?: string;
	content?: string;
};

function normalizeFileText(content: string): NormalizedFileText {
	const normalized = content.replace(/\r\n/g, "\n");
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	if (normalized.length === 0) {
		return { lines: [], eol, hadTrailingNewline: false };
	}

	const hadTrailingNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (hadTrailingNewline) {
		lines.pop();
	}

	return { lines, eol, hadTrailingNewline };
}

function denormalizeFileText(value: NormalizedFileText): string {
	if (value.lines.length === 0) return "";
	const joined = value.lines.join(value.eol);
	return value.hadTrailingNewline ? `${joined}${value.eol}` : joined;
}

function splitInsertText(value: string): string[] {
	const normalized = value.replace(/\r\n/g, "\n");
	if (normalized.length === 0) return [];
	const trailing = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (trailing) {
		lines.pop();
	}
	return lines;
}

function clipLine(text: string): string {
	if (text.length <= LINE_PREVIEW_LIMIT) return text;
	return `${text.slice(0, LINE_PREVIEW_LIMIT - 3)}...`;
}

function findUnresolvedLegacyPlaceholder(value: string): string | null {
	const match = LEGACY_TEMPLATE_PLACEHOLDER_REGEX.exec(value);
	return match?.[0] ?? null;
}

function parseOperation(value: string | undefined): HashlineOperation | null {
	const normalized = (value ?? "replace").trim().toLowerCase();
	if (HASHLINE_OPERATIONS.has(normalized as HashlineOperation)) {
		return normalized as HashlineOperation;
	}
	return null;
}

function resolveToolPath(pathValue: string, context: ToolContext): string {
	const trimmed = pathValue.trim();
	if (!trimmed) {
		throw new Error("path is required");
	}
	const baseDir = context.directory || process.cwd();
	return normalize(isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed));
}

function toDisplayPath(absolutePath: string, context: ToolContext): string {
	const root = context.worktree || context.directory || process.cwd();
	const rel = relative(root, absolutePath);
	if (!rel || rel.startsWith("..")) {
		return absolutePath;
	}
	return rel.replace(/\\/g, "/");
}

async function askFilePermission(
	context: ToolContext,
	permission: string,
	absolutePath: string,
): Promise<void> {
	await context.ask({
		permission,
		patterns: [absolutePath],
		always: [absolutePath],
		metadata: { path: absolutePath },
	});
}

function resolveHashlineRef(
	lines: string[],
	ref: ParsedHashlineRef,
	label: "lineRef" | "endLineRef",
): { ok: true; index: number } | { ok: false; message: string } {
	if (ref.lineNumber > lines.length) {
		return {
			ok: false,
			message: `${label} is out of range (${ref.raw}). File has ${lines.length} line(s).`,
		};
	}
	const index = ref.lineNumber - 1;
	const line = lines[index];
	if (line === undefined) {
		return {
			ok: false,
			message: `${label} is out of range (${ref.raw}).`,
		};
	}
	const currentHash = computeHashline(line);
	if (currentHash !== ref.hash) {
		return {
			ok: false,
			message:
				`${label} hash mismatch at line ${ref.lineNumber}. ` +
				`Expected ${ref.hash}, found ${currentHash}. ` +
				`Current ref: ${formatHashlineRef(ref.lineNumber, line)}`,
		};
	}
	return { ok: true, index };
}

function buildUpdatedRefs(
	content: string,
	startLine: number,
	endLine: number,
): string[] {
	const normalized = normalizeFileText(content);
	if (normalized.lines.length === 0) {
		return [];
	}
	const safeStart = Math.max(1, Math.min(startLine, normalized.lines.length));
	const safeEnd = Math.max(
		safeStart,
		Math.min(endLine, normalized.lines.length),
	);
	const refs: string[] = [];
	for (let lineNumber = safeStart; lineNumber <= safeEnd; lineNumber += 1) {
		const line = normalized.lines[lineNumber - 1];
		if (line === undefined) continue;
		refs.push(`${formatHashlineRef(lineNumber, line)} | ${clipLine(line)}`);
	}
	return refs;
}

export function computeHashline(text: string): string {
	return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 8);
}

export function formatHashlineRef(lineNumber: number, text: string): string {
	return `L${lineNumber}#${computeHashline(text)}`;
}

export function parseHashlineRef(value: string): ParsedHashlineRef | null {
	const raw = value.trim();
	const match = HASHLINE_REF_REGEX.exec(raw);
	if (!match) return null;

	const lineNumber = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;

	const hash = (match[2] ?? "").toLowerCase();
	return { lineNumber, hash, raw };
}

export function renderHashlineSlice(
	content: string,
	startLine = 1,
	maxLines = DEFAULT_WINDOW_LINES,
): string {
	const normalized = normalizeFileText(content);
	if (normalized.lines.length === 0) {
		return "File is empty.";
	}

	const safeStartLine = Math.max(1, Math.floor(startLine));
	const safeMaxLines = Math.max(1, Math.min(MAX_WINDOW_LINES, Math.floor(maxLines)));
	const startIndex = Math.min(normalized.lines.length - 1, safeStartLine - 1);
	const endIndex = Math.min(
		normalized.lines.length - 1,
		startIndex + safeMaxLines - 1,
	);

	const lines: string[] = [
		`Hashline window ${startIndex + 1}-${endIndex + 1} of ${normalized.lines.length}:`,
		"",
	];

	for (let index = startIndex; index <= endIndex; index += 1) {
		const lineText = normalized.lines[index] ?? "";
		lines.push(
			`${formatHashlineRef(index + 1, lineText)} | ${clipLine(lineText)}`,
		);
	}

	if (endIndex < normalized.lines.length - 1) {
		lines.push("");
		lines.push(`... ${normalized.lines.length - endIndex - 1} more line(s).`);
	}

	return lines.join("\n");
}

export function applyLegacyEdit(
	content: string,
	args: LegacyEditArgs,
): LegacyEditResult {
	const oldString = args.oldString;
	if (typeof oldString !== "string" || oldString.length === 0) {
		return {
			ok: false,
			message:
				"Legacy edit requires non-empty oldString. For hashline mode, use lineRef.",
		};
	}

	const unresolvedPlaceholder = findUnresolvedLegacyPlaceholder(oldString);
	if (unresolvedPlaceholder) {
		return {
			ok: false,
			message:
				`oldString contains unresolved template placeholder ${unresolvedPlaceholder}. ` +
				"Use literal file text for oldString, or prefer hashline_read + lineRef/endLineRef.",
		};
	}

	const newString = args.newString ?? "";
	if (args.replaceAll) {
		const parts = content.split(oldString);
		const replacements = parts.length - 1;
		if (replacements === 0) {
			return {
				ok: false,
				message: "oldString not found.",
			};
		}
		return {
			ok: true,
			updatedContent: parts.join(newString),
			replacements,
		};
	}

	const firstIndex = content.indexOf(oldString);
	if (firstIndex === -1) {
		return {
			ok: false,
			message: "oldString not found.",
		};
	}

	const secondIndex = content.indexOf(oldString, firstIndex + oldString.length);
	if (secondIndex !== -1) {
		return {
			ok: false,
			message:
				"oldString appears multiple times. Use replaceAll=true or hashline mode.",
		};
	}

	return {
		ok: true,
		updatedContent:
			content.slice(0, firstIndex) +
			newString +
			content.slice(firstIndex + oldString.length),
		replacements: 1,
	};
}

export function applyHashlineEdit(
	content: string,
	args: HashlineEditArgs,
): HashlineEditResult {
	if (!args.lineRef) {
		return {
			ok: false,
			message: "lineRef is required for hashline edit mode.",
		};
	}

	const lineRef = parseHashlineRef(args.lineRef);
	if (!lineRef) {
		return {
			ok: false,
			message: `Invalid lineRef format: ${args.lineRef}. Expected L<line>#<hash>.`,
		};
	}

	const endLineRef = args.endLineRef
		? parseHashlineRef(args.endLineRef)
		: lineRef;
	if (!endLineRef) {
		return {
			ok: false,
			message: `Invalid endLineRef format: ${args.endLineRef}. Expected L<line>#<hash>.`,
		};
	}

	if (endLineRef.lineNumber < lineRef.lineNumber) {
		return {
			ok: false,
			message: "endLineRef must be on or after lineRef.",
		};
	}

	const operation = parseOperation(args.operation);
	if (!operation) {
		return {
			ok: false,
			message:
				"Invalid operation. Use one of: replace, insert_before, insert_after, delete.",
		};
	}

	const normalized = normalizeFileText(content);
	const lines = [...normalized.lines];

	const resolvedStart = resolveHashlineRef(lines, lineRef, "lineRef");
	if (!resolvedStart.ok) return resolvedStart;
	const resolvedEnd = resolveHashlineRef(lines, endLineRef, "endLineRef");
	if (!resolvedEnd.ok) return resolvedEnd;

	const startIndex = resolvedStart.index;
	const endIndex = resolvedEnd.index;
	const rangeLength = endIndex - startIndex + 1;
	const nextText = args.content ?? args.newString ?? "";
	const insertLines = splitInsertText(nextText);

	if (
		(operation === "insert_before" || operation === "insert_after") &&
		insertLines.length === 0
	) {
		return {
			ok: false,
			message: `content is required for ${operation}.`,
		};
	}

	let changedStartLine = lineRef.lineNumber;
	let changedEndLine = lineRef.lineNumber;

	switch (operation) {
		case "replace":
			lines.splice(startIndex, rangeLength, ...insertLines);
			changedStartLine = lineRef.lineNumber;
			changedEndLine =
				insertLines.length > 0
					? lineRef.lineNumber + insertLines.length - 1
					: Math.max(1, lineRef.lineNumber - 1);
			break;
		case "delete":
			lines.splice(startIndex, rangeLength);
			changedStartLine = Math.max(1, lineRef.lineNumber - 1);
			changedEndLine = changedStartLine;
			break;
		case "insert_before":
			lines.splice(startIndex, 0, ...insertLines);
			changedStartLine = lineRef.lineNumber;
			changedEndLine = lineRef.lineNumber + insertLines.length - 1;
			break;
		case "insert_after":
			lines.splice(startIndex + 1, 0, ...insertLines);
			changedStartLine = lineRef.lineNumber + 1;
			changedEndLine = lineRef.lineNumber + insertLines.length;
			break;
	}

	return {
		ok: true,
		updatedContent: denormalizeFileText({
			lines,
			eol: normalized.eol,
			hadTrailingNewline:
				lines.length > 0 ? normalized.hadTrailingNewline : false,
		}),
		operation,
		changedStartLine,
		changedEndLine,
	};
}

export function createHashlineReadTool(): ToolDefinition {
	return tool({
		description:
			"Read file lines with hashline refs (L<line>#<hash>) for precise hash-verified edits.",
		args: {
			path: tool.schema
				.string()
				.describe("File path (absolute or relative to session directory)."),
			startLine: tool.schema
				.number()
				.optional()
				.describe("1-based line to start from (default: 1)."),
			maxLines: tool.schema
				.number()
				.optional()
				.describe("Maximum lines to return (default: 120, max: 400)."),
		},
		async execute({ path, startLine, maxLines }, context) {
			const absolutePath = resolveToolPath(path, context);
			await askFilePermission(context, "read", absolutePath);

			let content: string;
			try {
				content = await readFile(absolutePath, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Failed to read ${absolutePath}: ${message}`;
			}

			const displayPath = toDisplayPath(absolutePath, context);
			return [
				`File: ${displayPath}`,
				renderHashlineSlice(
					content,
					startLine ?? 1,
					maxLines ?? DEFAULT_WINDOW_LINES,
				),
			].join("\n");
		},
	});
}

export function createHashlineEditTool(): ToolDefinition {
	return tool({
		description:
			"Edit files with hashline refs for deterministic line-safe edits. Supports legacy oldString/newString fallback.",
		args: {
			path: tool.schema
				.string()
				.describe("File path (absolute or relative to session directory)."),
			oldString: tool.schema
				.string()
				.optional()
				.describe("Legacy mode: exact text to replace."),
			newString: tool.schema
				.string()
				.optional()
				.describe(
					"Legacy mode replacement text, or replacement body for hashline replace.",
				),
			replaceAll: tool.schema
				.boolean()
				.optional()
				.describe("Legacy mode: replace every match of oldString."),
			lineRef: tool.schema
				.string()
				.optional()
				.describe("Hashline mode anchor in format L<line>#<hash>."),
			endLineRef: tool.schema
				.string()
				.optional()
				.describe("Optional hashline end anchor for range replace/delete."),
			operation: tool.schema
				.string()
				.optional()
				.describe("Hashline mode operation: replace | insert_before | insert_after | delete."),
			content: tool.schema
				.string()
				.optional()
				.describe("Hashline mode content for replace/insert operations."),
		},
		async execute(args: EditToolArgs, context) {
			const absolutePath = resolveToolPath(args.path, context);
			await askFilePermission(context, "read", absolutePath);
			await askFilePermission(context, "edit", absolutePath);

			let originalContent: string;
			try {
				originalContent = await readFile(absolutePath, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Failed to read ${absolutePath}: ${message}`;
			}

			const hashlineMode = Boolean(
				args.lineRef || args.endLineRef || args.operation || args.content,
			);
			const displayPath = toDisplayPath(absolutePath, context);

			if (hashlineMode) {
				const result = applyHashlineEdit(originalContent, {
					lineRef: args.lineRef,
					endLineRef: args.endLineRef,
					operation: args.operation,
					content: args.content,
					newString: args.newString,
				});
				if (!result.ok) {
					return result.message;
				}
				if (result.updatedContent === originalContent) {
					return "No changes applied.";
				}

				try {
					await writeFile(absolutePath, result.updatedContent, "utf8");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return `Failed to write ${absolutePath}: ${message}`;
				}

				const refs = buildUpdatedRefs(
					result.updatedContent,
					result.changedStartLine,
					result.changedEndLine,
				);
				const responseLines = [
					`Updated ${displayPath} using hashline ${result.operation}.`,
				];
				if (refs.length > 0) {
					responseLines.push("Updated refs:");
					responseLines.push(...refs);
				}
				return responseLines.join("\n");
			}

			const legacyResult = applyLegacyEdit(originalContent, {
				oldString: args.oldString,
				newString: args.newString,
				replaceAll: args.replaceAll,
			});
			if (!legacyResult.ok) {
				return legacyResult.message;
			}
			if (legacyResult.updatedContent === originalContent) {
				return "No changes applied.";
			}

			try {
				await writeFile(absolutePath, legacyResult.updatedContent, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Failed to write ${absolutePath}: ${message}`;
			}

			const suffix = legacyResult.replacements === 1 ? "" : "s";
			return `Updated ${displayPath} using legacy edit (${legacyResult.replacements} replacement${suffix}).`;
		},
	});
}

