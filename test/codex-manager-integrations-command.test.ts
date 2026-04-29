import { describe, expect, it, vi } from "vitest";
import { runIntegrationsCommand } from "../lib/codex-manager/commands/integrations.js";

describe("integrations command", () => {
	it("prints selected json snippets", async () => {
		const logInfo = vi.fn();
		const exitCode = await runIntegrationsCommand(
			["--kind", "python", "--json"],
			{ logInfo, logError: vi.fn() },
		);
		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(logInfo.mock.calls[0]?.[0])) as {
			snippets: Array<{ kind: string; body: string }>;
		};
		expect(payload.snippets).toHaveLength(1);
		expect(payload.snippets[0]?.kind).toBe("python");
		expect(payload.snippets[0]?.body).toContain("client.responses.create");
		expect(payload.snippets[0]?.body).toContain("CODEX_MULTI_AUTH_LOCAL_KEY");
	});

	it("rejects invalid kinds", async () => {
		const logError = vi.fn();
		const exitCode = await runIntegrationsCommand(["--kind", "bad"], {
			logInfo: vi.fn(),
			logError,
		});
		expect(exitCode).toBe(1);
		expect(String(logError.mock.calls[0]?.[0])).toContain("invalid value");
	});
});
