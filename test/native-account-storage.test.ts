import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeAccountStorageReader } from "../lib/runtime/native-account-storage.js";
import * as parser from "../lib/storage/storage-parser.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
it("caches settled primary storage but adopts credential revocation on change", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-cache-"));
    roots.push(root);
    const path = join(root, "accounts.json");
    const disk = { version: 3, activeIndex: 0, accounts: [{ accountId: "example", email: "example@example.test", accessToken: "fixture-access", refreshToken: "fixture-refresh", addedAt: 1, lastUsed: 1 }] };
    await writeFile(path, JSON.stringify(disk));
    await utimes(path, new Date(0), new Date(0));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
    const parse = vi.spyOn(parser, "loadAccountsFromPath"), read = createNativeAccountStorageReader(undefined, path);
    const first = await read();
    expect(first.storage?.accounts[0]?.accessToken).toBe("fixture-access");
    first.storage!.accounts[0]!.accessToken = "mutated";
    expect((await read()).storage?.accounts[0]?.accessToken).toBe("fixture-access");
    expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(path, JSON.stringify({ ...disk, accounts: [{ ...disk.accounts[0], accessToken: undefined, enabled: false }] }));
    const revoked = await read();
    expect(revoked.verified).toBe(true);
    expect(revoked.storage?.accounts[0]?.accessToken).toBeUndefined();
    expect(revoked.storage?.accounts[0]?.enabled).toBe(false);
    await rm(path);
    expect((await read()).storage).toBeNull();
});
it("bounds the fallback grace and never labels cached credentials as verified", async () => {
    let now = 10000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const readFile = vi.fn().mockResolvedValueOnce({ version: 3, activeIndex: 0, accounts: [] }).mockRejectedValue(Object.assign(Error("locked"), { code: "EBUSY" }));
    const read = createNativeAccountStorageReader(readFile, "unused");
    expect((await read()).verified).toBe(true);
    expect((await read()).verified).toBe(false);
    now += 2001;
    expect((await read()).storage).toBeNull();
    expect(readFile).toHaveBeenCalledTimes(3);
});

it("refreshes the bounded fallback age after a verified settled cache hit", async () => {
    const root=await mkdtemp(join(tmpdir(),"native-cache-age-")); roots.push(root);
    const path=join(root,"accounts.json");
    await writeFile(path,JSON.stringify({version:3,activeIndex:0,accounts:[]}));
    let now=Date.now()+3000; vi.spyOn(Date,"now").mockImplementation(()=>now);
    const parse=vi.spyOn(parser,"loadAccountsFromPath"), read=createNativeAccountStorageReader(undefined,path);
    const initial=await read(); now+=10000;
    expect((await read()).verified).toBe(true); expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(path,"changed"); parse.mockRejectedValueOnce(Object.assign(Error("locked"),{code:"EBUSY"}));
    expect(await read()).toEqual({storage:initial.storage,verified:false,transientFailure:true,routingAvailable:true});
});


it("counts a verified cache hit as fresh so one EBUSY after steady traffic keeps the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-cache-grace-"));
    roots.push(root);
    const path = join(root, "accounts.json");
    const disk = { version: 3, activeIndex: 0, accounts: [{ accountId: "example", email: "example@example.test", accessToken: "fixture-access", refreshToken: "fixture-refresh", addedAt: 1, lastUsed: 1 }] };
    await writeFile(path, JSON.stringify(disk));
    await utimes(path, new Date(0), new Date(0));
    let now = Date.now() + 3000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = createNativeAccountStorageReader(undefined, path);
    expect((await read()).verified).toBe(true);
    now += 10_000;
    expect((await read()).verified).toBe(true);
    now += 1_000;
    await writeFile(path, JSON.stringify({ ...disk, activeIndex: 0, accounts: [{ ...disk.accounts[0], lastUsed: 2 }] }));
    vi.spyOn(parser, "loadAccountsFromPath").mockRejectedValueOnce(Object.assign(Error("locked"), { code: "EBUSY" }));
    const busy = await read();
    expect(busy.verified).toBe(false);
    expect(busy.storage?.accounts[0]?.accessToken).toBe("fixture-access");
});
