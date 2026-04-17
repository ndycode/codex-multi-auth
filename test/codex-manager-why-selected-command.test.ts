import { describe, expect, it, vi } from "vitest";
import {
	parseWhySelectedArgs,
	printWhySelectedUsage,
	runWhySelectedCommand,
	type WhySelectedCliOptions,
	type WhySelectedCommandDeps,
} from "../lib/codex-manager/commands/why-selected.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type {
	HybridSelectionTraceResult,
	HybridSelectionCandidateTrace,
} from "../lib/rotation.js";

function storage(
	accounts: Array<Partial<AccountStorageV3["accounts"][number]>> = [],
): AccountStorageV3 {
	const now = Date.now();
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: accounts.map((partial, idx) => ({
			refreshToken: `refresh-${idx}`,
			email: `user${idx}@example.com`,
			addedAt: now,
			lastUsed: now,
			rateLimitResetTimes: {},
			...partial,
		})),
	};
}

function candidate(
	overrides: Partial<HybridSelectionCandidateTrace> = {},
): HybridSelectionCandidateTrace {
	return {
		index: 0,
		trackerKey: 0,
		isAvailable: true,
		lastUsed: Date.now(),
		health: 90,
		tokens: 40,
		hoursSinceUsed: 2,
		capabilityBoost: 0,
		pidBonus: 0,
		score: 100,
		...overrides,
	};
}

function traceResult(
	overrides: Partial<HybridSelectionTraceResult> = {},
): HybridSelectionTraceResult {
	return {
		selected: null,
		selectedIndex: null,
		selectionReason: "no accounts provided",
		candidates: [],
		config: {
			healthWeight: 2,
			tokenWeight: 5,
			freshnessWeight: 2,
		},
		quotaKey: "codex",
		availableCount: 0,
		...overrides,
	};
}

function createDeps(
	overrides: Partial<WhySelectedCommandDeps> = {},
): WhySelectedCommandDeps {
	return {
		parseWhySelectedArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad"))
				return { ok: false as const, message: "Unknown option: --bad" };
			const options: WhySelectedCliOptions = {
				json: args.includes("--json") || args.includes("-j"),
				mode: args.includes("--last") || args.includes("-l") ? "last" : "now",
			};
			return { ok: true as const, options };
		}),
		printWhySelectedUsage: vi.fn(),
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => storage([{}, {}])),
		resolveActiveIndex: vi.fn(() => 0),
		selectAccountTraced: vi.fn(() =>
			traceResult({
				selected: {
					index: 0,
					isAvailable: true,
					lastUsed: Date.now(),
					trackerKey: 0,
				},
				selectedIndex: 0,
				selectionReason: "highest hybrid score",
				availableCount: 2,
				candidates: [
					candidate({ index: 0, score: 150 }),
					candidate({ index: 1, score: 100 }),
				],
			}),
		),
		sanitizeEmail: vi.fn((email) => email),
		logInfo: vi.fn(),
		logError: vi.fn(),
		...overrides,
	};
}

describe("runWhySelectedCommand", () => {
	it("prints usage for --help", async () => {
		const deps = createDeps();
		const result = await runWhySelectedCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printWhySelectedUsage).toHaveBeenCalled();
	});

	it("rejects unknown flags", async () => {
		const deps = createDeps();
		const result = await runWhySelectedCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("returns exit 1 and error when no accounts exist", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage([])),
		});
		const result = await runWhySelectedCommand([], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			expect.stringContaining("No accounts configured"),
		);
	});

	it("emits JSON payload for --json", async () => {
		const deps = createDeps();
		const result = await runWhySelectedCommand(["--json"], deps);
		expect(result).toBe(0);
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls[0]?.[0] ?? ""),
		) as {
			command: string;
			mode: string;
			ok: boolean;
			selected: { index: number } | null;
			candidates: Array<{ index: number; score: number }>;
		};
		expect(payload.command).toBe("why-selected");
		expect(payload.mode).toBe("now");
		expect(payload.ok).toBe(true);
		expect(payload.selected?.index).toBe(0);
		expect(payload.candidates.map((c) => c.index)).toEqual([0, 1]);
	});

	it("picks the single available account trivially", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage([{ email: "solo@example.com" }])),
			selectAccountTraced: vi.fn(() =>
				traceResult({
					availableCount: 1,
					selected: {
						index: 0,
						isAvailable: true,
						lastUsed: Date.now(),
						trackerKey: 0,
					},
					selectedIndex: 0,
					selectionReason: "single available account",
					candidates: [candidate({ index: 0, score: 50 })],
				}),
			),
		});
		const result = await runWhySelectedCommand(["--json"], deps);
		expect(result).toBe(0);
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls[0]?.[0] ?? ""),
		) as { selected: { index: number } | null; candidates: unknown[] };
		expect(payload.selected?.index).toBe(0);
		expect(payload.candidates).toHaveLength(1);
	});

	it("surfaces cooled-down fallback reason when all accounts unavailable", async () => {
		const deps = createDeps({
			selectAccountTraced: vi.fn(() =>
				traceResult({
					availableCount: 0,
					selected: {
						index: 1,
						isAvailable: false,
						lastUsed: 0,
						trackerKey: 1,
					},
					selectedIndex: 1,
					selectionReason:
						"all accounts unavailable; fell back to least-recently-used",
					candidates: [
						candidate({
							index: 1,
							isAvailable: false,
							score: -10,
							reason:
								"unavailable (rate-limited, cooling down, or circuit open)",
						}),
						candidate({
							index: 0,
							isAvailable: false,
							score: -20,
							reason:
								"unavailable (rate-limited, cooling down, or circuit open)",
						}),
					],
				}),
			),
		});
		const result = await runWhySelectedCommand(["--json"], deps);
		expect(result).toBe(0);
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls[0]?.[0] ?? ""),
		) as {
			selected: { selectionReason: string } | null;
			availableCount: number;
		};
		expect(payload.availableCount).toBe(0);
		expect(payload.selected?.selectionReason).toContain(
			"all accounts unavailable",
		);
	});

	it("reads runtime snapshot when --last is used", async () => {
		const runtimeSnapshot = { generatedAt: 1_234_567 };
		const loader = vi.fn(async () => runtimeSnapshot);
		const deps = createDeps({ loadRuntimeObservabilitySnapshot: loader });
		const result = await runWhySelectedCommand(["--last", "--json"], deps);
		expect(result).toBe(0);
		expect(loader).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(
			String(vi.mocked(deps.logInfo!).mock.calls[0]?.[0] ?? ""),
		) as { mode: string; runtimeSnapshot: { generatedAt: number } | null };
		expect(payload.mode).toBe("last");
		expect(payload.runtimeSnapshot).toEqual(runtimeSnapshot);
	});

	it("prints human-readable summary for non-JSON mode", async () => {
		const deps = createDeps();
		const result = await runWhySelectedCommand([], deps);
		expect(result).toBe(0);
		const logged = vi
			.mocked(deps.logInfo!)
			.mock.calls.map((call) => String(call[0]))
			.join("\n");
		expect(logged).toContain("Selected: account 1");
		expect(logged).toContain("Candidates (sorted by score desc)");
	});
});

describe("parseWhySelectedArgs", () => {
	it("defaults to now mode", () => {
		const parsed = parseWhySelectedArgs([]);
		if (!parsed.ok) throw new Error("expected ok result");
		expect(parsed.options).toEqual({ json: false, mode: "now" });
	});

	it("sets last mode", () => {
		const parsed = parseWhySelectedArgs(["--last"]);
		if (!parsed.ok) throw new Error("expected ok result");
		expect(parsed.options.mode).toBe("last");
	});

	it("enables json", () => {
		const parsed = parseWhySelectedArgs(["--json"]);
		if (!parsed.ok) throw new Error("expected ok result");
		expect(parsed.options.json).toBe(true);
	});

	it("rejects combining --now and --last", () => {
		const parsed = parseWhySelectedArgs(["--now", "--last"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toMatch(/cannot combine/i);
	});

	it("rejects unknown flag", () => {
		const parsed = parseWhySelectedArgs(["--wat"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toMatch(/unknown option/i);
	});
});

describe("printWhySelectedUsage", () => {
	it("prints help output", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printWhySelectedUsage();
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
