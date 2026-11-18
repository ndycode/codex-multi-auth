import { promises as fs } from "node:fs";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await removeWithRetry(dir, { recursive: true, force: true });
});

it.each(["reset-credits.json", "api-capability-probes.json", "automatic-api-checks.json", "api-routes.json"])(
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
		let cleared: Promise<void> | undefined;
		vi.useFakeTimers();
		try {
			const removedThisPath = () => rm.mock.calls.some(([target]) => String(target) === path);
			cleared = clearCredentialSidecars();
			// A waiter repeatedly tries to publish its candidate as this path's
			// lock directory: proof the clear is blocked on the held lock itself.
			await vi.waitFor(() => expect(rename.mock.calls.some(([, to]) => String(to).endsWith(`${name}.write-lock`))).toBe(true), { timeout: 1000, interval: 50 });
			expect(removedThisPath()).toBe(false);
			release();
			let drained = false;
			const done = Promise.all([writer, cleared]).finally(() => { drained = true; });
			await vi.waitFor(() => expect(drained).toBe(true));
			await done;
			expect(removedThisPath()).toBe(true);
			await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			release();
			let drained = false;
			const done = Promise.allSettled([writer, cleared]).finally(() => { drained = true; });
			try {
				await vi.waitFor(() => expect(drained).toBe(true));
				await done;
			} finally {
				vi.useRealTimers();
				rm.mockRestore();
				rename.mockRestore();
			}
		}
	},
);

it("treats a missing multi-auth dir as already clean during the wiped-lease sweep", async () => {
	const realReaddir = fs.readdir.bind(fs);
	// Only the sweep reads `dir` with no options; lock internals pass
	// withFileTypes or read lock/candidate paths, so they keep the real fs.
	vi.spyOn(fs, "readdir").mockImplementation(((path: unknown, options?: unknown) =>
		String(path) === dir && options === undefined
			? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
			: (realReaddir as (...args: never[]) => unknown)(path as never, options as never)) as never);
	await expect(clearCredentialSidecars()).resolves.toBeUndefined();
});

it("removes the credential sidecars even when the pool clear fails, then rethrows", async () => {
	const { clearAccountsAndCredentialSidecars } = await import("../lib/storage/credential-sidecars.js");
	await fs.writeFile(join(dir, "api-routes.json"), '{"apiKey":"sk-fixture"}');
	const failure = Object.assign(new Error("locked"), { code: "EBUSY" });
	await expect(clearAccountsAndCredentialSidecars(async () => { throw failure; })).rejects.toBe(failure);
	await expect(fs.stat(join(dir, "api-routes.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
