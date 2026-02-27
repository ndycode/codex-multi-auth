import { spawnSync } from "node:child_process";
import { resolveCodexExecutable } from "./Codex.mjs";

const FALLBACK_OPENAI_CODEX_STABLE = [
  "openai/gpt-5-codex",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.1-codex-max",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
];

const OPENAI_CODEX_PREFIXES = ["openai/", "openai-multi/"];

export function isOpenAiCodexProviderPrefix(modelId) {
  return OPENAI_CODEX_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export function codexTail(modelId) {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

export function canonicalCodexModelId(modelId) {
  return `openai/${codexTail(modelId)}`;
}

export function aliasCandidatesForCodexModel(modelId) {
  if (!isOpenAiCodexProviderPrefix(modelId)) {
    return [modelId];
  }
  const tail = codexTail(modelId);
  const candidates = [`openai/${tail}`, `openai-multi/${tail}`];
  return [...new Set([modelId, ...candidates])];
}

export function isStableOpenAiCodexModel(modelId) {
  if (!isOpenAiCodexProviderPrefix(modelId)) {
    return false;
  }
  if (!modelId.includes("codex")) {
    return false;
  }
  if (modelId.includes("-spark") || modelId.includes("-latest")) {
    return false;
  }
  return true;
}

export function listCodexModels() {
  const executable = resolveCodexExecutable();
  const child = spawnSync(executable.command, ["models"], {
    encoding: "utf8",
    windowsHide: true,
    shell: executable.shell,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  if ((child.status ?? 1) !== 0) {
    throw new Error(`Failed to list Codex models (exit=${child.status ?? 1})`);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("Using Node "));
}

function dedupeCodexModels(models) {
  const byCanonical = new Map();
  for (const modelId of models) {
    const canonical = canonicalCodexModelId(modelId);
    const existing = byCanonical.get(canonical);
    if (!existing) {
      byCanonical.set(canonical, modelId);
      continue;
    }
    // Prefer the shorter/default provider form when both exist.
    if (existing.startsWith("openai-multi/") && modelId.startsWith("openai/")) {
      byCanonical.set(canonical, modelId);
    }
  }
  return [...byCanonical.values()].sort((a, b) => canonicalCodexModelId(a).localeCompare(canonicalCodexModelId(b)));
}

export function resolveModelPreset(presetName, explicitModels) {
  if (explicitModels && explicitModels.length > 0) {
    return explicitModels;
  }

  if (presetName !== "codex-core") {
    throw new Error(`Unsupported preset: ${presetName}`);
  }

  try {
    const models = dedupeCodexModels(listCodexModels().filter(isStableOpenAiCodexModel));
    if (models.length > 0) {
      return models;
    }
  } catch {
    // Fall back to static list.
  }

  return [...FALLBACK_OPENAI_CODEX_STABLE];
}

