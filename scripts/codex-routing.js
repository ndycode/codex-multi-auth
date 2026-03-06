const AUTH_SUBCOMMANDS = new Set([
	"login",
	"list",
	"status",
	"switch",
	"check",
	"features",
	"verify-flagged",
	"forecast",
	"report",
	"fix",
	"doctor",
	"rotate-secrets",
	"telemetry",
]);

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

export { AUTH_SUBCOMMANDS };
