import { describe, expect, it, vi } from "vitest";
import {
	parseAuthLoginArgs,
	parseBestArgs,
} from "../lib/codex-manager/help.js";

describe("codex-manager help parsers", () => {
	it("parses login flags without printing usage", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(parseAuthLoginArgs(["--manual"])).toEqual({
			ok: true,
			options: { manual: true, deviceAuth: false },
		});
		expect(parseAuthLoginArgs(["--no-browser"])).toEqual({
			ok: true,
			options: { manual: true, deviceAuth: false },
		});
		expect(parseAuthLoginArgs(["--device-auth"])).toEqual({
			ok: true,
			options: { manual: false, deviceAuth: true },
		});
		expect(parseAuthLoginArgs(["--help"])).toEqual({
			ok: false,
			reason: "help",
		});
		expect(logSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("parses --org to bind a workspace (#491)", () => {
		expect(parseAuthLoginArgs(["--org", "org-BBBB"])).toEqual({
			ok: true,
			options: { manual: false, deviceAuth: false, org: "org-BBBB" },
		});
		expect(parseAuthLoginArgs(["--org=org-AAAA"])).toEqual({
			ok: true,
			options: { manual: false, deviceAuth: false, org: "org-AAAA" },
		});
		expect(parseAuthLoginArgs(["--manual", "--org", "org-BBBB"])).toEqual({
			ok: true,
			options: { manual: true, deviceAuth: false, org: "org-BBBB" },
		});
	});

	it("reports a missing --org value (#491)", () => {
		expect(parseAuthLoginArgs(["--org"])).toEqual({
			ok: false,
			reason: "error",
			message:
				"Missing value for --org. Usage: codex-multi-auth login --org <org_id>",
		});
		expect(parseAuthLoginArgs(["--org", "--manual"])).toEqual({
			ok: false,
			reason: "error",
			message:
				"Missing value for --org. Usage: codex-multi-auth login --org <org_id>",
		});
	});

	it("reports login parser errors explicitly", () => {
		expect(parseAuthLoginArgs(["--bogus"])).toEqual({
			ok: false,
			reason: "error",
			message: "Unknown login option: --bogus",
		});
		expect(parseAuthLoginArgs(["--device-auth", "--manual"])).toEqual({
			ok: false,
			reason: "error",
			message: "Cannot combine --device-auth with --manual",
		});
		expect(parseAuthLoginArgs(["--no-browser", "--device-auth"])).toEqual({
			ok: false,
			reason: "error",
			message: "Cannot combine --device-auth with --no-browser",
		});
		expect(parseAuthLoginArgs(["--device-auth", "--no-browser"])).toEqual({
			ok: false,
			reason: "error",
			message: "Cannot combine --device-auth with --no-browser",
		});
		expect(
			parseAuthLoginArgs(["--device-auth", "--manual", "--no-browser"]),
		).toEqual({
			ok: false,
			reason: "error",
			message: "Cannot combine --device-auth with --manual or --no-browser",
		});
	});

	it("parses best args and treats help as a first-class result", () => {
		expect(parseBestArgs(["--live", "--json", "--model", "gpt-5"])).toEqual({
			ok: true,
			options: {
				live: true,
				json: true,
				model: "gpt-5",
				modelProvided: true,
			},
		});
		expect(parseBestArgs(["-h"])).toEqual({
			ok: false,
			reason: "help",
		});
	});

	it("reports missing model values and unknown flags", () => {
		expect(parseBestArgs(["--model"])).toEqual({
			ok: false,
			reason: "error",
			message: "Missing value for --model",
		});
		expect(parseBestArgs(["--bogus"])).toEqual({
			ok: false,
			reason: "error",
			message: "Unknown option: --bogus",
		});
	});
});
