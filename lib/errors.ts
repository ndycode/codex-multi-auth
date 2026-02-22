/**
 * Typed error hierarchy for the Codex plugin.
 * Provides structured error types with codes, causes, and context.
 */

/**
 * Error codes for categorizing errors.
 */
export const ErrorCode = {
	NETWORK_ERROR: "CODEX_NETWORK_ERROR",
	API_ERROR: "CODEX_API_ERROR",
	AUTH_ERROR: "CODEX_AUTH_ERROR",
	VALIDATION_ERROR: "CODEX_VALIDATION_ERROR",
	RATE_LIMIT: "CODEX_RATE_LIMIT",
	TIMEOUT: "CODEX_TIMEOUT",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Options for creating a CodexError.
 */
export interface CodexErrorOptions {
	code?: string;
	cause?: unknown;
	context?: Record<string, unknown>;
}

/**
 * Base error class for all Codex plugin errors.
 * Supports error chaining via `cause` and arbitrary context data.
 */
export class CodexError extends Error {
	override readonly name: string = "CodexError";
	readonly code: string;
	readonly context?: Record<string, unknown>;

	constructor(message: string, options?: CodexErrorOptions) {
		super(message, { cause: options?.cause });
		this.code = options?.code ?? ErrorCode.API_ERROR;
		this.context = options?.context;

		// istanbul ignore next -- Error.captureStackTrace always exists in Node.js
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

/**
 * Options for creating a CodexApiError.
 */
export interface CodexApiErrorOptions extends CodexErrorOptions {
	status: number;
	headers?: Record<string, string>;
}

/**
 * Error for HTTP/API response errors.
 */
export class CodexApiError extends CodexError {
	override readonly name = "CodexApiError";
	readonly status: number;
	readonly headers?: Record<string, string>;

	constructor(message: string, options: CodexApiErrorOptions) {
		super(message, { ...options, code: options.code ?? ErrorCode.API_ERROR });
		this.status = options.status;
		this.headers = options.headers;
	}
}

/**
 * Options for creating a CodexAuthError.
 */
export interface CodexAuthErrorOptions extends CodexErrorOptions {
	accountId?: string;
	retryable?: boolean;
}

/**
 * Error for authentication failures.
 */
export class CodexAuthError extends CodexError {
	override readonly name = "CodexAuthError";
	readonly accountId?: string;
	readonly retryable: boolean;

	constructor(message: string, options?: CodexAuthErrorOptions) {
		super(message, { ...options, code: options?.code ?? ErrorCode.AUTH_ERROR });
		this.accountId = options?.accountId;
		this.retryable = options?.retryable ?? false;
	}
}

/**
 * Options for creating a CodexNetworkError.
 */
export interface CodexNetworkErrorOptions extends CodexErrorOptions {
	retryable?: boolean;
}

/**
 * Error for network/connection failures.
 */
export class CodexNetworkError extends CodexError {
	override readonly name = "CodexNetworkError";
	readonly retryable: boolean;

	constructor(message: string, options?: CodexNetworkErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.NETWORK_ERROR,
		});
		this.retryable = options?.retryable ?? true;
	}
}

/**
 * Options for creating a CodexValidationError.
 */
export interface CodexValidationErrorOptions extends CodexErrorOptions {
	field?: string;
	expected?: string;
}

/**
 * Error for input validation failures.
 */
export class CodexValidationError extends CodexError {
	override readonly name = "CodexValidationError";
	readonly field?: string;
	readonly expected?: string;

	constructor(message: string, options?: CodexValidationErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.VALIDATION_ERROR,
		});
		this.field = options?.field;
		this.expected = options?.expected;
	}
}

/**
 * Options for creating a CodexRateLimitError.
 */
export interface CodexRateLimitErrorOptions extends CodexErrorOptions {
	retryAfterMs?: number;
	accountId?: string;
}

/**
 * Error for rate limit exceeded.
 */
export class CodexRateLimitError extends CodexError {
	override readonly name = "CodexRateLimitError";
	readonly retryAfterMs?: number;
	readonly accountId?: string;

	constructor(message: string, options?: CodexRateLimitErrorOptions) {
		super(message, { ...options, code: options?.code ?? ErrorCode.RATE_LIMIT });
		this.retryAfterMs = options?.retryAfterMs;
		this.accountId = options?.accountId;
	}
}
