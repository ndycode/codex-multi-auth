import { describe, expect, it, vi } from "vitest";
import { type CheckCommandDeps, runCheckCommand } from "../lib/codex-manager/commands/check.js";
import { getStoragePathState, runWithStoragePathState } from "../lib/storage/path-state.js";
function setup() {
 const deps = {
  runHealthCheck: vi.fn(async () => undefined),
  runResetCheck: vi.fn(async () => 0),
  runCapabilityCheck: vi.fn(async () => true),
  logInfo: vi.fn(), logError: vi.fn(),
 } satisfies CheckCommandDeps;
 return deps;
}
describe("focused check commands", () => {
 it.each([[], ["accounts"], ["resets"], ["capabilities"]])("runs only the requested checks: %j", async (...args) => {
  const deps = setup(), original = getStoragePathState();
  expect(await runCheckCommand(deps, args)).toBe(0);
  expect(deps.runHealthCheck).toHaveBeenCalledTimes(args.length === 0 || args[0] === "accounts" ? 1 : 0);
  if (args.length === 0 || args[0] === "accounts") expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true, discoverModels: args.length === 0, primeUnusedSubscription: false });
  expect(deps.runResetCheck).toHaveBeenCalledTimes(args[0] === "resets" ? 1 : 0);
  expect(deps.runCapabilityCheck).toHaveBeenCalledTimes(args[0] === "capabilities" ? 1 : 0);
  expect(getStoragePathState()).toEqual(original);
 });
 it.each([["unknown"], ["accounts", "extra"], ["--help", "extra"]])("rejects invalid arguments without network calls: %j", async (...args) => {
  const deps = setup();
  expect(await runCheckCommand(deps, args)).toBe(1);
  expect(deps.runHealthCheck).not.toHaveBeenCalled();
  expect(deps.runResetCheck).not.toHaveBeenCalled();
  expect(deps.runCapabilityCheck).not.toHaveBeenCalled();
 });
 it("prints help without checking accounts", async () => {
  const deps = setup(); expect(await runCheckCommand(deps, ["--help"])).toBe(0);
  expect(deps.logInfo).toHaveBeenCalledWith(expect.stringContaining("accounts|resets|capabilities"));
  expect(deps.runHealthCheck).not.toHaveBeenCalled();
 });
 it("preserves reset-check failure status", async () => {
  const deps = setup(); deps.runResetCheck.mockResolvedValue(1);
  expect(await runCheckCommand(deps, ["resets"])).toBe(1);
 });
 it.each([[], ["accounts"], ["resets"], ["capabilities"]])("restores storage scope after a failed check: %j", async (...args) => {
  const deps = setup(), original = getStoragePathState(), error = Error("probe failed");
  deps.runHealthCheck.mockRejectedValue(error); deps.runResetCheck.mockRejectedValue(error); deps.runCapabilityCheck.mockRejectedValue(error);
  await expect(runCheckCommand(deps, args)).rejects.toThrow("probe failed");
  expect(getStoragePathState()).toEqual(original);
 });
});

it("returns failure when capability discovery cannot refresh", async () => {
 const deps = setup(); deps.runCapabilityCheck.mockResolvedValue(false);
 expect(await runCheckCommand(deps,["capabilities"])).toBe(1);
});

it.each([[],["accounts"],["resets"],["capabilities"]])("preserves the real storage state across checks: %j", async (...args) => {
 const storage = await import("../lib/storage.js");
 const previous={currentStoragePath:"C:\\shared\\projects\\fixture\\accounts.json",currentProjectRoot:"C:\\projects\\fixture",currentLegacyProjectStoragePath:"C:\\projects\\fixture\\.legacy\\accounts.json",currentLegacyWorktreeStoragePath:"C:\\shared\\old-worktree\\accounts.json"};
 await runWithStoragePathState(previous,async()=>{
  const deps=setup();
  expect(await runCheckCommand(deps,args)).toBe(0);
  expect(getStoragePathState()).toEqual(previous);
  expect(storage.getStoragePath()).toBe(previous.currentStoragePath);
 });
});

it("keeps a pending shared-pool check isolated from its caller and restores all paths after rejection",async()=>{
 const previous={currentStoragePath:"/fixture/shared/accounts.json",currentProjectRoot:"/fixture/project",currentLegacyProjectStoragePath:"/fixture/legacy/accounts.json",currentLegacyWorktreeStoragePath:"/fixture/worktree/accounts.json"};
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 await runWithStoragePathState(previous,async()=>{
  const deps=setup();
  deps.runHealthCheck.mockImplementation(async()=>{
   expect(getStoragePathState()).toEqual({currentStoragePath:null,currentProjectRoot:null,currentLegacyProjectStoragePath:null,currentLegacyWorktreeStoragePath:null});
   await gate;
   expect(getStoragePathState().currentProjectRoot).toBeNull();
   throw Error("probe failed");
  });
  const pending=runCheckCommand(deps,["accounts"]);
  const rejected=expect(pending).rejects.toThrow("probe failed");
  try{expect(getStoragePathState()).toEqual(previous);}finally{release();}
  await rejected;
  expect(getStoragePathState()).toEqual(previous);
 });
});

it.each([[[] as string[], false], [["accounts"], false], [["--prime"], true], [["accounts", "--prime"], true]])("sends the first-use priming request only on explicit --prime: %j", async (args, prime) => {
 const deps = setup();
 expect(await runCheckCommand(deps, args)).toBe(0);
 expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true, discoverModels: !args.includes("accounts"), primeUnusedSubscription: prime });
});

it.each([["resets", "--prime"], ["capabilities", "--prime"], ["--prime", "--prime"]])("rejects --prime outside account checks: %j", async (...args) => {
 const deps = setup();
 expect(await runCheckCommand(deps, args)).toBe(1);
 expect(deps.runHealthCheck).not.toHaveBeenCalled();
});
