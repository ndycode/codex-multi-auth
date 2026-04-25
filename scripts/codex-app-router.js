#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

function parsePort(value) {
	if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) return Number.NaN;
	const port = Number(text);
	return Number.isInteger(port) && port >= 0 && port <= 65535
		? port
		: Number.NaN;
}

function parseArgs(argv) {
	const result = {
		host: "127.0.0.1",
		port: 0,
		statusPath: "",
		statePath: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1] ?? "";
		if (arg === "--host") {
			result.host = next;
			index += 1;
			continue;
		}
		if (arg === "--port") {
			result.port = parsePort(next);
			index += 1;
			continue;
		}
		if (arg === "--status") {
			result.statusPath = next;
			index += 1;
			continue;
		}
		if (arg === "--state") {
			result.statePath = next;
			index += 1;
		}
	}
	return result;
}

function readState(path) {
	if (!path) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function readTrimmedString(record, key) {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function writeStatus(statusPath, payload) {
	if (!statusPath) return;
	try {
		mkdirSync(dirname(statusPath), { recursive: true });
		writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch {
		// Status is best-effort. The router should keep serving if telemetry is locked.
	}
}

function createStatusPayload({ state, proxyServer, error, stateRecord }) {
	const proxyStatus =
		typeof proxyServer?.getStatus === "function" ? proxyServer.getStatus() : {};
	const lastAccountIndex = proxyStatus.lastAccountIndex ?? null;
	const lastAccountLabel =
		typeof proxyStatus.lastAccountLabel === "string" &&
		!proxyStatus.lastAccountLabel.includes("@")
			? proxyStatus.lastAccountLabel
			: typeof lastAccountIndex === "number"
				? `Account ${lastAccountIndex + 1}`
				: null;
	return {
		version: 1,
		kind: "codex-app-runtime-rotation-router",
		state,
		pid: process.pid,
		updatedAt: Date.now(),
		baseUrl: proxyServer?.baseUrl ?? stateRecord?.baseUrl ?? null,
		totalRequests: proxyStatus.totalRequests ?? 0,
		upstreamRequests: proxyStatus.upstreamRequests ?? 0,
		retries: proxyStatus.retries ?? 0,
		rotations: proxyStatus.rotations ?? 0,
		lastAccountIndex,
		lastAccountLabel,
		lastAccountId: proxyStatus.lastAccountId ?? null,
		lastAccountUpdatedAt: proxyStatus.lastAccountUpdatedAt ?? null,
		lastError: error ? (error instanceof Error ? error.message : String(error)) : proxyStatus.lastError ?? null,
	};
}

function isLoopbackHost(host) {
	if (typeof host !== "string") return false;
	const normalized = host.trim().toLowerCase();
	const unbracketed =
		normalized.startsWith("[") && normalized.endsWith("]")
			? normalized.slice(1, -1)
			: normalized;
	return (
		unbracketed === "127.0.0.1" ||
		unbracketed === "::1" ||
		unbracketed === "localhost"
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const stateRecord = readState(args.statePath);
	const host =
		typeof stateRecord?.host === "string" && stateRecord.host.trim().length > 0
			? stateRecord.host.trim()
			: args.host;
	const statePort = parsePort(stateRecord?.port);
	const port = Number.isFinite(statePort) ? statePort : args.port;
	const clientApiKey = readTrimmedString(stateRecord, "clientApiKey");
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(
			"A valid --port in the range 0-65535 is required for the Codex app runtime router.",
		);
	}
	if (!isLoopbackHost(host)) {
		throw new Error(
			"Codex app runtime router host must be loopback-only (127.0.0.1, ::1, or localhost).",
		);
	}

	let proxyServer = null;
	const writeCurrentStatus = (state, error) => {
		writeStatus(
			args.statusPath || stateRecord?.statusPath || "",
			createStatusPayload({ state, proxyServer, error, stateRecord }),
		);
	};

	try {
		const proxyModule = await import("../dist/lib/runtime-rotation-proxy.js");
		proxyServer = await proxyModule.startRuntimeRotationProxy({
			host,
			port,
			clientApiKey,
		});
		writeCurrentStatus("running");
		const timer = setInterval(() => writeCurrentStatus("running"), 1000);
		let cleanupPromise = null;
		const cleanup = async (state) => {
			clearInterval(timer);
			try {
				await proxyServer?.close?.();
			} finally {
				writeCurrentStatus(state);
			}
		};
		const cleanupOnce = (state) => {
			cleanupPromise ??= cleanup(state);
			return cleanupPromise;
		};
		process.once("SIGINT", () => {
			void cleanupOnce("stopped").finally(() => process.exit(130));
		});
		process.once("SIGTERM", () => {
			void cleanupOnce("stopped").finally(() => process.exit(0));
		});
		process.once("SIGHUP", () => {
			void cleanupOnce("stopped").finally(() => process.exit(0));
		});
		await new Promise(() => undefined);
	} catch (error) {
		writeCurrentStatus("error", error);
		throw error;
	}
}

main().catch((error) => {
	console.error(
		`codex-multi-auth app router failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
