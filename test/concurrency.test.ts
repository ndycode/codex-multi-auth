import { expect, it } from "vitest";
import { mapWithConcurrency } from "../lib/concurrency.js";
it("bounds active work and preserves order while draining failures", async () => {
    let active = 0, maximum = 0;
    const result = await mapWithConcurrency([3, 2, 1, 0], 2, async (value) => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return value; });
    expect(result).toEqual([3, 2, 1, 0]);
    expect(maximum).toBe(2);
    let released!: () => void;
    const gate = new Promise<void>(resolve => { released = resolve; });
    let settled = false;
    let failed=false,parked!:()=>void;
    const waiting=new Promise<void>(resolve=>{parked=resolve;});
    const pending = mapWithConcurrency([0,1,2],2,async value=>{
        if(value===0){failed=true;throw Error("fixture");}
        parked();await gate;return value;
    }).catch(e=>{settled=true;return e;});
    try {
        await waiting;
        await new Promise(resolve=>setImmediate(resolve));
        expect(failed).toBe(true);
        expect(settled).toBe(false);
    } finally {released();}
    expect((await pending).message).toBe("fixture");
});
it("rejects invalid concurrency and handles empty input", async () => {
    await expect(mapWithConcurrency([], 0, async () => 0)).rejects.toThrow("Concurrency");
    expect(await mapWithConcurrency([], 3, async () => 0)).toEqual([]);
});
