import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");

export function getRepoRoot() {
  return repoRoot;
}

export function resolveCodexExecutable() {
  const envOverride = process.env.CODEX_BIN;
  if (envOverride && envOverride.trim().length > 0) {
    const command = envOverride.trim();
    return { command, shell: /\.cmd$/i.test(command) };
  }

  if (process.platform !== "win32") {
    return { command: "Codex", shell: false };
  }

  const whereResult = spawnSync("where", ["Codex"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const candidates = `${whereResult.stdout ?? ""}\n${whereResult.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    return { command: "Codex", shell: false };
  }

  const exactExe = candidates.find((candidate) => /npm\\Codex\.exe$/i.test(candidate));
  if (exactExe) {
    return { command: exactExe, shell: false };
  }

  const exactCmd = candidates.find((candidate) => /npm\\Codex\.cmd$/i.test(candidate));
  if (exactCmd) {
    return { command: exactCmd, shell: true };
  }

  const anyCmd = candidates.find((candidate) => /\.cmd$/i.test(candidate));
  if (anyCmd) {
    return { command: anyCmd, shell: true };
  }

  return { command: candidates[0], shell: false };
}

export function parseNdjson(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines emitted by wrappers (bun install, warnings, etc.).
    }
  }
  return events;
}

export function getToolEvents(events) {
  return events
    .filter((event) => event?.type === "tool_use" && event?.part?.type === "tool")
    .map((event) => ({
      tool: event.part.tool,
      input: event.part.state?.input ?? {},
      output: event.part.state?.output,
      status: event.part.state?.status,
      start: event.part.state?.time?.start,
      end: event.part.state?.time?.end,
      durationMs:
        typeof event.part.state?.time?.start === "number" &&
        typeof event.part.state?.time?.end === "number"
          ? event.part.state.time.end - event.part.state.time.start
          : null,
    }));
}

export function getSessionDuration(events) {
  const starts = events
    .filter((event) => event?.type === "step_start" && typeof event.timestamp === "number")
    .map((event) => event.timestamp);
  const finishes = events
    .filter((event) => event?.type === "step_finish" && typeof event.timestamp === "number")
    .map((event) => event.timestamp);
  if (starts.length === 0 || finishes.length === 0) {
    return null;
  }
  return Math.max(...finishes) - Math.min(...starts);
}

export function getTokenTotals(events) {
  const stepFinishes = events.filter((event) => event?.type === "step_finish" && event?.part?.tokens);
  if (stepFinishes.length === 0) {
    return null;
  }
  const total = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const event of stepFinishes) {
    const tokens = event.part.tokens ?? {};
    const input = Number(tokens.input ?? 0);
    const output = Number(tokens.output ?? 0);
    const reasoning = Number(tokens.reasoning ?? 0);
    const explicitTotal = Number(tokens.total ?? NaN);
    total.total += Number.isFinite(explicitTotal) ? explicitTotal : input + output + reasoning;
    total.input += input;
    total.output += output;
    total.reasoning += reasoning;
    total.cacheRead += Number(tokens.cache?.read ?? 0);
    total.cacheWrite += Number(tokens.cache?.write ?? 0);
  }
  return total;
}

export function getTextOutput(events) {
  return events
    .filter((event) => event?.type === "text" && typeof event?.part?.text === "string")
    .map((event) => event.part.text)
    .join("\n");
}

export function getEventError(events) {
  const errorEvent = events.find((event) => event?.type === "error");
  if (!errorEvent) {
    return null;
  }
  return {
    name: errorEvent.error?.name ?? "UnknownError",
    message: errorEvent.error?.data?.message ?? errorEvent.error?.message ?? "Unknown error",
  };
}

export function runCodexJson({
  executable,
  prompt,
  model,
  variant,
  agent,
  cwd,
  homeDir,
  timeoutMs,
  extraEnv,
}) {
  const startWall = Date.now();
  const args = ["run", "--format", "json", "--agent", agent, "--model", model];
  if (variant) {
    args.push("--variant", variant);
  }
  args.push(prompt);

  const child = spawnSync(executable.command, args, {
    cwd: cwd ?? repoRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: executable.shell,
    timeout: timeoutMs,
    maxBuffer: 30 * 1024 * 1024,
    env: {
      ...process.env,
      ...(homeDir ? { HOME: homeDir, USERPROFILE: homeDir } : {}),
      ...extraEnv,
    },
  });

  const wallMs = Date.now() - startWall;
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const events = parseNdjson(stdout);
  const eventError = getEventError(events);
  const timedOut =
    child.error?.code === "ETIMEDOUT" ||
    child.signal === "SIGTERM" ||
    /timed out/i.test(String(child.error?.message ?? ""));
  if (child.error && !timedOut) {
    throw child.error;
  }
  const modelNotFound = /Model not found|ProviderModelNotFoundError/i.test(`${stdout}\n${stderr}`) || /Model not found/i.test(eventError?.message ?? "");

  return {
    status: child.status ?? 1,
    signal: child.signal ?? null,
    stdout,
    stderr,
    wallMs,
    events,
    eventError,
    timedOut,
    modelNotFound,
  };
}

