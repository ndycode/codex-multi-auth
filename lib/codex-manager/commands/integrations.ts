import {
	generateIntegrationSnippets,
	type IntegrationSnippetKind,
} from "../../integration-generators.js";

export interface IntegrationsCommandDeps {
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

const VALID_KINDS = new Set<IntegrationSnippetKind>([
	"opencode",
	"openclaw",
	"python",
	"curl",
	"env",
]);

function printUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex-multi-auth integrations [--kind <name>] [--base-url <url>] [--model <model>] [--json]",
			"",
			"Kinds: opencode, openclaw, python, curl, env",
		].join("\n"),
	);
}

export function runIntegrationsCommand(
	args: string[],
	deps: IntegrationsCommandDeps = {},
): number {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printUsage(logInfo);
		return 0;
	}
	const kinds: IntegrationSnippetKind[] = [];
	let baseUrl: string | undefined;
	let model: string | undefined;
	let json = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--json" || arg === "-j") {
			json = true;
			continue;
		}
		if (arg === "--kind") {
			const value = args[i + 1];
			if (!value || !VALID_KINDS.has(value as IntegrationSnippetKind)) {
				logError("Missing or invalid value for --kind");
				return 1;
			}
			kinds.push(value as IntegrationSnippetKind);
			i += 1;
			continue;
		}
		if (arg === "--base-url") {
			const value = args[i + 1];
			if (!value) {
				logError("Missing value for --base-url");
				return 1;
			}
			baseUrl = value;
			i += 1;
			continue;
		}
		if (arg === "--model") {
			const value = args[i + 1]?.trim();
			if (!value || value.startsWith("-")) {
				logError("Missing value for --model");
				return 1;
			}
			model = value;
			i += 1;
			continue;
		}
		logError(`Unknown integrations option: ${arg ?? ""}`);
		return 1;
	}
	const snippets = generateIntegrationSnippets(
		kinds.length > 0 ? kinds : undefined,
		{ baseUrl, model },
	);
	if (json) {
		logInfo(JSON.stringify({ command: "integrations", snippets }, null, 2));
		return 0;
	}
	for (const snippet of snippets) {
		logInfo(`# ${snippet.title}`);
		logInfo(snippet.body);
	}
	return 0;
}
