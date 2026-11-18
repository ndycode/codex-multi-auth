import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
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

		it("should create the log file with 0600 permissions", () => {
			auditLog(
				AuditAction.ACCOUNT_ADD,
				"test-actor",
				"test-resource",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			// Fresh log files must not be world-readable; the append-mode write
			// only applies the mode on creation. Windows reports requested POSIX
			// mode bits unreliably (0o666 for a writable file), so only assert
			// existence there and the exact mode on POSIX.
			if (process.platform === "win32") {
				expect(existsSync(logPath)).toBe(true);
			} else {
				expect(statSync(logPath).mode & 0o777).toBe(0o600);
			}
		});

		it.skipIf(process.platform === "win32")(
			"should restrict permissions on a pre-existing permissive log file",
			() => {
				const logPath = getAuditLogPath();
				// An audit.log created before this hardening (or in a shared logDir)
				// can carry permissive bits; the append-mode mode flag does NOT
				// tighten an existing file, so the writer re-asserts 0600.
				writeFileSync(logPath, "", { mode: 0o644 });
				expect(statSync(logPath).mode & 0o777).toBe(0o644);

				auditLog(
					AuditAction.ACCOUNT_ADD,
					"test-actor",
					"test-resource",
					AuditOutcome.SUCCESS
				);

				expect(statSync(logPath).mode & 0o777).toBe(0o600);
			},
		);

		it.skipIf(process.platform === "win32")(
			"should restrict permissions on rotated backups",
			() => {
				const logPath = getAuditLogPath();
				// A permissive audit.log that rotates keeps its mode on the
				// rename; the backups must be re-asserted too.
				writeFileSync(logPath, `${"x".repeat(2048)}\n`, { mode: 0o644 });

				auditLog(
					AuditAction.ACCOUNT_ADD,
					"test-actor",
					"test-resource",
					AuditOutcome.SUCCESS
				);

				const rotated = join(testLogDir, "audit.1.log");
				expect(statSync(rotated).mode & 0o777).toBe(0o600);
				expect(statSync(logPath).mode & 0o777).toBe(0o600);
			},
		);

		it("should redact credential-carrying metadata keys", () => {
			auditLog(
				AuditAction.AUTH_REFRESH,
				"user",
				"auth",
				AuditOutcome.SUCCESS,
				{
					authorization: "Bearer live-token",
					api_key: "sk-live",
					apiKey: "sk-camel",
					"X-Api-Key": "sk-header",
					userCredential: "cred",
				}
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.metadata.authorization).toBe("***REDACTED***");
			expect(entry.metadata.api_key).toBe("***REDACTED***");
			expect(entry.metadata.apiKey).toBe("***REDACTED***");
			expect(entry.metadata["X-Api-Key"]).toBe("***REDACTED***");
			expect(entry.metadata.userCredential).toBe("***REDACTED***");
			expect(content).not.toContain("sk-live");
			expect(content).not.toContain("live-token");
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

		it("should mask email addresses in the resource field", () => {
			auditLog(
				AuditAction.ACCOUNT_SWITCH,
				"actor",
				"owner@example.com/account",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			const content = readFileSync(logPath, "utf8");
			const entry = JSON.parse(content.trim());

			expect(entry.resource).not.toContain("owner@example.com");
			expect(entry.resource).toContain("***");
		});

		it.each([
			["@scope/package", "actor"],
			["@scope/package", "resource"],
		])("should preserve non-email @identifier %s in the %s field", (value, field) => {
			// "@scope/package" is not an email; the whole-string maskEmail path
			// used to mangle it into "***@***.scope/package", erasing the
			// resource identity the audit entry exists to record.
			auditLog(
				AuditAction.ACCOUNT_ADD,
				field === "actor" ? value : "actor",
				field === "resource" ? value : "account",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
			expect(entry[field]).toBe("@scope/package");
		});

		it("should mask only the email span inside a larger resource string", () => {
			auditLog(
				AuditAction.ACCOUNT_SWITCH,
				"actor",
				"https://accounts.example.io/reset?user=alice@example.com",
				AuditOutcome.SUCCESS
			);

			const logPath = getAuditLogPath();
			const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
			expect(entry.resource).toBe(
				"https://accounts.example.io/reset?user=al***@***.com",
			);
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

		it("should preserve non-email @identifiers in metadata values", () => {
			auditLog(
				AuditAction.CONFIG_CHANGE,
				"actor",
				"config",
				AuditOutcome.SUCCESS,
				{ packageName: "@scope/package", url: "https://x.io/?u=bob@example.com" }
			);

			const logPath = getAuditLogPath();
			const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
			expect(entry.metadata.packageName).toBe("@scope/package");
			expect(entry.metadata.url).toBe("https://x.io/?u=bo***@***.com");
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
