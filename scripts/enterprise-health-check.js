#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WAL_STALE_MS = 24 * 60 * 60 * 1000;
const MAX_AUDIT_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

function resolveRoot() {
	const override = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "multi-auth");
}

async function newestMtimeMs(dir) {
	if (!existsSync(dir)) return null;
	const entries = await readdir(dir, { withFileTypes: true });
	let newest = null;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const fullPath = join(dir, entry.name);
		try {
			const details = await stat(fullPath);
			if (newest === null || details.mtimeMs > newest) {
				newest = details.mtimeMs;
			}
		} catch {
			// Ignore transient stat failures.
		}
	}
	return newest;
}

async function checkSecureMode(path, findings) {
	if (process.platform === "win32") return;
	if (!existsSync(path)) return;
	try {
		const details = await stat(path);
		const perms = details.mode & 0o777;
		if (perms !== 0o600) {
			findings.push({
				severity: "high",
				code: "insecure-file-permissions",
				path,
				message: `expected 0600 permissions, found ${perms.toString(8)}`,
			});
		}
	} catch (error) {
		findings.push({
			severity: "medium",
			code: "stat-failed",
			path,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function run() {
	const now = Date.now();
	const root = resolveRoot();
	const findings = [];
	const checks = [];

	const storagePath = join(root, "openai-codex-accounts.json");
	const settingsPath = join(root, "settings.json");
	const walPath = `${storagePath}.wal`;
	const auditDir = join(root, "logs");

	if (existsSync(walPath)) {
		const walStats = await stat(walPath);
		const walAgeMs = now - walStats.mtimeMs;
		checks.push({ name: "wal-age-ms", value: walAgeMs });
		if (walAgeMs > WAL_STALE_MS) {
			findings.push({
				severity: "high",
				code: "stale-wal",
				path: walPath,
				message: `WAL file older than ${WAL_STALE_MS}ms`,
			});
		}
	}

	await checkSecureMode(storagePath, findings);
	await checkSecureMode(settingsPath, findings);

	const newestAuditMs = await newestMtimeMs(auditDir);
	checks.push({ name: "newest-audit-mtime-ms", value: newestAuditMs });
	if (newestAuditMs !== null && now - newestAuditMs > MAX_AUDIT_STALENESS_MS) {
		findings.push({
			severity: "medium",
			code: "stale-audit-log",
			path: auditDir,
			message: `no audit activity in ${MAX_AUDIT_STALENESS_MS}ms`,
		});
	}

	const highFindings = findings.filter((entry) => entry.severity === "high");
	const payload = {
		command: "enterprise-health-check",
		root,
		status: highFindings.length === 0 ? "pass" : "fail",
		checks,
		findings,
	};
	console.log(JSON.stringify(payload, null, 2));
	if (highFindings.length > 0) {
		process.exit(1);
	}
}

run().catch((error) => {
	console.error(`enterprise-health-check failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
