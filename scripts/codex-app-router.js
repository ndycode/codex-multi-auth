#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

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
			result.port = Number.parseInt(next, 10);
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
		lastAccountIndex: proxyStatus.lastAccountIndex ?? null,
		lastAccountLabel: proxyStatus.lastAccountLabel ?? null,
		lastAccountEmail: proxyStatus.lastAccountEmail ?? null,
		lastAccountId: proxyStatus.lastAccountId ?? null,
		lastAccountUpdatedAt: proxyStatus.lastAccountUpdatedAt ?? null,
		lastError: error ? (error instanceof Error ? error.message : String(error)) : proxyStatus.lastError ?? null,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const stateRecord = readState(args.statePath);
	const host =
		typeof stateRecord?.host === "string" && stateRecord.host.trim().length > 0
			? stateRecord.host.trim()
			: args.host;
	const port =
		typeof stateRecord?.port === "number" && Number.isFinite(stateRecord.port)
			? stateRecord.port
			: args.port;
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error("A positive --port is required for the Codex app runtime router.");
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
		proxyServer = await proxyModule.startRuntimeRotationProxy({ host, port });
		writeCurrentStatus("running");
		const timer = setInterval(() => writeCurrentStatus("running"), 1000);
		const cleanup = async (state) => {
			clearInterval(timer);
			try {
				await proxyServer?.close?.();
			} finally {
				writeCurrentStatus(state);
			}
		};
		process.once("SIGINT", () => {
			void cleanup("stopped").finally(() => process.exit(130));
		});
		process.once("SIGTERM", () => {
			void cleanup("stopped").finally(() => process.exit(0));
		});
		process.once("SIGHUP", () => {
			void cleanup("stopped").finally(() => process.exit(0));
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
