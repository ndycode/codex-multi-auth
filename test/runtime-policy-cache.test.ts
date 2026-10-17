import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

/**
 * Fault injection for the account-policy loader the cache wraps. The real
 * loader folds read failures into the empty store and cannot be raced
 * deterministically from the outside, so the module is mocked with a
 * passthrough that can (a) rewrite the file mid-load — the proxy's load
 * racing a CLI write — and (b) resolve to the empty store the way an
 * exhausted EBUSY/EPERM read or corrupt JSON does.
 */
const accountPolicyReadFaults = vi.hoisted(() => ({
	/** Set: the next load returns the pre-write parse after replacing the file. */
	writeAfterRead: null as { path: string; contents: string } | null,
	/** Set: loads resolve to the empty store without touching the file. */
	returnEmptyStore: false,
}));

vi.mock("../lib/account-policy.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../lib/account-policy.js")>();
	const { promises: fsPromises } = await import("node:fs");
	return {
		...actual,
		loadAccountPolicyStore: async (options?: {strict?: boolean}) => {
			if (accountPolicyReadFaults.returnEmptyStore) {
				return { version: 1 as const, accounts: {} };
			}
			const value = await actual.loadAccountPolicyStore(options);
			const write = accountPolicyReadFaults.writeAfterRead;
			if (write) {
				accountPolicyReadFaults.writeAfterRead = null;
				await fsPromises.writeFile(write.path, write.contents, "utf8");
			}
			return value;
		},
	};
});

function writeAccountPolicies(
	accounts: Record<string, unknown>,
): string {
	return JSON.stringify({ version: 1, accounts }) + "\n";
}

/**
 * A linked-worktree fixture satisfying every check in
 * `resolveProjectStorageIdentityRoot`: `<repo>/.git/worktrees/<wt>/gitdir`
 * back-references `<worktree>/.git`, `commondir` resolves back to the shared
 * `<repo>/.git`, and the worktree's `.git` file points at the worktree gitdir.
 */
async function makeLinkedRepo(
	repoDir: string,
	worktreeName: string,
	worktreeDir: string,
): Promise<void> {
	const worktreeGitDir = join(repoDir, ".git", "worktrees", worktreeName);
	await fs.mkdir(worktreeGitDir, { recursive: true });
	await fs.writeFile(
		join(worktreeGitDir, "gitdir"),
		`${join(worktreeDir, ".git")}\n`,
		"utf8",
	);
	await fs.writeFile(join(worktreeGitDir, "commondir"), "../..\n", "utf8");
}

describe("runtime policy cache", () => {
	let tempDir: string;
	let multiAuthDir: string;
	let projectDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-policy-cache-"));
		multiAuthDir = join(tempDir, "multi-auth");
		projectDir = join(tempDir, "project");
		await fs.mkdir(multiAuthDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(join(projectDir, "package.json"), "{}", "utf8");
		process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
		accountPolicyReadFaults.writeAfterRead = null;
		accountPolicyReadFaults.returnEmptyStore = false;
		const { resetRuntimePolicyCacheForTests } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		resetRuntimePolicyCacheForTests();
	});

	afterEach(async () => {
		vi.useRealTimers();
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		const { resetRuntimePolicyCacheForTests } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		resetRuntimePolicyCacheForTests();
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

 it("rejects malformed emergency policy in the production cache loader",async()=>{
  const {getAccountPolicyPath}=await import('../lib/account-policy.js');
  const {loadAccountPolicyStoreCached}=await import('../lib/policy/runtime-policy-cache.js');
  await fs.writeFile(getAccountPolicyPath(),writeAccountPolicies({'sha256:a':{emergencyOnly:'true'}}));
  await expect(loadAccountPolicyStoreCached()).rejects.toThrow('Invalid account policy row');
 });
	it("serves the parsed store and re-reads it after a rewrite", async () => {
		const { loadAccountPolicyStoreCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getAccountPolicyPath } = await import("../lib/account-policy.js");

		const path = getAccountPolicyPath();
		await fs.writeFile(
			path,
			writeAccountPolicies({
				"sha256:a": {
					accountKey: "sha256:a",
					tags: ["one"],
					weight: 2,
					paused: true,
					drained: false,
					note: null,
					updatedAt: 1,
				},
			}),
		);

		const first = await loadAccountPolicyStoreCached();
		expect(first.accounts["sha256:a"]?.paused).toBe(true);
		expect(first.accounts["sha256:a"]?.weight).toBe(2);

		// Rewrite changes mtime+size; the next load must observe the new bytes
		// even though the fresh mtime sits inside the settle window.
		await fs.writeFile(
			path,
			writeAccountPolicies({
				"sha256:b": {
					accountKey: "sha256:b",
					tags: [],
					weight: 5,
					paused: false,
					drained: true,
					note: null,
					updatedAt: 2,
				},
			}),
		);
		const second = await loadAccountPolicyStoreCached();
		expect(second.accounts["sha256:a"]).toBeUndefined();
		expect(second.accounts["sha256:b"]?.drained).toBe(true);
	});

	it("re-reads a same-size rewrite that pins mtime back", async () => {
		const { loadAccountPolicyStoreCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getAccountPolicyPath } = await import("../lib/account-policy.js");

		const path = getAccountPolicyPath();
		const old = new Date(Date.now() - 60_000);
		const v1 = writeAccountPolicies({
			"sha256:a": {
				accountKey: "sha256:a",
				tags: ["alpha"],
				weight: 1,
				paused: false,
				drained: false,
				note: null,
				updatedAt: 1,
			},
		});
		await fs.writeFile(path, v1);
		// Settle the mtime so the fingerprint fast path is eligible.
		await fs.utimes(path, old, old);
		const first = await loadAccountPolicyStoreCached();
		expect(first.accounts["sha256:a"]?.tags).toEqual(["alpha"]);

		// Same mtime + same size, different content, delivered by rename — the
		// shape the store writers actually use. The mtime is pinned back to the
		// settled value, so only a ctime-aware fingerprint can catch this: on
		// POSIX every write bumps ctime, and a rename replacement gets a new
		// file creation time on Windows. The stale value must NOT be served.
		const v2 = v1.replace("alpha", "gamma");
		expect(v2.length).toBe(v1.length);
		const swapPath = join(tempDir, "account-policies.swap");
		await fs.writeFile(swapPath, v2);
		await fs.rename(swapPath, path);
		await fs.utimes(path, old, old);
		const reloaded = await loadAccountPolicyStoreCached();
		expect(reloaded.accounts["sha256:a"]?.tags).toEqual(["gamma"]);

		// A size-changing rewrite is caught immediately as before.
		const v3 = v1.replace("alpha", "gammadelta");
		await fs.writeFile(path, v3);
		const reloadedV3 = await loadAccountPolicyStoreCached();
		expect(reloadedV3.accounts["sha256:a"]?.tags).toEqual(["gammadelta"]);
	});

	it("never caches a store read raced by a concurrent rewrite", async () => {
		vi.useFakeTimers();
		try {
			const { loadAccountPolicyStoreCached } = await import(
				"../lib/policy/runtime-policy-cache.js"
			);
			const { getAccountPolicyPath } = await import("../lib/account-policy.js");

			const path = getAccountPolicyPath();
			const policy = (weight: number) =>
				writeAccountPolicies({
					"sha256:a": {
						accountKey: "sha256:a",
						tags: [],
						weight,
						paused: false,
						drained: false,
						note: null,
						updatedAt: 1,
					},
				});
			await fs.writeFile(path, policy(1));

			// The racing CLI write lands while the read is in flight: the loader
			// returns the OLD parse but the post-load stat sees the NEW file.
			accountPolicyReadFaults.writeAfterRead = {
				path,
				contents: policy(9),
			};
			const first = await loadAccountPolicyStoreCached();
			// The pre/post-load fingerprint mismatch forces a re-read, so the
			// caller already sees the new value.
			expect(first.accounts["sha256:a"]?.weight).toBe(9);

			// Once the new mtime settles, a poisoned "old value under new
			// fingerprint" entry would keep serving the stale parse. Advance the
			// clock past the settle window and confirm the cache serves v2.
			vi.setSystemTime(Date.now() + 10_000);
			const second = await loadAccountPolicyStoreCached();
			expect(second.accounts["sha256:a"]?.weight).toBe(9);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not cache the empty store produced by a failed read", async () => {
		const { loadAccountPolicyStoreCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getAccountPolicyPath } = await import("../lib/account-policy.js");

		const path = getAccountPolicyPath();
		await fs.writeFile(
			path,
			writeAccountPolicies({
				"sha256:a": {
					accountKey: "sha256:a",
					tags: [],
					weight: 2,
					paused: true,
					drained: false,
					note: null,
					updatedAt: 1,
				},
			}),
		);
		// Settle the file so a cached entry would be eligible for the fast path.
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(path, old, old);

		// An exhausted EBUSY/EPERM read resolves to the empty store while real
		// bytes still exist on disk.
		accountPolicyReadFaults.returnEmptyStore = true;
		const failed = await loadAccountPolicyStoreCached();
		expect(Object.keys(failed.accounts)).toHaveLength(0);
		accountPolicyReadFaults.returnEmptyStore = false;

		// The failed result must not be cached: the very next call observes the
		// real policy even though the fingerprint never changed.
		const recovered = await loadAccountPolicyStoreCached();
		expect(recovered.accounts["sha256:a"]?.weight).toBe(2);
		expect(recovered.accounts["sha256:a"]?.paused).toBe(true);
	});

	it("returns consistent stores across concurrent loads during a rewrite", async () => {
		const { loadAccountPolicyStoreCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getAccountPolicyPath } = await import("../lib/account-policy.js");

		const path = getAccountPolicyPath();
		const policy = (weight: number) =>
			writeAccountPolicies({
				"sha256:a": {
					accountKey: "sha256:a",
					tags: [],
					weight,
					paused: false,
					drained: false,
					note: null,
					updatedAt: 1,
				},
			});
		await fs.writeFile(path, policy(1));

		// The store writers all swap files in via temp+rename, so a concurrent
		// reader always sees one complete version — never a torn parse.
		const swapPath = join(tempDir, "account-policies.swap");
		const results = await Promise.all([
			loadAccountPolicyStoreCached(),
			loadAccountPolicyStoreCached(),
			fs.writeFile(swapPath, policy(9)).then(() => fs.rename(swapPath, path)),
			loadAccountPolicyStoreCached(),
			loadAccountPolicyStoreCached(),
		]);
		// Every call must return one complete real parse — never torn, never
		// poisoned for later calls.
		const stores = [results[0], results[1], results[3], results[4]];
		for (const store of stores) {
			expect([1, 9]).toContain(store.accounts["sha256:a"]?.weight);
		}
		expect(
			(await loadAccountPolicyStoreCached()).accounts["sha256:a"]?.weight,
		).toBe(9);
	});

	it("returns the empty store once the file disappears", async () => {
		const { loadBudgetGuardStoreCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getBudgetGuardPath } = await import("../lib/budget-guard.js");

		const path = getBudgetGuardPath();
		await fs.writeFile(
			path,
			JSON.stringify({
				version: 1,
				limits: {
					global: { key: "global", window: "day", maxRequests: 3, updatedAt: 1 },
				},
			}),
		);
		expect((await loadBudgetGuardStoreCached()).limits.global?.maxRequests).toBe(3);

		await fs.unlink(path);
		expect((await loadBudgetGuardStoreCached()).limits).toEqual({});
	});

	it("picks up a store file created after a cached absent read", async () => {
		const { loadBudgetGuardStoreCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getBudgetGuardPath } = await import("../lib/budget-guard.js");

		const path = getBudgetGuardPath();
		expect((await loadBudgetGuardStoreCached()).limits).toEqual({});

		await fs.writeFile(
			path,
			JSON.stringify({
				version: 1,
				limits: {
					global: { key: "global", window: "day", maxRequests: 7, updatedAt: 2 },
				},
			}),
		);
		expect((await loadBudgetGuardStoreCached()).limits.global?.maxRequests).toBe(7);
	});

	it("re-resolves when a project marker appears in a previously rootless dir", async () => {
		const { resolveProjectRoutingProfileCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);

		const plainDir = join(tempDir, "plain");
		await fs.mkdir(plainDir, { recursive: true });
		const rootless = await resolveProjectRoutingProfileCached(plainDir);
		expect(rootless.projectRoot).toBeNull();
		expect(rootless.projectKey).toBeNull();

		// A marker created in the startDir bumps that directory's mtime, which
		// invalidates the cached rootless answer before the TTL elapses.
		await fs.writeFile(join(plainDir, "package.json"), "{}", "utf8");
		const resolved = await resolveProjectRoutingProfileCached(plainDir);
		expect(resolved.projectRoot).toBe(plainDir);
		expect(resolved.projectKey).toMatch(/^plain-/);

		// Removing the marker bumps the directory mtime again and returns the
		// resolution to rootless.
		await fs.unlink(join(plainDir, "package.json"));
		const removed = await resolveProjectRoutingProfileCached(plainDir);
		expect(removed.projectRoot).toBeNull();
		expect(removed.projectKey).toBeNull();
	});

	it("re-resolves the project key when a worktree .git pointer is retargeted", async () => {
		const { resolveProjectRoutingProfileCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const { getProjectStorageKey } = await import("../lib/storage/paths.js");

		const repoA = join(tempDir, "repo-a");
		const repoB = join(tempDir, "repo-b");
		const worktreeDir = join(tempDir, "worktree-a");
		await fs.mkdir(worktreeDir, { recursive: true });
		await makeLinkedRepo(repoA, "wt-a", worktreeDir);
		await makeLinkedRepo(repoB, "wt-b", worktreeDir);
		const gitPointer = join(worktreeDir, ".git");
		const old = new Date(Date.now() - 60_000);
		// The two pointer contents are deliberately the same size and the same
		// pinned mtime — only the ctime component of the fingerprint (a new
		// inode on POSIX, a new creation time on Windows rename) can tell the
		// retarget apart from the original.
		const pointerA = `gitdir: ${join(repoA, ".git", "worktrees", "wt-a")}\n`;
		const pointerB = `gitdir: ${join(repoB, ".git", "worktrees", "wt-b")}\n`;
		expect(pointerA.length).toBe(pointerB.length);
		await fs.writeFile(gitPointer, pointerA, "utf8");
		await fs.utimes(gitPointer, old, old);

		const first = await resolveProjectRoutingProfileCached(worktreeDir);
		expect(first.projectRoot).toBe(worktreeDir);
		expect(first.projectKey).toBe(getProjectStorageKey(repoA));

		// Retarget the same .git file at a different shared repository. The
		// cache keys on the .git entry fingerprint — no ancestor directory
		// gained or lost a marker — so this must not wait out the TTL.
		const swapPath = join(tempDir, "git-pointer.swap");
		await fs.writeFile(swapPath, pointerB, "utf8");
		await fs.rename(swapPath, gitPointer);
		await fs.utimes(gitPointer, old, old);
		const second = await resolveProjectRoutingProfileCached(worktreeDir);
		expect(second.projectRoot).toBe(worktreeDir);
		expect(second.projectKey).toBe(getProjectStorageKey(repoB));
		expect(second.projectKey).not.toBe(first.projectKey);
	});

	it("resolves the project routing context through the cached loaders", async () => {
		const { resolveProjectRoutingProfileCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const {
			createDefaultRoutingProfile,
			loadRoutingProfileStore,
			resolveProjectRoutingProfile,
			saveRoutingProfileStore,
			upsertRoutingProfile,
		} = await import("../lib/routing-profiles.js");

		const direct = await resolveProjectRoutingProfile(projectDir);
		const cached = await resolveProjectRoutingProfileCached(projectDir);
		expect(cached.projectRoot).toBe(direct.projectRoot);
		expect(cached.identityRoot).toBe(direct.identityRoot);
		expect(cached.projectKey).toBe(direct.projectKey);
		expect(cached.profile).toBeNull();

		const store = await loadRoutingProfileStore();
		upsertRoutingProfile(
			store,
			createDefaultRoutingProfile({
				projectKey: direct.projectKey!,
				projectName: "project",
				identityRoot: direct.identityRoot!,
				now: 100,
			}),
			(next) => {
				next.preferredTags.push("fast");
			},
			200,
		);
		await saveRoutingProfileStore(store);

		const resolved = await resolveProjectRoutingProfileCached(projectDir);
		expect(resolved.profile?.preferredTags).toEqual(["fast"]);
		expect(resolved.profile?.updatedAt).toBe(200);
	});

	it("does not leak one startDir's project context into another", async () => {
		const { resolveProjectRoutingProfileCached } = await import(
			"../lib/policy/runtime-policy-cache.js"
		);
		const plainDir = join(tempDir, "plain");
		await fs.mkdir(plainDir, { recursive: true });

		const projectContext = await resolveProjectRoutingProfileCached(projectDir);
		const plainContext = await resolveProjectRoutingProfileCached(plainDir);
		expect(projectContext.projectKey).toMatch(/^project-/);
		expect(plainContext.projectRoot).toBeNull();
		expect(plainContext.projectKey).toBeNull();
	});
});
