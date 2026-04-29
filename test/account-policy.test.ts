import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("account policy store", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-account-policy-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("stores policy rows by hashed account identity", async () => {
		const {
			getAccountPolicyKey,
			getAccountPolicyPath,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const account = {
			accountId: "acct_sensitive",
			email: "owner@example.com",
		};
		const accountKey = getAccountPolicyKey(account, 0);
		const store = await loadAccountPolicyStore();
		upsertAccountPolicy(store, accountKey, (policy) => {
			policy.tags.push("Team A");
			policy.weight = 2;
			policy.paused = true;
			policy.note = "local note";
		}, 123);
		await saveAccountPolicyStore(store);

		const raw = await fs.readFile(getAccountPolicyPath(), "utf8");
		expect(raw).toContain("team-a");
		expect(raw).not.toContain("acct_sensitive");
		expect(raw).not.toContain("owner@example.com");

		const loaded = await loadAccountPolicyStore();
		expect(loaded.accounts[accountKey]).toMatchObject({
			tags: ["team-a"],
			weight: 2,
			paused: true,
			note: "local note",
			updatedAt: 123,
		});
	});
});

