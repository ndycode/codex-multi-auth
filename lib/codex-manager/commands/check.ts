import { runWithGlobalStoragePath } from "../../storage/path-state.js";

export interface CheckCommandDeps {
 runHealthCheck: (options: { liveProbe: boolean; discoverModels: boolean; primeUnusedSubscription: boolean }) => Promise<void>;
 runResetCheck: () => Promise<number>;
 runCapabilityCheck: () => Promise<boolean>;
 logInfo?: (message: string) => void;
 logError?: (message: string) => void;
}
const usage = "Usage: codex-multi-auth check [accounts|resets|capabilities] [--prime]";
export async function runCheckCommand(deps: CheckCommandDeps, args: string[] = []): Promise<number> {
 if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  (deps.logInfo ?? console.log)(usage);
  return 0;
 }
 // Priming starts an unused subscription's 5h/weekly windows, so it is never implicit.
 const prime = args.includes("--prime");
 const rest = args.filter((arg) => arg !== "--prime");
 const [scope] = rest;
 if (rest.length > 1 || args.length - rest.length > 1 || (scope !== undefined && !["accounts", "resets", "capabilities"].includes(scope)) || (prime && scope !== undefined && scope !== "accounts")) {
  (deps.logError ?? console.error)(usage);
  return 1;
 }
 return runWithGlobalStoragePath(async () => {
  if (scope === "resets") return await deps.runResetCheck();
  if (scope === "capabilities") return await deps.runCapabilityCheck() ? 0 : 1;
  else await deps.runHealthCheck({ liveProbe: true, discoverModels: scope === undefined, primeUnusedSubscription: prime });
  return 0;
 });
}
