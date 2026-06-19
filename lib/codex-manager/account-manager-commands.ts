/**
 * Canonical set of subcommands routed to the account-manager dispatcher.
 *
 * Kept in a small internal module (rather than exported from the CLI entrypoint
 * lib/codex-manager.ts) so both the dispatcher and the wrapper-routing alignment
 * test (test/codex-routing.test.ts) consume the SAME source of truth — the test
 * can assert AUTH_SUBCOMMANDS ⊇ ACCOUNT_MANAGER_COMMANDS without re-exporting a
 * test-only implementation detail through the public CLI surface (cli-manager-01
 * /02). This is an internal module, not part of the published package API.
 *
 * @internal
 */
export const ACCOUNT_MANAGER_COMMANDS = new Set([
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
	"history",
	"config",
	"init-config",
	"debug",
]);
