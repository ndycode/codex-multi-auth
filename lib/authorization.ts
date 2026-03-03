import { auditLog, AuditAction, AuditOutcome } from "./audit.js";

export type AuthRole = "admin" | "operator" | "viewer";

export type AuthAction =
	| "accounts:read"
	| "accounts:write"
	| "accounts:repair"
	| "secrets:rotate";

const ROLE_PERMISSIONS: Record<AuthRole, Set<AuthAction>> = {
	admin: new Set(["accounts:read", "accounts:write", "accounts:repair", "secrets:rotate"]),
	operator: new Set(["accounts:read", "accounts:write", "accounts:repair"]),
	viewer: new Set(["accounts:read"]),
};

function getRoleFromEnv(): AuthRole {
	const raw = (process.env.CODEX_AUTH_ROLE ?? "admin").trim().toLowerCase();
	if (raw === "operator" || raw === "viewer" || raw === "admin") {
		return raw;
	}
	return "admin";
}

export function getAuthorizationRole(): AuthRole {
	return getRoleFromEnv();
}

export function authorizeAction(action: AuthAction): { allowed: boolean; role: AuthRole; reason?: string } {
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
