#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BATCH_SIZE = 500;

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
	files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	return files;
}

function fileComesBefore(left, right) {
	return left.localeCompare(right, undefined, { sensitivity: "base" }) < 0;
}

async function collectBatch(logDir, files, checkpoint, batchSize) {
	const entries = [];
	for (const file of files) {
		if (checkpoint.file && fileComesBefore(file, checkpoint.file)) {
			continue;
		}

		const fullPath = join(logDir, file);
		let lineNumber = 0;
		const raw = await readFile(fullPath, "utf8");
		const lines = raw.split(/\r?\n/);
		for (const line of lines) {
			if (!line.trim()) continue;
			lineNumber += 1;

			if (checkpoint.file === file && lineNumber <= checkpoint.line) {
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
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`SIEM endpoint ${response.status}: ${body.slice(0, 500)}`);
	}
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
	await writeFile(checkpointPath, `${JSON.stringify(checkpointNext, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});

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
