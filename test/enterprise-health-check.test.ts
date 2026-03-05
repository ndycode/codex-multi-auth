import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve(process.cwd(), "scripts", "enterprise-health-check.js");

async function removeWithRetry(targetPath: string): Promise<void> {
	const retryableCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !retryableCodes.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

function runHealthCheck(args: string[], env: NodeJS.ProcessEnv = {}) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

function parseJsonStdout(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

function pathsEqual(left: string, right: string): boolean {
	const normalizedLeft = process.platform === "win32" ? left.replaceAll("/", "\\").toLowerCase() : left;
	const normalizedRight = process.platform === "win32" ? right.replaceAll("/", "\\").toLowerCase() : right;
	return normalizedLeft === normalizedRight;
}

describe("enterprise-health-check script", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
	});

	it("fails require-files mode when runtime artifacts are missing", () => {
		const root = mkdtempSync(path.join(tmpdir(), "health-check-missing-"));
		fixtures.push(root);

		const result = runHealthCheck(["--require-files", `--root=${root}`]);
		expect(result.status).toBe(1);
		expect(result.stdout).not.toBe("");

		const payload = parseJsonStdout(result.stdout);
		expect(payload.status).toBe("fail");
		const findings = Array.isArray(payload.findings) ? payload.findings : [];
		expect(findings.some((finding) => (finding as { code?: string }).code === "missing-storage-file")).toBe(
			true,
		);
		expect(findings.some((finding) => (finding as { code?: string }).code === "missing-audit-events")).toBe(
			true,
		);
	});

	it("resolves fallback multi-auth root for audit checks when account storage exists there", async () => {
		const homeRoot = mkdtempSync(path.join(tmpdir(), "health-check-home-"));
		fixtures.push(homeRoot);

		const primaryRoot = path.join(homeRoot, ".codex", "multi-auth");
		const fallbackRoot = path.join(homeRoot, "DevTools", "config", "codex", "multi-auth");
		await fs.mkdir(path.join(primaryRoot), { recursive: true });
		await fs.mkdir(path.join(fallbackRoot, "logs"), { recursive: true });
		await fs.writeFile(
			path.join(fallbackRoot, "openai-codex-accounts.json"),
			'{"version":3,"accounts":[],"activeIndex":0}\n',
			"utf8",
		);
		await fs.writeFile(
			path.join(fallbackRoot, "settings.json"),
			'{"version":1,"pluginConfig":{},"dashboardDisplaySettings":{}}\n',
			"utf8",
		);
		await fs.writeFile(path.join(fallbackRoot, "logs", "audit.log"), '{"timestamp":"2026-03-01T00:00:00Z"}\n');

		const result = runHealthCheck([], {
			HOME: homeRoot,
			USERPROFILE: homeRoot,
			CODEX_HOME: "",
			CODEX_MULTI_AUTH_DIR: "",
		});
		expect(result.status).toBe(0);

		const payload = parseJsonStdout(result.stdout);
		const payloadRoot = String(payload.root ?? "");
		if (process.platform === "win32") {
			expect(payloadRoot.toLowerCase()).toBe(fallbackRoot.toLowerCase());
		} else {
			expect(payloadRoot).toBe(fallbackRoot);
		}
		expect(pathsEqual(String(payload.auditDir), path.join(fallbackRoot, "logs"))).toBe(true);
		expect(payload.status).toBe("pass");
	});

	it("evaluates stale audit checks from fallback audit directory", async () => {
		const homeRoot = mkdtempSync(path.join(tmpdir(), "health-check-stale-fallback-"));
		fixtures.push(homeRoot);

		const fallbackRoot = path.join(homeRoot, "DevTools", "config", "codex", "multi-auth");
		const fallbackAuditDir = path.join(fallbackRoot, "logs");
		await fs.mkdir(fallbackAuditDir, { recursive: true });
		await fs.writeFile(
			path.join(fallbackRoot, "openai-codex-accounts.json"),
			'{"version":3,"accounts":[],"activeIndex":0}\n',
			"utf8",
		);
		await fs.writeFile(
			path.join(fallbackRoot, "settings.json"),
			'{"version":1,"pluginConfig":{},"dashboardDisplaySettings":{}}\n',
			"utf8",
		);

		const staleAuditPath = path.join(fallbackAuditDir, "audit.log");
		await fs.writeFile(staleAuditPath, '{"timestamp":"2025-01-01T00:00:00Z"}\n', "utf8");
		const staleMtimeMs = Date.now() - 9 * 24 * 60 * 60 * 1000;
		const staleDate = new Date(staleMtimeMs);
		await fs.utimes(staleAuditPath, staleDate, staleDate);

		const result = runHealthCheck([], {
			HOME: homeRoot,
			USERPROFILE: homeRoot,
			CODEX_HOME: "",
			CODEX_MULTI_AUTH_DIR: "",
		});

		expect(result.status).toBe(0);
		const payload = parseJsonStdout(result.stdout);
		expect(pathsEqual(String(payload.auditDir), fallbackAuditDir)).toBe(true);

		const findings = Array.isArray(payload.findings) ? payload.findings : [];
		const staleAuditFinding = findings.find((entry) => (entry as { code?: string }).code === "stale-audit-log") as
			| { path?: string }
			| undefined;
		expect(staleAuditFinding).toBeDefined();
		expect(pathsEqual(String(staleAuditFinding?.path ?? ""), fallbackAuditDir)).toBe(true);
	});

	it("treats audit directory churn (ENOTDIR) as no-audit-data instead of throwing", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "health-check-churn-"));
		fixtures.push(root);
		const auditPath = path.join(root, "logs");
		await fs.writeFile(auditPath, "not-a-directory", "utf8");

		const result = runHealthCheck([], {
			CODEX_MULTI_AUTH_DIR: root,
		});

		expect(result.status).toBe(0);
		const payload = parseJsonStdout(result.stdout);
		expect(pathsEqual(String(payload.auditDir), auditPath)).toBe(true);
		const checks = Array.isArray(payload.checks)
			? payload.checks
			: [];
		const newestAuditCheck = checks.find((entry) => (entry as { name?: string }).name === "newest-audit-mtime-ms") as
			| { value?: unknown }
			| undefined;
		expect(newestAuditCheck?.value ?? null).toBeNull();
	});
});
