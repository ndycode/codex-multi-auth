#!/usr/bin/env node

import {
	chmodSync,
	closeSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const LOG_SIZE_CHECK_INTERVAL_MS = 60_000;

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
		identityToken: "",
		statePath: "",
		logPath: "",
		maxLogBytes: DEFAULT_MAX_LOG_BYTES,
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
		if (arg === "--identity-token") {
			result.identityToken = next;
			index += 1;
			continue;
		}
		if (arg === "--state") {
			result.statePath = next;
			index += 1;
			continue;
		}
		if (arg === "--max-log-bytes") {
			const parsed = Number.parseInt(next, 10);
			result.maxLogBytes =
				Number.isFinite(parsed) && parsed > 0
					? parsed
					: DEFAULT_MAX_LOG_BYTES;
			index += 1;
			continue;
		}
		if (arg === "--log") {
			result.logPath = next;
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
	const statusDir = dirname(statusPath);
	const tempPath = join(
		statusDir,
		[
			`.${basename(statusPath)}`,
			String(process.pid),
			String(Date.now()),
			"tmp",
		].join("."),
	);
	let fd = null;
	try {
		mkdirSync(statusDir, { recursive: true });
		fd = openSync(tempPath, "w", 0o600);
		writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		closeSync(fd);
		fd = null;
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, statusPath);
		chmodSync(statusPath, 0o600);
	} catch {
		// Status is best-effort. The router should keep serving if telemetry is locked.
		try {
			if (fd !== null) closeSync(fd);
		} catch {
			// Preserve the original status-write failure.
		}
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Preserve the original status-write failure.
		}
	}
}

// Status history is untrusted local JSON; retain only safe operational fields.
function readDisconnect(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { at, cause, stage, closeCode, routeKind, connectionAgeMs, eventCount } = value;
	const transport = {};
	for (const key of ["requestBytes", "inputItemCount"]) {
		const field = value[key];
		if (field !== undefined) {
			if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) return null;
			transport[key] = field;
		}
	}
	for (const key of ["isPrewarm", "hasPreviousResponse", "reusedConnection", "sendCompleted", "compressionNegotiated", "tcpEndReceived", "tcpCloseHadError"]) {
		const field = value[key];
		if (field !== undefined) {
			if (typeof field !== "boolean") return null;
			transport[key] = field;
		}
	}
	if (value.transportErrorCode !== undefined) {
		if (!["ECONNRESET", "EPIPE", "ETIMEDOUT", "OTHER"].includes(value.transportErrorCode)) return null;
		transport.transportErrorCode = value.transportErrorCode;
	}
	if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 8.64e15) return null;
	if (!["close", "transport_error", "invalid_event", "buffer_limit", "send_error"].includes(cause)) return null;
	if (!["awaiting_first_event", "streaming"].includes(stage)) return null;
	if (routeKind !== undefined && !["oauth", "api", "zdr", "psp"].includes(routeKind)) return null;
	if (closeCode !== undefined && (!Number.isInteger(closeCode) || closeCode < 1000 || closeCode > 4999)) return null;
	for (const count of [connectionAgeMs, eventCount]) {
		if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) return null;
	}
	return {
		at, cause, stage,
		...(closeCode !== undefined ? { closeCode } : {}),
		...(routeKind !== undefined ? { routeKind } : {}),
		...(connectionAgeMs !== undefined ? { connectionAgeMs } : {}),
		...(eventCount !== undefined ? { eventCount } : {}),
		...transport,
	};
}

function readWebsocketCounter(value, maximum = Number.MAX_SAFE_INTEGER) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
		? value : null;
}

function readUpgradeRejection(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { at, reason, status, activeConnections } = value;
	if (readWebsocketCounter(at, 8.64e15) === null || readWebsocketCounter(activeConnections, 64) === null) return null;
	if (!((reason === "origin" && status === 403) ||
		((reason === "capacity" || reason === "repeated_disconnect") && status === 426))) return null;
	return { at, reason, status, activeConnections };
}

function createStatusPayload({
	state,
	proxyServer,
	error,
	stateRecord,
	startedAt,
	statusPath,
	routerScriptPath,
	identityToken,
	previousDisconnect = null,
	previousUpgradeRejection = null,
}) {
	const proxyStatus =
		typeof proxyServer?.getStatus === "function" ? proxyServer.getStatus() : {};
	const currentDisconnect = readDisconnect(proxyStatus.lastWebsocketDisconnect);
	// A current-process event is newer history even after wall-clock rollback.
	const lastDisconnect = currentDisconnect ?? previousDisconnect;
	const lastUpgradeRejection = readUpgradeRejection(proxyStatus.lastWebsocketUpgradeRejection) ?? previousUpgradeRejection;
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
		startedAt,
		statusPath: statusPath || readTrimmedString(stateRecord, "statusPath") || null,
		identityToken:
			identityToken || readTrimmedString(stateRecord, "identityToken") || null,
		routerScriptPath:
			routerScriptPath ||
			readTrimmedString(stateRecord, "routerScriptPath") ||
			process.argv[1] ||
			null,
		updatedAt: Date.now(),
		baseUrl: proxyServer?.baseUrl ?? stateRecord?.baseUrl ?? null,
		schedulingStrategy: proxyStatus.schedulingStrategy,
		totalRequests: proxyStatus.totalRequests ?? 0,
		upstreamRequests: proxyStatus.upstreamRequests ?? 0,
		websocketConnections: proxyStatus.websocketConnections ?? 0,
		websocketUpstreamRequests: proxyStatus.websocketUpstreamRequests ?? 0,
		websocketActiveConnections: readWebsocketCounter(proxyStatus.websocketActiveConnections, 64) ?? 0,
		websocketCapacityReclaims: readWebsocketCounter(proxyStatus.websocketCapacityReclaims) ?? 0,
		lastWebsocketUpgradeRejection: lastUpgradeRejection,
		lastWebsocketDisconnect: lastDisconnect,
		streamQuotaUpdates: proxyStatus.streamQuotaUpdates ?? 0,
		lastStreamQuotaUpdateAt: proxyStatus.lastStreamQuotaUpdateAt ?? null,
		retries: proxyStatus.retries ?? 0,
		lunaReserveFallbacks: proxyStatus.lunaReserveFallbacks ?? 0,
		rotations: proxyStatus.rotations ?? 0,
		lastAccountIndex,
		lastAccountLabel,
		lastAccountId: proxyStatus.lastAccountId ?? null,
		lastRequestedWorkspaceId: proxyStatus.lastRequestedWorkspaceId ?? null,
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

function truncateLogFdIfTooLarge(fd, maxBytes) {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.size <= maxBytes) return;
		ftruncateSync(fd, 0);
		writeSync(
			fd,
			`codex-multi-auth app router log truncated after exceeding ${maxBytes} bytes\n`,
		);
	} catch {
		// stdout/stderr may be pipes or otherwise unavailable; logging must not fail startup.
	}
}

function truncateLogPathIfTooLarge(logPath, maxBytes) {
	if (!logPath || !Number.isFinite(maxBytes) || maxBytes <= 0) return false;
	try {
		const stats = statSync(logPath);
		if (!stats.isFile() || stats.size <= maxBytes) return false;
		truncateSync(logPath, 0);
		return true;
	} catch {
		// Log path may not exist yet or may be locked; fd-level checks can still work.
		return false;
	}
}

function writeLogTruncatedMarker(maxBytes) {
	try {
		writeSync(
			1,
			`codex-multi-auth app router log truncated after exceeding ${maxBytes} bytes\n`,
		);
	} catch {
		// A closed stdout/stderr should not crash the router while enforcing log bounds.
	}
}

function installLogBounds(maxBytes, logPath) {
	if (truncateLogPathIfTooLarge(logPath, maxBytes)) {
		writeLogTruncatedMarker(maxBytes);
	}
	truncateLogFdIfTooLarge(1, maxBytes);
	truncateLogFdIfTooLarge(2, maxBytes);
	return setInterval(() => {
		if (truncateLogPathIfTooLarge(logPath, maxBytes)) {
			writeLogTruncatedMarker(maxBytes);
		}
		truncateLogFdIfTooLarge(1, maxBytes);
		truncateLogFdIfTooLarge(2, maxBytes);
	}, LOG_SIZE_CHECK_INTERVAL_MS);
}

async function main() {
	const routerStartedAt = Date.now();
	const args = parseArgs(process.argv.slice(2));
	installLogBounds(args.maxLogBytes, args.logPath).unref?.();
	const stateRecord = readState(args.statePath);
	const previousStatus = readState(args.statusPath || stateRecord?.statusPath || "");
	let previousDisconnect = readDisconnect(previousStatus?.lastWebsocketDisconnect);
	let previousUpgradeRejection = readUpgradeRejection(previousStatus?.lastWebsocketUpgradeRejection);
	if (args.statePath && stateRecord === null) {
		const error = new Error(
			"Codex app runtime router state is unreadable; refusing to bind an ephemeral port.",
		);
		writeStatus(
			args.statusPath,
			createStatusPayload({
				previousDisconnect,
				previousUpgradeRejection,
				state: "error",
				proxyServer: null,
				error,
				stateRecord: null,
				startedAt: routerStartedAt,
				statusPath: args.statusPath,
				routerScriptPath: process.argv[1],
				identityToken: args.identityToken,
			}),
		);
		throw error;
	}
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
	if (!clientApiKey) {
		throw new Error(
			"Codex app runtime router state is missing its client token.",
		);
	}

	let proxyServer = null;
	const writeCurrentStatus = (state, error) => {
		const payload = createStatusPayload({
			previousDisconnect,
			previousUpgradeRejection,
			state,
			proxyServer,
			error,
			stateRecord,
			startedAt: routerStartedAt,
			statusPath: args.statusPath || stateRecord?.statusPath || "",
			routerScriptPath: stateRecord?.routerScriptPath || process.argv[1],
			identityToken: args.identityToken || stateRecord?.identityToken || "",
		});
		previousDisconnect = payload.lastWebsocketDisconnect;
		previousUpgradeRejection = payload.lastWebsocketUpgradeRejection;
		writeStatus(args.statusPath || stateRecord?.statusPath || "", payload);
	};

	try {
		const proxyModule = await import("../dist/lib/runtime-rotation-proxy.js");
		// `rotation bind-app --upstream` chains a local proxy behind the router
		// (#753). The proxy library re-validates it before any token is sent.
		const upstreamBaseUrl = readTrimmedString(stateRecord, "upstreamBaseUrl");
		proxyServer = await proxyModule.startRuntimeRotationProxy({
			nativeOpenai: stateRecord?.nativeOpenai === true,
			catalogAccount: stateRecord?.catalogAccount,
			host,
			port,
			clientApiKey,
			...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
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
