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

	it("treats q hotkey as back/cancel", async () => {
		const { select } = await import("../lib/ui/select.js");
		const selectPromise = select(
			[
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			{
				message: "Pick",
			},
		);

		await vi.advanceTimersByTimeAsync(130);
		stdin.emit("data", Buffer.from("q", "utf8"));

		const result = await selectPromise;
		expect(result).toBeNull();
	});

	it("confirm returns false when q hotkey cancels", async () => {
		const { confirm } = await import("../lib/ui/confirm.js");
		const confirmPromise = confirm("Are you sure?");

		await vi.advanceTimersByTimeAsync(130);
		stdin.emit("data", Buffer.from("q", "utf8"));

		await expect(confirmPromise).resolves.toBe(false);
	});
});

describe("truncateAnsi ANSI reset placement (ui-01)", () => {
	const ESC = String.fromCharCode(27);
	const RED = `${ESC}[31m`;
	const RESET = `${ESC}[0m`;

	async function load() {
		const mod = await import("../lib/ui/select.js");
		return mod.truncateAnsi;
	}

	it("appends suffix + reset when the kept portion contains an ANSI escape", async () => {
		const truncateAnsi = await load();
		// 10 colored visible chars truncated to 5 -> "..", keep 2 visible, then reset.
		const out = truncateAnsi(`${RED}abcdefghij`, 5);
		expect(out.endsWith(`...${RESET}`)).toBe(true);
		expect(out.startsWith(RED)).toBe(true);
	});

	it("does NOT add an extra reset when the colored input is not truncated", async () => {
		const truncateAnsi = await load();
		const input = `${RED}abc${RESET}`;
		// Fits within width -> returned unchanged, no second reset appended.
		expect(truncateAnsi(input, 10)).toBe(input);
	});

	it("does NOT add a reset when plain (no ANSI) input is truncated", async () => {
		const truncateAnsi = await load();
		const out = truncateAnsi("abcdefghij", 5);
		expect(out.includes(RESET)).toBe(false);
		expect(out.endsWith("...")).toBe(true);
	});

	it("still ends with a single reset when multiple ANSI escapes are kept", async () => {
		const truncateAnsi = await load();
		const out = truncateAnsi(`${RED}a${RESET}${RED}bcdefghij`, 5);
		expect(out.endsWith(RESET)).toBe(true);
		// Exactly one trailing reset (suffix + reset), not a doubled reset.
		expect(out.endsWith(`${RESET}${RESET}`)).toBe(false);
	});
});
