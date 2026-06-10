import { describe, expect, it } from "vitest";
import {
	FILE_RETRY_CODES,
	shouldRetryFileOperation,
} from "../lib/fs-retry.js";

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("shouldRetryFileOperation", () => {
	it("treats every transient lock code as retryable", () => {
		for (const code of ["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]) {
			expect(shouldRetryFileOperation(errnoError(code)), code).toBe(true);
			expect(FILE_RETRY_CODES.has(code), code).toBe(true);
		}
	});

	it("does not retry non-transient errors", () => {
		for (const code of ["ENOENT", "EISDIR", "EINVAL", "EROFS"]) {
			expect(shouldRetryFileOperation(errnoError(code)), code).toBe(false);
		}
	});

	it("returns false for non-errors and errors without a code", () => {
		expect(shouldRetryFileOperation(undefined)).toBe(false);
		expect(shouldRetryFileOperation(null)).toBe(false);
		expect(shouldRetryFileOperation("EACCES")).toBe(false);
		expect(shouldRetryFileOperation(new Error("no code"))).toBe(false);
	});
});
