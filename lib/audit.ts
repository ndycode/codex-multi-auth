import { writeFileSync, mkdirSync, existsSync, statSync, chmodSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getCorrelationId, maskEmail } from "./logger.js";
import { getCodexLogDir } from "./runtime-paths.js";

export enum AuditAction {
	ACCOUNT_ADD = "account.add",
	ACCOUNT_REMOVE = "account.remove",
	ACCOUNT_SWITCH = "account.switch",
	ACCOUNT_REFRESH = "account.refresh",
	ACCOUNT_EXPORT = "account.export",
	ACCOUNT_IMPORT = "account.import",
	AUTH_LOGIN = "auth.login",
	AUTH_LOGOUT = "auth.logout",
	AUTH_REFRESH = "auth.refresh",
	AUTH_FAILURE = "auth.failure",
	CONFIG_LOAD = "config.load",
	CONFIG_CHANGE = "config.change",
	REQUEST_START = "request.start",
	REQUEST_SUCCESS = "request.success",
	REQUEST_FAILURE = "request.failure",
	CIRCUIT_OPEN = "circuit.open",
	CIRCUIT_CLOSE = "circuit.close",
}

export enum AuditOutcome {
	SUCCESS = "success",
	FAILURE = "failure",
	PARTIAL = "partial",
}

interface AuditEntry {
	timestamp: string;
	correlationId: string | null;
	action: AuditAction;
	actor: string;
	resource: string;
	outcome: AuditOutcome;
	metadata?: Record<string, unknown>;
}

export interface AuditConfig {
	enabled: boolean;
	logDir: string;
	maxFileSizeBytes: number;
	maxFiles: number;
}

const DEFAULT_CONFIG: AuditConfig = {
	enabled: true,
	logDir: getCodexLogDir(),
	maxFileSizeBytes: 10 * 1024 * 1024,
	maxFiles: 5,
};

let auditConfig: AuditConfig = { ...DEFAULT_CONFIG };

export function configureAudit(config: Partial<AuditConfig>): void {
	auditConfig = { ...auditConfig, ...config };
}

export function getAuditConfig(): AuditConfig {
	return { ...auditConfig };
}

function ensureLogDir(): void {
	if (!existsSync(auditConfig.logDir)) {
		mkdirSync(auditConfig.logDir, { recursive: true, mode: 0o700 });
	}
}

function getLogFilePath(): string {
	return join(auditConfig.logDir, "audit.log");
}

// POSIX-only permission re-assertion. The append-mode `mode` option applies
// only when the file is created, so an audit log that already exists with
// permissive bits (a shared/custom logDir, or one written before this
// hardening) would stay readable by other local users, and rotation would
// carry those bits onto the backups. On Windows chmod cannot establish the
// equivalent ACL — the logDir's ACLs govern access there — so this is skipped
// on win32 rather than half-applied.
function restrictLogPermissions(path: string, currentMode?: number): void {
	if (process.platform === "win32") return;
	try {
		const mode = currentMode ?? statSync(path).mode;
		if ((mode & 0o777) !== 0o600) {
			chmodSync(path, 0o600);
		}
	} catch {
		// Best-effort hardening: audit logging must never break the application.
	}
}

function rotateLogsIfNeeded(): void {
	const logPath = getLogFilePath();
	if (!existsSync(logPath)) return;

	const stats = statSync(logPath);
	restrictLogPermissions(logPath, stats.mode);
	if (stats.size < auditConfig.maxFileSizeBytes) return;

	for (let i = auditConfig.maxFiles - 1; i >= 1; i--) {
		const older = join(auditConfig.logDir, `audit.${i}.log`);
		const newer = i === 1 ? logPath : join(auditConfig.logDir, `audit.${i - 1}.log`);

		if (i === auditConfig.maxFiles - 1 && existsSync(older)) {
			unlinkSync(older);
		}
		if (existsSync(newer)) {
			renameSync(newer, older);
			restrictLogPermissions(older);
		}
	}
}

// Same email shape logger.ts scrubs, applied as a SUBSTRING masker. Feeding
// the whole value to maskEmail would treat any "@" as an email separator and
// mangle non-email identifiers that legitimately carry one — "@scope/package",
// "@user" handles, URLs with embedded credentials — leaving the audit entry
// unable to identify the resource. Only real email-shaped spans are masked.
const EMAIL_SUBSTRING_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function maskAuditField(value: string): string {
	return value.replace(EMAIL_SUBSTRING_PATTERN, maskEmail);
}

// Substring markers matched against the lowercased metadata key. Covers
// token/secret/password plus credential-carrying spellings: "authorization"
// (raw headers), "api_key"/"api-key"/"apiKey" (api[-_]?key), and "credential".
const SENSITIVE_KEY_PATTERN =
	/token|secret|password|authorization|api[-_]?key|credential/;

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!metadata) return undefined;

	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		const lowerKey = key.toLowerCase();
		if (SENSITIVE_KEY_PATTERN.test(lowerKey)) {
			sanitized[key] = "***REDACTED***";
		} else if (typeof value === "string") {
			sanitized[key] = maskAuditField(value);
		} else if (typeof value === "object" && value !== null) {
			sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
		} else {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

export function auditLog(
	action: AuditAction,
	actor: string,
	resource: string,
	outcome: AuditOutcome,
	metadata?: Record<string, unknown>,
): void {
	if (!auditConfig.enabled) return;

	try {
		ensureLogDir();
		rotateLogsIfNeeded();

		const entry: AuditEntry = {
			timestamp: new Date().toISOString(),
			correlationId: getCorrelationId(),
			action,
			actor: maskAuditField(actor),
			resource: maskAuditField(resource),
			outcome,
			metadata: sanitizeMetadata(metadata),
		};

		const logPath = getLogFilePath();
		const line = JSON.stringify(entry) + "\n";

		// mode applies only at creation; rotateLogsIfNeeded already re-asserted
		// 0o600 on an existing file (and on every backup it renamed).
		writeFileSync(logPath, line, { flag: "a", mode: 0o600 });
	} catch {
		// Audit logging should never break the application
	}
}

export function getAuditLogPath(): string {
	return getLogFilePath();
}

export function listAuditLogFiles(): string[] {
	ensureLogDir();
	const files = readdirSync(auditConfig.logDir);
	return files
		.filter((f) => f.startsWith("audit") && f.endsWith(".log"))
		.map((f) => join(auditConfig.logDir, f))
		.sort();
}
