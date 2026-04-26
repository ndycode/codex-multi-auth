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
