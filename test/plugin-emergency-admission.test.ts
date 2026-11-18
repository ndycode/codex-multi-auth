import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import {
	getAccountPolicyKey,
	getAccountPolicyPath,
	saveAccountPolicyStore,
	upsertAccountPolicy,
	type AccountPolicyStore,
} from "../lib/account-policy.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import * as logger from "../lib/logger.js";
import * as runtimePolicy from "../lib/policy/runtime-policy.js";
import { resetRuntimePolicyCacheForTests } from "../lib/policy/runtime-policy-cache.js";
import { resetTrackers } from "../lib/rotation.js";
import { resetRequestResilienceStateForTests } from "../lib/request/request-resilience.js";
import { SessionAffinityStore } from "../lib/session-affinity.js";
import { setStoragePath, type AccountStorageV3 } from "../lib/storage.js";
import { readUsageLedgerRows } from "../lib/usage/index.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

vi.mock("@codex-ai/plugin/tool", () => {
	const schema = () => ({ optional: schema, describe: schema });
	return {
		tool: Object.assign((definition: unknown) => definition, {
			schema: { string: schema, number: schema, boolean: schema },
		}),
	};
});
vi.mock("../lib/update-notice.js", () => ({
	checkAndNotify: vi.fn(async () => undefined),
}));
vi.mock("../lib/config.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/config.js")>(),
	getLiveAccountSync: () => false,
	getProactiveRefreshGuardian: () => false,
	getPrewarmCodexInstructions: () => false,
	getPerProjectAccounts: () => false,
	getContextBudgetGuardEnabled: () => false,
	getRetryAllAccountsRateLimited: () => false,
	getSessionAffinity: () => true,
}));
vi.mock("../lib/request/fetch-helpers.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/request/fetch-helpers.js")>(),
	// Keep real selection/policy/header and stream-failover behavior; bypass only
	// unrelated prompt transformation and response-format conversion.
	transformRequestForCodex: async (init: RequestInit) => ({
		updatedInit: init,
		body: JSON.parse(String(init.body)) as { model: string; stream?: boolean },
	}),
	handleSuccessResponse: async (response: Response) => response,
}));

describe("exported plugin emergency admission", () => {
	let directory: string;
	let manager: AccountManager | undefined;

	beforeEach(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "plugin-emergency-"));
		vi.stubEnv("CODEX_MULTI_AUTH_DIR", directory);
		setStoragePath(null);
		resetRuntimePolicyCacheForTests();
		resetTrackers();
		clearCircuitBreakers();
		resetRequestResilienceStateForTests();
	});

	afterEach(async () => {
		await manager?.flushPendingSave();
		manager = undefined;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		setStoragePath(null);
		resetRuntimePolicyCacheForTests();
		resetTrackers();
		clearCircuitBreakers();
		resetRequestResilienceStateForTests();
		await removeWithRetry(directory, { recursive: true, force: true });
	});

	async function request(mode:
		| "ordinary" | "only-emergency" | "affinity" | "paused"
		| "invalid-auth" | "disabled-workspace" | "stream" | "stream-policy"
		| "malformed-policy" | "load-failure" | "evaluation-failure" | "missing-policy",
	) {
		const now = Date.now();
		const account = (index: number): AccountStorageV3["accounts"][number] => ({
			accountId: `fixture-account-${index}`,
			accountIdSource: "manual",
			refreshToken: `fixture-refresh-${index}`,
			accessToken: `fixture-access-${index}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 1000,
			lastUsed: now - 1000,
		});
		const accounts = [account(0)];
		if (mode !== "only-emergency") accounts.push(account(1));
		if (mode.startsWith("stream")) accounts.push(account(2));
		if (mode === "stream-policy") accounts.push(account(3));
		if (mode === "invalid-auth") accounts[1]!.authInvalidatedAt = now - 1;
		if (mode === "disabled-workspace") {
			accounts[1]!.workspaces = [{ id: "fixture-account-1", enabled: false }];
			accounts[1]!.currentWorkspaceIndex = 0;
		}
		manager = new AccountManager(undefined, { version: 3, accounts, activeIndex: 0 });
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
		vi.spyOn(manager, "syncCodexCliActiveSelectionForIndex").mockResolvedValue(undefined);
		const policies: AccountPolicyStore = { version: 1, accounts: {} };
		upsertAccountPolicy(policies, getAccountPolicyKey(accounts[0]!, 0), (policy) => {
			policy.emergencyOnly = true;
			policy.weight = 10;
		});
		if (mode === "paused") {
			upsertAccountPolicy(policies, getAccountPolicyKey(accounts[1]!, 1), (policy) => {
				policy.paused = true;
			});
		}
		if (mode === "stream-policy") {
			upsertAccountPolicy(policies, getAccountPolicyKey(accounts[2]!, 2), (policy) => {
				policy.paused = true;
			});
		}
		if (mode !== "missing-policy") await saveAccountPolicyStore(policies);
		if (mode === "malformed-policy") {
			await fs.writeFile(getAccountPolicyPath(), JSON.stringify({
				version: 1,
				accounts: {
					[getAccountPolicyKey(accounts[0]!, 0)]: { emergencyOnly: "true" },
				},
			}));
		}
		if (mode === "load-failure") {
			vi.spyOn(runtimePolicy, "loadRuntimePolicyState")
				.mockRejectedValueOnce(new Error("synthetic-sensitive-policy-details"));
		}
		if (mode === "evaluation-failure") {
			vi.spyOn(runtimePolicy, "evaluateRuntimePolicy")
				.mockRejectedValueOnce(new Error("synthetic-sensitive-policy-details"));
		}
		if (mode === "affinity") {
			vi.spyOn(SessionAffinityStore.prototype, "getPreferredAccountIndex").mockReturnValue(0);
		}
		if (mode.startsWith("stream")) {
			vi.spyOn(SessionAffinityStore.prototype, "getPreferredAccountIndex").mockReturnValue(1);
			vi.stubEnv("CODEX_AUTH_STREAM_FAILOVER_MAX", "1");
		}
		let requestCount = 0;
		const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
			requestCount += 1;
			if (mode.startsWith("stream")) {
				if (requestCount === 1) return new Response(new ReadableStream<Uint8Array>({
					start(controller) { controller.error(new Error("synthetic stream failure")); },
				}), { headers: { "content-type": "text/event-stream" } });
				if (requestCount === 2) return Response.json({ error: { message: "synthetic unavailable" } }, { status: 503 });
				return new Response("data: recovered fixture\n\n", { headers: { "content-type": "text/event-stream" } });
			}
			return Response.json({ fixture: true });
		});
		vi.stubGlobal("fetch", upstream);
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({
			client: {
				tui: { showToast: vi.fn() },
				auth: { set: vi.fn() },
				session: { prompt: vi.fn() },
			},
		} as never);
		const sdk = await plugin.auth!.loader!(
			async () => ({
				type: "oauth", access: "fixture-access-0", refresh: "fixture-refresh-0",
				expires: now + 3_600_000,
			}),
			{ options: {}, models: {} } as never,
		);
		const response = await sdk.fetch!("https://api.openai.com/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "gpt-5.1", input: "synthetic fixture", stream: mode.startsWith("stream"),
			}),
		});
		return { response, upstream };
	}

	it.each(["ordinary", "affinity"] as const)("uses ordinary capacity instead of the reserved account (%s)", async (mode) => {
		const { response, upstream } = await request(mode);
		expect(response.status).toBe(200);
		expect(upstream).toHaveBeenCalledTimes(1);
		const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
		expect(headers.get("chatgpt-account-id")).toBe("fixture-account-1");
	});

	it.each(["stream", "stream-policy"] as const)("keeps reserved and policy-blocked accounts out of streaming failover (%s)", async (mode) => {
		const { response, upstream } = await request(mode);
		expect(await response.text()).toContain("recovered fixture");
		expect(upstream.mock.calls.map((call) => new Headers(call[1]?.headers).get("chatgpt-account-id")))
			.toEqual(["fixture-account-1", "fixture-account-1", mode === "stream" ? "fixture-account-2" : "fixture-account-3"]);
	});

	it.each(["only-emergency", "paused", "invalid-auth", "disabled-workspace"] as const)("does not open emergency capacity when ordinary capacity is unavailable (%s)", async (mode) => {
		const { response, upstream } = await request(mode);
		expect(response.status).toBe(503);
		expect(upstream).not.toHaveBeenCalled();
	});

	it.each(["malformed-policy", "load-failure", "evaluation-failure"] as const)("fails closed and records a sanitized policy error (%s)", async (mode) => {
		const warning = vi.spyOn(logger, "logWarn");
		const { response, upstream } = await request(mode);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "runtime_policy_unavailable" },
		});
		expect(upstream).not.toHaveBeenCalled();
		expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-sensitive-policy-details");
		expect(await readUsageLedgerRows()).toEqual([
			expect.objectContaining({
				source: "plugin-host", operation: "responses", outcome: "blocked",
				statusCode: 503, errorCode: "runtime_policy_unavailable", account: null,
			}),
		]);
	});

	it("retains the valid empty policy when the policy file does not exist", async () => {
		const { response, upstream } = await request("missing-policy");
		expect(response.status).toBe(200);
		expect(upstream).toHaveBeenCalledTimes(1);
	});
});
