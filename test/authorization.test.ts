import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditAction, configureAudit, getAuditConfig } from "../lib/audit.js";
import { authorizeAction, getAuthorizationRole } from "../lib/authorization.js";
import { removeWithRetry } from "./helpers/fs-retry.js";

const AUTH_ENV_KEYS = [
	"CODEX_AUTH_ROLE",
	"CODEX_AUTH_BREAK_GLASS",
	"CODEX_AUTH_ABAC_READ_ONLY",
	"CODEX_AUTH_ABAC_DENY_ACTIONS",
	"CODEX_AUTH_ABAC_DENY_COMMANDS",
	"CODEX_AUTH_ABAC_REQUIRE_INTERACTIVE",
	"CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY",
] as const;

function captureAuthEnv(): Record<(typeof AUTH_ENV_KEYS)[number], string | undefined> {
	const snapshot = {} as Record<(typeof AUTH_ENV_KEYS)[number], string | undefined>;
	for (const key of AUTH_ENV_KEYS) {
		snapshot[key] = process.env[key];
	}
	return snapshot;
}

function restoreAuthEnv(snapshot: Record<(typeof AUTH_ENV_KEYS)[number], string | undefined>): void {
	for (const key of AUTH_ENV_KEYS) {
		const previous = snapshot[key];
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}
}

describe("authorization", () => {
	it("defaults to viewer role", () => {
		const previous = captureAuthEnv();
		try {
			delete process.env.CODEX_AUTH_ROLE;
			expect(getAuthorizationRole()).toBe("viewer");
			expect(authorizeAction("accounts:read").allowed).toBe(true);
			expect(authorizeAction("secrets:rotate").allowed).toBe(false);
		} finally {
			restoreAuthEnv(previous);
		}
	});

	it("denies write actions for viewer role", () => {
		const previous = captureAuthEnv();
		try {
			process.env.CODEX_AUTH_ROLE = "viewer";
			const auth = authorizeAction("accounts:write");
			expect(auth.allowed).toBe(false);
			expect(auth.role).toBe("viewer");
			expect(auth.reason).toContain("accounts:write");
		} finally {
			restoreAuthEnv(previous);
		}
	});

	it("fails closed for invalid role overrides", () => {
		const previous = captureAuthEnv();
		try {
			process.env.CODEX_AUTH_ROLE = "root";
			const auth = authorizeAction("accounts:write");
			expect(auth.allowed).toBe(false);
			expect(auth.role).toBe("viewer");
		} finally {
			restoreAuthEnv(previous);
		}
	});

	it("allows all actions when break-glass is enabled and audits the bypass", async () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		const previousBreakGlass = process.env.CODEX_AUTH_BREAK_GLASS;
		const previousAuditConfig = getAuditConfig();
		const auditDir = await fs.mkdtemp(join(tmpdir(), "codex-auth-audit-"));
		try {
			configureAudit({
				enabled: true,
				logDir: auditDir,
				maxFileSizeBytes: 1024 * 1024,
				maxFiles: 2,
			});
			process.env.CODEX_AUTH_ROLE = "viewer";
			process.env.CODEX_AUTH_BREAK_GLASS = "1";
			const result = authorizeAction("secrets:rotate");
			expect(result).toEqual({
				allowed: true,
				role: "viewer",
			});

			const logPath = join(auditDir, "audit.log");
			const content = await fs.readFile(logPath, "utf8");
			const entries = content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as {
					action?: string;
					resource?: string;
					metadata?: { role?: string; breakGlass?: boolean };
				});
			const breakGlassEntry = entries.find((entry) => entry.action === AuditAction.AUTH_BREAK_GLASS);
			expect(breakGlassEntry).toBeDefined();
			expect(breakGlassEntry?.resource).toBe("secrets:rotate");
			expect(breakGlassEntry?.metadata?.role).toBe("viewer");
			expect(breakGlassEntry?.metadata?.breakGlass).toBe(true);
		} finally {
			configureAudit(previousAuditConfig);
			await removeWithRetry(auditDir, { recursive: true, force: true });
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
			if (previousBreakGlass === undefined) {
				delete process.env.CODEX_AUTH_BREAK_GLASS;
			} else {
				process.env.CODEX_AUTH_BREAK_GLASS = previousBreakGlass;
			}
		}
	});

	it("applies ABAC read-only mode to deny mutating actions", () => {
		const previous = captureAuthEnv();
		try {
			process.env.CODEX_AUTH_ROLE = "admin";
			process.env.CODEX_AUTH_ABAC_READ_ONLY = "1";
			const denied = authorizeAction("accounts:write", {
				command: "login",
				interactive: true,
			});
			expect(denied.allowed).toBe(false);
			expect(denied.reason).toContain("read-only");

			const allowed = authorizeAction("accounts:read", {
				command: "status",
				interactive: false,
			});
			expect(allowed.allowed).toBe(true);
		} finally {
			restoreAuthEnv(previous);
		}
	});

	it("applies ABAC denied actions and denied commands", () => {
		const previous = captureAuthEnv();
		try {
			process.env.CODEX_AUTH_ROLE = "admin";
			process.env.CODEX_AUTH_ABAC_DENY_ACTIONS = "secrets:rotate,accounts:repair";
			process.env.CODEX_AUTH_ABAC_DENY_COMMANDS = "rotate-secrets,doctor";

			const deniedByAction = authorizeAction("secrets:rotate", {
				command: "rotate-secrets",
				interactive: true,
				idempotencyKeyPresent: true,
			});
			expect(deniedByAction.allowed).toBe(false);
			expect(deniedByAction.reason).toContain("denies action");

			process.env.CODEX_AUTH_ABAC_DENY_ACTIONS = "";
			const deniedByCommand = authorizeAction("accounts:repair", {
				command: "doctor",
				interactive: true,
			});
			expect(deniedByCommand.allowed).toBe(false);
			expect(deniedByCommand.reason).toContain("denies command");
		} finally {
			restoreAuthEnv(previous);
		}
	});

	it("applies ABAC interactive and idempotency-key requirements", () => {
		const previous = captureAuthEnv();
		try {
			process.env.CODEX_AUTH_ROLE = "admin";
			process.env.CODEX_AUTH_ABAC_REQUIRE_INTERACTIVE = "accounts:write";
			process.env.CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY = "secrets:rotate";

			const nonInteractiveDenied = authorizeAction("accounts:write", {
				command: "login",
				interactive: false,
			});
			expect(nonInteractiveDenied.allowed).toBe(false);
			expect(nonInteractiveDenied.reason).toContain("interactive terminal");

			const interactiveAllowed = authorizeAction("accounts:write", {
				command: "login",
				interactive: true,
			});
			expect(interactiveAllowed.allowed).toBe(true);

			const missingIdempotencyDenied = authorizeAction("secrets:rotate", {
				command: "rotate-secrets",
				interactive: true,
				idempotencyKeyPresent: false,
			});
			expect(missingIdempotencyDenied.allowed).toBe(false);
			expect(missingIdempotencyDenied.reason).toContain("idempotency key");

			const idempotencyAllowed = authorizeAction("secrets:rotate", {
				command: "rotate-secrets",
				interactive: true,
				idempotencyKeyPresent: true,
			});
			expect(idempotencyAllowed.allowed).toBe(true);
		} finally {
			restoreAuthEnv(previous);
		}
	});
});
