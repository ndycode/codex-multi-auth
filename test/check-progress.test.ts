import { afterEach, expect, it, vi } from "vitest";
import { withCheckProgress } from "../lib/ui/check-progress.js";
afterEach(()=>vi.useRealTimers());
it("renders an elapsed spinner immediately and clears it after completion", async()=>{
 vi.useFakeTimers();
 const write=vi.fn(),log=vi.fn();let finish!:()=>void;
 const pending=withCheckProgress("Checking fixtures",()=>new Promise<void>(resolve=>{finish=resolve;}),log,{isTTY:true,write});
 expect(write.mock.calls[0]?.[0]).toContain("Checking fixtures");
 await vi.advanceTimersByTimeAsync(2100);
 expect(write.mock.calls.some(([line])=>line.includes("2s"))).toBe(true);
 finish();await pending;
 expect(write.mock.calls.at(-1)?.[0]).toBe("\r\x1b[2K");
 expect(vi.getTimerCount()).toBe(0);expect(log).not.toHaveBeenCalled();
});
it("prints plain heartbeat lines without escape codes and stops on failure",async()=>{
 vi.useFakeTimers();const log=vi.fn(),write=vi.fn();let fail!:(error:Error)=>void;
 const pending=withCheckProgress("Refreshing models",()=>new Promise((_,reject)=>{fail=reject;}),log,{isTTY:false,write});
 const caught=pending.catch(e=>e);
 expect(log).toHaveBeenCalledWith("Refreshing models...");
 await vi.advanceTimersByTimeAsync(5100);
 expect(log).toHaveBeenCalledWith("Refreshing models... 5s elapsed");
 fail(Error("fixture failure"));expect((await caught).message).toBe("fixture failure");
 expect(vi.getTimerCount()).toBe(0);expect(write).not.toHaveBeenCalled();
});
