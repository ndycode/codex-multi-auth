import { auditLog, AuditAction, AuditOutcome } from "./audit.js";

export type AuthRole = "admin" | "operator" | "viewer";

export type AuthAction =
	| "accounts:read"
	| "accounts:write"
	| "accounts:repair"
	| "secrets:rotate";

export interface AuthorizationContext {
	command?: string;
	interactive?: boolean;
	idempotencyKeyPresent?: boolean;
}

const ROLE_PERMISSIONS: Record<AuthRole, Set<AuthAction>> = {
	admin: new Set(["accounts:read", "accounts:write", "accounts:repair", "secrets:rotate"]),
	operator: new Set(["accounts:read", "accounts:write", "accounts:repair"]),
	viewer: new Set(["accounts:read"]),
};

const ALL_AUTH_ACTIONS = new Set<AuthAction>([
	"accounts:read",
	"accounts:write",
	"accounts:repair",
	"secrets:rotate",
]);

function getRoleFromEnv(): AuthRole {
	const rawEnv = process.env.CODEX_AUTH_ROLE;
	if (rawEnv === undefined || rawEnv.trim().length === 0) {
		return "admin";
	}
	const raw = rawEnv.trim().toLowerCase();
	if (raw === "operator" || raw === "viewer" || raw === "admin") {
		return raw;
	}
	return "viewer";
}

export function getAuthorizationRole(): AuthRole {
	return getRoleFromEnv();
}

function isTruthyEnv(name: string): boolean {
	const raw = (process.env[name] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseActionSetFromEnv(name: string): Set<AuthAction> {
	const raw = (process.env[name] ?? "").trim();
	if (!raw) return new Set<AuthAction>();
	const values = raw
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter((value) => value.length > 0);
	const parsed = new Set<AuthAction>();
	for (const value of values) {
		if (ALL_AUTH_ACTIONS.has(value as AuthAction)) {
			parsed.add(value as AuthAction);
		}
	}
	return parsed;
}

function parseCommandSetFromEnv(name: string): Set<string> {
	const raw = (process.env[name] ?? "").trim();
	if (!raw) return new Set<string>();
	return new Set(
		raw
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter((value) => value.length > 0),
	);
}

function evaluateAbacPolicy(
	action: AuthAction,
	context: AuthorizationContext,
): string | null {
	const readOnly = isTruthyEnv("CODEX_AUTH_ABAC_READ_ONLY");
	if (readOnly && action !== "accounts:read") {
		return "ABAC read-only mode denies mutating actions";
	}

	const deniedActions = parseActionSetFromEnv("CODEX_AUTH_ABAC_DENY_ACTIONS");
	if (deniedActions.has(action)) {
		return `ABAC policy denies action '${action}'`;
	}

	const deniedCommands = parseCommandSetFromEnv("CODEX_AUTH_ABAC_DENY_COMMANDS");
	const command = context.command?.trim().toLowerCase();
	if (command && deniedCommands.has(command)) {
		return `ABAC policy denies command '${command}'`;
	}

	const interactiveActions = parseActionSetFromEnv("CODEX_AUTH_ABAC_REQUIRE_INTERACTIVE");
	if (interactiveActions.has(action) && context.interactive !== true) {
		return `ABAC policy requires an interactive terminal for '${action}'`;
	}

	const idempotencyActions = parseActionSetFromEnv("CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY");
	if (idempotencyActions.has(action) && context.idempotencyKeyPresent !== true) {
		return `ABAC policy requires idempotency key for '${action}'`;
	}

	return null;
}

export function authorizeAction(
	action: AuthAction,
	context: AuthorizationContext = {},
): { allowed: boolean; role: AuthRole; reason?: string } {
	if (process.env.CODEX_AUTH_BREAK_GLASS === "1") {
		const role = getRoleFromEnv();
		auditLog(
			AuditAction.AUTH_BREAK_GLASS,
			"system",
			action,
			AuditOutcome.SUCCESS,
			{
				role,
				breakGlass: true,
			},
		);
		return { allowed: true, role };
	}

	const role = getRoleFromEnv();
	const abacReason = evaluateAbacPolicy(action, context);
	if (abacReason) {
		return {
			allowed: false,
			role,
			reason: abacReason,
		};
	}

	const permissions = ROLE_PERMISSIONS[role];
	if (permissions.has(action)) {
		return { allowed: true, role };
	}
	return {
		allowed: false,
		role,
		reason: `Role '${role}' does not allow '${action}'`,
	};
}
