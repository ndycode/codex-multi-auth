#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

const WAL_STALE_MS = 24 * 60 * 60 * 1000;
const MAX_AUDIT_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

function parseArgValue(flagName) {
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith(`${flagName}=`)) {
			return arg.slice(flagName.length + 1).trim();
		}
	}
	return "";
}

function hasFlag(flag) {
	return process.argv.slice(2).includes(flag);
}

function firstNonEmpty(values) {
	for (const value of values) {
		const trimmed = (value ?? "").trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

function getResolvedUserHomeDir() {
	if (process.platform === "win32") {
		const homeDrive = (process.env.HOMEDRIVE ?? "").trim();
		const homePath = (process.env.HOMEPATH ?? "").trim();
		const drivePathHome =
			homeDrive.length > 0 && homePath.length > 0
				? win32.resolve(`${homeDrive}\\`, homePath)
				: undefined;
		return (
			firstNonEmpty([
				process.env.USERPROFILE,
				process.env.HOME,
				drivePathHome,
				homedir(),
			]) ?? homedir()
		);
	}
	return firstNonEmpty([process.env.HOME, homedir()]) ?? homedir();
}

function deduplicatePaths(paths) {
	const seen = new Set();
	const unique = [];
	for (const path of paths) {
		const trimmed = (path ?? "").trim();
		if (trimmed.length === 0) continue;
		const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(trimmed);
	}
	return unique;
}

function getCodexHomeDir() {
	const fromEnv = (process.env.CODEX_HOME ?? "").trim();
	return fromEnv.length > 0 ? fromEnv : join(getResolvedUserHomeDir(), ".codex");
}

function hasStorageSignals(dir) {
	const signals = [
		"openai-codex-accounts.json",
		"codex-accounts.json",
		"settings.json",
		"config.json",
		"dashboard-settings.json",
	];
	for (const signal of signals) {
		if (existsSync(join(dir, signal))) {
			return true;
		}
	}
	return existsSync(join(dir, "projects"));
}

function hasAccountsStorage(dir) {
	const accountFiles = ["openai-codex-accounts.json", "codex-accounts.json"];
	for (const fileName of accountFiles) {
		if (existsSync(join(dir, fileName)) || existsSync(join(dir, `${fileName}.wal`))) {
			return true;
		}
	}
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			for (const fileName of accountFiles) {
				if (!entry.name.startsWith(`${fileName}.`)) continue;
				if (entry.name.endsWith(".tmp")) continue;
				if (entry.name.includes(".rotate.")) continue;
				return true;
			}
		}
	} catch {
		// Ignore unreadable directories and fall back to known filename probes.
	}
	return false;
}

function getFallbackCodexHomeDirs() {
	const userHome = getResolvedUserHomeDir();
	return deduplicatePaths([
		getCodexHomeDir(),
		join(userHome, "DevTools", "config", "codex"),
		join(userHome, ".codex"),
	]);
}

function resolveRoot() {
	const overrideArg = parseArgValue("--root");
	if (overrideArg.length > 0) return overrideArg;

	const overrideEnv = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (overrideEnv.length > 0) return overrideEnv;

	const primary = join(getCodexHomeDir(), "multi-auth");
	const fallbackCandidates = deduplicatePaths([
		...getFallbackCodexHomeDirs().map((dir) => join(dir, "multi-auth")),
		join(getResolvedUserHomeDir(), ".codex"),
	]);
	const orderedCandidates = deduplicatePaths([primary, ...fallbackCandidates]);

	for (const candidate of orderedCandidates) {
		if (hasAccountsStorage(candidate)) {
			return candidate;
		}
	}
	if (hasStorageSignals(primary)) {
		return primary;
	}
	for (const candidate of fallbackCandidates) {
		if (candidate === primary) continue;
		if (hasStorageSignals(candidate)) {
			return candidate;
		}
	}
	return primary;
}

function getAuditDir(root) {
	return join(root, "logs");
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
	const requireFiles = hasFlag("--require-files");
	const root = resolveRoot();
	const findings = [];
	const checks = [];

	const storagePath = join(root, "openai-codex-accounts.json");
	const settingsPath = join(root, "settings.json");
	const walPath = `${storagePath}.wal`;
	const auditDir = getAuditDir(root);

	try {
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
	} catch {
		// WAL does not exist or is transiently unavailable.
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

	if (requireFiles) {
		const requiredArtifacts = [
			{ path: storagePath, code: "missing-storage-file" },
			{ path: settingsPath, code: "missing-settings-file" },
			{ path: auditDir, code: "missing-audit-dir" },
		];
		for (const artifact of requiredArtifacts) {
			if (!existsSync(artifact.path)) {
				findings.push({
					severity: "high",
					code: artifact.code,
					path: artifact.path,
					message: "required artifact missing for enterprise health validation",
				});
			}
		}
		if (newestAuditMs === null) {
			findings.push({
				severity: "high",
				code: "missing-audit-events",
				path: auditDir,
				message: "required audit log entries missing for enterprise health validation",
			});
		}
	}

	const highFindings = findings.filter((entry) => entry.severity === "high");
	const payload = {
		command: "enterprise-health-check",
		root,
		auditDir,
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
