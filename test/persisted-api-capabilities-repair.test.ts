import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveApiRoutes } from "../lib/api-route-store.js";
import * as locks from "../lib/storage/file-lock.js";
import { enrichPersistedApiCapabilities, resetPersistedApiCapabilitiesForTests } from "../lib/runtime/persisted-api-capabilities.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let root: string, path: string, previous: string | undefined, posts: number;
const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
const fetcher: typeof fetch = async (_url, init) => {
	if (init?.method !== "POST") return new Response("missing", { status: 404 });
	posts++;
	const body = JSON.parse(String(init.body));
	return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
};
const check = (force = true) => enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, force, { fetchImpl: fetcher, requireStoredRoute: true });
beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "probe-cache-repair-"));
	previous = process.env.CODEX_MULTI_AUTH_DIR;
	process.env.CODEX_MULTI_AUTH_DIR = root;
	path = join(root, "api-capability-probes.json");
	posts = 0;
	await saveApiRoutes([route]);
});
afterEach(async () => {
	vi.restoreAllMocks();
	resetPersistedApiCapabilitiesForTests();
	if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
	else process.env.CODEX_MULTI_AUTH_DIR = previous;
	await removeWithRetry(root, { recursive: true, force: true });
});
it.each(["{truncated", JSON.stringify({ version: 1, entries: "invalid" })])("repairs malformed cache only for an explicit forced check: %s", async (original) => {
	await fs.writeFile(path, original);
	await check(false);
	expect(posts).toBe(0);
	expect(await fs.readFile(path, "utf8")).toBe(original);
	const [result] = await check();
	expect(posts).toBeGreaterThan(0);
	expect(result.capability_probe_status).toMatchObject({ responses: "verified" });
	const cache = JSON.parse(await fs.readFile(path, "utf8"));
	expect(cache.version).toBe(1);
	expect(cache.entries).toHaveLength(1);
	expect(cache.entries[0][1].status.responses).toBe("verified");
});
it.each(["EACCES", "EIO"])("does not force past a cache %s read failure", async (code) => {
	await fs.writeFile(path, "{truncated");
	const read = fs.readFile.bind(fs);
	vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
		if (String(args[0]) === path) throw Object.assign(Error("unavailable"), { code });
		return read(...args);
	});
	await check();
	expect(posts).toBe(0);
	expect(await read(path, "utf8")).toBe("{truncated");
});
it("does not launch paid requests when the forced repair cannot be committed", async () => {
	await fs.writeFile(path, "{truncated");
	const rename = fs.rename.bind(fs);
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === path) throw Object.assign(Error("full"), { code: "ENOSPC" });
		return rename(from, to);
	});
	await check();
	expect(posts).toBe(0);
	expect(await fs.readFile(path, "utf8")).toBe("{truncated");
	expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
it("rechecks corruption under the writer lock and preserves another writer's valid entries", async () => {
	await fs.writeFile(path, "{truncated");
	const foreignKey = "a".repeat(64);
	const foreign = { at: Date.now(), levels: ["low"], tiers: [], status: { responses: "verified" } };
	const original = locks.withFileTransactionLock;
	let replaced = false;
	vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => {
		if (String(args[0]) === path && !replaced) {
			replaced = true;
			await fs.writeFile(path, JSON.stringify({ version: 1, entries: [[foreignKey, foreign]] }));
		}
		return original(...args);
	});
	await check();
	expect(posts).toBeGreaterThan(0);
	expect(JSON.parse(await fs.readFile(path, "utf8")).entries).toContainEqual([foreignKey, foreign]);
});
it("does not recreate a wiped cache when a forced repair is waiting for its writer lock", async () => {
	const { clearCredentialSidecars } = await import("../lib/storage/credential-sidecars.js");
	await fs.writeFile(path, "{truncated");
	const original = locks.withFileTransactionLock;
	let release!: () => void, entered!: () => void, held = false;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => {
		if (String(args[0]) === path && !held) { held = true; entered(); await gate; }
		return original(...args);
	});
	const pending = check();
	try {
		await started;
		await clearCredentialSidecars();
		await saveApiRoutes([route]);
		release();
		await pending;
		expect(posts).toBe(0);
		await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	} finally { release(); await pending; }
});
it("aborts a forced repair before committing its temporary file", async () => {
	await fs.writeFile(path, "{truncated");
	const controller = new AbortController();
	const write = fs.writeFile.bind(fs);
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		const result = await write(...args);
		if (String(args[0]).startsWith(path + ".") && String(args[0]).endsWith(".tmp")) controller.abort();
		return result;
	});
	await expect(enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, true, { fetchImpl: fetcher, requireStoredRoute: true, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	expect(posts).toBe(0);
	expect(await fs.readFile(path, "utf8")).toBe("{truncated");
	expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
