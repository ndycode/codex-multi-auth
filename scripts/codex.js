#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	resolveRealCodexBin as resolveRealCodexBinFromEnvironment,
	splitPathEntries,
} from "./codex-bin-resolver.js";
import { normalizeAuthAlias, shouldHandleMultiAuthAuth } from "./codex-routing.js";

const RETRYABLE_SHADOW_HOME_CLEANUP_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const SHADOW_HOME_CLEANUP_BACKOFF_MS = [20, 60, 120];
const SHADOW_HOME_STATE_FILES = ["auth.json", "accounts.json", ".codex-global-state.json"];
let shadowHomeCleanupBusyFailuresRemaining = Number.parseInt(
	process.env.CODEX_MULTI_AUTH_TEST_SHADOW_CLEANUP_BUSY_FAILURES ?? "0",
	10,
);
let shadowHomeCleanupPreflightReadBusyFailuresRemaining = Number.parseInt(
	process.env.CODEX_MULTI_AUTH_TEST_SHADOW_PREFLIGHT_READ_BUSY_FAILURES ?? "0",
	10,
);
const shadowHomeCleanupRetryMarkerDir =
	(process.env.CODEX_MULTI_AUTH_TEST_SHADOW_RETRY_MARKER_DIR ?? "").trim();

function isRetryableShadowHomeCleanupError(error) {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && RETRYABLE_SHADOW_HOME_CLEANUP_CODES.has(code);
}

function sleepSync(ms) {
	if (!Number.isFinite(ms) || ms <= 0) {
		return;
	}
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeDirectoryWithRetry(targetPath) {
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		try {
			maybeThrowSimulatedShadowHomeBusyError();
			rmSync(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (
				!isRetryableShadowHomeCleanupError(error) ||
				attempt === SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				throw error;
			}
			sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
		}
	}
}

function hydrateCliVersionEnv() {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("../package.json");
		const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
		if (version.length > 0) {
			process.env.CODEX_MULTI_AUTH_CLI_VERSION = version;
		}
	} catch {
		// Best effort only.
	}
}

async function loadRunCodexMultiAuthCli() {
	try {
		const mod = await import("../dist/lib/codex-manager.js");
		if (typeof mod.runCodexMultiAuthCli !== "function") {
			console.error(
				"dist/lib/codex-manager.js is missing required export: runCodexMultiAuthCli",
			);
			return null;
		}
		return mod.runCodexMultiAuthCli;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			console.error(
				[
					"codex-multi-auth auth commands require built runtime files, but dist output is missing.",
					"Run: npm run build",
				].join("\n"),
			);
			return null;
		}
		throw error;
	}
}

async function autoSyncManagerActiveSelectionIfEnabled() {
	const enabled = (process.env.CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP ?? "1").trim() !== "0";
	if (!enabled) return;

	try {
		const mod = await import("../dist/lib/codex-manager.js");
		if (typeof mod.autoSyncActiveAccountToCodex !== "function") {
			return;
		}
		await mod.autoSyncActiveAccountToCodex();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			// Non-auth command path should keep forwarding even if dist is missing.
			return;
		}
		// Best effort only: never block official Codex startup on sync failure.
	}
}

function resolveRealCodexBin() {
	const override = (process.env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (!existsSync(override)) {
			console.error(
				`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${override}`,
			);
			return null;
		}
		return resolveRealCodexBinFromEnvironment({
			moduleUrl: import.meta.url,
			env: process.env,
			existsSyncImpl: existsSync,
		});
	}

	return resolveRealCodexBinFromEnvironment({ moduleUrl: import.meta.url });
}

const CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN =
	/model is not supported when using codex with a chatgpt account/i;
const NORMALIZED_UNSUPPORTED_MODEL_PATTERN =
	/model ['"]([^'"]+)['"] is not currently available for this chatgpt account when using codex oauth/i;
const MODEL_ACCESS_DENIED_PATTERN =
	/the model [`'"]([^`'"]+)[`'"] does not exist or you do not have access to it/i;
const DIRECT_UNSUPPORTED_MODEL_PATTERN =
	/['"]([^'"]+)['"]\s+model is not supported when using codex with a chatgpt account/i;
const WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN = {
	"gpt-5.5": ["gpt-5.4"],
	"gpt-5.5-pro": ["gpt-5.4"],
};

function canonicalizeRequestedModelName(model) {
	if (typeof model !== "string") return "";
	const normalizedModel = normalizeRequestedModel(model);
	if (normalizedModel) {
		return normalizedModel;
	}

	const stripped = stripProviderPrefix(model).trim().toLowerCase();
	if (!stripped) {
		return "";
	}

	return stripped.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
}

function extractUnsupportedModelFromOutput(output) {
	if (typeof output !== "string" || output.length === 0) {
		return undefined;
	}

	const directMatch = output.match(DIRECT_UNSUPPORTED_MODEL_PATTERN);
	if (directMatch?.[1]) {
		return canonicalizeRequestedModelName(directMatch[1]);
	}

	const normalizedMatch = output.match(NORMALIZED_UNSUPPORTED_MODEL_PATTERN);
	if (normalizedMatch?.[1]) {
		return canonicalizeRequestedModelName(normalizedMatch[1]);
	}
	const accessDeniedMatch = output.match(MODEL_ACCESS_DENIED_PATTERN);
	if (accessDeniedMatch?.[1]) {
		return canonicalizeRequestedModelName(accessDeniedMatch[1]);
	}

	return undefined;
}

function resolveUnsupportedModelRetryTarget(
	requestedModel,
	output,
	attemptedModels = [],
) {
	if (
		typeof output !== "string" ||
		output.length === 0 ||
		(!CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(output) &&
			!NORMALIZED_UNSUPPORTED_MODEL_PATTERN.test(output) &&
			!MODEL_ACCESS_DENIED_PATTERN.test(output))
	) {
		return undefined;
	}

	const attempted = new Set(
		attemptedModels
			.map((model) => canonicalizeRequestedModelName(model))
			.filter(Boolean),
	);
	const normalizedRequestedModel = canonicalizeRequestedModelName(requestedModel);
	const blockedModel =
		extractUnsupportedModelFromOutput(output) ?? normalizedRequestedModel;
	const fallbackChain =
		WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN[blockedModel] ??
		(normalizedRequestedModel
			? WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN[normalizedRequestedModel]
			: undefined) ??
		[];

	for (const fallbackModel of fallbackChain) {
		if (fallbackModel !== blockedModel && !attempted.has(fallbackModel)) {
			return fallbackModel;
		}
	}

	return undefined;
}

function replaceRequestedModel(args, nextModel) {
	if (!nextModel) {
		return [...args];
	}

	const nextArgs = [...args];
	for (let i = 0; i < nextArgs.length; i += 1) {
		const arg = nextArgs[i];
		if (arg === "--model" && typeof nextArgs[i + 1] === "string") {
			nextArgs[i + 1] = nextModel;
			return nextArgs;
		}
		if (typeof arg === "string" && arg.startsWith("--model=")) {
			nextArgs[i] = `--model=${nextModel}`;
			return nextArgs;
		}
	}

	return nextArgs;
}

function shouldCaptureForwardedCodexOutput(env = process.env) {
	const override = (env.CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT ?? "").trim();
	if (override === "1") {
		return true;
	}
	if (override === "0") {
		return false;
	}
	// Windows child processes can report undefined isTTY; treat that as non-TTY so retry capture remains available.
	return process.stdout.isTTY !== true || process.stderr.isTTY !== true;
}

function forwardToRealCodexOnce(
	codexBin,
	args,
	env = process.env,
	cleanup,
	options = {},
) {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const captureOutput = options.captureOutput === true;
		const finalize = (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			try {
				cleanup?.();
			} catch {
				// Best-effort cleanup only.
			}
			resolve({
				exitCode,
				// No-capture output stays empty by design so retry parsing cannot
				// reintroduce pipes that break terminal passthrough.
				output: `${stdout}\n${stderr}`.trim(),
			});
		};

		const command = codexBin.launchWithNode ? process.execPath : codexBin.path;
		const commandArgs = codexBin.launchWithNode ? [codexBin.path, ...args] : args;
		let child;
		const failLaunch = (error) => {
			const message = `Failed to launch real Codex CLI: ${String(error)}`;
			stderr += `${stderr ? "\n" : ""}${message}`;
			console.error(message);
			finalize(1);
		};
		try {
			child = spawn(command, commandArgs, {
				stdio: captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
				env,
			});
		} catch (error) {
			failLaunch(error);
			return;
		}

		if (captureOutput) {
			child.stdout?.on("data", (chunk) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				stdout += text;
				process.stdout.write(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				stderr += text;
				process.stderr.write(chunk);
			});
		}

		child.once("error", (error) => {
			failLaunch(error);
		});

		child.once("close", (code, signal) => {
			if (signal) {
				const signalNumber = signal === "SIGINT" ? 130 : 1;
				finalize(signalNumber);
				return;
			}
			finalize(typeof code === "number" ? code : 1);
		});
	});
}

async function forwardToRealCodex(codexBin, rawArgs, baseEnv = process.env) {
	let currentArgs = [...rawArgs];
	let lastExitCode = 1;
	const attemptedModels = new Set();

	for (let attempt = 0; attempt < 4; attempt += 1) {
		const requestedModel = extractRequestedModel(currentArgs);
		if (requestedModel) {
			attemptedModels.add(requestedModel);
		}

		const { args: forwardArgs, requestedModel: compatibilityRequestedModel } =
			buildForwardArgs(currentArgs);
		const compatibility = createCompatibilityCodexHome(
			forwardArgs,
			compatibilityRequestedModel,
			baseEnv,
		);
		const result = await forwardToRealCodexOnce(
			codexBin,
			compatibility.args,
			compatibility.env,
			compatibility.cleanup,
			{
				captureOutput: shouldCaptureForwardedCodexOutput(compatibility.env),
			},
		);
		lastExitCode = result.exitCode;
		if (result.exitCode === 0) {
			return result.exitCode;
		}

		const fallbackModel = resolveUnsupportedModelRetryTarget(
			requestedModel,
			result.output,
			[...attemptedModels],
		);
		if (!fallbackModel) {
			return result.exitCode;
		}

		console.error(
			`codex-multi-auth: model ${requestedModel ?? "requested model"} is unsupported on this ChatGPT Codex surface. Retrying with ${fallbackModel}.`,
		);
		attemptedModels.add(fallbackModel);
		const nextArgs = replaceRequestedModel(currentArgs, fallbackModel);
		if (JSON.stringify(nextArgs) === JSON.stringify(currentArgs)) {
			return result.exitCode;
		}
		currentArgs = nextArgs;
	}

	return lastExitCode;
}

function hasCliAuthCredentialsStoreOverride(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-c" || arg === "--config") {
			const next = args[i + 1];
			if (!next || !next.includes("=")) continue;
			const [key] = next.split("=", 1);
			if ((key ?? "").trim() === "cli_auth_credentials_store") {
				return true;
			}
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--config=")) {
			const assignment = arg.slice("--config=".length);
			const [key] = assignment.split("=", 1);
			if ((key ?? "").trim() === "cli_auth_credentials_store") {
				return true;
			}
		}
	}
	return false;
}

// IMPORTANT: Keep this mapping in sync with
// `lib/request/helpers/model-map.ts` `MODEL_PROFILES`
// and its GPT-5 normalization helpers.
// This wrapper runs before the TypeScript build, so it cannot import that source.
const SUPPORTED_REASONING_EFFORTS_BY_MODEL = {
	"gpt-5-codex": ["low", "medium", "high", "xhigh"],
	"gpt-5.1-codex-max": ["medium", "high", "xhigh"],
	"gpt-5.1-codex-mini": ["medium", "high"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.5-pro": ["medium", "high", "xhigh"],
	"gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4-pro": ["medium", "high", "xhigh"],
	"gpt-5.2-pro": ["medium", "high", "xhigh"],
	"gpt-5-pro": ["high"],
	"gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1": ["none", "low", "medium", "high"],
	"gpt-5": ["minimal", "low", "medium", "high"],
	"gpt-5-mini": ["medium"],
	"gpt-5-nano": ["medium"],
};

const REASONING_FALLBACKS = {
	none: ["none", "low", "minimal", "medium", "high", "xhigh"],
	minimal: ["minimal", "low", "none", "medium", "high", "xhigh"],
	low: ["low", "minimal", "none", "medium", "high", "xhigh"],
	medium: ["medium", "low", "high", "minimal", "none", "xhigh"],
	high: ["high", "medium", "xhigh", "low", "minimal", "none"],
	xhigh: ["xhigh", "high", "medium", "low", "minimal", "none"],
};

const KNOWN_REASONING_EFFORTS = new Set(Object.keys(REASONING_FALLBACKS));
const REQUESTED_MODEL_ALIASES = new Map();
const DEFAULT_GENERAL_GPT5_MODEL = "gpt-5.4";
const GPT_5_5_CANONICAL_MODEL = "gpt-5.5";
const GPT_5_5_PRO_CANONICAL_MODEL = "gpt-5.5-pro";
const GPT_5_5_RELEASE_MODEL = "gpt-5.5-20260423";
const GPT_5_5_PRO_RELEASE_MODEL = "gpt-5.5-pro-20260423";
const GENERAL_GPT5_VERSION_CATALOG = {
	1: {
		base: "gpt-5.1",
	},
	2: {
		base: "gpt-5.2",
		pro: "gpt-5.2-pro",
	},
	4: {
		base: DEFAULT_GENERAL_GPT5_MODEL,
		pro: "gpt-5.4-pro",
		mini: "gpt-5-mini",
		nano: "gpt-5-nano",
	},
	5: {
		base: GPT_5_5_CANONICAL_MODEL,
		pro: GPT_5_5_PRO_CANONICAL_MODEL,
		mini: "gpt-5-mini",
		nano: "gpt-5-nano",
	},
};
const GENERAL_GPT5_STABLE_VARIANTS = GENERAL_GPT5_VERSION_CATALOG[4];
const GENERAL_GPT5_GENERIC_VARIANTS = {
	base: DEFAULT_GENERAL_GPT5_MODEL,
	pro: "gpt-5-pro",
	mini: "gpt-5-mini",
	nano: "gpt-5-nano",
};

function addRequestedModelAlias(alias, normalizedModel) {
	REQUESTED_MODEL_ALIASES.set(alias, normalizedModel);
}

function addRequestedModelReasoningAliases(alias, normalizedModel) {
	addRequestedModelAlias(alias, normalizedModel);
	for (const effort of KNOWN_REASONING_EFFORTS) {
		addRequestedModelAlias(`${alias}-${effort}`, normalizedModel);
	}
}

function maybeThrowSimulatedShadowHomeBusyError() {
	if (shadowHomeCleanupBusyFailuresRemaining > 0) {
		shadowHomeCleanupBusyFailuresRemaining -= 1;
		const error = new Error("simulated busy shadow-home operation");
		error.code = "EBUSY";
		throw error;
	}
}

function maybeThrowSimulatedShadowHomePreflightReadBusyError() {
	if (shadowHomeCleanupPreflightReadBusyFailuresRemaining > 0) {
		shadowHomeCleanupPreflightReadBusyFailuresRemaining -= 1;
		const error = new Error("simulated busy shadow-home preflight read");
		error.code = "EBUSY";
		throw error;
	}
}

function writeShadowHomeCleanupRetryMarker(destinationPath, attempt) {
	if (shadowHomeCleanupRetryMarkerDir.length === 0) {
		return;
	}
	try {
		mkdirSync(shadowHomeCleanupRetryMarkerDir, { recursive: true });
		writeFileSync(
			join(
				shadowHomeCleanupRetryMarkerDir,
				`${basename(destinationPath)}.retry-${attempt + 1}`,
			),
			`${attempt + 1}\n`,
			"utf8",
		);
	} catch {
		// Best-effort test hook only.
	}
}

function ensureShadowHomeDestinationMatchesSnapshot(destinationPath, expectedState) {
	if (!expectedState) {
		return;
	}
	const currentState = captureShadowHomeState(destinationPath, {
		rethrowRetryableReadErrors: true,
	});
	if (!shadowHomeStateMatches(currentState, expectedState)) {
		const error = new Error("shadow-home destination changed during sync-back retry");
		error.code = "EEXIST";
		throw error;
	}
}

function renameFileWithRetry(sourcePath, destinationPath, expectedDestinationState) {
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		try {
			ensureShadowHomeDestinationMatchesSnapshot(
				destinationPath,
				expectedDestinationState,
			);
			maybeThrowSimulatedShadowHomeBusyError();
			renameSync(sourcePath, destinationPath);
			return;
		} catch (error) {
			if (
				!isRetryableShadowHomeCleanupError(error) ||
				attempt === SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				throw error;
			}
			writeShadowHomeCleanupRetryMarker(destinationPath, attempt);
			sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
		}
	}
}

function seedRequestedModelAliases() {
	addRequestedModelReasoningAliases(
		GPT_5_5_CANONICAL_MODEL,
		GPT_5_5_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_RELEASE_MODEL,
		GPT_5_5_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_PRO_CANONICAL_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_PRO_RELEASE_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases("gpt-5.4", "gpt-5.4");
	addRequestedModelReasoningAliases("gpt-5.4-pro", "gpt-5.4-pro");
	addRequestedModelReasoningAliases("gpt-5.2-pro", "gpt-5.2-pro");
	addRequestedModelReasoningAliases("gpt-5-pro", "gpt-5-pro");
	addRequestedModelReasoningAliases("gpt-5.2", "gpt-5.2");
	addRequestedModelReasoningAliases("gpt-5.1", "gpt-5.1");
	addRequestedModelReasoningAliases("gpt-5", "gpt-5");
	addRequestedModelReasoningAliases("gpt-5-mini", "gpt-5-mini");
	addRequestedModelReasoningAliases("gpt-5-nano", "gpt-5-nano");
	addRequestedModelReasoningAliases("gpt-5.1-chat-latest", "gpt-5.1");
	addRequestedModelReasoningAliases("gpt-5-chat-latest", "gpt-5");
	addRequestedModelReasoningAliases("gpt-5.4-mini", "gpt-5-mini");
	addRequestedModelReasoningAliases("gpt-5.4-nano", "gpt-5-nano");
	addRequestedModelReasoningAliases("gpt-5-codex", "gpt-5-codex");
	addRequestedModelReasoningAliases("gpt-5.3-codex-spark", "gpt-5-codex");
	addRequestedModelReasoningAliases("gpt-5.3-codex", "gpt-5-codex");
	addRequestedModelReasoningAliases("gpt-5.2-codex", "gpt-5-codex");
	addRequestedModelReasoningAliases("gpt-5.1-codex", "gpt-5-codex");
	addRequestedModelAlias("gpt_5_codex", "gpt-5-codex");
	addRequestedModelReasoningAliases("codex-max", "gpt-5.1-codex-max");
	addRequestedModelReasoningAliases("gpt-5.1-codex-max", "gpt-5.1-codex-max");
	addRequestedModelAlias("codex-mini-latest", "gpt-5.1-codex-mini");
	addRequestedModelReasoningAliases("gpt-5-codex-mini", "gpt-5.1-codex-mini");
	addRequestedModelReasoningAliases("gpt-5.1-codex-mini", "gpt-5.1-codex-mini");
}

seedRequestedModelAliases();

function stripProviderPrefix(model) {
	return typeof model === "string" && model.includes("/")
		? model.split("/").pop() ?? model
		: model;
}

function tokenizeRequestedModel(model) {
	return String(model ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function getGeneralGpt5CatalogForMinor(minor) {
	switch (minor) {
		case 1:
		case 2:
		case 4:
		case 5:
			return GENERAL_GPT5_VERSION_CATALOG[minor];
		default:
			return undefined;
	}
}

function resolveGeneralGpt5CatalogVariant(catalog, variant) {
	return catalog?.[variant] ?? catalog?.base;
}

function resolveStableGeneralGpt5Variant(variant) {
	const fallback = (
		GENERAL_GPT5_STABLE_VARIANTS[variant] ??
		GENERAL_GPT5_STABLE_VARIANTS.base
	);
	if (!fallback) {
		throw new Error(`Stable GPT-5 fallback is missing for variant ${variant}`);
	}
	return fallback;
}

function resolveCodexRequestedModel(normalized) {
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max") ||
		normalized.includes("codex-max")
	) {
		return "gpt-5.1-codex-max";
	}
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini") ||
		normalized.includes("codex-mini-latest")
	) {
		return "gpt-5.1-codex-mini";
	}
	if (
		normalized.includes("gpt-5.3-codex-spark") ||
		normalized.includes("gpt 5.3 codex spark") ||
		normalized.includes("gpt-5.3-codex") ||
		normalized.includes("gpt 5.3 codex") ||
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex") ||
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex") ||
		normalized.includes("gpt-5-codex") ||
		normalized.includes("gpt 5 codex") ||
		normalized === "codex"
	) {
		return "gpt-5-codex";
	}

	return "";
}

function resolveGeneralGpt5RequestedModel(stripped) {
	const tokens = tokenizeRequestedModel(stripped);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt5 = gptIndex !== -1 && tokens[gptIndex + 1] === "5";
	if (!isGpt5 || tokens.includes("codex")) {
		return "";
	}

	const rawMinor = tokens[gptIndex + 2];
	const minor =
		typeof rawMinor === "string" && /^\d+$/.test(rawMinor)
			? Number(rawMinor)
			: undefined;
	const variant = tokens.includes("mini")
		? "mini"
		: tokens.includes("nano")
			? "nano"
			: tokens.includes("pro")
				? "pro"
				: "base";

	if (minor === undefined) {
		return GENERAL_GPT5_GENERIC_VARIANTS[variant];
	}

	const exactCatalog = getGeneralGpt5CatalogForMinor(minor);
	const exactMatch = resolveGeneralGpt5CatalogVariant(exactCatalog, variant);
	if (exactMatch) {
		return exactMatch;
	}

	return resolveStableGeneralGpt5Variant(variant);
}

function normalizeRequestedModel(model) {
	const stripped = stripProviderPrefix(model ?? "");
	const normalized = stripped.trim().toLowerCase();
	if (normalized.length === 0) return "";
	const exactMatch = REQUESTED_MODEL_ALIASES.get(normalized);
	if (exactMatch) {
		return exactMatch;
	}

	const codexModel = resolveCodexRequestedModel(normalized);
	if (codexModel) {
		return codexModel;
	}

	const generalModel = resolveGeneralGpt5RequestedModel(stripped);
	if (generalModel) {
		return generalModel;
	}

	return "";
}

function coerceReasoningEffortForModel(model, effort) {
	if (typeof effort !== "string") return effort;
	const normalizedEffort = effort.trim().toLowerCase();
	if (!KNOWN_REASONING_EFFORTS.has(normalizedEffort)) {
		return effort;
	}

	const normalizedModel = normalizeRequestedModel(model);
	const supportedEfforts =
		SUPPORTED_REASONING_EFFORTS_BY_MODEL[normalizedModel] ?? null;
	if (!supportedEfforts || supportedEfforts.includes(normalizedEffort)) {
		return normalizedEffort;
	}

	const fallbackOrder = REASONING_FALLBACKS[normalizedEffort] ?? [normalizedEffort];
	for (const candidate of fallbackOrder) {
		if (supportedEfforts.includes(candidate)) {
			return candidate;
		}
	}

	return normalizedEffort;
}

function extractRequestedModel(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--model") {
			const next = args[i + 1];
			if (typeof next === "string" && next.trim().length > 0) {
				return next.trim();
			}
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (value.length > 0) {
				return value;
			}
		}
	}
	return null;
}

function parseConfigAssignment(value) {
	if (typeof value !== "string") return null;
	const separatorIndex = value.indexOf("=");
	if (separatorIndex < 0) return null;
	return {
		key: value.slice(0, separatorIndex).trim(),
		value: value.slice(separatorIndex + 1).trim(),
	};
}

function parseQuotedValue(value) {
	if (typeof value !== "string") {
		return { quote: '"', inner: "" };
	}
	const trimmed = value.trim();
	const first = trimmed[0];
	const last = trimmed.at(-1);
	if ((first === '"' || first === "'") && last === first) {
		return {
			quote: first,
			inner: trimmed.slice(1, -1),
		};
	}
	return { quote: '"', inner: trimmed };
}

function rewriteReasoningConfigAssignment(assignment, requestedModel) {
	const parsed = parseConfigAssignment(assignment);
	if (!parsed || parsed.key !== "model_reasoning_effort") {
		return assignment;
	}

	const { quote, inner } = parseQuotedValue(parsed.value);
	const coercedEffort = coerceReasoningEffortForModel(requestedModel, inner);
	if (coercedEffort === inner) {
		return assignment;
	}

	return `${parsed.key}=${quote}${coercedEffort}${quote}`;
}

function rewriteReasoningConfigArgs(rawArgs) {
	const requestedModel = extractRequestedModel(rawArgs);
	if (!requestedModel) {
		return {
			args: [...rawArgs],
			requestedModel: null,
		};
	}

	const nextArgs = [...rawArgs];
	for (let i = 0; i < nextArgs.length; i += 1) {
		const arg = nextArgs[i];
		if ((arg === "-c" || arg === "--config") && typeof nextArgs[i + 1] === "string") {
			nextArgs[i + 1] = rewriteReasoningConfigAssignment(
				nextArgs[i + 1],
				requestedModel,
			);
			i += 1;
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--config=")) {
			const assignment = arg.slice("--config=".length);
			nextArgs[i] = `--config=${rewriteReasoningConfigAssignment(
				assignment,
				requestedModel,
			)}`;
		}
	}

	return {
		args: nextArgs,
		requestedModel,
	};
}

function resolveCodexHomeDir(env = process.env) {
	const override = (env.CODEX_HOME ?? "").trim();
	if (override.length > 0) return override;
	if (process.platform === "win32") {
		const homeDir = resolveWindowsUserHomeDir();
		if (homeDir) {
			return join(homeDir, ".codex");
		}
	}
	return join(env.HOME ?? homedir(), ".codex");
}

function ensureTrailingNewline(value) {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function captureShadowHomeState(filePath, options = {}) {
	try {
		if (!existsSync(filePath)) {
			return { exists: false, content: null };
		}
		if (options.rethrowRetryableReadErrors) {
			maybeThrowSimulatedShadowHomePreflightReadBusyError();
		}
		return {
			exists: true,
			content: readFileSync(filePath, "utf8"),
		};
	} catch (error) {
		if (options.rethrowRetryableReadErrors && isRetryableShadowHomeCleanupError(error)) {
			throw error;
		}
		return { exists: true, content: null, unreadable: true };
	}
}

function shadowHomeStateMatches(left, right) {
	return (
		left.exists === right.exists &&
		left.content === right.content &&
		Boolean(left.unreadable) === Boolean(right.unreadable)
	);
}

function syncShadowHomeStateFile(
	sourcePath,
	destinationPath,
	expectedDestinationState,
) {
	const tempPath = join(
		dirname(destinationPath),
		`.${basename(destinationPath)}.codex-multi-auth-sync-${process.pid}.tmp`,
	);
	try {
		mkdirSync(dirname(destinationPath), { recursive: true });
		copyFileSync(sourcePath, tempPath);
		renameFileWithRetry(tempPath, destinationPath, expectedDestinationState);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Best-effort cleanup only.
		}
		throw error;
	}
}

function rewriteConfigTomlReasoningEffort(rawConfig, requestedModel) {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	let changed = false;
	const nextLines = rawConfig.split(/\r?\n/).map((line) => {
		const quotedMatch = line.match(
			/^(\s*model_reasoning_effort\s*=\s*)(["'])([^"']+)(\2.*)$/,
		);
		const bareMatch = quotedMatch
			? null
			: line.match(
					/^(\s*model_reasoning_effort\s*=\s*)([^\s#]+)(\s*(?:#.*)?)$/,
				);
		if (!quotedMatch && !bareMatch) return line;

		const prefix = quotedMatch?.[1] ?? bareMatch?.[1] ?? "";
		const openingQuote = quotedMatch?.[2] ?? "";
		const currentEffort = quotedMatch?.[3] ?? bareMatch?.[2] ?? "";
		const suffix = quotedMatch?.[4] ?? bareMatch?.[3] ?? "";
		const coercedEffort = coerceReasoningEffortForModel(
			requestedModel,
			currentEffort,
		);
		if (coercedEffort === currentEffort) {
			return line;
		}

		changed = true;
		return quotedMatch
			? `${prefix}${openingQuote}${coercedEffort}${suffix}`
			: `${prefix}${coercedEffort}${suffix}`;
	});

	if (!changed) {
		return rawConfig;
	}

	return ensureTrailingNewline(nextLines.join(lineEnding));
}

function resolveOriginalMultiAuthDir(env) {
	const explicit = (env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (explicit.length > 0) {
		return explicit;
	}
	return undefined;
}

async function loadRuntimeObservabilityModule() {
	try {
		const mod = await import("../dist/lib/runtime/runtime-observability.js");
		if (
			typeof mod.loadPersistedRuntimeObservabilitySnapshot !== "function" ||
			typeof mod.mutateRuntimeObservabilitySnapshot !== "function"
		) {
			return null;
		}
		return mod;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
}

function isPureHelpOrVersionArgs(rawArgs) {
	if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
		return false;
	}
	return rawArgs.every((arg) =>
		typeof arg === "string" && ["--help", "-h", "--version", "-V"].includes(arg),
	);
}

function consumesNextArg(arg) {
	return new Set([
		"-c",
		"--config",
		"--enable",
		"--disable",
		"--remote",
		"--remote-auth-token-env",
		"-i",
		"--image",
		"-m",
		"--model",
		"--local-provider",
		"-p",
		"--profile",
		"-s",
		"--sandbox",
		"-a",
		"--ask-for-approval",
		"-C",
		"--cd",
		"--add-dir",
		"--output-schema",
		"--color",
		"-o",
		"--output-last-message",
	]).has(arg);
}

function shouldTrackForwardedRuntimeObservability(rawArgs) {
	if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
		return true;
	}
	if (isPureHelpOrVersionArgs(rawArgs)) {
		return false;
	}

	const requestCommands = new Set(["exec", "review", "resume", "fork"]);
	const nonRequestCommands = new Set([
		"help",
		"completion",
		"login",
		"logout",
		"mcp",
		"mcp-server",
		"app-server",
		"sandbox",
		"debug",
		"apply",
		"cloud",
		"features",
		"auth",
	]);

	for (let i = 0; i < rawArgs.length; i += 1) {
		const arg = rawArgs[i];
		if (typeof arg !== "string" || arg.length === 0) continue;
		if (arg === "--") {
			return i + 1 < rawArgs.length;
		}
		if (arg.startsWith("--config=")) {
			continue;
		}
		if (arg.startsWith("--") || (arg.startsWith("-") && arg !== "-")) {
			if (consumesNextArg(arg)) {
				i += 1;
			}
			continue;
		}
		if (requestCommands.has(arg)) {
			return true;
		}
		if (nonRequestCommands.has(arg)) {
			return false;
		}
		return true;
	}

	return true;
}

function createRuntimeSnapshotChangeToken(snapshot) {
	return JSON.stringify({
		updatedAt: snapshot?.updatedAt ?? null,
		responsesRequests: snapshot?.responsesRequests ?? null,
		authRefreshRequests: snapshot?.authRefreshRequests ?? null,
		diagnosticProbeRequests: snapshot?.diagnosticProbeRequests ?? null,
		totalRequests: snapshot?.runtimeMetrics?.totalRequests ?? null,
		successfulRequests: snapshot?.runtimeMetrics?.successfulRequests ?? null,
		failedRequests: snapshot?.runtimeMetrics?.failedRequests ?? null,
		lastRequestAt: snapshot?.runtimeMetrics?.lastRequestAt ?? null,
	});
}

async function loadRuntimeSnapshotWithRetry(runtimeObservabilityModule) {
	let snapshot = null;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		snapshot =
			(await runtimeObservabilityModule.loadPersistedRuntimeObservabilitySnapshot()) ??
			null;
		if (snapshot) {
			return snapshot;
		}
		if (attempt < 4) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	return snapshot;
}

async function withForwardedRuntimeObservability(rawArgs, runForwardedCommand) {
	if (!shouldTrackForwardedRuntimeObservability(rawArgs)) {
		return runForwardedCommand();
	}

	const runtimeObservabilityModule = await loadRuntimeObservabilityModule();
	if (!runtimeObservabilityModule) {
		return runForwardedCommand();
	}

	const beforeSnapshot = await loadRuntimeSnapshotWithRetry(runtimeObservabilityModule);
	const beforeToken = createRuntimeSnapshotChangeToken(beforeSnapshot);
	const startedAt = Date.now();
	const exitCode = await runForwardedCommand();
	const afterSnapshot = await loadRuntimeSnapshotWithRetry(runtimeObservabilityModule);
	const afterToken = createRuntimeSnapshotChangeToken(afterSnapshot);
	if (afterToken !== beforeToken) {
		return exitCode;
	}

	runtimeObservabilityModule.mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.currentRequestId = null;
		snapshot.responsesRequests += 1;
		snapshot.runtimeMetrics.totalRequests += 1;
		snapshot.runtimeMetrics.responsesRequests += 1;
		snapshot.runtimeMetrics.cumulativeLatencyMs += Math.max(0, Date.now() - startedAt);
		snapshot.runtimeMetrics.lastRequestAt = Date.now();
		if (!snapshot.runtimeMetrics.startedAt) {
			snapshot.runtimeMetrics.startedAt = startedAt;
		}
		if (exitCode === 0) {
			snapshot.runtimeMetrics.successfulRequests += 1;
			snapshot.runtimeMetrics.lastError = null;
		} else {
			snapshot.runtimeMetrics.failedRequests += 1;
			snapshot.runtimeMetrics.lastError = `forwarded-codex-exit:${exitCode}`;
		}
	});
	return exitCode;
}

function createCompatibilityCodexHome(
	processedArgs,
	requestedModel,
	baseEnv = process.env,
) {
	if (!requestedModel) {
		return { args: processedArgs, env: baseEnv, cleanup: undefined };
	}

	const originalCodexHome = resolveCodexHomeDir(baseEnv);
	const configPath = join(originalCodexHome, "config.toml");
	if (!existsSync(configPath)) {
		return { args: processedArgs, env: baseEnv, cleanup: undefined };
	}
	const originalShadowHomeState = new Map(
		SHADOW_HOME_STATE_FILES.map((name) => [
			name,
			captureShadowHomeState(join(originalCodexHome, name)),
		]),
	);

	const rawConfig = readFileSync(configPath, "utf8");
	const compatConfig = rewriteConfigTomlReasoningEffort(
		rawConfig,
		requestedModel,
	);
	if (compatConfig === rawConfig) {
		return { args: processedArgs, env: baseEnv, cleanup: undefined };
	}

	const shadowCodexHome = mkdtempSync(join(tmpdir(), "codex-multi-auth-home-"));
	const cleanup = () => {
		try {
			removeDirectoryWithRetry(shadowCodexHome);
		} catch {
			// Best-effort cleanup only.
		}
	};
	const tightenShadowHomePermissions = (path) => {
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best-effort only; permission semantics vary by platform.
		}
	};
	const syncShadowHomeStateBack = () => {
		for (const name of SHADOW_HOME_STATE_FILES) {
			const shadowPath = join(shadowCodexHome, name);
			const shadowState = captureShadowHomeState(shadowPath);
			if (!shadowState.exists || shadowState.unreadable) {
				continue;
			}

			try {
				const originalPath = join(originalCodexHome, name);
				const originalSnapshot =
					originalShadowHomeState.get(name) ?? { exists: false, content: null };
				const currentOriginalState = captureShadowHomeState(originalPath);
				if (!shadowHomeStateMatches(currentOriginalState, originalSnapshot)) {
					continue;
				}
				if (shadowHomeStateMatches(shadowState, originalSnapshot)) {
					continue;
				}
				syncShadowHomeStateFile(shadowPath, originalPath, originalSnapshot);
				tightenShadowHomePermissions(originalPath);
			} catch {
				// Best-effort only; runtime auth refreshes should not fail cleanup.
			}
		}
	};
	try {
		const compatConfigPath = join(shadowCodexHome, "config.toml");
		writeFileSync(compatConfigPath, compatConfig, "utf8");
		tightenShadowHomePermissions(compatConfigPath);
		for (const name of SHADOW_HOME_STATE_FILES) {
			const sourcePath = join(originalCodexHome, name);
			if (existsSync(sourcePath)) {
				const destinationPath = join(shadowCodexHome, name);
				copyFileSync(sourcePath, destinationPath);
				tightenShadowHomePermissions(destinationPath);
			}
		}
	} catch (error) {
		cleanup();
		throw error;
	}
	const cleanupWithSync = () => {
		syncShadowHomeStateBack();
		cleanup();
	};

	const forwardedEnv = {
		...baseEnv,
		CODEX_HOME: shadowCodexHome,
	};
	const originalMultiAuthDir = resolveOriginalMultiAuthDir(baseEnv);
	if (originalMultiAuthDir) {
		forwardedEnv.CODEX_MULTI_AUTH_DIR = originalMultiAuthDir;
	}

	return {
		args: processedArgs,
		env: forwardedEnv,
		cleanup: cleanupWithSync,
	};
}

function buildForwardArgs(rawArgs) {
	const { args: compatibilityArgs, requestedModel } = rewriteReasoningConfigArgs(rawArgs);
	const forceFileAuthStore = (process.env.CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE ?? "1").trim() !== "0";
	if (!forceFileAuthStore) {
		return { args: compatibilityArgs, requestedModel };
	}
	if (hasCliAuthCredentialsStoreOverride(compatibilityArgs)) {
		return { args: compatibilityArgs, requestedModel };
	}

	return {
		args: [
			...compatibilityArgs,
			"-c",
			'cli_auth_credentials_store="file"',
		],
		requestedModel,
	};
}

function normalizeExitCode(value) {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	const parsed = Number(value);
	if (Number.isInteger(parsed)) {
		return parsed;
	}
	return 1;
}

const WINDOWS_SHIM_MARKER = "codex-multi-auth windows shim guardian v1";
const POWERSHELL_PROFILE_MARKER_START = "# >>> codex-multi-auth shell guard >>>";
const POWERSHELL_PROFILE_MARKER_END = "# <<< codex-multi-auth shell guard <<<";

function shouldInstallWindowsBatchShimGuard() {
	if (process.platform !== "win32") return false;
	const override = (process.env.CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD ?? "0").trim();
	return override !== "0";
}

function resolveWindowsShimDirectoryFromInvocation() {
	const invokedScript = (process.argv[1] ?? "").trim();
	if (invokedScript.length === 0) return null;
	const resolvedScript = resolvePath(invokedScript);
	const scriptDir = dirname(resolvedScript);
	const packageRoot = dirname(scriptDir);
	const nodeModulesDir = dirname(packageRoot);
	if (basename(nodeModulesDir).toLowerCase() !== "node_modules") {
		return null;
	}
	const shimDir = dirname(nodeModulesDir);
	if (existsSync(join(shimDir, "codex-multi-auth.cmd"))) {
		return shimDir;
	}
	return null;
}

function resolveWindowsShimDirectoryFromPath() {
	const fromInvocation = resolveWindowsShimDirectoryFromInvocation();
	if (fromInvocation) {
		return fromInvocation;
	}
	const pathEntries = splitPathEntries(process.env.PATH ?? process.env.Path ?? "");
	for (const entry of pathEntries) {
		if (existsSync(join(entry, "codex-multi-auth.cmd"))) {
			return entry;
		}
	}
	return null;
}

function buildWindowsBatchShimContent() {
	return [
		"@ECHO off",
		`:: ${WINDOWS_SHIM_MARKER}`,
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		'  SET PATHEXT=%PATHEXT:;.JS;=%',
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
	].join("\r\n");
}

function buildWindowsCmdShimContent() {
	return [
		"@ECHO off",
		`:: ${WINDOWS_SHIM_MARKER}`,
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		'  SET PATHEXT=%PATHEXT:;.JS;=%',
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
	].join("\r\n");
}

function buildWindowsPowerShellShimContent() {
	return [
		`# ${WINDOWS_SHIM_MARKER}`,
		"$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
		"",
		'$exe=""',
		'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
		'  $exe=".exe"',
		"}",
		"$ret=0",
		'if (Test-Path "$basedir/node$exe") {',
		"  if ($MyInvocation.ExpectingInput) {",
		'    $input | & "$basedir/node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  } else {",
		'    & "$basedir/node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  }",
		"  $ret=$LASTEXITCODE",
		"} else {",
		"  if ($MyInvocation.ExpectingInput) {",
		'    $input | & "node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  } else {",
		'    & "node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  }",
		"  $ret=$LASTEXITCODE",
		"}",
		"if ($null -eq $ret) {",
		"  exit 0",
		"}",
		"exit $ret",
	].join("\r\n");
}

function ensureWindowsShellShim(filePath, desiredContent, options = {}) {
	const {
		overwriteCustomShim = false,
		shimMarker = WINDOWS_SHIM_MARKER,
	} = options;

	let currentContent = "";
	if (existsSync(filePath)) {
		try {
			currentContent = readFileSync(filePath, "utf8");
		} catch {
			return false;
		}
		if (currentContent === desiredContent || currentContent.includes(shimMarker)) {
			if (currentContent !== desiredContent) {
				try {
					writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
					return true;
				} catch {
					return false;
				}
			}
			return false;
		}
		const looksLikeStockOpenAiShim =
			currentContent.includes("node_modules\\@openai\\codex\\bin\\codex.js") ||
			currentContent.includes("node_modules/@openai/codex/bin/codex.js") ||
			currentContent.includes("@openai\\codex-win32-") ||
			currentContent.includes("@openai/codex-win32-") ||
			currentContent.includes("vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe") ||
			currentContent.includes("vendor\\aarch64-pc-windows-msvc\\codex\\codex.exe") ||
			currentContent.includes("vendor/x86_64-pc-windows-msvc/codex/codex.exe") ||
			currentContent.includes("vendor/aarch64-pc-windows-msvc/codex/codex.exe");
		if (looksLikeStockOpenAiShim) {
			try {
				writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
				return true;
			} catch {
				return false;
			}
		}
		if (!overwriteCustomShim) {
			return false;
		}
	}

	try {
		writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
		return true;
	} catch {
		return false;
	}
}

function shouldInstallPowerShellProfileGuard() {
	if (process.platform !== "win32") return false;
	const override = (process.env.CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD ?? "0").trim();
	return override !== "0";
}

function resolveWindowsUserHomeDir() {
	const userProfile = (process.env.USERPROFILE ?? "").trim();
	if (userProfile.length > 0) return userProfile;
	const homeDrive = (process.env.HOMEDRIVE ?? "").trim();
	const homePath = (process.env.HOMEPATH ?? "").trim();
	if (homeDrive.length > 0 && homePath.length > 0) {
		return `${homeDrive}${homePath}`;
	}
	const home = (process.env.HOME ?? "").trim();
	return home;
}

function buildPowerShellProfileGuardBlock(shimDirectory) {
	const codexBatchPath = join(shimDirectory, "codex.bat").replace(/\\/g, "\\\\");
	return [
		POWERSHELL_PROFILE_MARKER_START,
		`$CodexMultiAuthShim = "${codexBatchPath}"`,
		"if (Test-Path $CodexMultiAuthShim) {",
		"  function global:codex {",
		"    & $CodexMultiAuthShim @args",
		"  }",
		"}",
		POWERSHELL_PROFILE_MARKER_END,
	].join("\r\n");
}

function upsertPowerShellProfileGuard(profilePath, guardBlock) {
	let content = "";
	if (existsSync(profilePath)) {
		try {
			content = readFileSync(profilePath, "utf8");
		} catch {
			return false;
		}
	}
	const normalizedCurrentContent = content.replace(/\r?\n$/, "");

	const startIndex = content.indexOf(POWERSHELL_PROFILE_MARKER_START);
	const endIndex = content.indexOf(POWERSHELL_PROFILE_MARKER_END);
	let nextContent;
	if (startIndex >= 0 && endIndex >= startIndex) {
		const endWithMarker = endIndex + POWERSHELL_PROFILE_MARKER_END.length;
		const prefix = content.slice(0, startIndex).replace(/\s*$/, "");
		const suffix = content.slice(endWithMarker).replace(/^\s*/, "");
		nextContent = `${prefix}\r\n\r\n${guardBlock}\r\n\r\n${suffix}`.trimEnd();
	} else if (normalizedCurrentContent.trim().length === 0) {
		nextContent = guardBlock;
	} else {
		nextContent = `${normalizedCurrentContent.replace(/\s*$/, "")}\r\n\r\n${guardBlock}`;
	}

	if (nextContent === normalizedCurrentContent) {
		return false;
	}

	try {
		mkdirSync(dirname(profilePath), { recursive: true });
		writeFileSync(profilePath, `${nextContent}\r\n`, { encoding: "utf8", mode: 0o644 });
		return true;
	} catch {
		return false;
	}
}

function ensurePowerShellProfileGuard(shimDirectory) {
	if (!shouldInstallPowerShellProfileGuard()) return false;
	const homeDir = resolveWindowsUserHomeDir();
	if (!homeDir) return false;
	const guardBlock = buildPowerShellProfileGuardBlock(shimDirectory);
	const profilePaths = [
		join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(homeDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
	];
	let changed = false;
	for (const profilePath of profilePaths) {
		changed = upsertPowerShellProfileGuard(profilePath, guardBlock) || changed;
	}
	return changed;
}

function ensureWindowsShellShimGuards() {
	const shouldInstallBatchGuard = shouldInstallWindowsBatchShimGuard();
	const shouldInstallProfileGuard = shouldInstallPowerShellProfileGuard();
	if (!shouldInstallBatchGuard && !shouldInstallProfileGuard) return;
	const shimDirectory = resolveWindowsShimDirectoryFromPath();
	if (!shimDirectory) return;

	const codexMultiAuthShimPath = join(shimDirectory, "codex-multi-auth.cmd");
	if (!existsSync(codexMultiAuthShimPath)) return;

	const overwriteCustomShim =
		(process.env.CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM ?? "0").trim() === "1";
	const installedBatch = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.bat"),
				buildWindowsBatchShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedCmd = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.cmd"),
				buildWindowsCmdShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedPs1 = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.ps1"),
				buildWindowsPowerShellShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedAny = installedBatch || installedCmd || installedPs1;
	const installedProfileGuard = shouldInstallProfileGuard
		? ensurePowerShellProfileGuard(shimDirectory)
		: false;
	if (installedAny || installedProfileGuard) {
		console.error(
			"codex-multi-auth: installed Windows shell guards to keep multi-auth routing after codex npm updates.",
		);
	}
}

async function main() {
	hydrateCliVersionEnv();
	ensureWindowsShellShimGuards();

	const rawArgs = process.argv.slice(2);
	const normalizedArgs = normalizeAuthAlias(rawArgs);
	const bypass = (process.env.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1";

	if (!bypass && shouldHandleMultiAuthAuth(normalizedArgs)) {
		try {
			const runCodexMultiAuthCli = await loadRunCodexMultiAuthCli();
			if (!runCodexMultiAuthCli) {
				return 1;
			}
			const exitCode = await runCodexMultiAuthCli(normalizedArgs);
			return normalizeExitCode(exitCode);
		} catch (error) {
			console.error(
				`codex-multi-auth runner failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
	}

	const realCodexBin = resolveRealCodexBin();
	if (!realCodexBin) {
		console.error(
			[
				"Could not locate the official Codex CLI.",
				"Install it with npm, Homebrew, or an official native release so `codex` is on PATH.",
				"Or set CODEX_MULTI_AUTH_REAL_CODEX_BIN to the full path of either codex or @openai/codex/bin/codex.js.",
			].join("\n"),
		);
		return 1;
	}

	await autoSyncManagerActiveSelectionIfEnabled();
	return withForwardedRuntimeObservability(rawArgs, () =>
		forwardToRealCodex(realCodexBin, rawArgs),
	);
}

const exitCode = await main();
process.exitCode = normalizeExitCode(exitCode);
