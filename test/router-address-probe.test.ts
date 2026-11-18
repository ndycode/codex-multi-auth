import * as net from "node:net";
vi.mock("node:net", async (importOriginal) => ({ ...await importOriginal<typeof import("node:net")>(), connect: vi.fn() }));
import { afterEach, it, expect, vi } from "vitest";
import { probeRouterAddress } from "../lib/runtime/app-bind.js";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("waits for a delayed Windows connection refusal instead of declaring the address unknown", async () => {
    vi.useFakeTimers();
    const socket = new net.Socket();
    vi.mocked(net.connect).mockReturnValue(socket);
    const result = probeRouterAddress("http://127.0.0.1:12345", "win32");
    setTimeout(() => socket.emit("error", Object.assign(Error("fixture refusal"), { code: "ECONNREFUSED" })), 1500);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("refused");
    expect(socket.destroyed).toBe(true);
});
