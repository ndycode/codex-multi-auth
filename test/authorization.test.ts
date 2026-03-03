import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditAction, configureAudit, getAuditConfig } from "../lib/audit.js";
import { authorizeAction, getAuthorizationRole } from "../lib/authorization.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("authorization", () => {
	it("defaults to admin role", () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		try {
			delete process.env.CODEX_AUTH_ROLE;
			expect(getAuthorizationRole()).toBe("admin");
			expect(authorizeAction("secrets:rotate").allowed).toBe(true);
		} finally {
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
		}
	});

	it("denies write actions for viewer role", () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		try {
			process.env.CODEX_AUTH_ROLE = "viewer";
			const auth = authorizeAction("accounts:write");
			expect(auth.allowed).toBe(false);
			expect(auth.role).toBe("viewer");
			expect(auth.reason).toContain("accounts:write");
		} finally {
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
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
});
