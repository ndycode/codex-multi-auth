import { writeFileSync, mkdirSync, existsSync, statSync, renameSync, readdirSync, unlinkSync } from "node:fs";
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

export interface AuditEntry {
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
	retentionDays: number;
}

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_CONFIG: AuditConfig = {
	enabled: true,
	logDir: getCodexLogDir(),
	maxFileSizeBytes: 10 * 1024 * 1024,
	maxFiles: 5,
	retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
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

function rotateLogsIfNeeded(): void {
	const logPath = getLogFilePath();
	if (!existsSync(logPath)) return;

	const stats = statSync(logPath);
	if (stats.size < auditConfig.maxFileSizeBytes) return;

	for (let i = auditConfig.maxFiles - 1; i >= 1; i--) {
		const older = join(auditConfig.logDir, `audit.${i}.log`);
		const newer = i === 1 ? logPath : join(auditConfig.logDir, `audit.${i - 1}.log`);
		
		if (i === auditConfig.maxFiles - 1 && existsSync(older)) {
			unlinkSync(older);
		}
		if (existsSync(newer)) {
			renameSync(newer, older);
		}
	}
}

function purgeExpiredLogs(): void {
	const retentionDays =
		Number.isFinite(auditConfig.retentionDays) && auditConfig.retentionDays >= 1
			? Math.floor(auditConfig.retentionDays)
			: DEFAULT_AUDIT_RETENTION_DAYS;
	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const files = readdirSync(auditConfig.logDir);
	for (const file of files) {
		if (!file.startsWith("audit") || !file.endsWith(".log")) continue;
		const target = join(auditConfig.logDir, file);
		try {
			const stats = statSync(target);
			if (stats.mtimeMs < cutoffMs) {
				unlinkSync(target);
			}
		} catch {
			// Best-effort purge.
		}
	}
}

function sanitizeActor(actor: string): string {
	if (actor.includes("@")) {
		return maskEmail(actor);
	}
	return actor;
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!metadata) return undefined;

	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		const lowerKey = key.toLowerCase();
		if (lowerKey.includes("token") || lowerKey.includes("secret") || lowerKey.includes("password")) {
			sanitized[key] = "***REDACTED***";
		} else if (typeof value === "string" && value.includes("@")) {
			sanitized[key] = maskEmail(value);
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
		purgeExpiredLogs();
		rotateLogsIfNeeded();

		const entry: AuditEntry = {
			timestamp: new Date().toISOString(),
			correlationId: getCorrelationId(),
			action,
			actor: sanitizeActor(actor),
			resource,
			outcome,
			metadata: sanitizeMetadata(metadata),
		};

		const logPath = getLogFilePath();
		const line = JSON.stringify(entry) + "\n";
		
		writeFileSync(logPath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
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
