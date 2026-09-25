import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { withRetry } from "../lib/fs-retry.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
    for (const child of children.splice(0))
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
        }
    for (const path of dirs.splice(0))
        await withRetry(() => rm(path, { recursive: true, force: true }), { maxAttempts: 6, backoffMs: 25 });
});
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "storage-lock-test-"));
    dirs.push(dir);
    // Compile only the source under test for independent Node processes, never import build output.
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    for (const [source, target] of [["lib/storage/file-lock.ts", "file-lock.js"], ["lib/fs-retry.ts", "fs-retry.js"], ["lib/storage/transactions.ts", "transactions.js"]]) {
        const text = await readFile(source!, "utf8");
        await writeFile(join(dir, target!), ts.transpileModule(text.replace('"../fs-retry.js"', '"./fs-retry.js"').replace('"../logger.js"', '"./logger.js"'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
    }
    await writeFile(join(dir, "logger.js"), "export const logWarn = () => {};\n");
    const worker = join(dir, "worker.mjs");
    await writeFile(worker, `import {withAccountStorageTransaction} from ${JSON.stringify(pathToFileURL(join(dir, "transactions.js")).href)};
 import {readFile,writeFile,rename} from 'node:fs/promises';
 const path=process.argv[2];
 process.send('started');
 await withAccountStorageTransaction(async(data,persist)=>{
   const release=new Promise(resolve=>process.once('message',resolve));
   process.send('entered');await release;
   data.accounts.push({recordId:String(process.pid)});await persist(data);
 },{getStoragePath:()=>path,loadCurrent:async()=>JSON.parse(await readFile(path,'utf8')),saveAccounts:async data=>{const temp=path+'.'+process.pid;await writeFile(temp,JSON.stringify(data));await rename(temp,path);}});process.send('saved');process.disconnect();`);
    const path = join(dir, "store.json");
    await writeFile(path, JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }));
    return { dir, path, worker };
}
function launch(worker: string, path: string) {
    const child = fork(worker, [path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    const messages: string[] = [];
    child.on("message", m => messages.push(String(m)));
    const wait = async (message: string) => { const deadline = Date.now() + 4000; while (!messages.includes(message)) {
        if (Date.now() > deadline)
            throw Error(`Worker did not report ${message}`);
        await new Promise(r => setTimeout(r, 5));
    } };
    return { child, messages, wait };
}
it("serializes real processes across the read-modify-write transaction", async () => {
    const { path, worker } = await fixture();
    const a = launch(worker, path);
    await a.wait("entered");
    const b = launch(worker, path);
    await b.wait("started");
    await new Promise(r => setTimeout(r, 80));
    expect(b.messages).not.toContain("entered");
    a.child.send("go");
    await a.wait("saved");
    await b.wait("entered");
    b.child.send("go");
    await b.wait("saved");
    expect(JSON.parse(await readFile(path, "utf8")).accounts).toHaveLength(2);
});
it("recovers a killed writer without relying on a lease expiry", async () => {
    const { path, worker, dir } = await fixture();
    const a = launch(worker, path);
    await a.wait("entered");
    const exit = once(a.child, "exit");
    a.child.kill("SIGKILL");
    await exit;
    await withFileTransactionLock(path, async () => writeFile(path, '["recovered"]'));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(["recovered"]);
    expect((await readdir(dir)).filter(p => p.includes("write-lock"))).toEqual([]);
});
it("times out visibly rather than stealing a live writer's lock", async () => {
    const { path, worker } = await fixture();
    const a = launch(worker, path);
    await a.wait("entered");
    await expect(withFileTransactionLock(path, async () => { throw Error("must not enter"); }, { waitMs: 70 })).rejects.toMatchObject({ code: "ELOCKED" });
    a.child.send("go");
    await a.wait("saved");
});
it("releases on exceptions and supports nested persistence under the same lease", async () => {
    const { path } = await fixture();
    await expect(withFileTransactionLock(path, async () => withFileTransactionLock(path, async () => { throw Error("fixture failure"); }))).rejects.toThrow("fixture failure");
    await expect(withFileTransactionLock(path, async () => 42)).resolves.toBe(42);
});
it.each(["EBUSY", "EPERM"])("retries %s while publishing the storage lease", async (code) => {
    const { path, dir } = await fixture();
    const rename = fs.rename.bind(fs);
    let blocked = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (!blocked && String(args[1]).endsWith(".write-lock")) {
            blocked = true;
            throw Object.assign(Error("fixture lock"), { code });
        }
        return rename(...args);
    });
    try {
        await expect(withFileTransactionLock(path, async () => 42)).resolves.toBe(42);
        expect(blocked).toBe(true);
        expect((await readdir(dir)).filter(p => p.includes("write-lock"))).toEqual([]);
    }
    finally {
        spy.mockRestore();
    }
});

it.each([false,true])("does not mask the action outcome on release failure (throws=%s) and recovers its abandoned lease", async throws => {
    const {path}=await fixture();
    const unlink=vi.spyOn(fs,"unlink").mockRejectedValue(Object.assign(Error("locked"),{code:"EBUSY"}));
    try {
        const action=withFileTransactionLock(path,async()=>{if(throws)throw Error("action failure");return 42;});
        if(throws) await expect(action).rejects.toThrow("action failure");
        else await expect(action).resolves.toBe(42);
    } finally {unlink.mockRestore();}
    await expect(withFileTransactionLock(path,async()=>43,{waitMs:100})).resolves.toBe(43);
});
it("retries its own deferred release even when this process makes no later write",async()=>{
 const {path}=await fixture();
 const unlink=vi.spyOn(fs,"unlink").mockRejectedValue(Object.assign(Error("locked"),{code:"EBUSY"}));
 try {await expect(withFileTransactionLock(path,async()=>42)).resolves.toBe(42);}finally{unlink.mockRestore();}
 await vi.waitFor(async()=>{await expect(fs.stat(`${path}.write-lock`)).rejects.toMatchObject({code:"ENOENT"});},{timeout:1500});
});


it("keeps the committed result when the owner file cannot be released, and reclaims it next time", async () => {
    const { path, dir } = await fixture();
    const unlink = fs.unlink.bind(fs);
    const spy = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
        const target = String(args[0]);
        if (target.includes(".write-lock") && !target.includes(".candidate-"))
            throw Object.assign(Error("fixture scanner"), { code: "EBUSY" });
        return unlink(...args);
    });
    try {
        await expect(withFileTransactionLock(path, async () => 42)).resolves.toBe(42);
    }
    finally {
        spy.mockRestore();
    }
    await expect(withFileTransactionLock(path, async () => 43, { waitMs: 200 })).resolves.toBe(43);
    expect((await readdir(dir)).filter(p => p.includes("write-lock"))).toEqual([]);
});

it("reclaims a killed waiter's populated candidate without touching a live writer",async()=>{
 const {path,worker,dir}=await fixture();
 const a=launch(worker,path);await a.wait("entered");
 const b=launch(worker,path);await b.wait("started");
 await vi.waitFor(async()=>{
  const candidates=(await readdir(dir)).filter(p=>p.includes(".candidate-"));
  expect((await Promise.all(candidates.map(p=>readdir(join(dir,p))))).flat().some(p=>p.includes(`.${b.child.pid}.`))).toBe(true);
 },{timeout:5000});
 const exit=once(b.child,"exit");b.child.kill("SIGKILL");await exit;
 await expect(withFileTransactionLock(path,async()=>{}, {waitMs:0})).rejects.toMatchObject({code:"ELOCKED"});
 expect(a.messages).not.toContain("saved");
 a.child.send("go");await a.wait("saved");
 await withFileTransactionLock(path,async()=>{});
 expect((await readdir(dir)).filter(p=>p.includes("write-lock"))).toEqual([]);
});
it("retries cleanup of an unpublished candidate after a failed acquisition",async()=>{
 const {path,worker,dir}=await fixture();const a=launch(worker,path);await a.wait("entered");
 const original=fs.unlink.bind(fs);
 const unlink=vi.spyOn(fs,"unlink").mockImplementation(async path=>{
  if(String(path).includes(".candidate-"))throw Object.assign(Error("busy"),{code:"EBUSY"});
  return original(path);
 });
 try {await expect(withFileTransactionLock(path,async()=>{}, {waitMs:0})).rejects.toMatchObject({code:"ELOCKED"});}
 finally {unlink.mockRestore();}
 await vi.waitFor(async()=>expect((await readdir(dir)).filter(p=>p.includes(".candidate-"))).toEqual([]),{timeout:5000});
 a.child.send("go");await a.wait("saved");
});
