import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, utimesSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve(process.cwd(), "scripts", "slo-budget-report.js");

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

describe("slo-budget-report script", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
		vi.doUnmock("node:child_process");
		vi.restoreAllMocks();
		vi.resetModules();
		delete process.env.CODEX_HEALTH_CHECK_TIMEOUT_MS;
		delete process.env.CODEX_SLO_HEALTH_CHECK_SCRIPT;
	});

	it("counts stale-audit-log findings in staleWalFindings evaluation", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "slo-budget-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const policyPath = path.join(root, "policy.json");
		await fs.mkdir(logDir, { recursive: true });
		const staleAuditPath = path.join(logDir, "audit.log");
		await fs.writeFile(staleAuditPath, '{"timestamp":"2025-01-01T00:00:00Z","action":"request.start"}\n', "utf8");
		const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		utimesSync(staleAuditPath, staleDate, staleDate);
		await fs.writeFile(
			policyPath,
			JSON.stringify({
				windowDays: 30,
				objectives: {
					staleWalFindingsMax: 0,
				},
			}),
			"utf8",
		);

		const result = spawnSync(process.execPath, [scriptPath, `--policy=${policyPath}`], {
			encoding: "utf8",
			env: {
				...process.env,
				CODEX_MULTI_AUTH_DIR: root,
			},
		});

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout) as {
			health?: { staleWalFindings?: number };
			evaluations?: Array<{ id?: string; status?: string }>;
		};
		expect(payload.health?.staleWalFindings).toBe(1);
		const staleEval = payload.evaluations?.find((entry) => entry.id === "stale-wal-findings");
		expect(staleEval?.status).toBe("fail");
	});

	it("runHealthCheck surfaces timeout failures and applies timeout/kill options", async () => {
		const execError = new Error("spawn ETIMEDOUT: health check timed out");
		Object.assign(execError, { stdout: "", stderr: "" });
		const execFileSync = vi.fn(() => {
			throw execError;
		});
		vi.doMock("node:child_process", () => ({ execFileSync }));
		process.env.CODEX_HEALTH_CHECK_TIMEOUT_MS = "4321";

		const module = await import("../scripts/slo-budget-report.js");
		const payload = module.runHealthCheck() as {
			status?: string;
			findings?: Array<{ code?: string; message?: string }>;
		};

		expect(execFileSync).toHaveBeenCalledTimes(1);
		const call = execFileSync.mock.calls[0];
		expect(call[0]).toBe(process.execPath);
		expect(call[1]).toEqual(["scripts/enterprise-health-check.js"]);
		expect(call[2]).toMatchObject({
			timeout: 4321,
			killSignal: "SIGTERM",
		});
		expect(payload.status).toBe("fail");
		expect(payload.findings?.[0]?.code).toBe("health-check-exec-failed");
		expect(payload.findings?.[0]?.message).toContain("ETIMEDOUT");
	});

	it("runHealthCheck falls back to spawn error text when stdout/stderr are empty", async () => {
		const execError = new Error("spawn ENOENT: missing health check script");
		Object.assign(execError, { stdout: "", stderr: "" });
		const execFileSync = vi.fn(() => {
			throw execError;
		});
		vi.doMock("node:child_process", () => ({ execFileSync }));

		const module = await import("../scripts/slo-budget-report.js");
		const payload = module.runHealthCheck() as {
			status?: string;
			findings?: Array<{ message?: string }>;
		};

		expect(payload.status).toBe("fail");
		expect(payload.findings?.[0]?.message).toContain("ENOENT");
	});

	it("runHealthCheck honors health script overrides (Windows-compatible path)", async () => {
		const execFileSync = vi.fn(() => JSON.stringify({ status: "pass", checks: [], findings: [] }));
		vi.doMock("node:child_process", () => ({ execFileSync }));
		process.env.CODEX_SLO_HEALTH_CHECK_SCRIPT = "scripts\\enterprise-health-check.js";

		const module = await import("../scripts/slo-budget-report.js");
		const payload = module.runHealthCheck() as { status?: string };

		expect(execFileSync).toHaveBeenCalledTimes(1);
		expect(execFileSync.mock.calls[0][1]).toEqual(["scripts\\enterprise-health-check.js"]);
		expect(payload.status).toBe("pass");
	});
});
