import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FILE_RETRY_CODES,
	withFileOperationRetry,
	withRetry,
	withRetrySync,
	shouldRetryFileOperation,
} from "../lib/fs-retry.js";

function makeErrnoError(code: string, message = code): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("withRetry", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the result on first-try success without retrying", async () => {
		const operation = vi.fn(async () => "ok");
		await expect(
			withRetry(operation, { maxAttempts: 5, backoffMs: 10 }),
		).resolves.toBe("ok");
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it("retries a retryable code and resolves once the operation succeeds", async () => {
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(makeErrnoError("EBUSY"))
			.mockRejectedValueOnce(makeErrnoError("EPERM"))
			.mockResolvedValueOnce("done");
		await expect(
			withRetry(operation, { maxAttempts: 5, backoffMs: 0 }),
		).resolves.toBe("done");
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it("rethrows the last error once maxAttempts is exhausted", async () => {
		const first = makeErrnoError("EBUSY", "first failure");
		const last = makeErrnoError("EPERM", "last failure");
		const operation = vi
			.fn<() => Promise<never>>()
			.mockRejectedValueOnce(first)
			.mockRejectedValueOnce(makeErrnoError("EBUSY", "middle failure"))
			.mockRejectedValue(last);
		await expect(
			withRetry(operation, { maxAttempts: 3, backoffMs: 0 }),
		).rejects.toBe(last);
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it("throws immediately on a non-retryable code", async () => {
		const error = makeErrnoError("ENOENT");
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);
		await expect(
			withRetry(operation, { maxAttempts: 5, backoffMs: 10 }),
		).rejects.toBe(error);
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it("throws immediately on errors without a string code", async () => {
		const error = new Error("no code at all");
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);
		await expect(
			withRetry(operation, { maxAttempts: 5, backoffMs: 10 }),
		).rejects.toBe(error);
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it("honors a custom retryableCodes array and rejects default codes", async () => {
		const ebusy = makeErrnoError("EBUSY");
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(ebusy);
		await expect(
			withRetry(operation, {
				maxAttempts: 5,
				backoffMs: 0,
				retryableCodes: ["ESTALE"],
			}),
		).rejects.toBe(ebusy);
		expect(operation).toHaveBeenCalledTimes(1);

		const estale = makeErrnoError("ESTALE");
		const recovers = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(estale)
			.mockResolvedValueOnce("recovered");
		await expect(
			withRetry(recovers, {
				maxAttempts: 3,
				backoffMs: 0,
				retryableCodes: ["ESTALE"],
			}),
		).resolves.toBe("recovered");
		expect(recovers).toHaveBeenCalledTimes(2);
	});

	it("defaults retryableCodes to FILE_RETRY_CODES", async () => {
		for (const code of FILE_RETRY_CODES) {
			const operation = vi
				.fn<() => Promise<string>>()
				.mockRejectedValueOnce(makeErrnoError(code))
				.mockResolvedValueOnce("ok");
			await expect(
				withRetry(operation, { maxAttempts: 2, backoffMs: 0 }),
			).resolves.toBe("ok");
			expect(operation).toHaveBeenCalledTimes(2);
		}
	});

	it("honors the exponential backoff schedule between attempts", async () => {
		vi.useFakeTimers();
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(makeErrnoError("EBUSY"))
			.mockRejectedValueOnce(makeErrnoError("EBUSY"))
			.mockRejectedValueOnce(makeErrnoError("EBUSY"))
			.mockResolvedValueOnce("ok");
		const pending = withRetry(operation, {
			maxAttempts: 5,
			backoffMs: (attempt) => 10 * 2 ** (attempt - 1),
		});
		// First attempt runs immediately; no timer has elapsed yet.
		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);
		// 9ms is one short of the first 10ms delay.
		await vi.advanceTimersByTimeAsync(9);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(operation).toHaveBeenCalledTimes(2);
		// Second delay is 20ms.
		await vi.advanceTimersByTimeAsync(19);
		expect(operation).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(operation).toHaveBeenCalledTimes(3);
		// Third delay is 40ms.
		await vi.advanceTimersByTimeAsync(40);
		expect(operation).toHaveBeenCalledTimes(4);
		await expect(pending).resolves.toBe("ok");
	});

	it("adds jitter to the backoff delay", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.999);
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(makeErrnoError("EBUSY"))
			.mockResolvedValueOnce("ok");
		const pending = withRetry(operation, {
			maxAttempts: 2,
			backoffMs: 10,
			jitterMs: 20,
		});
		// Delay is 10 + floor(0.999 * 20) = 29ms.
		await vi.advanceTimersByTimeAsync(28);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(operation).toHaveBeenCalledTimes(2);
		await expect(pending).resolves.toBe("ok");
	});

	it("retries immediately without scheduling a timer when the delay is zero", async () => {
		vi.useFakeTimers();
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(makeErrnoError("EBUSY"))
			.mockResolvedValueOnce("ok");
		// With fake timers active, a setTimeout-based sleep would hang until the
		// clock is advanced; a zero delay must resolve without any timer.
		await expect(
			withRetry(operation, { maxAttempts: 2, backoffMs: 0 }),
		).resolves.toBe("ok");
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it("invokes onRetry for each retryable failure but not for the final one", async () => {
		const first = makeErrnoError("EBUSY", "first");
		const second = makeErrnoError("EPERM", "second");
		const last = makeErrnoError("EACCES", "last");
		const operation = vi
			.fn<() => Promise<never>>()
			.mockRejectedValueOnce(first)
			.mockRejectedValueOnce(second)
			.mockRejectedValue(last);
		const onRetry = vi.fn();
		await expect(
			withRetry(operation, { maxAttempts: 3, backoffMs: 0, onRetry }),
		).rejects.toBe(last);
		expect(onRetry).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenNthCalledWith(1, first, 1);
		expect(onRetry).toHaveBeenNthCalledWith(2, second, 2);
	});
});

describe("withRetrySync", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the result on first-try success", () => {
		const operation = vi.fn(() => 42);
		expect(withRetrySync(operation, { maxAttempts: 4, backoffMs: 0 })).toBe(42);
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it("retries a retryable code and returns once the operation succeeds", () => {
		const operation = vi
			.fn<() => string>()
			.mockImplementationOnce(() => {
				throw makeErrnoError("EBUSY");
			})
			.mockReturnValueOnce("done");
		expect(
			withRetrySync(operation, {
				maxAttempts: 4,
				backoffMs: 1,
				retryableCodes: new Set(["EBUSY"]),
			}),
		).toBe("done");
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it("rethrows the last error once maxAttempts is exhausted", () => {
		const last = makeErrnoError("EPERM", "still locked");
		const operation = vi.fn<() => never>(() => {
			throw last;
		});
		expect(() =>
			withRetrySync(operation, { maxAttempts: 4, backoffMs: 0 }),
		).toThrow(last);
		expect(operation).toHaveBeenCalledTimes(4);
	});

	it("throws immediately on a non-retryable code", () => {
		const error = makeErrnoError("ENOENT");
		const operation = vi.fn<() => never>(() => {
			throw error;
		});
		expect(() =>
			withRetrySync(operation, { maxAttempts: 4, backoffMs: 0 }),
		).toThrow(error);
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it("invokes onRetry with the failure and the 1-based attempt index", () => {
		const error = makeErrnoError("EBUSY");
		const operation = vi
			.fn<() => string>()
			.mockImplementationOnce(() => {
				throw error;
			})
			.mockReturnValueOnce("ok");
		const onRetry = vi.fn();
		expect(
			withRetrySync(operation, { maxAttempts: 2, backoffMs: 0, onRetry }),
		).toBe("ok");
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry).toHaveBeenCalledWith(error, 1);
	});
});

describe("withFileOperationRetry", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("retains the shared schedule: 6 attempts with 25ms exponential backoff plus jitter", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		const last = makeErrnoError("EBUSY", "always locked");
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(last);
		const pending = withFileOperationRetry(operation);
		const rejection = expect(pending).rejects.toBe(last);
		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);
		// Delays: 25, 50, 100, 200, 400 (jitter mocked to 0).
		for (const [index, delay] of [25, 50, 100, 200, 400].entries()) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(operation).toHaveBeenCalledTimes(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(operation).toHaveBeenCalledTimes(index + 2);
		}
		expect(operation).toHaveBeenCalledTimes(6);
		await rejection;
	});

	it("throws immediately on a non-retryable code", async () => {
		const error = makeErrnoError("ENOENT");
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);
		await expect(withFileOperationRetry(operation)).rejects.toBe(error);
		expect(operation).toHaveBeenCalledTimes(1);
	});
});


describe("shouldRetryFileOperation", () => {
	it("treats every transient lock code as retryable", () => {
		for (const code of ["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]) {
			expect(shouldRetryFileOperation(makeErrnoError(code)), code).toBe(true);
			expect(FILE_RETRY_CODES.has(code), code).toBe(true);
		}
	});

	it("does not retry non-transient errors", () => {
		for (const code of ["ENOENT", "EISDIR", "EINVAL", "EROFS"]) {
			expect(shouldRetryFileOperation(makeErrnoError(code)), code).toBe(false);
		}
	});

	it("returns false for non-errors and errors without a code", () => {
		expect(shouldRetryFileOperation(undefined)).toBe(false);
		expect(shouldRetryFileOperation(null)).toBe(false);
		expect(shouldRetryFileOperation("EACCES")).toBe(false);
		expect(shouldRetryFileOperation(new Error("no code"))).toBe(false);
	});
});
