import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAbortableSleep,
	sleepWithCountdown,
} from "../lib/request/wait-utils.js";

describe("wait utils", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves abortable sleep after timeout", async () => {
		const sleep = createAbortableSleep();
		const promise = sleep(1000);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects abortable sleep when aborted", async () => {
		const controller = new AbortController();
		const sleep = createAbortableSleep(controller.signal);
		const promise = sleep(1000);
		controller.abort();
		await expect(promise).rejects.toThrow("Aborted");
	});

	it("shows countdown toasts and sleeps in intervals", async () => {
		const showToast = vi.fn(async () => undefined);
		const sleep = vi.fn(async () => undefined);
		await sleepWithCountdown({
			totalMs: 10_000,
			message: "Waiting",
			sleep,
			showToast,
			formatWaitTime: (ms) => `${ms}ms`,
			toastDurationMs: 9_000,
			intervalMs: 5_000,
		});
		expect(showToast).toHaveBeenCalled();
		expect(sleep).toHaveBeenCalled();
	});
});
