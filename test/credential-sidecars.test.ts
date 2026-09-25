import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCredentialSidecars } from "../lib/storage/credential-sidecars.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "sidecars-"));
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(dir, { recursive: true, force: true });
});

it.each(["reset-credits.json", "api-capability-probes.json", "api-routes.json"])(
	"waits for an in-flight %s writer so its old state cannot reappear after the reset",
	async (name) => {
		const path = join(dir, name);
		await fs.writeFile(path, '{"policy":"last-resort"}');
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const inside = new Promise<void>((resolve) => { entered = resolve; });
		// A writer that read the old state under the lock and renames it back later.
		const writer = withFileTransactionLock(path, async () => {
			entered();
			await gate;
			await fs.writeFile(path, '{"policy":"last-resort"}');
		});
		await inside;
		// Fresh spies for this case only, created after the writer owns the lock.
		const rm = vi.spyOn(fs, "rm");
		const rename = vi.spyOn(fs, "rename");
		try {
			const removedThisPath = () => rm.mock.calls.some(([target]) => String(target) === path);
			const cleared = clearCredentialSidecars();
			// A waiter repeatedly tries to publish its candidate as this path's
			// lock directory: proof the clear is blocked on the held lock itself.
			await vi.waitFor(() => expect(rename.mock.calls.some(([, to]) => String(to).endsWith(`${name}.write-lock`))).toBe(true), { timeout: 5000 });
			expect(removedThisPath()).toBe(false);
			release();
			await writer;
			await cleared;
			expect(removedThisPath()).toBe(true);
			await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			release();
			rm.mockRestore();
			rename.mockRestore();
		}
	},
);

it("removes the credential sidecars even when the pool clear fails, then rethrows", async () => {
	const { clearAccountsAndCredentialSidecars } = await import("../lib/storage/credential-sidecars.js");
	await fs.writeFile(join(dir, "api-routes.json"), '{"apiKey":"sk-fixture"}');
	const failure = Object.assign(new Error("locked"), { code: "EBUSY" });
	await expect(clearAccountsAndCredentialSidecars(async () => { throw failure; })).rejects.toBe(failure);
	await expect(fs.stat(join(dir, "api-routes.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
