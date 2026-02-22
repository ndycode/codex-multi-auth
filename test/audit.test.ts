import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	AuditAction,
	AuditOutcome,
	auditLog,
	configureAudit,
	getAuditConfig,
	getAuditLogPath,
	listAuditLogFiles,
} from "../lib/audit.js";

describe("Audit logging", () => {
	const testLogDir = join(tmpdir(), `audit-test-${Date.now()}`);

	beforeEach(() => {
		if (existsSync(testLogDir)) {
			rmSync(testLogDir, { recursive: true });
		}
		mkdirSync(testLogDir, { recursive: true });
		configureAudit({
			enabled: true,
			logDir: testLogDir,
			maxFileSizeBytes: 1024,
			maxFiles: 3,
		});
	});

	afterEach(() => {
		if (existsSync(testLogDir)) {
			rmSync(testLogDir, { recursive: true });
		}
	});

	describe("ensureLogDir (line 68 coverage)", () => {
		it("should create log directory if it does not exist", () => {
			const newLogDir = join(tmpdir(), `audit-test-new-${Date.now()}`);
			if (existsSync(newLogDir)) {
				rmSync(newLogDir, { recursive: true });
			}
			
			configureAudit({
				enabled: true,
				logDir: newLogDir,
			});
			
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"test-actor",
				"test-resource",
				AuditOutcome.SUCCESS
			);
			
			expect(existsSync(newLogDir)).toBe(true);
			
			rmSync(newLogDir, { recursive: true });
		});
	});

	describe("configureAudit", () => {
		it("should update audit configuration", () => {
			configureAudit({ enabled: false });
			const config = getAuditConfig();
			expect(config.enabled).toBe(false);
		});

		it("should preserve other config values", () => {
			const originalDir = getAuditConfig().logDir;
			configureAudit({ enabled: false });
			expect(getAuditConfig().logDir).toBe(originalDir);
		});
	});

	describe("auditLog", () => {
		it("should write audit entry to log file", () => {
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"test-actor",
				"test-resource",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			expect(existsSync(logPath)).toBe(true);

			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.action).toBe(AuditAction.ACCOUNT_ADD);
			expect(entry.actor).toBe("test-actor");
			expect(entry.resource).toBe("test-resource");
			expect(entry.outcome).toBe(AuditOutcome.SUCCESS);
			expect(entry.timestamp).toBeDefined();
		});

		it("should include metadata when provided", () => {
			auditLog(
				AuditAction.AUTH_LOGIN,
				"user",
				"auth",
				AuditOutcome.SUCCESS,
				{ method: "oauth" }
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.metadata).toEqual({ method: "oauth" });
		});

		it("should redact sensitive metadata", () => {
			auditLog(
				AuditAction.AUTH_REFRESH,
				"user",
				"tokens",
				AuditOutcome.SUCCESS,
				{ accessToken: "secret123", refreshToken: "secret456" }
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.metadata.accessToken).toBe("***REDACTED***");
			expect(entry.metadata.refreshToken).toBe("***REDACTED***");
		});

		it("should mask email addresses in actor", () => {
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"user@example.com",
				"account",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.actor).not.toContain("user@example.com");
			expect(entry.actor).toContain("***");
		});

		it("should mask email addresses in metadata values (line 112 coverage)", () => {
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"actor",
				"account",
				AuditOutcome.SUCCESS,
				{ userEmail: "test@example.org" }
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.metadata.userEmail).not.toContain("test@example.org");
			expect(entry.metadata.userEmail).toContain("***");
		});

		it("should recursively sanitize nested object metadata (line 114 coverage)", () => {
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"actor",
				"account",
				AuditOutcome.SUCCESS,
				{ 
					nested: { 
						secretToken: "hidden-value",
						email: "nested@example.com"
					}
				}
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.metadata.nested.secretToken).toBe("***REDACTED***");
			expect(entry.metadata.nested.email).toContain("***");
		});

		it("should not write when disabled", () => {
			configureAudit({ enabled: false });
			
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"actor",
				"resource",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			expect(existsSync(logPath)).toBe(false);
		});

		it("should append multiple entries", () => {
			auditLog(AuditAction.ACCOUNT_ADD, "a1", "r1", AuditOutcome.SUCCESS);
			auditLog(AuditAction.ACCOUNT_REMOVE, "a2", "r2", AuditOutcome.FAILURE);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const lines = content.trim().split("\n");

			expect(lines.length).toBe(2);
		});
	});

	describe("log rotation", () => {
		it("should rotate logs when max size exceeded", () => {
			const largeData = "x".repeat(600);
			
			auditLog(AuditAction.REQUEST_START, "actor", "resource", AuditOutcome.SUCCESS, { data: largeData });
			auditLog(AuditAction.REQUEST_SUCCESS, "actor", "resource", AuditOutcome.SUCCESS, { data: largeData });

			const files = listAuditLogFiles();
			expect(files.length).toBeGreaterThanOrEqual(1);
		});

		it("should limit number of rotated files", () => {
			const largeData = "x".repeat(800);
			
			for (let i = 0; i < 10; i++) {
				auditLog(AuditAction.REQUEST_START, "actor", `resource-${i}`, AuditOutcome.SUCCESS, { data: largeData });
			}

			const files = listAuditLogFiles();
			expect(files.length).toBeLessThanOrEqual(3);
		});
	});

	describe("listAuditLogFiles", () => {
		it("should return empty array when no logs exist", () => {
			const files = listAuditLogFiles();
			expect(files).toEqual([]);
		});

		it("should return log files sorted", () => {
			auditLog(AuditAction.ACCOUNT_ADD, "actor", "resource", AuditOutcome.SUCCESS);
			
			const files = listAuditLogFiles();
			expect(files.length).toBeGreaterThan(0);
			expect(files[0]).toContain("audit");
		});
	});

	describe("AuditAction enum", () => {
		it("should have all expected actions", () => {
			expect(AuditAction.ACCOUNT_ADD).toBe("account.add");
			expect(AuditAction.AUTH_LOGIN).toBe("auth.login");
			expect(AuditAction.CONFIG_LOAD).toBe("config.load");
			expect(AuditAction.REQUEST_START).toBe("request.start");
			expect(AuditAction.CIRCUIT_OPEN).toBe("circuit.open");
		});
	});

	describe("AuditOutcome enum", () => {
		it("should have all expected outcomes", () => {
			expect(AuditOutcome.SUCCESS).toBe("success");
			expect(AuditOutcome.FAILURE).toBe("failure");
			expect(AuditOutcome.PARTIAL).toBe("partial");
		});
	});
});
