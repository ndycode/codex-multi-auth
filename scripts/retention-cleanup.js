#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const DEFAULT_RETENTION_DAYS = 90;

function parseRetentionDays(raw) {
	if (!raw) return DEFAULT_RETENTION_DAYS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
	return parsed;
}

function parseArgDays(args) {
	for (const arg of args) {
		if (arg.startsWith("--days=")) {
			return parseRetentionDays(arg.slice("--days=".length));
		}
	}
	return parseRetentionDays(process.env.CODEX_RETENTION_DAYS);
}

function resolveRuntimeRoot() {
	const override = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "multi-auth");
}

async function removeWithRetry(targetPath, options) {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await rm(targetPath, options);
			return;
		} catch (error) {
			const code = error?.code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

async function collectExpiredFiles(rootPath, cutoffMs, output) {
	if (!existsSync(rootPath)) return;
	const entries = await readdir(rootPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(rootPath, entry.name);
		if (entry.isDirectory()) {
			await collectExpiredFiles(fullPath, cutoffMs, output);
			continue;
		}
		if (!entry.isFile()) continue;
		try {
			const metadata = await stat(fullPath);
			if (metadata.mtimeMs < cutoffMs) {
				output.push(fullPath);
			}
		} catch {
			// Ignore transient stat failures.
		}
	}
}

async function run() {
	const retentionDays = parseArgDays(process.argv.slice(2));
	const root = resolveRuntimeRoot();
	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const targets = [
		join(root, "logs"),
		join(root, "cache"),
		join(root, "recovery"),
	];

	const expired = [];
	for (const target of targets) {
		await collectExpiredFiles(target, cutoffMs, expired);
	}

	let deletedFiles = 0;
	const failed = [];
	for (const targetPath of expired) {
		try {
			await removeWithRetry(targetPath, { force: true });
			deletedFiles += 1;
		} catch (error) {
			failed.push({
				path: targetPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const payload = {
		command: "retention-cleanup",
		root,
		retentionDays,
		cutoffIso: new Date(cutoffMs).toISOString(),
		deletedFiles,
		failedFiles: failed.length,
		failures: failed,
		status: failed.length === 0 ? "pass" : "partial",
	};
	console.log(JSON.stringify(payload, null, 2));
}

run().catch((error) => {
	console.error(`retention-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
