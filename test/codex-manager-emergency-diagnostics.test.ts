import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_INVALIDATION_MARKER } from "../lib/accounts.js";
import {
	getAccountPolicyKey,
	getAccountPolicyPath,
	saveAccountPolicyStore,
	upsertAccountPolicy,
	type AccountPolicyStore,
} from "../lib/account-policy.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { runCodexMultiAuthCli } from "../lib/codex-manager.js";
import { resetRuntimePolicyCacheForTests } from "../lib/policy/runtime-policy-cache.js";
import { resetTrackers } from "../lib/rotation.js";
import { saveAccounts, setStoragePath, type AccountStorageV3 } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

interface DiagnosticPayload {
	selected: { index: number } | null;
	availableCount: number;
	candidates: Array<{ index: number; score: number; available: boolean; reason?: string }>;
}

describe("why-selected emergency policy through CLI wiring", () => {
	let directory: string;
	let previousDirectory: string | undefined;

	beforeEach(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "cma-emergency-diagnostics-"));
		previousDirectory = process.env.CODEX_MULTI_AUTH_DIR;
		process.env.CODEX_MULTI_AUTH_DIR = directory;
		setStoragePath(null);
		resetRuntimePolicyCacheForTests();
		resetTrackers();
		clearCircuitBreakers();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		if (previousDirectory === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = previousDirectory;
		setStoragePath(null);
		resetRuntimePolicyCacheForTests();
		resetTrackers();
		clearCircuitBreakers();
		await removeWithRetry(directory, { recursive: true, force: true });
	});

	async function runDiagnostic(mode: "ordinary" | "only-emergency" | "paused" | "invalid-auth" | "disabled-workspace") {
		const now = Date.now();
		const emergency: AccountStorageV3["accounts"][number] = {
			accountId: "fixture-emergency",
			email: "emergency@example.com",
			refreshToken: "fixture-emergency-refresh",
			addedAt: now - 86_400_000,
			lastUsed: now - 86_400_000,
			...(mode === "invalid-auth" ? { authInvalidatedAt: now - 1 } : {}),
			...(mode === "disabled-workspace" ? {
				workspaces: [{ id: "fixture-emergency", enabled: false }],
				currentWorkspaceIndex: 0,
			} : {}),
		};
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [emergency],
		};
		if (mode === "ordinary") storage.accounts.push({
			accountId: "fixture-ordinary",
			email: "ordinary@example.com",
			refreshToken: "fixture-ordinary-refresh",
			addedAt: now,
			lastUsed: now,
		});
		await saveAccounts(storage);
		const policies: AccountPolicyStore = { version: 1, accounts: {} };
		upsertAccountPolicy(policies, getAccountPolicyKey(emergency, 0), (policy) => {
			policy.emergencyOnly = true;
			policy.weight = 10;
			policy.paused = mode === "paused";
		});
		await saveAccountPolicyStore(policies);
		const paths = [join(directory, "openai-codex-accounts.json"), getAccountPolicyPath()];
		const before = await Promise.all(paths.map((path) => fs.readFile(path, "utf8")));
		const fetchMock = vi.fn(() => { throw new Error("diagnostics must remain offline"); });
		vi.stubGlobal("fetch", fetchMock);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const code = await runCodexMultiAuthCli(["why-selected", "--now", "--json"]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await Promise.all(paths.map((path) => fs.readFile(path, "utf8")))).toEqual(before);
		const output = log.mock.calls.find(([line]) => String(line).startsWith("{"));
		expect(output).toBeDefined();
		return { code, payload: JSON.parse(String(output?.[0])) as DiagnosticPayload };
	}

	it("selects ordinary capacity even when an emergency account scores highest", async () => {
		const { code, payload } = await runDiagnostic("ordinary");
		expect(code).toBe(0);
		expect(payload.selected?.index).toBe(1);
		expect(payload.availableCount).toBe(1);
		expect(payload.candidates[0]?.index).toBe(0);
		expect(payload.candidates[0]).toMatchObject({
			available: false,
			reason: "emergency-only: reserved until runtime confirms ordinary capacity and permitted resets are exhausted",
		});
	});

	it("keeps emergency capacity reserved when offline diagnostics cannot prove exhaustion", async () => {
		const { code, payload } = await runDiagnostic("only-emergency");
		expect(code).toBe(1);
		expect(payload.selected).toBeNull();
		expect(payload.availableCount).toBe(0);
		expect(payload.candidates[0]).toMatchObject({ available: false, reason: expect.stringContaining("emergency-only: reserved") });
	});

	it.each([
		["paused", "policy: paused"],
		["invalid-auth", AUTH_INVALIDATION_MARKER],
		["disabled-workspace", "workspace-disabled"],
	] as const)("preserves the existing %s exclusion reason", async (mode, reason) => {
		const { code, payload } = await runDiagnostic(mode);
		expect(code).toBe(1);
		expect(payload.selected).toBeNull();
		expect(payload.candidates[0]).toMatchObject({ available: false, reason });
	});
});
