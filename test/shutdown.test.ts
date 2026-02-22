import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	registerCleanup,
	unregisterCleanup,
	runCleanup,
	getCleanupCount,
} from "../lib/shutdown.js";

describe("Graceful shutdown", () => {
	beforeEach(async () => {
		await runCleanup();
	});

	it("registers and runs cleanup functions", async () => {
		const fn = vi.fn();
		registerCleanup(fn);
		expect(getCleanupCount()).toBe(1);
		await runCleanup();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(getCleanupCount()).toBe(0);
	});

	it("unregisters cleanup functions", async () => {
		const fn = vi.fn();
		registerCleanup(fn);
		unregisterCleanup(fn);
		expect(getCleanupCount()).toBe(0);
		await runCleanup();
		expect(fn).not.toHaveBeenCalled();
	});

	it("runs multiple cleanup functions in order", async () => {
		const order: number[] = [];
		registerCleanup(() => { order.push(1); });
		registerCleanup(() => { order.push(2); });
		registerCleanup(() => { order.push(3); });
		await runCleanup();
		expect(order).toEqual([1, 2, 3]);
	});

	it("handles async cleanup functions", async () => {
		const fn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		registerCleanup(fn);
		await runCleanup();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("continues cleanup even if one function throws", async () => {
		const fn1 = vi.fn(() => { throw new Error("fail"); });
		const fn2 = vi.fn();
		registerCleanup(fn1);
		registerCleanup(fn2);
		await runCleanup();
		expect(fn1).toHaveBeenCalled();
		expect(fn2).toHaveBeenCalled();
	});

	it("clears cleanup list after running", async () => {
		registerCleanup(() => {});
		registerCleanup(() => {});
		expect(getCleanupCount()).toBe(2);
		await runCleanup();
		expect(getCleanupCount()).toBe(0);
	});

	it("unregister is no-op for non-registered function", () => {
		const fn = vi.fn();
		unregisterCleanup(fn);
		expect(getCleanupCount()).toBe(0);
	});

	describe("process signal integration", () => {
		it("SIGINT handler runs cleanup and exits with code 0", async () => {
			const capturedHandlers = new Map<string, (...args: unknown[]) => void>();
			
			const processOnceSpy = vi.spyOn(process, "once").mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
				capturedHandlers.set(String(event), handler);
				return process;
			});
			const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

			vi.resetModules();
			const { registerCleanup: freshRegister, runCleanup: freshRunCleanup } = await import("../lib/shutdown.js");
			await freshRunCleanup();

			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			const sigintHandler = capturedHandlers.get("SIGINT");
			expect(sigintHandler).toBeDefined();

			sigintHandler!();
			await new Promise((r) => setTimeout(r, 10));

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(0);

			processOnceSpy.mockRestore();
			processExitSpy.mockRestore();
		});

		it("SIGTERM handler runs cleanup and exits with code 0", async () => {
			const capturedHandlers = new Map<string, (...args: unknown[]) => void>();
			
			const processOnceSpy = vi.spyOn(process, "once").mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
				capturedHandlers.set(String(event), handler);
				return process;
			});
			const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

			vi.resetModules();
			const { registerCleanup: freshRegister, runCleanup: freshRunCleanup } = await import("../lib/shutdown.js");
			await freshRunCleanup();

			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			const sigtermHandler = capturedHandlers.get("SIGTERM");
			expect(sigtermHandler).toBeDefined();

			sigtermHandler!();
			await new Promise((r) => setTimeout(r, 10));

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(0);

			processOnceSpy.mockRestore();
			processExitSpy.mockRestore();
		});

		it("beforeExit handler runs cleanup without calling exit", async () => {
			const capturedHandlers = new Map<string, (...args: unknown[]) => void>();
			
			const processOnceSpy = vi.spyOn(process, "once").mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
				capturedHandlers.set(String(event), handler);
				return process;
			});
			const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

			vi.resetModules();
			const { registerCleanup: freshRegister, runCleanup: freshRunCleanup } = await import("../lib/shutdown.js");
			await freshRunCleanup();

			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			const beforeExitHandler = capturedHandlers.get("beforeExit");
			expect(beforeExitHandler).toBeDefined();

			beforeExitHandler!();
			await new Promise((r) => setTimeout(r, 10));

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).not.toHaveBeenCalled();

			processOnceSpy.mockRestore();
			processExitSpy.mockRestore();
		});

		it("signal handlers are only registered once", async () => {
			const processOnceSpy = vi.spyOn(process, "once").mockImplementation(() => process);

			vi.resetModules();
			const { registerCleanup: freshRegister } = await import("../lib/shutdown.js");

			freshRegister(() => {});
			const firstCallCount = processOnceSpy.mock.calls.length;

			freshRegister(() => {});
			expect(processOnceSpy.mock.calls.length).toBe(firstCallCount);

			processOnceSpy.mockRestore();
		});
	});
});
