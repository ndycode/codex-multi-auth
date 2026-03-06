import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const CONFIG_FILE_NAMES = [".codex.json", "Codex.json"];
const VARIANT_SUFFIX_RE = /-(none|minimal|low|medium|high|xhigh)$/i;
const SUPPORTED_REASONING_SUMMARIES = new Set(["auto", "concise", "detailed"]);
const SUPPORTED_TEXT_VERBOSITY = new Set(["low", "medium", "high"]);
const SUPPORTED_REASONING_EFFORT = new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

const MODEL_MAP = {
	"gpt-5-codex": "gpt-5-codex",
	"gpt-5-codex-none": "gpt-5-codex",
	"gpt-5-codex-minimal": "gpt-5-codex",
	"gpt-5-codex-low": "gpt-5-codex",
	"gpt-5-codex-medium": "gpt-5-codex",
	"gpt-5-codex-high": "gpt-5-codex",
	"gpt-5-codex-xhigh": "gpt-5-codex",
	"gpt-5.3-codex-spark": "gpt-5-codex",
	"gpt-5.3-codex-spark-low": "gpt-5-codex",
	"gpt-5.3-codex-spark-medium": "gpt-5-codex",
	"gpt-5.3-codex-spark-high": "gpt-5-codex",
	"gpt-5.3-codex-spark-xhigh": "gpt-5-codex",
	"gpt-5.3-codex": "gpt-5-codex",
	"gpt-5.3-codex-low": "gpt-5-codex",
	"gpt-5.3-codex-medium": "gpt-5-codex",
	"gpt-5.3-codex-high": "gpt-5-codex",
	"gpt-5.3-codex-xhigh": "gpt-5-codex",
	"gpt-5.1-codex": "gpt-5-codex",
	"gpt-5.1-codex-low": "gpt-5-codex",
	"gpt-5.1-codex-medium": "gpt-5-codex",
	"gpt-5.1-codex-high": "gpt-5-codex",
	"gpt-5.1-codex-max": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-low": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-medium": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-high": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-xhigh": "gpt-5.1-codex-max",
	"gpt-5.2": "gpt-5.2",
	"gpt-5.2-none": "gpt-5.2",
	"gpt-5.2-low": "gpt-5.2",
	"gpt-5.2-medium": "gpt-5.2",
	"gpt-5.2-high": "gpt-5.2",
	"gpt-5.2-xhigh": "gpt-5.2",
	"gpt-5.2-codex": "gpt-5-codex",
	"gpt-5.2-codex-low": "gpt-5-codex",
	"gpt-5.2-codex-medium": "gpt-5-codex",
	"gpt-5.2-codex-high": "gpt-5-codex",
	"gpt-5.2-codex-xhigh": "gpt-5-codex",
	"gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-medium": "gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-high": "gpt-5.1-codex-mini",
	"gpt-5.1": "gpt-5.1",
	"gpt-5.1-none": "gpt-5.1",
	"gpt-5.1-low": "gpt-5.1",
	"gpt-5.1-medium": "gpt-5.1",
	"gpt-5.1-high": "gpt-5.1",
	"gpt-5.1-chat-latest": "gpt-5.1",
	"gpt_5_codex": "gpt-5-codex",
	"codex-mini-latest": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini-medium": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini-high": "gpt-5.1-codex-mini",
	"gpt-5": "gpt-5.1",
	"gpt-5-mini": "gpt-5.1",
	"gpt-5-nano": "gpt-5.1",
};

function stripProviderPrefix(name) {
	return name.includes("/") ? (name.split("/").pop() ?? name) : name;
}

function getNormalizedModel(modelId) {
	if (Object.hasOwn(MODEL_MAP, modelId)) {
		return MODEL_MAP[modelId];
	}

	const lowerModelId = modelId.toLowerCase();
	const match = Object.keys(MODEL_MAP).find(
		(key) => key.toLowerCase() === lowerModelId,
	);

	return match ? MODEL_MAP[match] : undefined;
}

export function normalizeModel(model) {
	if (!model) return "gpt-5.1";

	const modelId = stripProviderPrefix(model);
	const mappedModel = getNormalizedModel(modelId);
	if (mappedModel) {
		return mappedModel;
	}

	const normalized = modelId.toLowerCase();
	if (
		normalized.includes("gpt-5.3-codex-spark") ||
		normalized.includes("gpt 5.3 codex spark")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.3-codex") ||
		normalized.includes("gpt 5.3 codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex")
	) {
		return "gpt-5-codex";
	}
	if (normalized.includes("gpt-5.2") || normalized.includes("gpt 5.2")) {
		return "gpt-5.2";
	}
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max")
	) {
		return "gpt-5.1-codex-max";
	}
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini")
	) {
		return "gpt-5.1-codex-mini";
	}
	if (
		normalized.includes("codex-mini-latest") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini")
	) {
		return "gpt-5.1-codex-mini";
	}
	if (
		normalized.includes("gpt-5-codex") ||
		normalized.includes("gpt 5 codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex")
	) {
		return "gpt-5-codex";
	}
	if (normalized.includes("gpt-5.1") || normalized.includes("gpt 5.1")) {
		return "gpt-5.1";
	}
	if (normalized.includes("codex")) {
		return "gpt-5-codex";
	}
	if (normalized.includes("gpt-5") || normalized.includes("gpt 5")) {
		return "gpt-5.1";
	}
	return "gpt-5.1";
}

function getVariantFromModelName(name) {
	const stripped = stripProviderPrefix(name).toLowerCase();
	const match = stripped.match(VARIANT_SUFFIX_RE);
	if (!match) return undefined;
	const variant = match[1];
	return SUPPORTED_REASONING_EFFORT.has(variant) ? variant : undefined;
}

function removeVariantSuffix(name) {
	return stripProviderPrefix(name).replace(VARIANT_SUFFIX_RE, "");
}

export function deriveUserConfigFromCodexConfig(config) {
	const provider = config?.provider?.openai;
	const global = provider?.options;
	const models = provider?.models;
	return {
		global: global && typeof global === "object" ? global : {},
		models: models && typeof models === "object" ? models : {},
	};
}

function findModelEntry(modelMap, candidates) {
	for (const key of candidates) {
		if (typeof key !== "string" || key.length === 0) continue;
		const entry = modelMap[key];
		if (entry && typeof entry === "object") {
			return { key, entry };
		}
	}
	return undefined;
}

export function getModelConfig(
	modelName,
	userConfig = { global: {}, models: {} },
) {
	const globalOptions =
		userConfig.global && typeof userConfig.global === "object" ? userConfig.global : {};
	const modelMap =
		userConfig.models && typeof userConfig.models === "object" ? userConfig.models : {};

	const strippedModelName = stripProviderPrefix(modelName);
	const normalizedModelName = normalizeModel(strippedModelName);
	const normalizedBaseModelName = normalizeModel(removeVariantSuffix(strippedModelName));
	const baseModelName = removeVariantSuffix(strippedModelName);
	const requestedVariant = getVariantFromModelName(strippedModelName);

	const directMatch = findModelEntry(modelMap, [modelName, strippedModelName]);
	if (directMatch?.entry?.options && typeof directMatch.entry.options === "object") {
		return { ...globalOptions, ...directMatch.entry.options };
	}

	const baseMatch = findModelEntry(modelMap, [
		baseModelName,
		normalizedBaseModelName,
		normalizedModelName,
	]);
	const baseOptions =
		baseMatch?.entry?.options && typeof baseMatch.entry.options === "object"
			? baseMatch.entry.options
			: {};

	const variantConfig =
		requestedVariant &&
		baseMatch?.entry?.variants &&
		typeof baseMatch.entry.variants === "object"
			? baseMatch.entry.variants[requestedVariant]
			: undefined;
	let variantOptions = {};
	if (variantConfig && typeof variantConfig === "object") {
		const { disabled: _disabled, ...rest } = variantConfig;
		void _disabled;
		variantOptions = rest;
	}

	return { ...globalOptions, ...baseOptions, ...variantOptions };
}

function normalizeCliReasoningSummary(value) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return SUPPORTED_REASONING_SUMMARIES.has(normalized) ? normalized : undefined;
}

function normalizeCliTextVerbosity(value) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return SUPPORTED_TEXT_VERBOSITY.has(normalized) ? normalized : undefined;
}

function normalizeCliReasoningEffort(value) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return SUPPORTED_REASONING_EFFORT.has(normalized) ? normalized : undefined;
}

export function loadNearestCodexConfig(startDir = process.cwd()) {
	let currentDir = resolve(startDir);
	while (true) {
		for (const fileName of CONFIG_FILE_NAMES) {
			const candidate = join(currentDir, fileName);
			if (!existsSync(candidate)) continue;
			try {
				const config = JSON.parse(readFileSync(candidate, "utf8"));
				return { path: candidate, config };
			} catch {
				return null;
			}
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export function resolveCliModelSelection(modelName, options = {}) {
	const userConfig =
		options.userConfig ??
		deriveUserConfigFromCodexConfig(loadNearestCodexConfig(options.cwd)?.config);
	const modelConfig = getModelConfig(modelName, userConfig);
	const configEntries = [];
	const reasoningEffort = normalizeCliReasoningEffort(modelConfig.reasoningEffort);
	const reasoningSummary = normalizeCliReasoningSummary(modelConfig.reasoningSummary);
	const textVerbosity = normalizeCliTextVerbosity(modelConfig.textVerbosity);

	if (reasoningEffort) {
		configEntries.push({
			key: "model_reasoning_effort",
			value: reasoningEffort,
		});
	}
	if (reasoningSummary) {
		configEntries.push({
			key: "model_reasoning_summary",
			value: reasoningSummary,
		});
	}
	if (textVerbosity) {
		configEntries.push({
			key: "model_text_verbosity",
			value: textVerbosity,
		});
	}

	return {
		model: normalizeModel(modelName),
		configEntries,
	};
}
