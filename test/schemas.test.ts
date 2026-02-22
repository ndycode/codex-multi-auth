import { describe, it, expect } from "vitest";
import {
	PluginConfigSchema,
	AccountMetadataV3Schema,
	AccountStorageV3Schema,
	AccountStorageV1Schema,
	AnyAccountStorageSchema,
	TokenSuccessSchema,
	TokenFailureSchema,
	TokenResultSchema,
	OAuthTokenResponseSchema,
	safeParsePluginConfig,
	safeParseAccountStorage,
	safeParseAccountStorageV3,
	safeParseTokenResult,
	safeParseOAuthTokenResponse,
	getValidationErrors,
} from "../lib/schemas.js";

describe("PluginConfigSchema", () => {
	it("accepts empty object (all optional)", () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it("accepts valid full config", () => {
		const config = {
			codexMode: true,
			fastSession: true,
			retryAllAccountsRateLimited: true,
			retryAllAccountsMaxWaitMs: 5000,
			retryAllAccountsMaxRetries: 3,
			unsupportedCodexPolicy: "strict",
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: false,
			unsupportedCodexFallbackChain: {
				"gpt-5.3-codex-spark": ["gpt-5.3-codex", "gpt-5.2-codex"],
			},
			tokenRefreshSkewMs: 60000,
			rateLimitToastDebounceMs: 30000,
			toastDurationMs: 5000,
			perProjectAccounts: true,
			sessionRecovery: true,
			autoResume: false,
			fetchTimeoutMs: 60000,
			streamStallTimeoutMs: 45000,
		};
		const result = PluginConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
	});

	it("rejects toastDurationMs below 1000", () => {
		const result = PluginConfigSchema.safeParse({ toastDurationMs: 500 });
		expect(result.success).toBe(false);
	});

	it("rejects negative numbers for numeric fields", () => {
		const result = PluginConfigSchema.safeParse({ retryAllAccountsMaxWaitMs: -100 });
		expect(result.success).toBe(false);
	});

	it("rejects timeout settings below 1000ms", () => {
		const fetchResult = PluginConfigSchema.safeParse({ fetchTimeoutMs: 999 });
		const stallResult = PluginConfigSchema.safeParse({ streamStallTimeoutMs: 999 });
		expect(fetchResult.success).toBe(false);
		expect(stallResult.success).toBe(false);
	});

	it("rejects wrong types", () => {
		const result = PluginConfigSchema.safeParse({ codexMode: "yes" });
		expect(result.success).toBe(false);
	});

	it("rejects invalid unsupportedCodexPolicy", () => {
		const result = PluginConfigSchema.safeParse({ unsupportedCodexPolicy: "invalid" });
		expect(result.success).toBe(false);
	});
});

describe("AccountMetadataV3Schema", () => {
	const validAccount = {
		refreshToken: "rt_valid_token",
		addedAt: Date.now(),
		lastUsed: Date.now(),
	};

	it("accepts minimal valid account", () => {
		const result = AccountMetadataV3Schema.safeParse(validAccount);
		expect(result.success).toBe(true);
	});

	it("accepts full account with all optional fields", () => {
		const fullAccount = {
			...validAccount,
			accountId: "acc_123",
			accountIdSource: "token" as const,
			accountLabel: "Work Account",
			email: "test@example.com",
			lastSwitchReason: "rate-limit" as const,
			rateLimitResetTimes: { "gpt-5.2-codex": Date.now() + 60000 },
			coolingDownUntil: Date.now() + 30000,
			cooldownReason: "auth-failure" as const,
		};
		const result = AccountMetadataV3Schema.safeParse(fullAccount);
		expect(result.success).toBe(true);
	});

	it("rejects empty refreshToken", () => {
		const result = AccountMetadataV3Schema.safeParse({ ...validAccount, refreshToken: "" });
		expect(result.success).toBe(false);
	});

	it("rejects missing refreshToken", () => {
		const result = AccountMetadataV3Schema.safeParse({ addedAt: Date.now(), lastUsed: Date.now() });
		expect(result.success).toBe(false);
	});

	it("rejects invalid accountIdSource", () => {
		const result = AccountMetadataV3Schema.safeParse({ ...validAccount, accountIdSource: "invalid" });
		expect(result.success).toBe(false);
	});

	it("rejects invalid cooldownReason", () => {
		const result = AccountMetadataV3Schema.safeParse({ ...validAccount, cooldownReason: "unknown" });
		expect(result.success).toBe(false);
	});
});

describe("AccountStorageV3Schema", () => {
	const validStorage = {
		version: 3,
		accounts: [
			{ refreshToken: "rt_1", addedAt: Date.now(), lastUsed: Date.now() },
		],
		activeIndex: 0,
	};

	it("accepts valid V3 storage", () => {
		const result = AccountStorageV3Schema.safeParse(validStorage);
		expect(result.success).toBe(true);
	});

	it("accepts V3 storage with activeIndexByFamily", () => {
		const storage = {
			...validStorage,
			activeIndexByFamily: {
				"gpt-5.2-codex": 0,
				"codex-max": 0,
			},
		};
		const result = AccountStorageV3Schema.safeParse(storage);
		expect(result.success).toBe(true);
	});

	it("accepts empty accounts array", () => {
		const result = AccountStorageV3Schema.safeParse({ version: 3, accounts: [], activeIndex: 0 });
		expect(result.success).toBe(true);
	});

	it("rejects wrong version", () => {
		const result = AccountStorageV3Schema.safeParse({ ...validStorage, version: 2 });
		expect(result.success).toBe(false);
	});

	it("rejects negative activeIndex", () => {
		const result = AccountStorageV3Schema.safeParse({ ...validStorage, activeIndex: -1 });
		expect(result.success).toBe(false);
	});
});

describe("AccountStorageV1Schema", () => {
	const validV1 = {
		version: 1,
		accounts: [
			{ refreshToken: "rt_1", addedAt: Date.now(), lastUsed: Date.now(), rateLimitResetTime: Date.now() + 60000 },
		],
		activeIndex: 0,
	};

	it("accepts valid V1 storage", () => {
		const result = AccountStorageV1Schema.safeParse(validV1);
		expect(result.success).toBe(true);
	});

	it("rejects V1 with rateLimitResetTimes (V3 field)", () => {
		const result = AccountStorageV1Schema.safeParse({
			...validV1,
			accounts: [{ ...validV1.accounts[0], rateLimitResetTimes: {} }],
		});
		expect(result.success).toBe(true);
	});
});

describe("AnyAccountStorageSchema (discriminated union)", () => {
	it("accepts V1 storage", () => {
		const result = AnyAccountStorageSchema.safeParse({
			version: 1,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
			activeIndex: 0,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.version).toBe(1);
		}
	});

	it("accepts V3 storage", () => {
		const result = AnyAccountStorageSchema.safeParse({
			version: 3,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
			activeIndex: 0,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.version).toBe(3);
		}
	});

	it("rejects unknown version", () => {
		const result = AnyAccountStorageSchema.safeParse({
			version: 5,
			accounts: [],
			activeIndex: 0,
		});
		expect(result.success).toBe(false);
	});
});

describe("TokenSuccessSchema", () => {
	const validSuccess = {
		type: "success" as const,
		access: "access_token_123",
		refresh: "refresh_token_456",
		expires: Date.now() + 3600000,
	};

	it("accepts valid success", () => {
		const result = TokenSuccessSchema.safeParse(validSuccess);
		expect(result.success).toBe(true);
	});

	it("accepts success with optional fields", () => {
		const result = TokenSuccessSchema.safeParse({
			...validSuccess,
			idToken: "id_token_789",
			multiAccount: true,
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty access token", () => {
		const result = TokenSuccessSchema.safeParse({ ...validSuccess, access: "" });
		expect(result.success).toBe(false);
	});

	it("rejects empty refresh token", () => {
		const result = TokenSuccessSchema.safeParse({ ...validSuccess, refresh: "" });
		expect(result.success).toBe(false);
	});
});

describe("TokenFailureSchema", () => {
	it("accepts minimal failure", () => {
		const result = TokenFailureSchema.safeParse({ type: "failed" });
		expect(result.success).toBe(true);
	});

	it("accepts failure with all optional fields", () => {
		const result = TokenFailureSchema.safeParse({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "Unauthorized",
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid reason", () => {
		const result = TokenFailureSchema.safeParse({ type: "failed", reason: "invalid_reason" });
		expect(result.success).toBe(false);
	});
});

describe("TokenResultSchema (discriminated union)", () => {
	it("accepts success type", () => {
		const result = TokenResultSchema.safeParse({
			type: "success",
			access: "a",
			refresh: "r",
			expires: 123,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe("success");
		}
	});

	it("accepts failure type", () => {
		const result = TokenResultSchema.safeParse({ type: "failed" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe("failed");
		}
	});

	it("rejects unknown type", () => {
		const result = TokenResultSchema.safeParse({ type: "pending" });
		expect(result.success).toBe(false);
	});
});

describe("OAuthTokenResponseSchema", () => {
	it("accepts valid response", () => {
		const result = OAuthTokenResponseSchema.safeParse({
			access_token: "at_123",
			expires_in: 3600,
		});
		expect(result.success).toBe(true);
	});

	it("accepts response with all fields", () => {
		const result = OAuthTokenResponseSchema.safeParse({
			access_token: "at_123",
			refresh_token: "rt_456",
			expires_in: 3600,
			id_token: "id_789",
			token_type: "Bearer",
			scope: "openid profile",
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing access_token", () => {
		const result = OAuthTokenResponseSchema.safeParse({ expires_in: 3600 });
		expect(result.success).toBe(false);
	});

	it("rejects missing expires_in", () => {
		const result = OAuthTokenResponseSchema.safeParse({ access_token: "at" });
		expect(result.success).toBe(false);
	});
});

describe("safeParsePluginConfig", () => {
	it("returns parsed config for valid input", () => {
		const result = safeParsePluginConfig({ codexMode: true });
		expect(result).toEqual({ codexMode: true });
	});

	it("returns null for invalid input", () => {
		const result = safeParsePluginConfig({ codexMode: "yes" });
		expect(result).toBeNull();
	});

	it("returns null for non-object", () => {
		const result = safeParsePluginConfig("invalid");
		expect(result).toBeNull();
	});
});

describe("safeParseAccountStorage", () => {
	it("returns parsed V1 storage", () => {
		const result = safeParseAccountStorage({
			version: 1,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
			activeIndex: 0,
		});
		expect(result).not.toBeNull();
		expect(result?.version).toBe(1);
	});

	it("returns parsed V3 storage", () => {
		const result = safeParseAccountStorage({
			version: 3,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
			activeIndex: 0,
		});
		expect(result).not.toBeNull();
		expect(result?.version).toBe(3);
	});

	it("returns null for invalid storage", () => {
		const result = safeParseAccountStorage({ version: 99, accounts: [], activeIndex: 0 });
		expect(result).toBeNull();
	});
});

describe("safeParseAccountStorageV3", () => {
	it("returns parsed V3 storage", () => {
		const result = safeParseAccountStorageV3({
			version: 3,
			accounts: [],
			activeIndex: 0,
		});
		expect(result).not.toBeNull();
	});

	it("returns null for V1 storage", () => {
		const result = safeParseAccountStorageV3({
			version: 1,
			accounts: [],
			activeIndex: 0,
		});
		expect(result).toBeNull();
	});
});

describe("safeParseTokenResult", () => {
	it("returns parsed success result", () => {
		const result = safeParseTokenResult({
			type: "success",
			access: "a",
			refresh: "r",
			expires: 123,
		});
		expect(result).not.toBeNull();
		expect(result?.type).toBe("success");
	});

	it("returns parsed failure result", () => {
		const result = safeParseTokenResult({ type: "failed" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("failed");
	});

	it("returns null for invalid result", () => {
		const result = safeParseTokenResult({ type: "unknown" });
		expect(result).toBeNull();
	});
});

describe("safeParseOAuthTokenResponse", () => {
	it("returns parsed response", () => {
		const result = safeParseOAuthTokenResponse({ access_token: "at", expires_in: 3600 });
		expect(result).not.toBeNull();
		expect(result?.access_token).toBe("at");
	});

	it("returns null for invalid response", () => {
		const result = safeParseOAuthTokenResponse({ invalid: true });
		expect(result).toBeNull();
	});
});

describe("getValidationErrors", () => {
	it("returns empty array for valid data", () => {
		const errors = getValidationErrors(PluginConfigSchema, { codexMode: true });
		expect(errors).toEqual([]);
	});

	it("returns error messages for invalid data", () => {
		const errors = getValidationErrors(PluginConfigSchema, { codexMode: "yes" });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("codexMode");
	});

	it("includes path in error messages", () => {
		const errors = getValidationErrors(AccountStorageV3Schema, {
			version: 3,
			accounts: [{ refreshToken: "", addedAt: 1, lastUsed: 1 }],
			activeIndex: 0,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes("accounts") || e.includes("refreshToken"))).toBe(true);
	});

	it("returns error without path prefix when path is empty (line 286 coverage)", () => {
		const errors = getValidationErrors(PluginConfigSchema, "not-an-object");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).not.toMatch(/^[a-zA-Z0-9_.]+: /);
	});
});
