import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("local client tokens", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-local-client-token-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("stores hashes and verifies bearer tokens without persisting plaintext", async () => {
		const {
			addLocalClientToken,
			getLocalClientTokenPath,
			loadLocalClientTokenStore,
			verifyLocalClientBearerToken,
		} = await import("../lib/local-client-tokens.js");

		const created = await addLocalClientToken({ label: "OpenCode", now: 100 });
		expect(created.plainToken).toMatch(/^cma_local_/);
		expect(created.record.tokenHash).toMatch(/^sha256:/);
		expect(created.record.prefix).toBe(created.plainToken.slice(0, 18));

		const raw = await fs.readFile(getLocalClientTokenPath(), "utf8");
		expect(raw).not.toContain(created.plainToken);
		expect(raw).toContain(created.record.prefix);

		const verified = await verifyLocalClientBearerToken(
			`Bearer ${created.plainToken}`,
			200,
		);
		expect(verified?.id).toBe(created.record.id);
		const loaded = await loadLocalClientTokenStore();
		expect(loaded.tokens[0]?.lastUsedAt).toBe(200);
	});

	it("rotates and revokes tokens", async () => {
		const {
			addLocalClientToken,
			loadLocalClientTokenStore,
			revokeLocalClientToken,
			rotateLocalClientToken,
			verifyLocalClientBearerToken,
		} = await import("../lib/local-client-tokens.js");

		const created = await addLocalClientToken({ label: "client", now: 100 });
		const rotated = await rotateLocalClientToken({
			id: created.record.id,
			now: 200,
		});
		expect(rotated?.plainToken).toMatch(/^cma_local_/);
		expect(
			await verifyLocalClientBearerToken(`Bearer ${created.plainToken}`, 300),
		).toBeNull();
		const verifiedRotated = await verifyLocalClientBearerToken(
			`Bearer ${rotated?.plainToken}`,
			300,
		);
		expect(verifiedRotated?.id).toBe(rotated?.record.id);

		expect(await revokeLocalClientToken(rotated?.record.id ?? "", 400)).toBe(true);
		expect(
			await verifyLocalClientBearerToken(`Bearer ${rotated?.plainToken}`, 500),
		).toBeNull();
		const store = await loadLocalClientTokenStore();
		expect(store.tokens.filter((token) => token.revokedAt !== null)).toHaveLength(2);
	});

	it("does not lose mutations when revoke and add run concurrently", async () => {
		const {
			addLocalClientToken,
			loadLocalClientTokenStore,
			revokeLocalClientToken,
		} = await import("../lib/local-client-tokens.js");

		// Seed a token whose revoke will race against a brand-new add. Before the
		// read-modify-write was serialized through the write queue, the add and
		// the revoke each loaded the same base store, mutated their own copy, and
		// the later write clobbered the earlier one (lost update). Routing the
		// full load->mutate->persist through the queue means each op observes the
		// other's committed state, so both survive.
		const seeded = await addLocalClientToken({ label: "seed", now: 100 });

		const [, revoked] = await Promise.all([
			addLocalClientToken({ label: "added-concurrently", now: 200 }),
			revokeLocalClientToken(seeded.record.id, 300),
		]);

		expect(revoked).toBe(true);

		const store = await loadLocalClientTokenStore();
		// Neither mutation was lost: the seed token is present and revoked, and
		// the concurrently-added token is present and active.
		expect(store.tokens).toHaveLength(2);
		const seedRecord = store.tokens.find((t) => t.id === seeded.record.id);
		expect(seedRecord?.revokedAt).toBe(300);
		const addedRecord = store.tokens.find(
			(t) => t.label === "added-concurrently",
		);
		expect(addedRecord).toBeDefined();
		expect(addedRecord?.revokedAt).toBeNull();
	});

	it("retries atomic rename on transient ENOTEMPTY errors", async () => {
		const { addLocalClientToken, loadLocalClientTokenStore } = await import(
			"../lib/local-client-tokens.js"
		);
		const realRename = fs.rename.bind(fs);
		let attempts = 0;
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementation(async (...args) => {
			attempts += 1;
			if (attempts === 1) {
				const error = new Error("dir not empty") as NodeJS.ErrnoException;
				error.code = "ENOTEMPTY";
				throw error;
			}
			return realRename(...args);
		});

		try {
			const created = await addLocalClientToken({ label: "retry", now: 100 });
			expect(attempts).toBeGreaterThan(1);
			const store = await loadLocalClientTokenStore();
			expect(store.tokens.find((t) => t.id === created.record.id)).toBeDefined();
		} finally {
			renameSpy.mockRestore();
		}
	});
});
