import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createResumeCatalog, pickResumeThread, type ResumePickerOptions } from "../lib/runtime/resume-picker.js";

process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY = "1";
const { getResumePickerRequest } = await import("../scripts/codex.js");
delete process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY;

const options: ResumePickerOptions = {
 codexBin: { path: process.execPath }, cwd: process.cwd(), configArgs: [],
 showAll: false, includeNonInteractive: false,
};

describe("cross-provider resume arguments", () => {
 it.each([
  ["resume", "abc"], ["resume", "--last"], ["resume", "--help"],
  ["resume", "--remote=ws://localhost"], ["resume", "--", "abc"], ["exec", "resume"],
 ])("leaves native invocation %j alone", (...args) => {
  expect(getResumePickerRequest(args)).toBeNull();
 });
 it("preserves config values and resolves project scope", () => {
  expect(getResumePickerRequest(["-c", "--last", "resume", "--all", "--cd", "child"], "/project"))
   .toMatchObject({ commandIndex: 2, cwd: resolve("/project", "child"), showAll: true, configArgs: ["-c", "--last"] });
 });
 it("recognizes attached directory and config options", () => {
  expect(getResumePickerRequest(["resume", "-C/project", "--config=x=1"]))
   .toMatchObject({ cwd: resolve("/project"), configArgs: ["--config=x=1"] });
 });
});

describe("resume catalog protocol", () => {
 // Use Node itself as a tiny JSON-RPC server; no files, accounts or sockets needed.
 const server = `
 const rl = require('node:readline').createInterface({input: process.stdin});
 rl.on('line', line => {
  const req = JSON.parse(line);
  if (!req.id) return;
  const result = req.method === 'initialize' ? {} : {
   data: [{id:'desktop',cwd:process.cwd(),name:JSON.stringify(req.params),modelProvider:'openai'}],nextCursor:'page2'
  };
  process.stdout.write(JSON.stringify({id:req.id,result})+'\\n');
 });`;
 it("lists all providers with cwd and interactive source filters", async () => {
  const catalog = createResumeCatalog({...options, configArgs:["-e",server,"--"]});
  try {
   const page = await catalog.page("cursor1");
   expect(page.nextCursor).toBe("page2");
   expect(JSON.parse(page.data[0].name!)).toMatchObject({modelProviders:[],cwd:options.cwd,sourceKinds:["cli","vscode"],cursor:"cursor1"});
  } finally { catalog.close(); }
 });
 it("names the resumable non-interactive sources, since an empty list means interactive-only", async () => {
  const catalog = createResumeCatalog({...options, includeNonInteractive:true, configArgs:["-e",server,"--"]});
  try { expect(JSON.parse((await catalog.page()).data[0].name!).sourceKinds).toEqual(["cli","vscode","exec","appServer"]); }
  finally { catalog.close(); }
 });
 it("removes cwd filtering for --all", async () => {
  const catalog = createResumeCatalog({...options, showAll:true, configArgs:["-e",server,"--"]});
  try { expect(JSON.parse((await catalog.page()).data[0].name!)).not.toHaveProperty("cwd"); }
  finally { catalog.close(); }
 });
 it("fails promptly if the child exits", async () => {
  const catalog = createResumeCatalog({...options,configArgs:["-e","process.exit(1)","--"]});
  try { await expect(catalog.page()).rejects.toThrow("stopped"); }
  finally { catalog.close(); }
 });
 it("times out and can close an unresponsive server", async () => {
  const catalog = createResumeCatalog({...options,timeoutMs:50,configArgs:["-e","process.stdin.resume()","--"]});
  try { await expect(catalog.page()).rejects.toThrow("timed out"); }
  finally { catalog.close(); catalog.close(); }
 });
});

describe("resume selection", () => {
 it("paginates across providers and returns the exact selected ID", async () => {
  const page = vi.fn().mockResolvedValueOnce({data:[{id:"desktop",cwd:"/project",name:"desktop\u001b\n"}],nextCursor:"next"})
   .mockResolvedValueOnce({data:[{id:"proxy",cwd:"/project"}]});
  const close = vi.fn();
  const select = vi.fn().mockResolvedValueOnce({kind:"next"}).mockResolvedValueOnce({kind:"previous"})
   .mockResolvedValueOnce({kind:"thread",id:"desktop"});
  expect(await pickResumeThread(options,{createCatalog:()=>({page,close}),select})).toBe("desktop");
  expect(page.mock.calls).toEqual([[],["next"]]);
  expect(select.mock.calls[0][0][0].label).toBe("desktop  ");
  expect(close).toHaveBeenCalledOnce();
 });
 it("cancels without automatically opening a sole session", async () => {
  const close = vi.fn();
  const select = vi.fn().mockResolvedValue(null);
  expect(await pickResumeThread(options,{createCatalog:()=>({page:async()=>({data:[{id:"one",cwd:"/p"}]}),close}),select})).toBeNull();
  expect(select.mock.calls[0][0]).toHaveLength(2);
  expect(close).toHaveBeenCalledOnce();
 });
 it("reports an empty catalog instead of letting select auto-pick Cancel silently", async () => {
  const close = vi.fn();
  const select = vi.fn();
  const log = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
   expect(await pickResumeThread(options,{createCatalog:()=>({page:async()=>({data:[]}),close}),select})).toBeNull();
   expect(select).not.toHaveBeenCalled();
   expect(log).toHaveBeenCalledWith("No saved Codex sessions found.\n");
  } finally { log.mockRestore(); }
  expect(close).toHaveBeenCalledOnce();
 });
 it("treats an interrupt during discovery as cancellation", async () => {
  const before = new Set(process.listeners("SIGINT"));
  let rejectPage: (error: Error) => void = () => {};
  const close = vi.fn(() => rejectPage(new Error("Session catalog is closed.")));
  const page = () => new Promise<never>((_, reject) => {
   rejectPage = reject;
   const onInterrupt = process.listeners("SIGINT").find((listener) => !before.has(listener));
   (onInterrupt as () => void)();
  });
  expect(await pickResumeThread(options,{createCatalog:()=>({page,close}),select:vi.fn()})).toBeNull();
  expect(close).toHaveBeenCalled();
  expect(process.listeners("SIGINT").filter((listener) => !before.has(listener))).toEqual([]);
 });
 it("closes discovery after a listing error", async () => {
  const close = vi.fn();
  await expect(pickResumeThread(options,{createCatalog:()=>({page:async()=>{throw new Error("failed");},close}),select:vi.fn()})).rejects.toThrow("failed");
  expect(close).toHaveBeenCalledOnce();
 });
});
