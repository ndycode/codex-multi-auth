import { RUNTIME_ROTATION_PROXY_PROVIDER_ID } from "../runtime-constants.js";

export function tomlStringLiteral(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function readTomlTableName(line: string): string | null {
	const match = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$/.exec(line);
	return match?.[1]?.trim() ?? null;
}

export function removeRuntimeRotationProviderBlock(rawConfig: string): string {
	const lines = rawConfig.split(/\r?\n/);
	const output: string[] = [];
	let skipping = false;
	const providerTable = `model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}`;
	for (const line of lines) {
		const tableName = readTomlTableName(line);
		if (tableName === providerTable) {
			skipping = true;
			continue;
		}
		if (skipping && tableName) {
			if (tableName === providerTable || tableName.startsWith(`${providerTable}.`)) {
				continue;
			}
			skipping = false;
		}
		if (!skipping) output.push(line);
	}
	return output.join(rawConfig.includes("\r\n") ? "\r\n" : "\n");
}

export function rewriteTopLevelModelProvider(rawConfig: string): string {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	const lines = rawConfig.length > 0 ? rawConfig.split(/\r?\n/) : [];
	const rewrittenLine = `model_provider = ${tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`;
	let replaced = false;
	const output: string[] = [];

	for (const line of lines) {
		const isTable = readTomlTableName(line) !== null;
		if (!replaced && isTable) {
			output.push(rewrittenLine);
			replaced = true;
		}
		if (!replaced && /^\s*model_provider\s*=/.test(line)) {
			output.push(rewrittenLine);
			replaced = true;
			continue;
		}
		output.push(line);
	}

	if (!replaced) output.push(rewrittenLine);
	return output.join(lineEnding);
}

function extractTopLevelModelProviderLine(rawConfig: string): string | null {
	for (const line of rawConfig.split(/\r?\n/)) {
		if (readTomlTableName(line) !== null) return null;
		if (/^\s*model_provider\s*=/.test(line)) return line;
	}
	return null;
}

export function restoreTopLevelModelProvider(
	currentConfig: string,
	originalConfig: string,
): string {
	const lineEnding = currentConfig.includes("\r\n") ? "\r\n" : "\n";
	const originalLine = extractTopLevelModelProviderLine(originalConfig);
	const lines = currentConfig.length > 0 ? currentConfig.split(/\r?\n/) : [];
	const output: string[] = [];
	let handled = false;

	for (const line of lines) {
		const isRuntimeProviderLine =
			/^\s*model_provider\s*=/.test(line) &&
			line.includes(RUNTIME_ROTATION_PROXY_PROVIDER_ID);
		if (isRuntimeProviderLine && !handled) {
			if (originalLine) output.push(originalLine);
			handled = true;
			continue;
		}
		output.push(line);
	}

	return output.join(lineEnding);
}

export function ensureTomlTrailingNewline(value: string): string {
	return value.replace(/[\r\n]*$/, "\n");
}

export function createRuntimeRotationProviderBlock(
	baseUrl: string,
	clientApiKey = "",
): string[] {
	const lines = [
		`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`,
		'name = "codex-multi-auth"',
		`base_url = ${tomlStringLiteral(baseUrl)}`,
		"requires_openai_auth = false",
		'wire_api = "responses"',
	];
	if (clientApiKey.trim().length > 0) {
		lines.splice(
			4,
			0,
			`experimental_bearer_token = ${tomlStringLiteral(clientApiKey)}`,
		);
	}
	return lines;
}

export function rewriteConfigTomlForRuntimeRotationProvider(
	rawConfig: string,
	baseUrl: string,
	clientApiKey = "",
): string {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	const withoutOldProvider = removeRuntimeRotationProviderBlock(rawConfig).replace(
		/[\r\n]*$/,
		"",
	);
	const withModelProvider = rewriteTopLevelModelProvider(withoutOldProvider).replace(
		/[\r\n]*$/,
		"",
	);
	const providerBlock = createRuntimeRotationProviderBlock(
		baseUrl,
		clientApiKey,
	).join(lineEnding);
	return `${withModelProvider}${lineEnding}${lineEnding}${providerBlock}${lineEnding}`;
}

export function restoreConfigTomlFromRuntimeRotationProvider(
	currentConfig: string,
	originalConfig: string,
): string {
	const withoutProvider = removeRuntimeRotationProviderBlock(currentConfig);
	return ensureTomlTrailingNewline(
		restoreTopLevelModelProvider(withoutProvider, originalConfig).replace(
			/[\r\n]*$/,
			"",
		),
	);
}
