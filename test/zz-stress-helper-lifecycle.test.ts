import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveAppBindPaths,
	UNBIND_HELPER_CONCURRENCY,
	unbindCodexAppRuntimeRotation,
} from "../lib/runtime/app-bind.js";
import {
	APP_RUNTIME_HELPER_OWNER_FILE,
	APP_RUNTIME_HELPER_STATUS_FILE,
	listRuntimeHelperOwnerPaths,
	listRuntimeHelperStatusPaths,
} from "../lib/runtime-constants.js";
import {
	isLiveRuntimeHelper,
	liveRuntimeHelpers,
	RUNTIME_HELPER_STATUS_STALE_MS,
	selectRuntimeHelperStatus,
	type RuntimeHelperSelectable,
} from "../lib/runtime/app-helper-selection.js";
import {
	appRuntimeHelperStatusToSignal,
	readAppRuntimeHelperStatus,
} from "../lib/runtime/runtime-current-account.js";
import { withDeadPids, withLivePids } from "./helpers/owned-pids.js";

// Stress coverage for the helper-lifecycle work: the unit tests pin individual
// predicates with two or three records, which is not the shape the #663 machine
// was in. These drive the same code at the scale and with the hostile inputs
// that report described — hundreds of files, mixed liveness, corrupt payloads,
// concurrent readers — and assert the properties that must hold regardless of
// how many records exist.

const createdDirs: string[] = [];

afterEach(async () => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function createRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	createdDirs.push(root);
	return root;
}

function multiAuthDirFor(root: string): string {
	const env = {
		CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
		CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
	};
	const paths = resolveAppBindPaths({
		platform: process.platform,
		home: root,
		env,
	});
	return dirname(paths.bindDir);
}

function envFor(root: string): NodeJS.ProcessEnv {
	return {
		CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
		CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
	};
}

function statusPathFor(baseDir: string, pid: number): string {
	return join(
		baseDir,
		APP_RUNTIME_HELPER_STATUS_FILE.replace(/\.json$/i, `.${pid}.json`),
	);
}

function ownerPathFor(baseDir: string, pid: number): string {
	return join(
		baseDir,
		APP_RUNTIME_HELPER_OWNER_FILE.replace(/\.json$/i, `.${pid}.json`),
	);
}

function statusRecord(pid: number, overrides: Record<string, unknown> = {}) {
	return `${JSON.stringify({
		version: 1,
		kind: "codex-app-runtime-rotation-helper",
		state: "running",
		pid,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		scriptPath: "/nonexistent/runtime-helper.mjs",
		...overrides,
	})}\n`;
}

function ownerRecord(pid: number, token = `token-${pid}`) {
	return `${JSON.stringify({
		version: 1,
		kind: "codex-app-runtime-rotation-helper-owner",
		identityToken: token,
		launcherPid: 1,
		createdAt: Date.now(),
	})}\n`;
}

// Windows draws PIDs from a shared pool and hands a just-reaped one straight
// back out, so any other process on the machine can take a "dead" fixture PID
// while a test runs. unbind then finds that PID live, keeps its files, and
// logs that it did. A kept file is excused only by that log line naming the
// PID; every PID that stayed dead must still be cleaned up.
function preservedAsLive(warnings: readonly string[], pid: number): boolean {
	return warnings.some(
		(w) =>
			w.includes(`(pid ${pid}) did not stop`) ||
			w.includes(`(pid ${pid}) has no status record but its PID is live`),
	);
}

function remainingHelperFiles(baseDir: string, warnings: readonly string[]): string[] {
	return readdirSync(baseDir).filter((name) => {
		if (!name.startsWith("runtime-rotation-app-helper")) return false;
		const pid = Number(/\.(\d+)\.json$/i.exec(name)?.[1]);
		return !(Number.isInteger(pid) && preservedAsLive(warnings, pid));
	});
}

function isPidAliveNow(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

describe("stress: unbind at the scale the leak report described", () => {
	it("reclaims hundreds of dead records and orphaned owner files in one pass", async () => {
		// The reported machine had 183 live helpers and 701 owner files. The
		// per-file logic is covered elsewhere; what is not is whether the whole
		// pass still terminates, still reclaims everything, and still leaves live
		// records alone once the directory is this size.
		const root = await createRoot("cma-stress-unbind-scale-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });

		// Every PID here is a process this test started and reaped — no sentinel
		// integers standing in for "dead", which is the trap #668 was about.
		const pairedCount = 150;
		const orphanOwnerCount = 100;
		// The live PIDs are taken first and held for the whole test. Windows hands
		// a just-reaped PID straight back out, so spawning them after the dead
		// batch regularly gave a live helper one of the "dead" PIDs: its record
		// then overwrote the dead one, and unbind correctly kept it.
		await withLivePids(6, async (livePids) => {
			await withDeadPids(pairedCount + orphanOwnerCount, async (allDeadPids) => {
				const deadPids = allDeadPids.slice(0, pairedCount);
				const orphanPids = allDeadPids.slice(pairedCount);
				// Dead status records, each with a matching owner file.
				for (const pid of deadPids) {
					await writeFile(statusPathFor(baseDir, pid), statusRecord(pid), "utf8");
					await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
				}
				// Owner files with no status record at all — the #666 orphans, which
				// no pass before this one could rediscover.
				for (const pid of orphanPids) {
					await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
				}
				// Live helpers whose ownership cannot be verified: these must survive.
				for (const pid of livePids) {
					await writeFile(
						statusPathFor(baseDir, pid),
						statusRecord(pid, { identityToken: `live-${pid}` }),
						"utf8",
					);
				}

				const warnings: string[] = [];
				const startedAt = Date.now();
				await unbindCodexAppRuntimeRotation({
					platform: process.platform,
					home: root,
					env: envFor(root),
					log: (message) => warnings.push(message),
				});
				const elapsedMs = Date.now() - startedAt;

				// Everything provably dead is gone (see preservedAsLive)...
				for (const pid of deadPids) {
					if (preservedAsLive(warnings, pid)) continue;
					expect(existsSync(statusPathFor(baseDir, pid))).toBe(false);
					expect(existsSync(ownerPathFor(baseDir, pid))).toBe(false);
				}
				for (const pid of orphanPids) {
					if (preservedAsLive(warnings, pid)) continue;
					expect(existsSync(ownerPathFor(baseDir, pid))).toBe(false);
				}
				// ...and every live helper's record survived, because unbind could
				// not verify ownership and must not signal a foreign PID.
				for (const pid of livePids) {
					expect(existsSync(statusPathFor(baseDir, pid))).toBe(true);
				}
				expect(
					warnings.filter((w) => w.includes("ownership metadata does not match"))
						.length,
				).toBe(livePids.length);

				// A serial implementation paying a stop window per record is what the
				// pool replaced. This is a generous ceiling — the point is that it
				// does not scale with the record count.
				expect(elapsedMs).toBeLessThan(60_000);
			});
		});
	}, 180_000);

	it("survives a directory full of hostile and malformed metadata", async () => {
		// Every one of these has been seen in the wild or is one truncated write
		// away: a helper killed mid-publish, a hand-edited file, a file from a
		// future version. None may throw out of unbind, which runs during
		// `uninstall`.
		const root = await createRoot("cma-stress-unbind-hostile-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });

		const hostile: Array<[string, string]> = [
			["truncated JSON", '{"kind":"codex-app-runtime-rotation-helper","pid":'],
			["empty file", ""],
			["whitespace only", "   \n\t\n"],
			["a JSON array", "[]"],
			["a JSON string", '"running"'],
			["JSON null", "null"],
			["a number", "42"],
			["negative pid", statusRecord(-1234)],
			["fractional pid", statusRecord(4242.5)],
			["zero pid", statusRecord(0)],
			["pid as string", statusRecord(0, { pid: "4242" })],
			["pid beyond safe integer", statusRecord(0, { pid: 2 ** 63 })],
			["NaN-ish startedAt", statusRecord(999_999_991, { startedAt: "soon" })],
			["missing kind", '{"state":"running","pid":999999992}'],
			["foreign kind", statusRecord(999_999_993, { kind: "something-else" })],
			["null state", statusRecord(999_999_994, { state: null })],
			["deeply nested payload", JSON.stringify({ a: { b: { c: { d: {} } } } })],
			["unicode payload", statusRecord(999_999_995, { note: "日本語 🎉  " })],
		];
		for (const [index, [, contents]] of hostile.entries()) {
			await writeFile(
				statusPathFor(baseDir, 900_000_000 + index),
				contents,
				"utf8",
			);
		}
		// A 2 MB record, past the readers' sanity cap.
		await writeFile(
			statusPathFor(baseDir, 910_000_000),
			JSON.stringify({
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: 910_000_000,
				padding: "x".repeat(2 * 1024 * 1024),
			}),
			"utf8",
		);
		// Owner files that are themselves garbage.
		await writeFile(ownerPathFor(baseDir, 920_000_000), "{not json", "utf8");
		await writeFile(ownerPathFor(baseDir, 920_000_001), "", "utf8");

		await expect(
			unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env: envFor(root),
			}),
		).resolves.toBeDefined();

		// And the readers must survive the same directory.
		const previousDir = process.env.CODEX_MULTI_AUTH_DIR;
		process.env.CODEX_MULTI_AUTH_DIR = baseDir;
		try {
			expect(() => readAppRuntimeHelperStatus()).not.toThrow();
			expect(() =>
				appRuntimeHelperStatusToSignal(readAppRuntimeHelperStatus()),
			).not.toThrow();
		} finally {
			if (previousDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
			else process.env.CODEX_MULTI_AUTH_DIR = previousDir;
		}
	}, 120_000);

	it("keeps the concurrency bound under repeated back-to-back unbinds", async () => {
		// One measurement can miss a pool that leaks a slot per invocation. Run it
		// repeatedly against the same shape and assert the ceiling every time.
		const root = await createRoot("cma-stress-unbind-repeat-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });
		const recordCount = UNBIND_HELPER_CONCURRENCY * 3;

		await withLivePids(recordCount, async (livePids) => {
			for (const pid of livePids) {
				await writeFile(
					statusPathFor(baseDir, pid),
					statusRecord(pid, { identityToken: `token-${pid}` }),
					"utf8",
				);
				await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
			}

			for (let round = 0; round < 5; round += 1) {
				let inFlight = 0;
				let peak = 0;
				let seen = 0;
				await unbindCodexAppRuntimeRotation({
					platform: process.platform,
					home: root,
					env: envFor(root),
					verifyProcessIdentity: async () => {
						inFlight += 1;
						seen += 1;
						peak = Math.max(peak, inFlight);
						await new Promise((resolve) => setTimeout(resolve, 2));
						inFlight -= 1;
						return false;
					},
				});
				expect(seen).toBe(recordCount);
				expect(peak).toBeGreaterThan(1);
				expect(peak).toBeLessThanOrEqual(UNBIND_HELPER_CONCURRENCY);
				expect(inFlight).toBe(0);
			}
		});
	}, 180_000);
});

describe("stress: the selector against a directory of many helpers", () => {
	it("picks the newest live helper out of hundreds of records", async () => {
		const root = await createRoot("cma-stress-select-scale-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });
		const now = Date.now();

		// Live PIDs are taken first and held, so none of them can be a reused
		// dead PID (see the reclaim test above).
		await withLivePids(8, async (livePids) => {
			await withDeadPids(200, async (deadPids) => {
				// Dead records with the freshest timestamps of all, so recency alone
				// would pick one of them.
				for (const [index, pid] of deadPids.entries()) {
					await writeFile(
						statusPathFor(baseDir, pid),
						statusRecord(pid, { updatedAt: now + 10_000 + index }),
						"utf8",
					);
				}
				// Live but stale — passes kill(pid, 0), must not count as live.
				await writeFile(
					statusPathFor(baseDir, livePids[0] ?? 0),
					statusRecord(livePids[0] ?? 0, {
						updatedAt: now - RUNTIME_HELPER_STATUS_STALE_MS - 60_000,
						lastAccountId: "acc_stale",
					}),
					"utf8",
				);
				// Live and fresh; the last one written is the newest.
				const freshPids = livePids.slice(1);
				for (const [index, pid] of freshPids.entries()) {
					await writeFile(
						statusPathFor(baseDir, pid),
						statusRecord(pid, {
							updatedAt: now - 10_000 + index * 100,
							lastAccountId: `acc_live_${index}`,
						}),
						"utf8",
					);
				}
				const expectedPid = freshPids[freshPids.length - 1];

				const previousDir = process.env.CODEX_MULTI_AUTH_DIR;
				process.env.CODEX_MULTI_AUTH_DIR = baseDir;
				try {
					let selected = readAppRuntimeHelperStatus(now);
					// A dead PID that another process has since taken is live, and its
					// record is the freshest, so the selector rightly prefers it. That
					// record no longer describes a dead helper: drop it and select
					// again. The PID must be alive right now, so a selector that picked
					// a genuinely dead record still fails below.
					const deadPidSet = new Set(deadPids);
					for (
						let attempt = 0;
						attempt < 20 &&
						selected !== null &&
						selected.pid !== null &&
						deadPidSet.has(selected.pid) &&
						isPidAliveNow(selected.pid);
						attempt += 1
					) {
						await rm(statusPathFor(baseDir, selected.pid), { force: true });
						selected = readAppRuntimeHelperStatus(now);
					}
					expect(selected?.pid).toBe(expectedPid);
					expect(selected?.lastAccountId).toBe(
						`acc_live_${freshPids.length - 1}`,
					);
					// And the signal agrees, rather than being derived separately.
					const signal = appRuntimeHelperStatusToSignal(selected, now);
					expect(signal?.lastAccountId).toBe(
						`acc_live_${freshPids.length - 1}`,
					);
				} finally {
					if (previousDir === undefined) {
						delete process.env.CODEX_MULTI_AUTH_DIR;
					} else {
						process.env.CODEX_MULTI_AUTH_DIR = previousDir;
					}
				}
			});
		});
	}, 180_000);

	it("is deterministic and order-independent across shuffles", async () => {
		// Selection must be a function of the records, not of readdir order — which
		// differs by filesystem. Shuffle the same set repeatedly and assert one
		// answer.
		const now = Date.now();
		const build = (pid: number, updatedAt: number): RuntimeHelperSelectable => ({
			state: "running",
			pid,
			startedAt: now - 60_000,
			updatedAt,
		});
		await withLivePids(5, async (livePids) => {
			const records = livePids.map((pid, index) =>
				build(pid, now - 50_000 + index * 1_000),
			);
			const expected = records[records.length - 1];
			for (let round = 0; round < 50; round += 1) {
				const shuffled = [...records];
				for (let i = shuffled.length - 1; i > 0; i -= 1) {
					// Deterministic shuffle: no Math.random, so a failure reproduces.
					const j = (i * 7 + round * 13) % (i + 1);
					const a = shuffled[i];
					const b = shuffled[j];
					if (a && b) {
						shuffled[i] = b;
						shuffled[j] = a;
					}
				}
				expect(selectRuntimeHelperStatus(shuffled, now)).toBe(expected);
				expect(liveRuntimeHelpers(shuffled, now)).toHaveLength(records.length);
			}
		});
	}, 60_000);

	it("never reports a live helper once every record has aged out", async () => {
		// Time marching forward must flip every record from live to not-live at the
		// boundary, with no record surviving on a stale `updatedAt`.
		await withLivePids(4, async (livePids) => {
			const base = Date.now();
			const records: RuntimeHelperSelectable[] = livePids.map((pid, index) => ({
				state: "running",
				pid,
				startedAt: base - 60_000,
				updatedAt: base - index * 1_000,
			}));
			expect(liveRuntimeHelpers(records, base)).toHaveLength(records.length);
			const wayLater = base + RUNTIME_HELPER_STATUS_STALE_MS + 10_000;
			expect(liveRuntimeHelpers(records, wayLater)).toHaveLength(0);
			for (const record of records) {
				expect(isLiveRuntimeHelper(record, wayLater)).toBe(false);
			}
			// The fallback still reports something, so `rotation status` can show
			// the last thing a helper said.
			expect(selectRuntimeHelperStatus(records, wayLater)).not.toBeNull();
		});
	}, 60_000);
});

describe("stress: filesystem shapes that are not plain files", () => {
	it("tolerates a directory, a symlink and an unreadable file where records belong", async () => {
		// The multi-auth root is a user-writable directory, so anything can end up
		// at these paths: a directory created by a botched script, a symlink from
		// a dotfile manager, a file whose mode was changed. `statSync` succeeds on
		// all three, so a reader that trusts it and calls `readFileSync` throws
		// EISDIR or EACCES — inside `rotation status`, or inside `uninstall`.
		const root = await createRoot("cma-stress-fs-shapes-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });

		// A directory sitting exactly where a per-PID status file goes.
		await mkdir(statusPathFor(baseDir, 800_000_001), { recursive: true });
		// A directory where an owner file goes.
		await mkdir(ownerPathFor(baseDir, 800_000_002), { recursive: true });
		// A symlink pointing at a real record elsewhere, and a broken one.
		const realTarget = join(baseDir, "target-record.json");
		await writeFile(realTarget, statusRecord(800_000_003), "utf8");
		if (process.platform !== "win32") {
			const { symlink } = await import("node:fs/promises");
			await symlink(realTarget, statusPathFor(baseDir, 800_000_003));
			await symlink(
				join(baseDir, "does-not-exist.json"),
				statusPathFor(baseDir, 800_000_004),
			);
		}
		// A well-formed record alongside them, which must still be found.
		await withLivePids(1, async ([livePid]) => {
			const pid = livePid ?? process.pid;
			await writeFile(
				statusPathFor(baseDir, pid),
				statusRecord(pid, { lastAccountId: "acc_survivor" }),
				"utf8",
			);

			const previousDir = process.env.CODEX_MULTI_AUTH_DIR;
			process.env.CODEX_MULTI_AUTH_DIR = baseDir;
			try {
				// The reader must neither throw nor be blinded by the junk.
				expect(() => readAppRuntimeHelperStatus()).not.toThrow();
				expect(readAppRuntimeHelperStatus()?.lastAccountId).toBe(
					"acc_survivor",
				);
			} finally {
				if (previousDir === undefined) {
					delete process.env.CODEX_MULTI_AUTH_DIR;
				} else {
					process.env.CODEX_MULTI_AUTH_DIR = previousDir;
				}
			}

			// And unbind must complete over the same directory.
			await expect(
				unbindCodexAppRuntimeRotation({
					platform: process.platform,
					home: root,
					env: envFor(root),
				}),
			).resolves.toBeDefined();

			// The directories are still there — unbind removes records, not
			// whatever else a user put in their multi-auth root.
			expect(existsSync(statusPathFor(baseDir, 800_000_001))).toBe(true);
			expect(existsSync(ownerPathFor(baseDir, 800_000_002))).toBe(true);
		});
	}, 120_000);
});

describe("stress: readers racing a live unbind", () => {
	it("never throws when files vanish underneath a status read", async () => {
		// `rotation status` and the interactive menu read this directory while
		// `unbind-app` or a launcher sweep is deleting from it. Every read is a
		// three-step existsSync/statSync/readFileSync, so a file removed between
		// any two of those steps has to degrade to "no record", never to an
		// exception surfacing in the CLI.
		const root = await createRoot("cma-stress-race-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });

		await withDeadPids(120, async (deadPids) => {
			for (const pid of deadPids) {
				await writeFile(statusPathFor(baseDir, pid), statusRecord(pid), "utf8");
				await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
			}

			const previousDir = process.env.CODEX_MULTI_AUTH_DIR;
			process.env.CODEX_MULTI_AUTH_DIR = baseDir;
			let reads = 0;
			let stop = false;
			const failures: unknown[] = [];
			const warnings: string[] = [];
			// Hammer the reader while unbind tears the directory down beneath it.
			const reader = (async () => {
				while (!stop) {
					try {
						const status = readAppRuntimeHelperStatus();
						appRuntimeHelperStatusToSignal(status);
						reads += 1;
					} catch (error) {
						failures.push(error);
						return;
					}
					await new Promise((resolve) => setImmediate(resolve));
				}
			})();

			try {
				await unbindCodexAppRuntimeRotation({
					platform: process.platform,
					home: root,
					env: envFor(root),
					log: (message) => warnings.push(message),
				});
			} finally {
				stop = true;
				await reader;
				if (previousDir === undefined) {
					delete process.env.CODEX_MULTI_AUTH_DIR;
				} else {
					process.env.CODEX_MULTI_AUTH_DIR = previousDir;
				}
			}

			expect(failures).toEqual([]);
			// The loop has to have actually run against a populated directory,
			// otherwise it proves nothing.
			expect(reads).toBeGreaterThan(0);
			for (const pid of deadPids) {
				if (preservedAsLive(warnings, pid)) continue;
				expect(existsSync(statusPathFor(baseDir, pid))).toBe(false);
			}
		});
	}, 180_000);

	it("is idempotent: a second unbind over the same directory is a clean no-op", async () => {
		// `uninstall` can be re-run, and a partially-completed unbind must not make
		// the next one throw or resurrect work.
		const root = await createRoot("cma-stress-idempotent-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });

		await withDeadPids(40, async (deadPids) => {
			for (const pid of deadPids) {
				await writeFile(statusPathFor(baseDir, pid), statusRecord(pid), "utf8");
				await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
			}
			const warnings: string[] = [];
			for (let round = 0; round < 3; round += 1) {
				await expect(
					unbindCodexAppRuntimeRotation({
						platform: process.platform,
						home: root,
						env: envFor(root),
						log: (message) => warnings.push(message),
					}),
				).resolves.toBeDefined();
			}
			expect(remainingHelperFiles(baseDir, warnings)).toEqual([]);
		});
	}, 180_000);

	it("runs concurrent unbinds over one directory without throwing", async () => {
		// Two terminals, two `uninstall` runs. They contend on the same files; the
		// requirement is that neither throws and the directory still ends clean.
		const root = await createRoot("cma-stress-concurrent-unbind-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });

		await withDeadPids(60, async (deadPids) => {
			for (const pid of deadPids) {
				await writeFile(statusPathFor(baseDir, pid), statusRecord(pid), "utf8");
				await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
			}
			const warnings: string[] = [];
			const results = await Promise.allSettled(
				Array.from({ length: 4 }, () =>
					unbindCodexAppRuntimeRotation({
						platform: process.platform,
						home: root,
						env: envFor(root),
						log: (message) => warnings.push(message),
					}),
				),
			);
			expect(results.every((r) => r.status === "fulfilled")).toBe(true);
			expect(remainingHelperFiles(baseDir, warnings)).toEqual([]);
		});
	}, 180_000);
});

describe("stress: the shared filename contract", () => {
	it("classifies a large mixed directory identically for status and owner paths", async () => {
		// Every reader discovers files through these two functions. A directory
		// containing near-miss names must not be mis-parsed in either direction.
		const baseDir = "/tmp/does-not-need-to-exist";
		const entries = [
			"runtime-rotation-app-helper.json",
			"runtime-rotation-app-helper.1.json",
			"runtime-rotation-app-helper.99999999.json",
			"runtime-rotation-app-helper.0.json",
			"runtime-rotation-app-helper.-1.json",
			"runtime-rotation-app-helper.1.2.json",
			"runtime-rotation-app-helper.abc.json",
			"runtime-rotation-app-helper..json",
			"runtime-rotation-app-helper.1.json.bak",
			"runtime-rotation-app-helper-owner.json",
			"runtime-rotation-app-helper-owner.1.json",
			"runtime-rotation-app-helper-owner.42.json",
			"runtime-rotation-app-helper-owner.abc.json",
			"RUNTIME-ROTATION-APP-HELPER.7.JSON",
			"unrelated.json",
			"",
		];

		const statusPaths = listRuntimeHelperStatusPaths(baseDir, entries);
		const owners = listRuntimeHelperOwnerPaths(baseDir, entries);

		// Status discovery accepts only `<name>.<digits>.json`, plus the legacy
		// un-suffixed path which is always appended.
		const statusNames = statusPaths.map((p) => p.split(/[\\/]/).pop());
		expect(statusNames).toContain("runtime-rotation-app-helper.1.json");
		expect(statusNames).toContain("runtime-rotation-app-helper.99999999.json");
		expect(statusNames).toContain("RUNTIME-ROTATION-APP-HELPER.7.JSON");
		expect(statusNames).toContain("runtime-rotation-app-helper.json");
		expect(statusNames).not.toContain("runtime-rotation-app-helper.abc.json");
		expect(statusNames).not.toContain("runtime-rotation-app-helper.-1.json");
		expect(statusNames).not.toContain("runtime-rotation-app-helper.1.json.bak");
		expect(statusNames).not.toContain("runtime-rotation-app-helper..json");
		expect(statusNames).not.toContain("unrelated.json");
		// The owner name must never be picked up as a status file.
		expect(
			statusNames.filter((n) => n?.includes("owner")).length,
		).toBe(0);

		// Owner discovery rejects non-positive and non-numeric PIDs outright.
		const ownerPids = owners.map((o) => o.pid);
		expect(ownerPids).toContain(1);
		expect(ownerPids).toContain(42);
		expect(ownerPids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
		expect(owners.some((o) => o.path.includes("abc"))).toBe(false);
		// And the un-suffixed owner name is not a per-PID owner file.
		expect(
			owners.some((o) => o.path.endsWith("runtime-rotation-app-helper-owner.json")),
		).toBe(false);
	});

	it("round-trips every plausible PID through both path builders", async () => {
		const root = await createRoot("cma-stress-paths-");
		const baseDir = multiAuthDirFor(root);
		await mkdir(baseDir, { recursive: true });
		const pids = [1, 2, 7, 99, 1234, 65_535, 4_194_304, 2_147_483_647];
		for (const pid of pids) {
			await writeFile(statusPathFor(baseDir, pid), statusRecord(pid), "utf8");
			await writeFile(ownerPathFor(baseDir, pid), ownerRecord(pid), "utf8");
		}
		const entries = readdirSync(baseDir);
		const discoveredStatus = listRuntimeHelperStatusPaths(baseDir, entries);
		const discoveredOwners = listRuntimeHelperOwnerPaths(baseDir, entries);
		for (const pid of pids) {
			expect(discoveredStatus).toContain(statusPathFor(baseDir, pid));
			expect(discoveredOwners.map((o) => o.pid)).toContain(pid);
		}
	}, 60_000);
});
