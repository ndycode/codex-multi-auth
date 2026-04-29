import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
		await fs.rm(tempDir, { recursive: true, force: true });
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
});
