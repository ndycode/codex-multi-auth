import type { ConfigExplainReport } from "../../config.js";

export function runConfigExplainCommand(
	args: string[],
	deps: {
		getReport: () => ConfigExplainReport;
		logInfo?: (message: string) => void;
		logError?: (message: string) => void;
	},
): number {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const json = args.includes("--json");
	const unknown = args.filter((arg) => arg !== "--json");
	if (unknown.length > 0) {
		logError(`Unknown option: ${unknown[0]}`);
		return 1;
	}

	const report = deps.getReport();
	if (json) {
		logInfo(JSON.stringify(report, null, 2));
		return 0;
	}

	logInfo(`Config storage: ${report.storageKind}`);
	logInfo(`Config path: ${report.configPath ?? "(none)"}`);
	logInfo("");
	for (const entry of report.entries) {
		const envSuffix =
			entry.envNames.length > 0 ? ` [${entry.envNames.join(", ")}]` : "";
		logInfo(
			`${entry.key} = ${JSON.stringify(entry.value)} (${entry.source})${envSuffix}`,
		);
	}
	return 0;
}
