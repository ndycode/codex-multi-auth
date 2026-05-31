const AUTH_SUBCOMMANDS = new Set([
	"login",
	"list",
	"status",
	"switch",
	"unpin",
	"workspace",
	"best",
	"check",
	"features",
	"usage",
	"verify-flagged",
	"verify",
	"forecast",
	"report",
	"fix",
	"doctor",
	"uninstall",
	"account",
	"budget",
	"bridge",
	"integrations",
	"models",
	"monitor",
	"rotation",
	"why-selected",
	"config",
	"init-config",
	"debug",
]);

/**
 * @param {string[]} args
 * @returns {string[]}
 */
export function normalizeAuthAlias(args) {
	if (args.length >= 2 && args[0] === "multi" && args[1] === "auth") {
		return ["auth", ...args.slice(2)];
	}
	if (args.length >= 1 && (args[0] === "multi-auth" || args[0] === "multiauth")) {
		return ["auth", ...args.slice(1)];
	}
	return args;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
export function shouldHandleMultiAuthAuth(args) {
	if (args[0] !== "auth") return false;
	if (args.length === 1) return true;
	const subcommand = args[1];
	if (typeof subcommand !== "string") return false;
	if (subcommand.startsWith("-")) return true;
	return AUTH_SUBCOMMANDS.has(subcommand);
}

export { AUTH_SUBCOMMANDS };
