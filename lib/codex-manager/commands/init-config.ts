import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_MAP = {
	modern: "codex-modern.json",
	legacy: "codex-legacy.json",
	minimal: "minimal-codex.json",
} as const;

type TemplateName = keyof typeof TEMPLATE_MAP;

type ParsedArgs =
	| { ok: true; template: TemplateName; stdout: boolean; writePath?: string }
	| { ok: false; message: string };

function parseArgs(args: string[]): ParsedArgs {
	let template: TemplateName = "modern";
	let stdout = true;
	let writePath: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "modern" || arg === "legacy" || arg === "minimal") {
			template = arg;
			continue;
		}
		if (arg === "--stdout") {
			stdout = true;
			continue;
		}
		if (arg === "--write") {
			const next = args[i + 1];
			if (!next) return { ok: false, message: "Missing value for --write" };
			writePath = next;
			stdout = false;
			i += 1;
			continue;
		}
		if (arg.startsWith("--write=")) {
			const value = arg.slice("--write=".length).trim();
			if (!value) return { ok: false, message: "Missing value for --write" };
			writePath = value;
			stdout = false;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, template, stdout, writePath };
}

export async function runInitConfigCommand(
	args: string[],
	deps?: {
		logInfo?: (message: string) => void;
		logError?: (message: string) => void;
		readTemplate?: (template: TemplateName) => Promise<string>;
		writeTemplate?: (path: string, content: string) => Promise<void>;
		cwd?: () => string;
	},
): Promise<number> {
	const logInfo = deps?.logInfo ?? console.log;
	const logError = deps?.logError ?? console.error;
	const cwd = deps?.cwd?.() ?? process.cwd();

	const parsed = parseArgs(args);
	if (!parsed.ok) {
		logError(parsed.message);
		return 1;
	}

	const readTemplate =
		deps?.readTemplate ??
		(async (template: TemplateName) => {
			const currentFile = fileURLToPath(import.meta.url);
			const currentDir = dirname(currentFile);
			const repoRoot = currentDir.includes(`${sep}dist${sep}`)
				? resolve(currentDir, "../../../../")
				: resolve(currentDir, "../../../");
			const templatePath = resolve(repoRoot, "config", TEMPLATE_MAP[template]);
			return readFile(templatePath, "utf8");
		});

	const writeTemplate =
		deps?.writeTemplate ??
		(async (path: string, content: string) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		});

	let content: string;
	try {
		content = await readTemplate(parsed.template);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to read config template";
		logError(message);
		return 1;
	}

	if (parsed.stdout || !parsed.writePath) {
		logInfo(content.trimEnd());
		return 0;
	}

	const outputPath = resolve(cwd, parsed.writePath);
	await writeTemplate(
		outputPath,
		content.endsWith("\n") ? content : `${content}\n`,
	);
	logInfo(`Wrote ${parsed.template} template to ${outputPath}`);
	return 0;
}
