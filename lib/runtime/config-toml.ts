import { RUNTIME_ROTATION_PROXY_PROVIDER_ID } from "../runtime-constants.js";

export function tomlStringLiteral(value: string): string {
	return `"${value.replace(/[\u0000-\u001f\u007f\\"]/g, (character) => {
		switch (character) {
			case "\b":
				return "\\b";
			case "\t":
				return "\\t";
			case "\n":
				return "\\n";
			case "\f":
				return "\\f";
			case "\r":
				return "\\r";
			case '"':
				return '\\"';
			case "\\":
				return "\\\\";
			default:
				return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
		}
	})}"`;
}

function readTomlTableName(line: string): string | null {
	const match = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$/.exec(line);
	return match?.[1]?.trim() ?? null;
}

function removeRuntimeRotationProviderBlock(rawConfig: string): string {
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

function rewriteTopLevelModelProvider(rawConfig: string): string {
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

function enableTopLevelResponseStorage(rawConfig: string): string {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	const lines = rawConfig.length > 0 ? rawConfig.split(/\r?\n/) : [];
	const output: string[] = [];
	let inTopLevel = true;

	for (const line of lines) {
		if (readTomlTableName(line) !== null) {
			inTopLevel = false;
			output.push(line);
			continue;
		}
		if (
			inTopLevel &&
			/^\s*disable_response_storage\s*=\s*true\s*(?:#.*)?$/i.test(line)
		) {
			output.push("disable_response_storage = false");
			continue;
		}
		output.push(line);
	}

	return output.join(lineEnding);
}

function extractTopLevelLine(rawConfig: string, key: string): string | null {
	const pattern = new RegExp(`^\\s*${key}\\s*=`);
	for (const line of rawConfig.split(/\r?\n/)) {
		if (readTomlTableName(line) !== null) return null;
		if (pattern.test(line)) return line;
	}
	return null;
}

function extractTopLevelModelProviderLine(rawConfig: string): string | null {
	return extractTopLevelLine(rawConfig, "model_provider");
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

	if (!handled && originalLine) {
		// Splice the restored line into the root table — appending at tail
		// would land it inside whatever section appears last in `output`.
		const firstSectionIdx = output.findIndex(
			(line) => readTomlTableName(line) !== null,
		);
		if (firstSectionIdx === -1) {
			output.push(originalLine);
		} else {
			output.splice(firstSectionIdx, 0, originalLine);
		}
	}

	return output.join(lineEnding);
}

export function restoreTopLevelResponseStorage(
	currentConfig: string,
	originalConfig: string,
): string {
	const lineEnding = currentConfig.includes("\r\n") ? "\r\n" : "\n";
	const originalLine = extractTopLevelLine(
		originalConfig,
		"disable_response_storage",
	);
	const lines = currentConfig.length > 0 ? currentConfig.split(/\r?\n/) : [];
	const output: string[] = [];
	let handled = false;
	let inTopLevel = true;

	for (const line of lines) {
		if (readTomlTableName(line) !== null) {
			inTopLevel = false;
			output.push(line);
			continue;
		}
		if (
			!handled &&
			inTopLevel &&
			/^\s*disable_response_storage\s*=/.test(line) &&
			readTomlTableName(line) === null
		) {
			if (originalLine) {
				output.push(originalLine);
			}
			// If no originalLine, drop the line we wrote during bind (removing residue)
			handled = true;
			continue;
		}
		output.push(line);
	}

	if (!handled && originalLine) {
		// Mirror restoreTopLevelModelProvider: when the bind-written line was
		// stripped from currentConfig before unbind, the user's original
		// setting must still come back into the root table. Splice it before
		// the first section header instead of appending at tail (a tail
		// append would land it inside whatever section comes last).
		const firstSectionIdx = output.findIndex(
			(line) => readTomlTableName(line) !== null,
		);
		if (firstSectionIdx === -1) {
			output.push(originalLine);
		} else {
			output.splice(firstSectionIdx, 0, originalLine);
		}
	}

	return output.join(lineEnding);
}

function ensureTomlTrailingNewline(value: string): string {
	return value.replace(/[\r\n]*$/, "\n");
}

function createRuntimeRotationProviderBlock(
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
	const withResponseStorage = enableTopLevelResponseStorage(
		withModelProvider,
	).replace(/[\r\n]*$/, "");
	const providerBlock = createRuntimeRotationProviderBlock(
		baseUrl,
		clientApiKey,
	).join(lineEnding);
	return `${withResponseStorage}${lineEnding}${lineEnding}${providerBlock}${lineEnding}`;
}

export function restoreConfigTomlFromRuntimeRotationProvider(
	currentConfig: string,
	originalConfig: string,
): string {
	const withoutProvider = removeRuntimeRotationProviderBlock(currentConfig);
	const withResponseStorage = restoreTopLevelResponseStorage(
		withoutProvider,
		originalConfig,
	);
	return ensureTomlTrailingNewline(
		restoreTopLevelModelProvider(withResponseStorage, originalConfig).replace(
			/[\r\n]*$/,
			"",
		),
	);
}
