import type { AccountStorageV3 } from "../../storage.js";
import type {
	HybridSelectionCandidateTrace,
	HybridSelectionTraceResult,
} from "../../rotation.js";

export interface WhySelectedCliOptions {
	json: boolean;
	mode: "now" | "last";
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

interface WhySelectedRuntimeSnapshot {
	lastSwitchReason?: string;
	lastRateLimitReason?: string;
	cooldownReason?: string;
	generatedAt?: number | string;
}

export interface WhySelectedCommandDeps {
	parseWhySelectedArgs: (
		args: string[],
	) => ParsedArgsResult<WhySelectedCliOptions>;
	printWhySelectedUsage: () => void;
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
	selectAccountTraced: (
		storage: AccountStorageV3,
	) => HybridSelectionTraceResult;
	loadRuntimeObservabilitySnapshot?: () => Promise<WhySelectedRuntimeSnapshot | null>;
	sanitizeEmail?: (email: string | undefined) => string | undefined;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

interface WhySelectedCandidateRecord {
	index: number;
	oneBasedIndex: number;
	email?: string;
	accountId?: string;
	enabled: boolean;
	available: boolean;
	health: number;
	tokens: number;
	hoursSinceUsed: number;
	capabilityBoost: number;
	pidBonus: number;
	score: number;
	lastSwitchReason?: string;
	lastRateLimitReason?: string;
	cooldownReason?: string;
	reason?: string;
}

interface WhySelectedSelectedRecord extends WhySelectedCandidateRecord {
	selectionReason: string;
}

function formatScore(value: number): string {
	if (!Number.isFinite(value)) return "NaN";
	return value.toFixed(2);
}

function buildCandidateRecord(
	storage: AccountStorageV3,
	candidate: HybridSelectionCandidateTrace,
	sanitizeEmail: (email: string | undefined) => string | undefined,
): WhySelectedCandidateRecord {
	const account = storage.accounts[candidate.index] as
		| (AccountStorageV3["accounts"][number] & {
				lastRateLimitReason?: string;
		  })
		| undefined;
	return {
		index: candidate.index,
		oneBasedIndex: candidate.index + 1,
		email: sanitizeEmail(account?.email),
		accountId: account?.accountId,
		enabled: account?.enabled !== false,
		available: candidate.isAvailable,
		health: candidate.health,
		tokens: candidate.tokens,
		hoursSinceUsed: candidate.hoursSinceUsed,
		capabilityBoost: candidate.capabilityBoost,
		pidBonus: candidate.pidBonus,
		score: candidate.score,
		lastSwitchReason: account?.lastSwitchReason,
		lastRateLimitReason: account?.lastRateLimitReason,
		cooldownReason: account?.cooldownReason,
		reason: candidate.reason,
	};
}

export async function runWhySelectedCommand(
	args: string[],
	deps: WhySelectedCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const sanitizeEmail =
		deps.sanitizeEmail ?? ((email: string | undefined) => email);

	if (args.includes("--help") || args.includes("-h")) {
		deps.printWhySelectedUsage();
		return 0;
	}

	const parsed = deps.parseWhySelectedArgs(args);
	if (!parsed.ok) {
		logError(parsed.message);
		deps.printWhySelectedUsage();
		return 1;
	}
	const options = parsed.options;

	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		const emptyPayload = {
			command: "why-selected",
			mode: options.mode,
			ok: false,
			error: "no accounts configured",
			selected: null,
			candidates: [] as WhySelectedCandidateRecord[],
		};
		if (options.json) {
			logInfo(JSON.stringify(emptyPayload, null, 2));
		} else {
			logError(
				"No accounts configured. Run `codex-multi-auth login` to add an account.",
			);
		}
		return 1;
	}

	const trace = deps.selectAccountTraced(storage);
	const candidates = trace.candidates.map((candidate) =>
		buildCandidateRecord(storage, candidate, sanitizeEmail),
	);

	let selectedRecord: WhySelectedSelectedRecord | null = null;
	if (trace.selected) {
		const baseCandidate = trace.candidates.find(
			(candidate) => candidate.index === trace.selected?.index,
		);
		if (baseCandidate) {
			selectedRecord = {
				...buildCandidateRecord(storage, baseCandidate, sanitizeEmail),
				selectionReason: trace.selectionReason,
			};
		}
	}

	let runtimeSnapshot: WhySelectedRuntimeSnapshot | null = null;
	if (options.mode === "last" && deps.loadRuntimeObservabilitySnapshot) {
		try {
			runtimeSnapshot = await deps.loadRuntimeObservabilitySnapshot();
		} catch {
			runtimeSnapshot = null;
		}
	}

	const payload = {
		command: "why-selected",
		mode: options.mode,
		ok: Boolean(selectedRecord),
		availableCount: trace.availableCount,
		totalCount: storage.accounts.length,
		quotaKey: trace.quotaKey,
		config: trace.config,
		selected: selectedRecord,
		candidates,
		runtimeSnapshot: options.mode === "last" ? runtimeSnapshot : undefined,
	};

	if (options.json) {
		logInfo(JSON.stringify(payload, null, 2));
		return selectedRecord ? 0 : 1;
	}

	const modeLabel =
		options.mode === "last"
			? "Last selection (live recomputation; no persistent tracker)"
			: "Selection right now (live)";
	logInfo(`why-selected: ${modeLabel}`);
	if (trace.quotaKey) {
		logInfo(`Quota key: ${trace.quotaKey}`);
	}
	logInfo(
		`Available: ${trace.availableCount} of ${storage.accounts.length} account(s)`,
	);
	logInfo("");

	if (selectedRecord) {
		const labelParts = [
			`Selected: account ${selectedRecord.oneBasedIndex}`,
			selectedRecord.email ? `<${selectedRecord.email}>` : null,
		]
			.filter((part): part is string => Boolean(part))
			.join(" ");
		logInfo(`${labelParts}`);
		logInfo(`  score: ${formatScore(selectedRecord.score)}`);
		logInfo(`  health: ${selectedRecord.health.toFixed(1)}`);
		logInfo(`  tokens: ${selectedRecord.tokens.toFixed(1)}`);
		logInfo(`  hoursSinceUsed: ${selectedRecord.hoursSinceUsed.toFixed(2)}`);
		logInfo(`  reason: ${selectedRecord.selectionReason}`);
		if (selectedRecord.lastSwitchReason) {
			logInfo(`  lastSwitchReason: ${selectedRecord.lastSwitchReason}`);
		}
		if (selectedRecord.lastRateLimitReason) {
			logInfo(`  lastRateLimitReason: ${selectedRecord.lastRateLimitReason}`);
		}
		if (selectedRecord.cooldownReason) {
			logInfo(`  cooldownReason: ${selectedRecord.cooldownReason}`);
		}
	} else {
		logError(
			`No account could be selected: ${trace.selectionReason}. Run \`codex-multi-auth check\` or \`codex-multi-auth doctor\` for diagnostics.`,
		);
	}

	logInfo("");
	logInfo("Candidates (sorted by score desc):");
	for (const candidate of candidates) {
		const marker =
			selectedRecord && candidate.index === selectedRecord.index
				? "*"
				: candidate.available
					? " "
					: "x";
		const emailSegment = candidate.email ? ` <${candidate.email}>` : "";
		const reasonSegment = candidate.reason ? ` (${candidate.reason})` : "";
		logInfo(
			`  ${marker} ${candidate.oneBasedIndex}${emailSegment}: score=${formatScore(candidate.score)} health=${candidate.health.toFixed(0)} tokens=${candidate.tokens.toFixed(0)} hrs=${candidate.hoursSinceUsed.toFixed(1)}${reasonSegment}`,
		);
	}

	if (options.mode === "last" && !runtimeSnapshot) {
		logInfo("");
		logInfo(
			"Note: no persistent selection tracker exists. Output above is a live recomputation from current state.",
		);
	}

	return selectedRecord ? 0 : 1;
}

export function parseWhySelectedArgs(
	args: string[],
): ParsedArgsResult<WhySelectedCliOptions> {
	const options: WhySelectedCliOptions = { json: false, mode: "now" };
	let modeExplicitlySet = false;
	for (const arg of args) {
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--now" || arg === "-n") {
			if (modeExplicitlySet && options.mode !== "now") {
				return {
					ok: false,
					message: "Cannot combine --now with --last",
				};
			}
			options.mode = "now";
			modeExplicitlySet = true;
			continue;
		}
		if (arg === "--last" || arg === "-l") {
			if (modeExplicitlySet && options.mode !== "last") {
				return {
					ok: false,
					message: "Cannot combine --now with --last",
				};
			}
			options.mode = "last";
			modeExplicitlySet = true;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}
	return { ok: true, options };
}

export function printWhySelectedUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex-multi-auth why-selected [--now | --last] [--json]",
			"",
			"Options:",
			"  --now, -n     Run selection now with live state (default)",
			"  --last, -l    Recompute selection using current state + last persisted runtime snapshot",
			"  --json, -j    Print machine-readable JSON output",
			"",
			"Exits 0 when an account is selected, 1 when no account can be selected.",
		].join("\n"),
	);
}
