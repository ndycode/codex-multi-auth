export function printUsage(): void {
	console.log(
		[
			"Codex Multi-Auth CLI",
			"",
			"Start here:",
			"  codex auth login [--manual|--no-browser]",
			"  codex auth status",
			"  codex auth check",
			"",
			"Daily use:",
			"  codex auth list",
			"  codex auth switch <index>",
			"  codex auth best [--live] [--json] [--model <model>]",
			"  codex auth forecast [--live] [--json] [--model <model>]",
			"",
			"Repair:",
			"  codex auth verify-flagged [--dry-run] [--json] [--no-restore]",
			"  codex auth fix [--dry-run] [--json] [--live] [--model <model>]",
			"  codex auth doctor [--json] [--fix] [--dry-run]",
			"",
			"Advanced:",
			"  codex auth report [--live] [--json] [--explain] [--model <model>] [--out <path>]",
			"  codex auth config explain [--json]",
			"  codex auth debug bundle [--json]",
			"  codex auth features",
			"",
			"Notes:",
			"  - Uses ~/.codex/multi-auth/openai-codex-accounts.json",
			"  - Syncs active account into Codex CLI auth state",
			"  - See docs/reference/commands.md for the full command and flag matrix",
		].join("\n"),
	);
}

export type AuthLoginOptions = {
	manual: boolean;
};

export type ParsedAuthLoginArgs =
	| { ok: true; options: AuthLoginOptions }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

export function parseAuthLoginArgs(args: string[]): ParsedAuthLoginArgs {
	const options: AuthLoginOptions = {
		manual: false,
	};

	for (const arg of args) {
		if (arg === "--manual" || arg === "--no-browser") {
			options.manual = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			return { ok: false, reason: "help" };
		}
		return {
			ok: false,
			reason: "error",
			message: `Unknown login option: ${arg}`,
		};
	}

	return { ok: true, options };
}

export interface BestCliOptions {
	live: boolean;
	json: boolean;
	model: string;
	modelProvided: boolean;
}

export type ParsedBestArgs =
	| { ok: true; options: BestCliOptions }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

export function printBestUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth best [--live] [--json] [--model <model>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend before switching",
			"  --json, -j         Print machine-readable JSON output",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"",
			"Behavior:",
			"  - Chooses the healthiest account using forecast scoring",
			"  - Switches to the recommended account when it is not already active",
		].join("\n"),
	);
}

export function parseBestArgs(args: string[]): ParsedBestArgs {
	const options: BestCliOptions = {
		live: false,
		json: false,
		model: "gpt-5-codex",
		modelProvided: false,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--help" || arg === "-h") {
			return { ok: false, reason: "help" };
		}
		if (arg === "--live" || arg === "-l") {
			options.live = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					reason: "error",
					message: "Missing value for --model",
				};
			}
			options.model = value;
			options.modelProvided = true;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) {
				return {
					ok: false,
					reason: "error",
					message: "Missing value for --model",
				};
			}
			options.model = value;
			options.modelProvided = true;
			continue;
		}
		return {
			ok: false,
			reason: "error",
			message: `Unknown option: ${arg}`,
		};
	}

	return { ok: true, options };
}
