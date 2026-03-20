const AUTH_SUBCOMMANDS = new Set([
	"login",
	"list",
	"status",
	"switch",
	"best",
	"check",
	"features",
	"verify-flagged",
	"forecast",
	"report",
	"fix",
	"doctor",
]);
const COMMAND_FLAGS_WITH_VALUE = new Set(["-c", "--config"]);
const HELP_OR_VERSION_FLAGS = new Set(["--help", "-h", "--version"]);

export function normalizeAuthAlias(args) {
	if (args.length >= 2 && args[0] === "multi" && args[1] === "auth") {
		return ["auth", ...args.slice(2)];
	}
	if (args.length >= 1 && (args[0] === "multi-auth" || args[0] === "multiauth")) {
		return ["auth", ...args.slice(1)];
	}
	return args;
}

export function shouldHandleMultiAuthAuth(args) {
	if (args[0] !== "auth") return false;
	if (args.length === 1) return true;
	const subcommand = args[1];
	if (typeof subcommand !== "string") return false;
	if (subcommand.startsWith("-")) return true;
	return AUTH_SUBCOMMANDS.has(subcommand);
}

export function findPrimaryCodexCommand(args) {
	let expectFlagValue = false;
	let stopOptionParsing = false;

	for (let index = 0; index < args.length; index += 1) {
		const normalizedArg = `${args[index] ?? ""}`.trim().toLowerCase();
		if (normalizedArg.length === 0) {
			continue;
		}
		if (expectFlagValue) {
			expectFlagValue = false;
			continue;
		}
		if (!stopOptionParsing && normalizedArg === "--") {
			stopOptionParsing = true;
			continue;
		}
		if (!stopOptionParsing) {
			if (COMMAND_FLAGS_WITH_VALUE.has(normalizedArg)) {
				expectFlagValue = true;
				continue;
			}
			if (normalizedArg.startsWith("--config=")) {
				continue;
			}
			if (normalizedArg.startsWith("-")) {
				continue;
			}
		}
		return {
			command: normalizedArg,
			index,
		};
	}

	return null;
}

export function hasTopLevelHelpOrVersionFlag(args) {
	let expectFlagValue = false;

	for (let index = 0; index < args.length; index += 1) {
		const normalizedArg = `${args[index] ?? ""}`.trim().toLowerCase();
		if (normalizedArg.length === 0) {
			continue;
		}
		if (expectFlagValue) {
			expectFlagValue = false;
			continue;
		}
		if (normalizedArg === "--") {
			return false;
		}
		if (HELP_OR_VERSION_FLAGS.has(normalizedArg)) {
			return true;
		}
		if (COMMAND_FLAGS_WITH_VALUE.has(normalizedArg)) {
			expectFlagValue = true;
			continue;
		}
		if (normalizedArg.startsWith("--config=")) {
			continue;
		}
		if (normalizedArg.startsWith("-")) {
			continue;
		}
		return false;
	}

	return false;
}

export function splitCodexCommandArgs(args) {
	const primaryCommand = findPrimaryCodexCommand(args);
	if (!primaryCommand) {
		return {
			leadingArgs: [...args],
			command: null,
			trailingArgs: [],
		};
	}

	return {
		leadingArgs: args.slice(0, primaryCommand.index),
		command: primaryCommand.command,
		trailingArgs: args.slice(primaryCommand.index + 1),
	};
}

export { AUTH_SUBCOMMANDS };
