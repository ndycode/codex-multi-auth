#!/usr/bin/env node

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  getRepoRoot,
  getSessionDuration,
  getTextOutput,
  getTokenTotals,
  getToolEvents,
  resolveCodexExecutable,
  runCodexJson,
} from "./bench-format/Codex.mjs";
import { aliasCandidatesForCodexModel, listCodexModels, resolveModelPreset } from "./bench-format/models.mjs";
import {
  applyHashlineV2Edits,
  autocorrectHashlineV2Call,
  extractJsonCodeBlock,
  formatFileForHashlineV2,
  parseHashlineV2Call,
} from "./bench-format/hashline-v2.mjs";
import { BENCHMARK_FIXTURE, TASKS, getTaskMap } from "./bench-format/tasks.mjs";
import { buildMarkdownReport, renderDashboardHtml } from "./bench-format/render.mjs";
import { stats, safePercent, round1, pctDelta } from "./bench-format/stats.mjs";

const REPO_ROOT = getRepoRoot();
const ALL_MODES = ["patch", "replace", "hashline", "hashline_v2"];
const DEFAULT_PRESET = "codex-core";
const DEFAULT_AGENT = "build";
const DEFAULT_V2_AGENT = "default";
const DEFAULT_VARIANT = "low";
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_OUTPUT_ROOT = ".tmp-bench";
const DEFAULT_TRANSIENT_RETRIES = 2;
const V2_PROMPT_PATH = resolve(REPO_ROOT, "bench/format-benchmark/prompts/hashline-v2.md");
const FIXTURE_SOURCE_PATH = resolve(REPO_ROOT, BENCHMARK_FIXTURE.sourcePath);
const DIST_PLUGIN_DIR = resolve(REPO_ROOT, "dist");

function printUsage() {
  console.log([
    "Usage: node scripts/benchmark-edit-formats.mjs [options]",
    "",
    "Options:",
    "  --preset=codex-core              Model preset (default: codex-core)",
    "  --models=a,b,c                   Explicit model IDs (overrides preset)",
    "  --modes=patch,replace,hashline,hashline_v2",
    "  --tasks=T01,T02                  Restrict to task IDs",
    "  --max-tasks=N                    Cap number of tasks after filtering",
    "  --agent=build|default            Codex agent (default: build)",
    "  --v2-agent=default|build         Agent used for hashline_v2 mode (default: default)",
    "  --variant=low|medium|high|none   Model variant (default: low)",
    "  --warmup-runs=N                  Warmup repeats per model/task/mode (default: 1)",
    "  --measured-runs=N                Measured repeats per model/task/mode (default: 1)",
    "  --timeout-ms=N                   Per-run timeout (default: 300000)",
    "  --output-root=.tmp-bench         Benchmark output root (default: .tmp-bench)",
    "  --label=name                     Output label suffix",
    "  --home=PATH                      HOME/USERPROFILE override for model provider access",
    "  --keep-raw-logs                  Keep all NDJSON logs (default: keep measured + failures)",
    "  --smoke                          Shortcut: 4 tasks, 0 warmup, 1 measured",
    "  --no-dashboard                   Skip HTML dashboard generation",
    "  --help                           Show this help",
    "",
    "Examples:",
    "  node scripts/benchmark-edit-formats.mjs --smoke --models=openai/gpt-5-codex",
    "  node scripts/benchmark-edit-formats.mjs --preset=codex-core --warmup-runs=1 --measured-runs=5",
  ].join("\n"));
}

function parseArgValue(args, name) {
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseIntOption(raw, fallback, name) {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function slugify(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toFileUri(pathValue) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

function modelDisplayName(modelId) {
  const parts = modelId.split("/");
  const tail = parts[parts.length - 1] ?? modelId;
  return tail
    .replace(/^gpt-/i, "GPT-")
    .replace(/codex/gi, "Codex")
    .replace(/mini/gi, "Mini")
    .replace(/max/gi, "Max")
    .replace(/spark/gi, "Spark")
    .replace(/-/g, " ")
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

function classifyFailureReason(run, mode) {
  if (run.timedOut) {
    return { type: "timeout", reason: "Codex run timed out" };
  }
  if (run.modelNotFound) {
    return { type: "model_not_found", reason: "Model not found in current Codex provider config" };
  }
  if (run.status !== 0 && run.eventError) {
    return { type: "CODEX_error", reason: run.eventError.message };
  }
  if (run.status !== 0) {
    return { type: "nonzero_exit", reason: `Codex exited with status ${run.status}` };
  }
  if (mode === "hashline_v2") {
    return { type: "v2_no_json", reason: "No valid hashline_v2 JSON response found" };
  }
  return { type: "mode_signature_missing", reason: `Did not observe expected ${mode} tool signature` };
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isTransientNonzeroExit(run) {
  if (!run || run.status === 0 || run.timedOut || run.modelNotFound || run.eventError) {
    return false;
  }
  const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const noEvents = !Array.isArray(run.events) || run.events.length === 0;
  const noOutput = combined.trim().length === 0;
  const providerRefreshNoise = /service=models\.dev|refreshing/i.test(combined);
  return noEvents || noOutput || providerRefreshNoise;
}

async function runCodexWithResilience({
  executable,
  prompt,
  requestedModel,
  variant,
  agent,
  cwd,
  homeDir,
  timeoutMs,
  extraEnv,
  availableModels,
  transientRetries = DEFAULT_TRANSIENT_RETRIES,
}) {
  const availableSet = Array.isArray(availableModels) && availableModels.length > 0 ? new Set(availableModels) : null;
  const preferredCandidates = aliasCandidatesForCodexModel(requestedModel);
  const filteredCandidates = availableSet
    ? preferredCandidates.filter((candidate) => availableSet.has(candidate))
    : preferredCandidates;
  const candidates = filteredCandidates.length > 0 ? filteredCandidates : preferredCandidates;
  let lastRun = null;
  let lastModel = requestedModel;

  for (const candidateModel of candidates) {
    const maxAttempts = transientRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const run = runCodexJson({
        executable,
        prompt,
        model: candidateModel,
        variant,
        agent,
        cwd,
        homeDir,
        timeoutMs,
        extraEnv,
      });
      lastRun = run;
      lastModel = candidateModel;

      if (run.status === 0 || run.timedOut || run.eventError) {
        return { run, actualModel: candidateModel, attempts: attempt, aliasUsed: candidateModel !== requestedModel };
      }
      if (run.modelNotFound) {
        if (attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        break;
      }
      if (attempt < maxAttempts && isTransientNonzeroExit(run)) {
        await sleep(500 * attempt);
        continue;
      }
      return { run, actualModel: candidateModel, attempts: attempt, aliasUsed: candidateModel !== requestedModel };
    }
  }

  return {
    run:
      lastRun ??
      runCodexJson({
        executable,
        prompt,
        model: requestedModel,
        variant,
        agent,
        cwd,
        homeDir,
        timeoutMs,
        extraEnv,
      }),
    actualModel: lastModel,
    attempts: 1,
    aliasUsed: lastModel !== requestedModel,
  };
}

function toolNameMatches(tool, suffix) {
  return typeof tool === "string" && tool.toLowerCase().endsWith(suffix.toLowerCase());
}

function isEditFamilyTool(tool) {
  return tool === "edit" || tool === "apply_patch";
}

function extractTextPreview(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").slice(0, 400);
}

function mergeTokenTotals(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  const left = current ?? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const right = incoming ?? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    total: Number(left.total ?? 0) + Number(right.total ?? 0),
    input: Number(left.input ?? 0) + Number(right.input ?? 0),
    output: Number(left.output ?? 0) + Number(right.output ?? 0),
    reasoning: Number(left.reasoning ?? 0) + Number(right.reasoning ?? 0),
    cacheRead: Number(left.cacheRead ?? 0) + Number(right.cacheRead ?? 0),
    cacheWrite: Number(left.cacheWrite ?? 0) + Number(right.cacheWrite ?? 0),
  };
}

function sumNullableMs(left, right) {
  if (typeof left !== "number" && typeof right !== "number") {
    return null;
  }
  return Number(left ?? 0) + Number(right ?? 0);
}

function summarizeToolMetrics(mode, tools) {
  const totalToolMs = tools.reduce((acc, tool) => acc + (tool.durationMs ?? 0), 0);
  const editFamilyCalls = tools.filter((tool) => isEditFamilyTool(tool.tool));
  const hashlineReadCalls = tools.filter((tool) => tool.tool === "hashline_read");
  const filesystemEditCalls = tools.filter((tool) => toolNameMatches(tool.tool, "edit_file"));

  let targetEditCall = null;
  if (mode === "replace") {
    targetEditCall = editFamilyCalls.find((tool) => typeof tool.input?.oldString === "string" && !tool.input?.lineRef) ?? null;
  } else if (mode === "hashline") {
    targetEditCall = editFamilyCalls.find((tool) => typeof tool.input?.lineRef === "string") ?? null;
  } else if (mode === "patch") {
    targetEditCall = filesystemEditCalls[0] ?? null;
  }

  return {
    totalToolMs,
    toolCount: tools.length,
    editFamilyCallCount: editFamilyCalls.length,
    filesystemEditCallCount: filesystemEditCalls.length,
    hashlineReadCallCount: hashlineReadCalls.length,
    hashlineReadTotalMs: hashlineReadCalls.reduce((acc, tool) => acc + (tool.durationMs ?? 0), 0),
    targetEditCallMs: targetEditCall?.durationMs ?? null,
    targetEditCallCount:
      mode === "patch"
        ? filesystemEditCalls.length
        : mode === "hashline" || mode === "replace"
          ? editFamilyCalls.length
          : 0,
    toolSequence: tools.map((tool) => tool.tool),
  };
}

function classifyToolMode(mode, tools, finalContent, task) {
  const toolMetrics = summarizeToolMetrics(mode, tools);
  const toolNames = toolMetrics.toolSequence;
  const validationPass = task.validate(finalContent);
  const fileChanged = finalContent !== task.originalContent;

  let signatureOk = false;
  let supported = true;
  let fallbackUsed = false;
  let failureType = null;
  let failureReason = null;

  if (mode === "patch") {
    signatureOk = toolMetrics.filesystemEditCallCount > 0;
    fallbackUsed = toolMetrics.editFamilyCallCount > 0 || toolMetrics.hashlineReadCallCount > 0;
    if (!signatureOk) {
      supported = false;
      failureType = "wrong_tool_family";
      failureReason = `Patch mode expected filesystem edit tool; saw: ${toolNames.join(", ") || "none"}`;
    }
  }

  if (mode === "replace") {
    const hasLegacyEdit = tools.some((tool) => isEditFamilyTool(tool.tool) && typeof tool.input?.oldString === "string" && !tool.input?.lineRef);
    signatureOk = hasLegacyEdit;
    fallbackUsed = toolMetrics.hashlineReadCallCount > 0 || tools.some((tool) => isEditFamilyTool(tool.tool) && typeof tool.input?.lineRef === "string");
    if (!signatureOk) {
      supported = false;
      failureType = "missing_legacy_signature";
      failureReason = `Replace mode expected oldString/newString edit signature; saw: ${toolNames.join(", ") || "none"}`;
    }
  }

  if (mode === "hashline") {
    const hasHashlineEdit = tools.some((tool) => isEditFamilyTool(tool.tool) && typeof tool.input?.lineRef === "string");
    signatureOk = toolMetrics.hashlineReadCallCount > 0 && hasHashlineEdit;
    fallbackUsed = tools.some((tool) => isEditFamilyTool(tool.tool) && typeof tool.input?.oldString === "string");
    if (!signatureOk) {
      supported = false;
      failureType = "missing_hashline_signature";
      failureReason = `Hashline mode expected hashline_read + lineRef edit; saw: ${toolNames.join(", ") || "none"}`;
    }
  }

  if (supported && !fileChanged) {
    failureType = "file_unchanged";
    failureReason = "File content was unchanged after run";
  }

  if (supported && fileChanged && !validationPass) {
    failureType = "validation_failed";
    failureReason = `Task validator failed for ${task.id}`;
  }

  const pass = supported && signatureOk && fileChanged && validationPass;
  const firstTrySuccess = pass && ((mode === "patch")
    ? toolMetrics.filesystemEditCallCount === 1
    : toolMetrics.targetEditCallCount === 1);

  return {
    pass,
    supported,
    signatureOk,
    fallbackUsed,
    firstTrySuccess,
    failureType,
    failureReason,
    validationPass,
    fileChanged,
    toolMetrics,
  };
}

function buildToolPrompt(mode, task) {
  const taskLine = `Task: ${task.prompt}`;
  if (mode === "patch") {
    return [
      "Edit only src/TodoApp.tsx in the working directory and then stop.",
      taskLine,
      "Use filesystem patch/edit tools only (for example filesystem_edit_file).",
      "Do not use plugin edit/apply_patch and do not use hashline_read.",
      "Make the changes directly and return DONE.",
    ].join(" ");
  }
  if (mode === "replace") {
    return [
      "Edit only src/TodoApp.tsx in the working directory and then stop.",
      taskLine,
      "Use plugin edit/apply_patch legacy mode with oldString/newString only.",
      "Do not use hashline_read and do not use lineRef/endLineRef.",
      "Return DONE after editing.",
    ].join(" ");
  }
  return [
    "Edit only src/TodoApp.tsx in the working directory and then stop.",
    taskLine,
    "Use hashline mode: first call hashline_read on src/TodoApp.tsx, then use edit/apply_patch with lineRef (and endLineRef if needed).",
    "Do not use oldString/newString legacy mode.",
    "Return DONE after editing.",
  ].join(" ");
}

function buildHashlineV2Prompt(v2Prompt, task, taggedContent) {
  return [
    "You are benchmarking a code edit format named hashline_v2.",
    "This is a format benchmark. The file content is already provided below.",
    "If your runtime policy requires tools, tool usage is allowed.",
    "Final answer must include exactly one JSON code block with the edit call and no explanation.",
    "Also repeat the same JSON between BEGIN_V2_JSON and END_V2_JSON markers.",
    "Use real tags from the file content below. Do not invent placeholder tags (for example ???).",
    "",
    "## hashline_v2 format",
    v2Prompt,
    "",
    "## Current file: src/TodoApp.tsx",
    "```",
    taggedContent,
    "```",
    "",
    "## Task",
    task.prompt,
    "",
    "## Output format",
    "BEGIN_V2_JSON",
    "```json",
    '{ "path": "src/TodoApp.tsx", "edits": [ ... ] }',
    "```",
    "END_V2_JSON",
  ].join("\n");
}

function buildHashlineV2RepairPrompt(v2Prompt, task, taggedContent, previousOutput) {
  return [
    "Your previous response was not valid hashline_v2 JSON.",
    "Return valid hashline_v2 JSON now.",
    "If your runtime policy requires tools, tool usage is allowed.",
    "Final answer must include exactly one JSON code block and the same JSON between BEGIN_V2_JSON and END_V2_JSON.",
    "No explanation text.",
    "",
    "## hashline_v2 format",
    v2Prompt,
    "",
    "## Current file: src/TodoApp.tsx",
    "```",
    taggedContent,
    "```",
    "",
    "## Task",
    task.prompt,
    "",
    "## Previous invalid output",
    "```",
    previousOutput || "(empty)",
    "```",
    "",
    "## Required output",
    "BEGIN_V2_JSON",
    "```json",
    '{ "path": "src/TodoApp.tsx", "edits": [ ... ] }',
    "```",
    "END_V2_JSON",
  ].join("\n");
}

async function ensureWorkspace(workspaceDir, fixtureContent) {
  const srcDir = join(workspaceDir, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "TodoApp.tsx"), fixtureContent, "utf8");
  const workspaceConfig = {
    plugin: [toFileUri(DIST_PLUGIN_DIR)],
  };
  await writeFile(join(workspaceDir, "Codex.json"), `${JSON.stringify(workspaceConfig, null, 2)}\n`, "utf8");
}

async function readWorkspaceFixture(workspaceDir) {
  return readFile(join(workspaceDir, BENCHMARK_FIXTURE.relativePath), "utf8");
}

function extractPhaseRuns(runRecords, phase) {
  return runRecords.filter((record) => record.phase === phase);
}

function modeRunMetrics(mode, records) {
  const measured = records.filter((record) => record.phase === "measured");
  const passCount = measured.filter((record) => record.pass).length;
  const supportedCount = measured.filter((record) => record.supported !== false).length;
  const firstTrySuccessCount = measured.filter((record) => record.firstTrySuccess).length;
  const fallbackCount = measured.filter((record) => record.fallbackUsed).length;
  const unsupportedCount = measured.filter((record) => record.supported === false).length;
  const timeoutCount = measured.filter((record) => record.failureType === "timeout").length;
  const wallStats = stats(measured.map((record) => record.wallMs));
  const sessionStats = stats(measured.map((record) => record.sessionMs));
  const totalToolStats = stats(measured.map((record) => record.totalToolMs));
  const editCallStats = stats(measured.map((record) => record.targetEditCallMs));
  const hashlineReadStats = stats(measured.map((record) => record.hashlineReadTotalMs));
  const tokenTotalStats = stats(measured.map((record) => record.tokens?.total));
  const toolCountStats = stats(measured.map((record) => record.toolCount));

  return {
    mode,
    measuredRuns: measured.length,
    warmupRuns: records.filter((record) => record.phase === "warmup").length,
    passCount,
    failCount: measured.length - passCount,
    supportedCount,
    unsupportedCount,
    timeoutCount,
    accuracyPct: round1(safePercent(passCount, measured.length) ?? NaN),
    firstTrySuccessPct: round1(safePercent(firstTrySuccessCount, measured.length) ?? NaN),
    fallbackRatePct: round1(safePercent(fallbackCount, measured.length) ?? NaN),
    wallMsP50: wallStats?.p50 ?? null,
    wallMsP95: wallStats?.p95 ?? null,
    sessionMsP50: sessionStats?.p50 ?? null,
    sessionMsP95: sessionStats?.p95 ?? null,
    totalToolMsP50: totalToolStats?.p50 ?? null,
    totalToolMsP95: totalToolStats?.p95 ?? null,
    editCallMsP50: editCallStats?.p50 ?? null,
    editCallMsP95: editCallStats?.p95 ?? null,
    hashlineReadMsP50: hashlineReadStats?.p50 ?? null,
    hashlineReadMsP95: hashlineReadStats?.p95 ?? null,
    tokensTotalP50: tokenTotalStats?.p50 ?? null,
    tokensTotalP95: tokenTotalStats?.p95 ?? null,
    toolCountAvg: toolCountStats?.mean ?? null,
    failureTypes: Object.fromEntries(
      Object.entries(
        measured.reduce((acc, record) => {
          if (!record.pass && record.failureType) {
            acc[record.failureType] = (acc[record.failureType] ?? 0) + 1;
          }
          return acc;
        }, {}),
      ).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function aggregateSummary({ options, runRecords, failures, startTime, endTime, executable }) {
  const measuredRuns = extractPhaseRuns(runRecords, "measured");
  const warmupRuns = extractPhaseRuns(runRecords, "warmup");
  const modelIds = [...new Set(runRecords.map((record) => record.modelId))];
  const rows = [];

  for (const modelId of modelIds) {
    const byMode = {};
    for (const mode of options.modes) {
      const modeRecords = runRecords.filter((record) => record.modelId === modelId && record.mode === mode);
      byMode[mode] = modeRunMetrics(mode, modeRecords);
    }

    const patch = byMode.patch;
    const replace = byMode.replace;
    const hashline = byMode.hashline;
    const hashlineV2 = byMode.hashline_v2;

    rows.push({
      modelId,
      displayName: modelDisplayName(modelId),
      modes: byMode,
      deltas: {
        hashline: {
          accuracyVsPatch: round1((hashline?.accuracyPct ?? NaN) - (patch?.accuracyPct ?? NaN)),
          accuracyVsReplace: round1((hashline?.accuracyPct ?? NaN) - (replace?.accuracyPct ?? NaN)),
          tokensVsReplacePct: round1(pctDelta(hashline?.tokensTotalP50 ?? NaN, replace?.tokensTotalP50 ?? NaN)),
        },
        hashline_v2: {
          accuracyVsPatch: round1((hashlineV2?.accuracyPct ?? NaN) - (patch?.accuracyPct ?? NaN)),
          accuracyVsReplace: round1((hashlineV2?.accuracyPct ?? NaN) - (replace?.accuracyPct ?? NaN)),
          tokensVsReplacePct: round1(pctDelta(hashlineV2?.tokensTotalP50 ?? NaN, replace?.tokensTotalP50 ?? NaN)),
        },
      },
    });
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      benchmarkStartedAt: startTime,
      benchmarkFinishedAt: endTime,
      preset: options.preset,
      label: options.label,
      models: options.models,
      tasks: options.tasks.map((task) => task.id),
      modes: options.modes,
      agent: options.agent,
      hashlineV2Agent: options.v2Agent,
      variant: options.variant || null,
      warmupRunsPerTask: options.warmupRuns,
      measuredRunsPerTask: options.measuredRuns,
      timeoutMs: options.timeoutMs,
      outputRoot: options.outputRoot,
      runDir: options.runDir,
      homeDir: options.homeDir || null,
      CodexCommand: executable.command,
      CodexUsesShell: executable.shell,
      keepRawLogs: options.keepRawLogs,
      runCount: measuredRuns.length,
      warmupCount: warmupRuns.length,
    },
    failures,
    rows,
    runs: measuredRuns,
    warmupRuns,
  };
}

function buildRunId({ modelId, mode, taskId, repeatIndex, phase }) {
  return `${slugify(modelId)}__${mode}__${taskId}__${phase}${String(repeatIndex).padStart(2, "0")}`;
}

async function writeRawLog(logDir, runId, text) {
  const path = join(logDir, `${runId}.ndjson`);
  await writeFile(path, text, "utf8");
  return path;
}

function baseRecord({ modelId, mode, task, phase, repeatIndex, variant, runId }) {
  return {
    id: runId,
    modelId,
    modelDisplayName: modelDisplayName(modelId),
    requestedModelId: modelId,
    actualModelId: modelId,
    modelAliasUsed: false,
    attempts: 1,
    mode,
    taskId: task.id,
    taskName: task.name,
    difficulty: task.difficulty,
    phase,
    repeatIndex,
    variant: variant || null,
    pass: false,
    supported: true,
    signatureOk: false,
    fallbackUsed: false,
    formatFallbackUsed: false,
    firstTrySuccess: false,
    failureType: null,
    failureReason: null,
    wallMs: null,
    sessionMs: null,
    totalToolMs: null,
    targetEditCallMs: null,
    hashlineReadTotalMs: null,
    toolCount: 0,
    tokens: null,
    toolSequence: [],
    rawLogPath: null,
    textPreview: "",
    fileChanged: false,
    validationPass: false,
    eventError: null,
  };
}

async function runToolMode({ mode, modelId, task, phase, repeatIndex, options, executable, fixtureContent }) {
  const runId = buildRunId({ modelId, mode, taskId: task.id, repeatIndex, phase });
  const workspaceDir = join(options.workspacesDir, runId);
  await rm(workspaceDir, { recursive: true, force: true });
  await ensureWorkspace(workspaceDir, fixtureContent);

  const prompt = buildToolPrompt(mode, task);
  const { run, actualModel, attempts, aliasUsed } = await runCodexWithResilience({
    executable,
    prompt,
    requestedModel: modelId,
    variant: options.variant,
    agent: options.agent,
    cwd: workspaceDir,
    homeDir: options.homeDir,
    timeoutMs: Math.max(task.timeoutMs ?? 0, options.timeoutMs),
    availableModels: options.availableModels,
    extraEnv: {
      ENABLE_PLUGIN_REQUEST_LOGGING: "0",
      CODEX_PLUGIN_LOG_BODIES: "0",
      DEBUG_CODEX_PLUGIN: "0",
    },
  });

  const record = baseRecord({ modelId, mode, task, phase, repeatIndex, variant: options.variant, runId });
  record.actualModelId = actualModel;
  record.modelAliasUsed = aliasUsed;
  record.attempts = attempts;
  record.wallMs = run.wallMs;
  record.sessionMs = getSessionDuration(run.events);
  record.tokens = getTokenTotals(run.events);
  record.eventError = run.eventError;
  record.textPreview = extractTextPreview(getTextOutput(run.events));

  const tools = getToolEvents(run.events);
  const toolMetrics = summarizeToolMetrics(mode, tools);
  record.totalToolMs = toolMetrics.totalToolMs;
  record.targetEditCallMs = toolMetrics.targetEditCallMs;
  record.hashlineReadTotalMs = toolMetrics.hashlineReadTotalMs;
  record.toolCount = toolMetrics.toolCount;
  record.toolSequence = toolMetrics.toolSequence;

  const shouldKeepLog = options.keepRawLogs || phase === "measured" || run.status !== 0 || run.modelNotFound || run.eventError;
  if (shouldKeepLog) {
    record.rawLogPath = await writeRawLog(options.logsDir, runId, run.stdout);
  }

  if (run.status !== 0 || run.modelNotFound || run.timedOut || run.eventError) {
    const failure = classifyFailureReason(run, mode);
    record.supported = !run.modelNotFound;
    record.failureType = failure.type;
    record.failureReason = failure.reason;
    return record;
  }

  const finalContent = await readWorkspaceFixture(workspaceDir);
  const classification = classifyToolMode(mode, tools, finalContent, {
    ...task,
    originalContent: fixtureContent,
  });

  record.pass = classification.pass;
  record.supported = classification.supported;
  record.signatureOk = classification.signatureOk;
  record.fallbackUsed = classification.fallbackUsed;
  record.firstTrySuccess = classification.firstTrySuccess;
  record.failureType = classification.failureType;
  record.failureReason = classification.failureReason;
  record.fileChanged = classification.fileChanged;
  record.validationPass = classification.validationPass;
  return record;
}

async function runHashlineV2Mode({ modelId, task, phase, repeatIndex, options, executable, fixtureContent, v2Prompt }) {
  const mode = "hashline_v2";
  const runId = buildRunId({ modelId, mode, taskId: task.id, repeatIndex, phase });
  const workspaceDir = join(options.workspacesDir, runId);
  await rm(workspaceDir, { recursive: true, force: true });
  await ensureWorkspace(workspaceDir, fixtureContent);

  const taggedContent = formatFileForHashlineV2(BENCHMARK_FIXTURE.relativePath, fixtureContent);
  const prompt = buildHashlineV2Prompt(v2Prompt, task, taggedContent);
  const { run, actualModel, attempts, aliasUsed } = await runCodexWithResilience({
    executable,
    prompt,
    requestedModel: modelId,
    variant: options.variant,
    agent: options.v2Agent,
    cwd: workspaceDir,
    homeDir: options.homeDir,
    timeoutMs: Math.max(task.timeoutMs ?? 0, options.timeoutMs),
    availableModels: options.availableModels,
    extraEnv: {
      ENABLE_PLUGIN_REQUEST_LOGGING: "0",
      CODEX_PLUGIN_LOG_BODIES: "0",
      DEBUG_CODEX_PLUGIN: "0",
    },
  });

  const record = baseRecord({ modelId, mode, task, phase, repeatIndex, variant: options.variant, runId });
  record.actualModelId = actualModel;
  record.modelAliasUsed = aliasUsed;
  record.attempts = attempts;
  record.wallMs = run.wallMs;
  record.sessionMs = getSessionDuration(run.events);
  record.tokens = getTokenTotals(run.events);
  record.eventError = run.eventError;

  const tools = getToolEvents(run.events);
  const toolMetrics = summarizeToolMetrics(mode, tools);
  record.totalToolMs = toolMetrics.totalToolMs;
  record.targetEditCallMs = null;
  record.hashlineReadTotalMs = toolMetrics.hashlineReadTotalMs;
  record.toolCount = toolMetrics.toolCount;
  record.toolSequence = toolMetrics.toolSequence;

  const textOutput = getTextOutput(run.events);
  record.textPreview = extractTextPreview(textOutput);

  const shouldKeepLog = options.keepRawLogs || phase === "measured" || run.status !== 0 || run.modelNotFound || run.eventError;
  if (shouldKeepLog) {
    record.rawLogPath = await writeRawLog(options.logsDir, runId, run.stdout);
  }

  if (run.status !== 0 || run.modelNotFound || run.timedOut || run.eventError) {
    const failure = classifyFailureReason(run, mode);
    record.supported = !run.modelNotFound;
    record.failureType = failure.type;
    record.failureReason = failure.reason;
    return record;
  }

  record.fallbackUsed = tools.length > 0;

  let effectiveOutput = textOutput;
  let jsonText = extractJsonCodeBlock(effectiveOutput);

  if (!jsonText) {
    const repairPrompt = buildHashlineV2RepairPrompt(v2Prompt, task, taggedContent, textOutput);
    const repair = await runCodexWithResilience({
      executable,
      prompt: repairPrompt,
      requestedModel: modelId,
      variant: options.variant,
      agent: options.v2Agent,
      cwd: workspaceDir,
      homeDir: options.homeDir,
      timeoutMs: Math.max(task.timeoutMs ?? 0, options.timeoutMs),
      availableModels: options.availableModels,
      extraEnv: {
        ENABLE_PLUGIN_REQUEST_LOGGING: "0",
        CODEX_PLUGIN_LOG_BODIES: "0",
        DEBUG_CODEX_PLUGIN: "0",
      },
    });

    record.attempts += repair.attempts;
    record.modelAliasUsed = record.modelAliasUsed || repair.aliasUsed;
    record.actualModelId = repair.actualModel;
    record.wallMs = sumNullableMs(record.wallMs, repair.run.wallMs);
    record.sessionMs = sumNullableMs(record.sessionMs, getSessionDuration(repair.run.events));
    record.tokens = mergeTokenTotals(record.tokens, getTokenTotals(repair.run.events));

    const repairTools = getToolEvents(repair.run.events);
    const repairToolMetrics = summarizeToolMetrics(mode, repairTools);
    record.totalToolMs = sumNullableMs(record.totalToolMs, repairToolMetrics.totalToolMs);
    record.hashlineReadTotalMs = sumNullableMs(record.hashlineReadTotalMs, repairToolMetrics.hashlineReadTotalMs);
    record.toolCount += repairToolMetrics.toolCount;
    record.toolSequence = [...record.toolSequence, ...repairToolMetrics.toolSequence];
    record.fallbackUsed = record.fallbackUsed || repairTools.length > 0;

    if (repair.run.status !== 0 || repair.run.modelNotFound || repair.run.timedOut || repair.run.eventError) {
      const failure = classifyFailureReason(repair.run, mode);
      record.supported = !repair.run.modelNotFound;
      record.failureType = failure.type;
      record.failureReason = `repair_pass: ${failure.reason}`;
      return record;
    }

    effectiveOutput = getTextOutput(repair.run.events);
    record.textPreview = extractTextPreview(effectiveOutput);
    jsonText = extractJsonCodeBlock(effectiveOutput);
  }

  let parsedCall;
  try {
    if (!jsonText) {
      record.fallbackUsed = true;
      record.formatFallbackUsed = true;
      parsedCall = { path: BENCHMARK_FIXTURE.relativePath, edits: [] };
    } else {
      parsedCall = autocorrectHashlineV2Call(parseHashlineV2Call(jsonText), fixtureContent);
    }
  } catch {
    record.fallbackUsed = true;
    record.formatFallbackUsed = true;
    parsedCall = { path: BENCHMARK_FIXTURE.relativePath, edits: [] };
  }

  if (![BENCHMARK_FIXTURE.relativePath, `./${BENCHMARK_FIXTURE.relativePath}`].includes(parsedCall.path)) {
    record.failureType = "v2_wrong_path";
    record.failureReason = `Unexpected path in v2 edit call: ${parsedCall.path}`;
    return record;
  }

  const applyResult = applyHashlineV2Edits(fixtureContent, parsedCall);
  if (!applyResult.ok) {
    record.failureType = "v2_apply_error";
    record.failureReason = applyResult.errors[0] ?? "Unknown apply error";
    return record;
  }

  const finalContent = applyResult.content;
  record.fileChanged = finalContent !== fixtureContent;
  record.validationPass = task.validate(finalContent);
  record.signatureOk = true;
  record.supported = true;
  record.fallbackUsed = record.fallbackUsed || record.formatFallbackUsed;
  record.firstTrySuccess = applyResult.ok;
  record.pass = record.fileChanged && record.validationPass;
  if (!record.fileChanged) {
    record.failureType = "file_unchanged";
    record.failureReason = "hashline_v2 edit call produced no file changes";
  } else if (!record.validationPass) {
    record.failureType = "validation_failed";
    record.failureReason = `Task validator failed for ${task.id}`;
  }

  await writeFile(join(workspaceDir, BENCHMARK_FIXTURE.relativePath), finalContent, "utf8");
  return record;
}

async function parseOptions() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const smoke = args.includes("--smoke");
  const noDashboard = args.includes("--no-dashboard");
  const keepRawLogs = args.includes("--keep-raw-logs");
  const preset = parseArgValue(args, "--preset") ?? DEFAULT_PRESET;
  const outputRootArg = parseArgValue(args, "--output-root") ?? DEFAULT_OUTPUT_ROOT;
  const outputRoot = resolve(REPO_ROOT, outputRootArg);
  const labelValue = parseArgValue(args, "--label");
  const label = slugify(labelValue ?? `${preset}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const runDir = join(outputRoot, label);
  const logsDir = join(runDir, "logs");
  const workspacesDir = join(runDir, "workspaces");
  const resultsDir = join(runDir, "results");
  const homeDir = parseArgValue(args, "--home");

  const warmupRuns = smoke
    ? 0
    : parseIntOption(parseArgValue(args, "--warmup-runs"), 1, "--warmup-runs");
  const measuredRuns = smoke
    ? 1
    : parseIntOption(parseArgValue(args, "--measured-runs"), 1, "--measured-runs");
  const timeoutMs = parseIntOption(parseArgValue(args, "--timeout-ms"), DEFAULT_TIMEOUT_MS, "--timeout-ms");
  const maxTasks = parseIntOption(parseArgValue(args, "--max-tasks"), 0, "--max-tasks");
  const agent = parseArgValue(args, "--agent") ?? DEFAULT_AGENT;
  const v2Agent = parseArgValue(args, "--v2-agent") ?? DEFAULT_V2_AGENT;
  const variantRaw = parseArgValue(args, "--variant");
  const variant = variantRaw === "none" ? "" : (variantRaw ?? DEFAULT_VARIANT);

  const modesRaw = parseArgValue(args, "--modes");
  const modes = (modesRaw ? modesRaw.split(",").map((v) => v.trim()).filter(Boolean) : [...ALL_MODES]);
  for (const mode of modes) {
    if (!ALL_MODES.includes(mode)) {
      throw new Error(`Unsupported mode: ${mode}`);
    }
  }

  const explicitModelsRaw = parseArgValue(args, "--models");
  const explicitModels = explicitModelsRaw ? explicitModelsRaw.split(",").map((v) => v.trim()).filter(Boolean) : [];
  const models = resolveModelPreset(preset, explicitModels);
  if (models.length === 0) {
    throw new Error("No models selected");
  }
  let availableModels = [];
  try {
    availableModels = listCodexModels();
  } catch {
    availableModels = [];
  }

  const taskMap = getTaskMap();
  const taskIdsRaw = parseArgValue(args, "--tasks");
  let tasks = [...TASKS];
  if (taskIdsRaw) {
    const ids = taskIdsRaw.split(",").map((value) => value.trim()).filter(Boolean);
    tasks = ids.map((id) => {
      const task = taskMap.get(id);
      if (!task) {
        throw new Error(`Unknown task ID: ${id}`);
      }
      return task;
    });
  }
  if (smoke && !taskIdsRaw) {
    tasks = tasks.slice(0, 4);
  }
  if (maxTasks > 0 && tasks.length > maxTasks) {
    tasks = tasks.slice(0, maxTasks);
  }

  return {
    smoke,
    noDashboard,
    keepRawLogs,
    preset,
    label,
    outputRoot,
    runDir,
    logsDir,
    workspacesDir,
    resultsDir,
    homeDir,
    warmupRuns,
    measuredRuns,
    timeoutMs,
    agent,
    v2Agent,
    variant,
    models,
    availableModels,
    modes,
    tasks,
  };
}

async function writeOutputs(options, summary) {
  await mkdir(options.resultsDir, { recursive: true });
  const summaryPath = join(options.resultsDir, "summary.json");
  const markdownPath = join(options.resultsDir, "report.md");
  const dashboardPath = join(options.resultsDir, "dashboard.html");
  const latestPath = join(options.outputRoot, "latest.json");

  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${buildMarkdownReport(summary)}\n`, "utf8");
  if (!options.noDashboard) {
    await writeFile(dashboardPath, renderDashboardHtml(summary), "utf8");
  }
  await mkdir(dirname(latestPath), { recursive: true });
  await writeFile(latestPath, `${JSON.stringify({ latestRunDir: options.runDir, summaryPath }, null, 2)}\n`, "utf8");

  return { summaryPath, markdownPath, dashboardPath: options.noDashboard ? null : dashboardPath };
}

async function main() {
  const options = await parseOptions();
  const executable = resolveCodexExecutable();
  const startTime = new Date().toISOString();

  if (!existsSync(FIXTURE_SOURCE_PATH)) {
    throw new Error(`Fixture not found: ${FIXTURE_SOURCE_PATH}`);
  }
  if (!existsSync(V2_PROMPT_PATH)) {
    throw new Error(`hashline_v2 prompt not found: ${V2_PROMPT_PATH}`);
  }
  if (!existsSync(join(DIST_PLUGIN_DIR, "index.js"))) {
    throw new Error(`Plugin dist build not found at ${join(DIST_PLUGIN_DIR, "index.js")}. Run npm run build first.`);
  }

  const fixtureContent = await readFile(FIXTURE_SOURCE_PATH, "utf8");
  const v2Prompt = await readFile(V2_PROMPT_PATH, "utf8");

  await mkdir(options.logsDir, { recursive: true });
  await mkdir(options.workspacesDir, { recursive: true });
  await mkdir(options.resultsDir, { recursive: true });

  console.log("Code Edit Format Benchmark");
  console.log(`Repo: ${REPO_ROOT}`);
  console.log(`Preset: ${options.preset}`);
  console.log(`Models (${options.models.length}): ${options.models.join(", ")}`);
  console.log(`Tasks (${options.tasks.length}): ${options.tasks.map((task) => task.id).join(", ")}`);
  console.log(`Modes: ${options.modes.join(", ")}`);
  console.log(`Agent: ${options.agent}`);
  console.log(`V2 Agent: ${options.v2Agent}`);
  console.log(`Variant: ${options.variant || "(none)"}`);
  console.log(`Output: ${options.runDir}`);
  console.log(`Codex: ${executable.command}`);
  console.log("");

  const runRecords = [];
  const failures = [];

  const phases = [];
  for (let index = 0; index < options.warmupRuns; index += 1) {
    phases.push({ phase: "warmup", repeatIndex: index + 1 });
  }
  for (let index = 0; index < options.measuredRuns; index += 1) {
    phases.push({ phase: "measured", repeatIndex: index + 1 });
  }

  const totalRuns = options.models.length * options.modes.length * options.tasks.length * phases.length;
  let currentRun = 0;

  for (const modelId of options.models) {
    console.log(`=== ${modelId} ===`);
    for (const mode of options.modes) {
      for (const task of options.tasks) {
        for (const phaseEntry of phases) {
          currentRun += 1;
          const label = `[${currentRun}/${totalRuns}] ${modelId} | ${mode} | ${task.id} | ${phaseEntry.phase}#${phaseEntry.repeatIndex}`;
          process.stdout.write(`${label} ... `);

          let record;
          try {
            if (mode === "hashline_v2") {
              record = await runHashlineV2Mode({
                modelId,
                task,
                phase: phaseEntry.phase,
                repeatIndex: phaseEntry.repeatIndex,
                options,
                executable,
                fixtureContent,
                v2Prompt,
              });
            } else {
              record = await runToolMode({
                mode,
                modelId,
                task,
                phase: phaseEntry.phase,
                repeatIndex: phaseEntry.repeatIndex,
                options,
                executable,
                fixtureContent,
              });
            }
          } catch (error) {
            record = baseRecord({
              modelId,
              mode,
              task,
              phase: phaseEntry.phase,
              repeatIndex: phaseEntry.repeatIndex,
              variant: options.variant,
              runId: buildRunId({
                modelId,
                mode,
                taskId: task.id,
                repeatIndex: phaseEntry.repeatIndex,
                phase: phaseEntry.phase,
              }),
            });
            record.supported = false;
            record.failureType = "runner_error";
            record.failureReason = error instanceof Error ? error.message : String(error);
          }

          runRecords.push(record);
          if (!record.pass) {
            failures.push({
              modelId: record.modelId,
              mode: record.mode,
              taskId: record.taskId,
              phase: record.phase,
              reason: record.failureReason ?? record.failureType ?? "unknown",
              failureType: record.failureType,
              supported: record.supported,
            });
          }

          if (record.pass) {
            process.stdout.write(`PASS wall=${record.wallMs ?? "-"}ms tokens=${record.tokens?.total ?? "-"} tools=${record.toolCount}\n`);
          } else {
            process.stdout.write(`FAIL ${record.failureType ?? "unknown"}${record.failureReason ? ` (${record.failureReason})` : ""}\n`);
          }
        }
      }
    }
    console.log("");
  }

  const summary = aggregateSummary({
    options,
    runRecords,
    failures,
    startTime,
    endTime: new Date().toISOString(),
    executable,
  });

  const outputs = await writeOutputs(options, summary);

  const measuredPasses = summary.runs.filter((record) => record.pass).length;
  console.log("=== SUMMARY ===");
  console.log(`Measured runs: ${summary.runs.length}`);
  console.log(`Measured passes: ${measuredPasses}`);
  console.log(`Measured failures: ${summary.runs.length - measuredPasses}`);
  console.log(`summary.json: ${outputs.summaryPath}`);
  console.log(`report.md: ${outputs.markdownPath}`);
  if (outputs.dashboardPath) {
    console.log(`dashboard.html: ${outputs.dashboardPath}`);
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

