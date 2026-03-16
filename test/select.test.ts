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

	it("renders the preview split shell at 80 columns", async () => {
		const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
		const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
		Object.defineProperty(stdout, "columns", {
			value: 80,
			configurable: true,
		});
		Object.defineProperty(stdout, "rows", {
			value: 24,
			configurable: true,
		});

		try {
			const { select } = await import("../lib/ui/select.js");
			const selectPromise = select(
				[
					{ label: "Open Browser", value: "browser" },
					{ label: "Manual", value: "manual" },
				],
				{
					message: "Sign-In Method",
					shellMode: "opentui-preview",
					panel: () => ({
						tag: "Sign-In Flow",
						title: "Open Browser",
						body: "Use the browser flow to finish OAuth with the local callback server.",
						footer: "Q Back",
					}),
				},
			);

			await vi.advanceTimersByTimeAsync(130);
			stdin.emit("data", Buffer.from("\x1b", "utf8"));
			await vi.advanceTimersByTimeAsync(80);
			await selectPromise;

			const output = writeSpy?.mock.calls.map((call) => String(call[0])).join("") ?? "";
			expect(output).toContain("Sign-In Flow");
			expect(output).toContain("Open Browser");
			expect(output).toContain("|");
		} finally {
			if (columnsDescriptor) {
				Object.defineProperty(stdout, "columns", columnsDescriptor);
			} else {
				delete (stdout as NodeJS.WriteStream & { columns?: number }).columns;
			}
			if (rowsDescriptor) {
				Object.defineProperty(stdout, "rows", rowsDescriptor);
			} else {
				delete (stdout as NodeJS.WriteStream & { rows?: number }).rows;
			}
		}
	});

	it("renders the preview shell in stacked mode below 80 columns", async () => {
		const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
		const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
		Object.defineProperty(stdout, "columns", {
			value: 60,
			configurable: true,
		});
		Object.defineProperty(stdout, "rows", {
			value: 24,
			configurable: true,
		});

		try {
			const { select } = await import("../lib/ui/select.js");
			const selectPromise = select(
				[
					{ label: "Open Browser", value: "browser" },
					{ label: "Manual", value: "manual" },
				],
				{
					message: "Sign-In Method",
					shellMode: "opentui-preview",
					panel: () => ({
						tag: "Sign-In Flow",
						title: "Open Browser",
						body: "Use the browser flow to finish OAuth with the local callback server.",
						footer: "Q Back",
					}),
				},
			);

			await vi.advanceTimersByTimeAsync(130);
			stdin.emit("data", Buffer.from("\x1b", "utf8"));
			await vi.advanceTimersByTimeAsync(80);
			await selectPromise;

			const output = writeSpy?.mock.calls.map((call) => String(call[0])).join("") ?? "";
			expect(output).toContain("Sign-In Flow");
			expect(output).toContain("Open Browser");
			expect(output).toContain("callback server.");
		} finally {
			if (columnsDescriptor) {
				Object.defineProperty(stdout, "columns", columnsDescriptor);
			} else {
				delete (stdout as NodeJS.WriteStream & { columns?: number }).columns;
			}
			if (rowsDescriptor) {
				Object.defineProperty(stdout, "rows", rowsDescriptor);
			} else {
				delete (stdout as NodeJS.WriteStream & { rows?: number }).rows;
			}
		}
	});
});
