import { describe, expect, it, vi } from "vitest";
import { runIntegrationsCommand } from "../lib/codex-manager/commands/integrations.js";
import { DEFAULT_MODEL } from "../lib/request/helpers/model-map.js";

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
		expect(payload.snippets[0]?.body).toContain(`model="${DEFAULT_MODEL}"`);
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

	it("rejects a flag-like value after --model instead of consuming it", async () => {
		const logError = vi.fn();
		const exitCode = await runIntegrationsCommand(["--model", "-x"], {
			logInfo: vi.fn(),
			logError,
		});
		expect(exitCode).toBe(1);
		expect(logError).toHaveBeenCalledWith("Missing value for --model");
	});

	it("rejects a whitespace-only --model value", async () => {
		const logError = vi.fn();
		const exitCode = await runIntegrationsCommand(["--model", "   "], {
			logInfo: vi.fn(),
			logError,
		});
		expect(exitCode).toBe(1);
		expect(logError).toHaveBeenCalledWith("Missing value for --model");
	});
});
