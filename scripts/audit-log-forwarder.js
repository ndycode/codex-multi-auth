#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BATCH_SIZE = 500;
const SEND_TIMEOUT_MS = Number.parseInt(process.env.CODEX_AUDIT_FORWARDER_TIMEOUT_MS ?? "15000", 10);
const SEND_MAX_ATTEMPTS = Number.parseInt(process.env.CODEX_AUDIT_FORWARDER_MAX_ATTEMPTS ?? "3", 10);
const CHECKPOINT_LOCK_MAX_ATTEMPTS = parsePositiveInt(process.env.CODEX_AUDIT_FORWARDER_LOCK_MAX_ATTEMPTS, 40);
const CHECKPOINT_LOCK_STALE_MS = parsePositiveInt(process.env.CODEX_AUDIT_FORWARDER_STALE_LOCK_MS, 5 * 60 * 1000);
const CHECKPOINT_LOCK_MAX_WAIT_MS = parsePositiveInt(process.env.CODEX_AUDIT_FORWARDER_MAX_WAIT_MS, 60 * 1000);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function parseArgValue(name) {
	const prefix = `${name}=`;
	const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name) {
	return process.argv.slice(2).includes(name);
}

function parseBatchSize(value) {
	if (!value) return DEFAULT_BATCH_SIZE;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
	return parsed;
}

function countNonEmptyLines(content) {
	return content.split(/\r?\n/).reduce((count, line) => (line.trim().length > 0 ? count + 1 : count), 0);
}

function getNewestRotatedAuditFile(files) {
	return files
		.map((file) => {
			const match = /^audit\.(\d+)\.log$/i.exec(file);
			if (!match) return null;
			return {
				file,
				rotation: Number.parseInt(match[1], 10),
			};
		})
		.filter((entry) => entry !== null)
		.sort((a, b) => a.rotation - b.rotation)[0]?.file ?? null;
}

function resolveRoot() {
	const override = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "multi-auth");
}

async function loadCheckpoint(path) {
	if (!existsSync(path)) {
		return { file: null, line: 0 };
	}
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (
			parsed &&
			(typeof parsed.file === "string" || parsed.file === null) &&
			typeof parsed.line === "number" &&
			parsed.line >= 0
		) {
			return {
				file: parsed.file,
				line: parsed.line,
			};
		}
	} catch {
		// Ignore malformed checkpoint and re-seed from zero.
	}
	return { file: null, line: 0 };
}

async function discoverAuditFiles(logDir) {
	if (!existsSync(logDir)) return [];
	const entries = await readdir(logDir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.startsWith("audit") || !entry.name.endsWith(".log")) continue;
		files.push(entry.name);
	}
	files.sort((a, b) => {
		const leftRotation = /^audit\.(\d+)\.log$/i.exec(a);
		const rightRotation = /^audit\.(\d+)\.log$/i.exec(b);
		const leftActive = a.toLowerCase() === "audit.log";
		const rightActive = b.toLowerCase() === "audit.log";
		if (leftActive && rightActive) return 0;
		if (leftActive) return 1;
		if (rightActive) return -1;
		if (leftRotation && rightRotation) {
			// Process older rotated files first (audit.3.log before audit.1.log).
			return Number.parseInt(rightRotation[1], 10) - Number.parseInt(leftRotation[1], 10);
		}
		return a.localeCompare(b, undefined, { sensitivity: "base" });
	});
	return files;
}

function resolveCheckpointFile(files, checkpointFile) {
	if (!checkpointFile) return null;
	const newestRotated = getNewestRotatedAuditFile(files);
	if (files.includes(checkpointFile)) {
		return checkpointFile;
	}
	if (checkpointFile === "audit.log") {
		return newestRotated;
	}
	const rotatedMatch = /^audit\.(\d+)\.log$/i.exec(checkpointFile);
	if (rotatedMatch) {
		const nextRotation = `audit.${Number.parseInt(rotatedMatch[1], 10) + 1}.log`;
		if (files.includes(nextRotation)) return nextRotation;
	}
	return null;
}

async function collectBatch(logDir, files, checkpoint, batchSize) {
	let checkpointFile = resolveCheckpointFile(files, checkpoint.file);
	if (checkpoint.file === "audit.log" && checkpointFile === "audit.log") {
		const newestRotated = getNewestRotatedAuditFile(files);
		if (newestRotated) {
			const activePath = join(logDir, "audit.log");
			try {
				const activeRaw = await readFile(activePath, "utf8");
				const activeLineCount = countNonEmptyLines(activeRaw);
				if (checkpoint.line > activeLineCount) {
					checkpointFile = newestRotated;
				}
			} catch {
				// Best effort: fall back to active audit.log checkpoint.
			}
		}
	}
	const checkpointFileIndex = checkpointFile ? files.indexOf(checkpointFile) : -1;
	const entries = [];
	for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
		const file = files[fileIndex];
		if (checkpointFileIndex >= 0 && fileIndex < checkpointFileIndex) {
			continue;
		}

		const fullPath = join(logDir, file);
		let lineNumber = 0;
		const raw = await readFile(fullPath, "utf8");
		const lines = raw.split(/\r?\n/);
		for (const line of lines) {
			if (!line.trim()) continue;
			lineNumber += 1;

			if (checkpointFile === file && lineNumber <= checkpoint.line) {
				continue;
			}
			try {
				entries.push({
					file,
					line: lineNumber,
					entry: JSON.parse(line),
				});
			} catch {
				entries.push({
					file,
					line: lineNumber,
					entry: {
						parseError: true,
						raw: line,
					},
				});
			}
			if (entries.length >= batchSize) {
				return entries;
			}
		}
	}
	return entries;
}

async function sendBatch({ endpoint, apiKey, payload }) {
	const headers = {
		"content-type": "application/json",
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}
	const maxAttempts = Number.isFinite(SEND_MAX_ATTEMPTS) && SEND_MAX_ATTEMPTS > 0 ? SEND_MAX_ATTEMPTS : 3;
	const timeoutMs = Number.isFinite(SEND_TIMEOUT_MS) && SEND_TIMEOUT_MS > 0 ? SEND_TIMEOUT_MS : 15_000;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (response.ok) {
				return;
			}
			const body = await response.text();
			const retryableStatus = response.status === 429 || response.status >= 500;
			if (!retryableStatus || attempt === maxAttempts - 1) {
				throw new Error(`SIEM endpoint ${response.status}: ${body.slice(0, 500)}`);
			}
		} catch (error) {
			const retryableNetworkError =
				error instanceof Error &&
				(error.name === "AbortError" ||
					/timeout|network|fetch/i.test(error.message));
			if (!retryableNetworkError || attempt === maxAttempts - 1) {
				throw error;
			}
		} finally {
			clearTimeout(timeout);
		}
		const backoffMs = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
		await sleep(backoffMs);
	}
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

async function clearStaleCheckpointLock(lockPath) {
	let details;
	try {
		details = await stat(lockPath);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		return false;
	}
	if (Date.now() - details.mtimeMs < CHECKPOINT_LOCK_STALE_MS) {
		return false;
	}

	let ownerPid = null;
	try {
		const raw = (await readFile(lockPath, "utf8")).trim();
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			ownerPid = parsed;
		}
	} catch {
		// Ignore parse/read failures and treat as stale candidate.
	}

	if (ownerPid !== null && isProcessAlive(ownerPid)) {
		return false;
	}
	try {
		await unlink(lockPath);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
}

function buildCheckpointLockTimeoutError(lockPath, elapsedMs, waitMs) {
	const effectiveElapsed = Math.max(0, Math.floor(elapsedMs + waitMs));
	return new Error(`Timed out acquiring checkpoint lock after ${effectiveElapsed}ms: ${lockPath}`);
}

async function withCheckpointLock(checkpointPath, action) {
	const lockPath = `${checkpointPath}.lock`;
	const startedAt = Date.now();
	for (let attempt = 0; attempt < CHECKPOINT_LOCK_MAX_ATTEMPTS; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(`${process.pid}\n`, "utf8");
			} finally {
				await handle.close();
			}
			try {
				return await action();
			} finally {
				await unlink(lockPath).catch(() => {});
			}
		} catch (error) {
			const code = error?.code;
			const contention = code === "EEXIST" || code === "EPERM";
			if (!contention) {
				throw error;
			}
			if (await clearStaleCheckpointLock(lockPath)) {
				continue;
			}
			const backoffMs = 25 * 2 ** Math.min(attempt, 6);
			const elapsedMs = Date.now() - startedAt;
			if (
				attempt === CHECKPOINT_LOCK_MAX_ATTEMPTS - 1 ||
				elapsedMs >= CHECKPOINT_LOCK_MAX_WAIT_MS ||
				elapsedMs + backoffMs > CHECKPOINT_LOCK_MAX_WAIT_MS
			) {
				throw buildCheckpointLockTimeoutError(lockPath, elapsedMs, backoffMs);
			}
			await sleep(backoffMs);
		}
	}
	throw buildCheckpointLockTimeoutError(lockPath, Date.now() - startedAt, 0);
}

async function writeCheckpointAtomic(checkpointPath, checkpoint) {
	const tmpPath = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
	await withCheckpointLock(checkpointPath, async () => {
		await writeFile(tmpPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(tmpPath, checkpointPath);
	});
	await unlink(tmpPath).catch(() => {});
}

async function main() {
	const dryRun = hasFlag("--dry-run");
	const endpoint = parseArgValue("--endpoint") ?? process.env.CODEX_SIEM_ENDPOINT;
	const apiKey = parseArgValue("--api-key") ?? process.env.CODEX_SIEM_API_KEY;
	const batchSize = parseBatchSize(parseArgValue("--batch-size"));
	const root = resolveRoot();
	const logDir = resolve(parseArgValue("--log-dir") ?? join(root, "logs"));
	const checkpointPath = resolve(parseArgValue("--checkpoint") ?? join(root, "audit-forwarder-checkpoint.json"));

	await mkdir(dirname(checkpointPath), { recursive: true });
	const checkpoint = await loadCheckpoint(checkpointPath);
	const files = await discoverAuditFiles(logDir);
	const batch = await collectBatch(logDir, files, checkpoint, batchSize);

	if (batch.length === 0) {
		console.log(
			JSON.stringify(
				{
					command: "audit-log-forwarder",
					status: "noop",
					reason: "no-new-audit-events",
					logDir,
					checkpoint,
				},
				null,
				2,
			),
		);
		return;
	}

	const data = batch.map((item) => item.entry);
	const checksum = createHash("sha256").update(JSON.stringify(data)).digest("hex");
	const last = batch[batch.length - 1];
	const payload = {
		source: "codex-multi-auth",
		generatedAt: new Date().toISOString(),
		count: data.length,
		checksum,
		entries: data,
	};

	if (!dryRun) {
		if (!endpoint) {
			throw new Error("Missing --endpoint (or CODEX_SIEM_ENDPOINT) for audit export.");
		}
		await sendBatch({ endpoint, apiKey, payload });
	}

	const checkpointNext = {
		file: last?.file ?? checkpoint.file,
		line: last?.line ?? checkpoint.line,
		updatedAt: new Date().toISOString(),
	};
	if (!dryRun) {
		await writeCheckpointAtomic(checkpointPath, checkpointNext);
	}

	const newestMtime = (() => {
		const newest = files[files.length - 1];
		return newest ? join(logDir, newest) : null;
	})();
	let newestLogMtimeMs = null;
	if (newestMtime && existsSync(newestMtime)) {
		const metadata = await stat(newestMtime);
		newestLogMtimeMs = metadata.mtimeMs;
	}

	console.log(
		JSON.stringify(
			{
				command: "audit-log-forwarder",
				status: dryRun ? "dry-run" : "sent",
				dryRun,
				endpoint: endpoint ?? null,
				logDir,
				checkpointPath,
				sent: data.length,
				checksum,
				checkpoint: checkpointNext,
				newestLogMtimeMs,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(`audit-log-forwarder failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
