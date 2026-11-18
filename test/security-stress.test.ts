import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditAction, AuditOutcome, auditLog, configureAudit, getAuditLogPath } from "../lib/audit.js";
import { combineSignals } from "../lib/utils.js";
import { isFullyQualifiedBinOverride } from "../scripts/codex-bin-resolver.js";

describe("stress: audit redaction adversarial strings", () => {
	const testLogDir = join(tmpdir(), `audit-stress-${Date.now()}`);

	beforeEach(() => {
		if (existsSync(testLogDir)) rmSync(testLogDir, { recursive: true });
		mkdirSync(testLogDir, { recursive: true });
		configureAudit({ enabled: true, logDir: testLogDir, maxFileSizeBytes: 1 << 20, maxFiles: 3 });
	});

	afterEach(() => {
		if (existsSync(testLogDir)) rmSync(testLogDir, { recursive: true });
	});

	function lastEntry() {
		const line = readFileSync(getAuditLogPath(), "utf8").trim().split("\n").at(-1)!;
		return JSON.parse(line) as { actor: string; resource: string; metadata?: Record<string, unknown> };
	}

	it.each([
		// scope identifiers must survive untouched
		["@scope/package", "@scope/package"],
		["@scope/pkg@1.2.3", "@scope/pkg@1.2.3"],
		["npm:@scope/pkg@npm:other@2", "npm:@scope/pkg@npm:other@2"],
		// bare handles / non-email shapes are not emails
		["@neil", "@neil"],
		["user@localhost", "user@localhost"],
		["a@b.c", "a@b.c"],
		["notanemail@", "notanemail@"],
		// real emails masked wherever they appear: prefix(<=2)***@***.<tld>
		["alice@corp.io", "al***@***.io"],
		["a@x.io", "a***@***.io"],
	])("actor/resource field %j → %j", (input, expected) => {
		auditLog(AuditAction.ACCOUNT_ADD, input, input, AuditOutcome.SUCCESS);
		const entry = lastEntry();
		expect(entry.actor).toBe(expected);
		expect(entry.resource).toBe(expected);
	});

	it("masks only the email span inside URLs and mixed prose", () => {
		const url = "https://idp.example/cb?email=alice@corp.io&state=xyz";
		auditLog(AuditAction.AUTH_LOGIN, url, "res", AuditOutcome.SUCCESS);
		const entry = lastEntry();
		expect(entry.actor).toBe("https://idp.example/cb?email=al***@***.io&state=xyz");
		expect(entry.actor).not.toContain("alice@corp.io");

		auditLog(
			AuditAction.AUTH_LOGIN,
			"contact admin@corp.io or see @scope/pkg docs, cc bob+dev@sub.corp.io",
			"res",
			AuditOutcome.SUCCESS,
		);
		const mixed = lastEntry();
		expect(mixed.actor).toContain("@scope/pkg");
		expect(mixed.actor).not.toContain("admin@corp.io");
		expect(mixed.actor).not.toContain("bob+dev@sub.corp.io");
		expect(mixed.actor).toContain("ad***@***.io");
		expect(mixed.actor).toContain("bo***@***.io");
	});

	it("handles multiple emails at string boundaries", () => {
		auditLog(AuditAction.ACCOUNT_ADD, "a@x.io mid b@y.io tail c@z.io", "r", AuditOutcome.SUCCESS);
		const entry = lastEntry();
		expect(entry.actor).toBe("a***@***.io mid b***@***.io tail c***@***.io");
	});

	it("sanitizes nested objects and arrays, redacts sensitive keys at depth", () => {
		auditLog(AuditAction.ACCOUNT_EXPORT, "actor", "res", AuditOutcome.SUCCESS, {
			note: "mail alice@corp.io",
			scope: "@scope/pkg",
			nested: {
				deep: { Authorization: "Bearer abc", who: "bob@corp.io" },
				list: ["a@x.io", "@scope/pkg", 42],
				apiKey: "k",
				client_secret: "s",
				accessToken: "t",
				credentialSet: "c",
				"X-Api-Key": "x",
				normal: "ok",
			},
		});
		const md = lastEntry().metadata as Record<string, unknown>;
		expect(md.note).toBe("mail al***@***.io");
		expect(md.scope).toBe("@scope/pkg");
		const nested = md.nested as Record<string, unknown>;
		const deep = nested.deep as Record<string, unknown>;
		expect(deep.Authorization).toBe("***REDACTED***");
		expect(deep.who).toBe("bo***@***.io");
		const list = nested.list as unknown[];
		expect(list[0]).toBe("a***@***.io");
		expect(list[1]).toBe("@scope/pkg");
		expect(list[2]).toBe(42);
		expect(nested.apiKey).toBe("***REDACTED***");
		expect(nested.client_secret).toBe("***REDACTED***");
		expect(nested.accessToken).toBe("***REDACTED***");
		expect(nested.credentialSet).toBe("***REDACTED***");
		expect(nested["X-Api-Key"]).toBe("***REDACTED***");
		expect(nested.normal).toBe("ok");
	});

	it("survives 200 mixed entries without throwing", () => {
		for (let i = 0; i < 200; i += 1) {
			auditLog(
				AuditAction.ACCOUNT_SWITCH,
				i % 2 ? `u${i}@corp.io` : `@scope-${i}/pkg`,
				`res/${i}@weird`,
				AuditOutcome.SUCCESS,
				{ i, apiToken: `secret-${i}` },
			);
		}
		const raw = readFileSync(getAuditLogPath(), "utf8");
		expect(raw).not.toContain("@corp.io");
		expect(raw).not.toContain("secret-");
		expect(raw).toContain("@scope-4/pkg");
	});
});

describe("stress: local token digest edge cases", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-lct-stress-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it.each([
		"sha256:not-hex-at-all",
		`sha256:${"ab".repeat(32)}`.slice(0, -1), // 63 hex
		`sha256:${"ab".repeat(32)}0`, // 65 hex
		"sha256:",
		"sha256: ",
		`sha256:${"zz".repeat(32)}`,
		`sha256:${"ab".repeat(32)} `, // trailing space
		`sha256:${"AB".repeat(32)}`, // uppercase — decodes, but mismatched bytes
		`sha256:${"ab".repeat(33)}`, // 66
	])("verify returns null, never throws, for malformed stored hash %j", async (storedHash) => {
		const { addLocalClientToken, saveLocalClientTokenStore, loadLocalClientTokenStore, verifyLocalClientBearerToken } =
			await import("../lib/local-client-tokens.js");
		const created = await addLocalClientToken({ label: "victim", now: 100 });
		const store = await loadLocalClientTokenStore();
		const rec = store.tokens.find((t) => t.id === created.record.id)!;
		rec.tokenHash = storedHash;
		await saveLocalClientTokenStore(store);
		await expect(
			verifyLocalClientBearerToken(`Bearer ${created.plainToken}`, 200),
		).resolves.toBeNull();
	});

	it("never matches records whose tokenHash is non-string, non-sha256, or wrong digest", async () => {
		const { addLocalClientToken, verifyLocalClientBearerToken, getLocalClientTokenPath } =
			await import("../lib/local-client-tokens.js");
		const created = await addLocalClientToken({ label: "victim", now: 100 });
		const path = getLocalClientTokenPath();
		const store = JSON.parse(await fs.readFile(path, "utf8")) as { tokens: Array<Record<string, unknown>> };
		const real = store.tokens[0]!;
		store.tokens = [
			{ ...real, id: "upper-prefix", tokenHash: `SHA256:${"ab".repeat(32)}` },
			{ ...real, id: "num", tokenHash: 12345 },
			{ ...real, id: "nul", tokenHash: null },
			{ ...real, id: "obj", tokenHash: { x: 1 } },
			{ ...real, id: "empty", tokenHash: "" },
			{ ...real, id: "wrong-digest", tokenHash: `sha256:${"ab".repeat(32)}` },
		];
		await fs.writeFile(path, JSON.stringify(store));
		await expect(
			verifyLocalClientBearerToken(`Bearer ${created.plainToken}`, 200),
		).resolves.toBeNull();
	});

	it("still verifies the true digest among many malformed sibling records", async () => {
		const { addLocalClientToken, saveLocalClientTokenStore, loadLocalClientTokenStore, verifyLocalClientBearerToken } =
			await import("../lib/local-client-tokens.js");
		const created = await addLocalClientToken({ label: "victim", now: 100 });
		const store = await loadLocalClientTokenStore();
		for (let i = 0; i < 50; i += 1) {
			store.tokens.push({
				...created.record,
				id: `bad-${i}`,
				tokenHash: `sha256:${(i % 2 ? "zz" : "ab").repeat(32)}`,
			});
		}
		await saveLocalClientTokenStore(store);
		const verified = await verifyLocalClientBearerToken(`Bearer ${created.plainToken}`, 200);
		expect(verified?.id).toBe(created.record.id);
	});
});

describe("stress: abort/listener accounting under many probes", () => {
	it("500 composites on one long-lived signal register zero listeners and still propagate", () => {
		const caller = new AbortController();
		const composites: AbortSignal[] = [];
		for (let i = 0; i < 500; i += 1) {
			composites.push(combineSignals(caller.signal, AbortSignal.timeout(60_000)));
		}
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		caller.abort("bulk-stop");
		expect(composites.every((s) => s.aborted)).toBe(true);
	});

	it("completed-request pattern: composites are dropped without pinning the caller", () => {
		const caller = new AbortController();
		// Simulate request lifecycle: combine, "complete" (drop), repeat. The
		// caller must never accumulate listeners or trigger MaxListeners warnings.
		let warnings = 0;
		const onWarning = () => { warnings += 1; };
		process.on("warning", onWarning);
		try {
			for (let i = 0; i < 1000; i += 1) {
				const s = combineSignals(caller.signal, AbortSignal.timeout(60_000));
				expect(s.aborted).toBe(false);
			}
			expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		} finally {
			process.off("warning", onWarning);
		}
		expect(warnings).toBe(0);
	});

	it("second-signal abort propagates to every outstanding composite", () => {
		const caller = new AbortController();
		const composites = Array.from({ length: 50 }, () => {
			const t = new AbortController();
			return { t, s: combineSignals(caller.signal, t.signal) };
		});
		for (const { t, s } of composites) {
			t.abort("per-request");
			expect(s.aborted).toBe(true);
			expect(s.reason).toBe("per-request");
		}
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		caller.abort();
	});
});

describe("stress: binary resolver path-injection variants", () => {
	it.each([
		["\\bin\\codex.exe", false],
		["/bin/codex.exe", false],
		["\\", false],
		["/", false],
		["\\bin", false],
		["\\codex.exe", false],
		["/bin", false],
		["C:\\bin\\codex.exe", true],
		["C:/bin/codex.exe", true],
		["c:\\bin\\codex.exe", true],
		["D:\\codex.exe", true],
		["\\\\server\\share\\codex.exe", true],
		["\\\\?\\C:\\bin\\codex.exe", true],
		["\\\\?\\UNC\\server\\share\\codex.exe", true],
		["C:bin\\codex.exe", false], // drive-relative — not absolute
		["bin\\codex.exe", false],
		["bin/codex.exe", false],
		["", false],
		["C:\\", true], // drive root itself is absolute+drive-qualified
	])("win32 override %j → %s", (candidate, expected) => {
		expect(isFullyQualifiedBinOverride(candidate, "win32")).toBe(expected);
	});

	it.each([
		["/usr/bin/codex", true],
		["/opt/codex/bin/codex.js", true],
		["bin/codex", false],
		["./codex", false],
		["", false],
		["C:\\bin\\codex.exe", false], // win paths mean nothing on posix
	])("linux override %j → %s", (candidate, expected) => {
		expect(isFullyQualifiedBinOverride(candidate, "linux")).toBe(expected);
	});
});
