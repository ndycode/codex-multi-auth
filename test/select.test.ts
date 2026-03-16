import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ui/ansi.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/ui/ansi.js")>(
		"../lib/ui/ansi.js",
	);
	return {
		...actual,
		isTTY: () => true,
	};
});

describe("ui select", () => {
	const stdin = process.stdin as NodeJS.ReadStream & {
		setRawMode?: (mode: boolean) => void;
	};
	const stdout = process.stdout;
	let rawModeSpy: ReturnType<typeof vi.spyOn> | null = null;
	let resumeSpy: ReturnType<typeof vi.spyOn> | null = null;
	let pauseSpy: ReturnType<typeof vi.spyOn> | null = null;
	let writeSpy: ReturnType<typeof vi.spyOn> | null = null;
	let readSpy: ReturnType<typeof vi.spyOn> | null = null;

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		if (typeof stdin.setRawMode !== "function") {
			Object.defineProperty(stdin, "setRawMode", {
				value: (_mode: boolean) => undefined,
				configurable: true,
				writable: true,
			});
		}
		rawModeSpy = vi.spyOn(stdin, "setRawMode").mockImplementation(() => undefined);
		resumeSpy = vi.spyOn(stdin, "resume").mockImplementation(() => stdin);
		pauseSpy = vi.spyOn(stdin, "pause").mockImplementation(() => stdin);
		writeSpy = vi.spyOn(stdout, "write").mockImplementation(() => true);
		readSpy = vi.spyOn(stdin, "read").mockImplementation(() => null);
	});

	afterEach(() => {
		vi.useRealTimers();
		rawModeSpy?.mockRestore();
		resumeSpy?.mockRestore();
		pauseSpy?.mockRestore();
		writeSpy?.mockRestore();
		readSpy?.mockRestore();
		vi.restoreAllMocks();
	});

	it("suppresses initial enter during the input guard window", async () => {
		const { select } = await import("../lib/ui/select.js");
		const selectPromise = select(
			[
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			{
				message: "Pick",
				onInput: (input) => {
					if (input === "x") return "hotkey-picked";
					return undefined;
				},
			},
		);

		stdin.emit("data", Buffer.from("\r", "utf8"));
		stdin.emit("data", Buffer.from("x", "utf8"));

		const result = await selectPromise;
		expect(result).toBe("hotkey-picked");
	});

	it("cleans up refresh interval and signal listeners on cancel", async () => {
		const initialSigintCount = process.listenerCount("SIGINT");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { select } = await import("../lib/ui/select.js");

		const selectPromise = select(
			[
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			{
				message: "Pick",
				dynamicSubtitle: () => "live",
				refreshIntervalMs: 200,
			},
		);

		await vi.advanceTimersByTimeAsync(130);
		stdin.emit("data", Buffer.from("\x1b", "utf8"));
		await vi.advanceTimersByTimeAsync(80);

		const result = await selectPromise;
		expect(result).toBeNull();
		expect(clearIntervalSpy).toHaveBeenCalled();
		expect(process.listenerCount("SIGINT")).toBe(initialSigintCount);
		clearIntervalSpy.mockRestore();
	});

	it("renders a split pane when the layout is enabled and the terminal is wide", async () => {
		const { __testOnly } = await import("../lib/ui/select.js");
		const lines = __testOnly.renderSelectFrame(
			[
				{ label: "Quick Actions", value: "noop", kind: "heading" },
				{ label: "Add New Account", value: "add" },
				{ label: "Run Health Check", value: "check" },
			],
			1,
			{
				message: "Accounts Dashboard",
				headerNote: "Add | Check | Best | Fix",
				layout: "split-pane-auto",
				detailPane: () => ({
					title: "Add New Account",
					lines: ["Choose browser or manual sign-in.", "Enter starts the flow."],
				}),
			},
			{ columns: 120, rows: 18 },
		);

		expect(lines.some((line: string) => line.includes("Accounts Dashboard"))).toBe(true);
		expect(lines.some((line: string) => line.includes("Add New Account"))).toBe(true);
		expect(lines.some((line: string) => line.includes("Choose browser or manual sign-in."))).toBe(true);
		expect(lines.some((line: string) => line.includes("|"))).toBe(true);
	});

	it("falls back to stacked rendering when the terminal is narrow", async () => {
		const { __testOnly } = await import("../lib/ui/select.js");
		const lines = __testOnly.renderSelectFrame(
			[
				{ label: "Quick Actions", value: "noop", kind: "heading" },
				{ label: "Add New Account", value: "add", hint: "Choose browser or manual sign-in." },
				{ label: "Run Health Check", value: "check" },
			],
			1,
			{
				message: "Accounts Dashboard",
				layout: "split-pane-auto",
				detailPane: () => ({
					title: "Add New Account",
					lines: ["Choose browser or manual sign-in."],
				}),
			},
			{ columns: 72, rows: 18 },
		);

		expect(lines.some((line: string) => line.includes("Choose browser or manual sign-in."))).toBe(true);
		expect(lines.filter((line: string) => line.includes("|")).length).toBeLessThanOrEqual(1);
	});
});
