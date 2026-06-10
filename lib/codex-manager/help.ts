import { DEFAULT_MODEL } from "../request/helpers/model-map.js";

const DEFAULT_LIVE_PROBE_MODEL = DEFAULT_MODEL;

export function printUsage(): void {
	console.log(
		[
			"Codex Multi-Auth CLI",
			"",
			"Start here:",
			"  codex-multi-auth login [--device-auth|--manual|--no-browser] [--org <org_id>]",
			"  codex-multi-auth status",
			"  codex-multi-auth check",
			"",
			"Daily use:",
			"  codex-multi-auth list",
			"  codex-multi-auth switch <index>   (pins the account for runtime routing)",
			"  codex-multi-auth unpin            (clears the manual pin set by switch)",
			"  codex-multi-auth workspace <account> [workspace]   (list or switch an account's workspaces)",
			"  codex-multi-auth best [--live] [--json] [--model <model>]   (clears any manual pin set by switch)",
			"  codex-multi-auth forecast [--live] [--json] [--model <model>]",
			"  codex-multi-auth account tag|untag|weight|pause|unpause|drain|undrain|note ...",
			"",
			"Repair:",
			"  codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]",
			"  codex-multi-auth verify-flagged [--dry-run] [--json] [--no-restore]",
			"  codex-multi-auth verify [--paths | --flagged | --all] [--json]",
			"  codex-multi-auth fix [--dry-run] [--json] [--live] [--model <model>]",
			"  codex-multi-auth doctor [--json] [--fix] [--dry-run]",
			"",
			"Diagnostics:",
			"  codex-multi-auth usage [--since <time|duration>] [--by <group>] [--json|--csv] [--out <path>]",
			"  codex-multi-auth budget limit|check|list ...",
			"  codex-multi-auth bridge token create|list|rotate|revoke",
			"  codex-multi-auth integrations [--kind <name>] [--base-url <url>] [--model <model>] [--json]",
			"  codex-multi-auth models [--json] [--model <model>]",
			"  codex-multi-auth monitor [--json]",
			"  codex-multi-auth rotation <enable|disable|status|bind-app|unbind-app>",
			"  codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
			"  codex-multi-auth why-selected [--now | --last] [--json]",
			"",
			"Advanced:",
			"  codex-multi-auth report [--live] [--json] [--explain] [--model <model>] [--out <path>]",
			"  codex-multi-auth config explain [--json]",
			"  codex-multi-auth debug bundle [--json]",
			"  codex-multi-auth features",
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
	deviceAuth: boolean;
	org?: string;
};

export type ParsedAuthLoginArgs =
	| { ok: true; options: AuthLoginOptions }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

export function parseAuthLoginArgs(args: string[]): ParsedAuthLoginArgs {
	const options: AuthLoginOptions = {
		manual: false,
		deviceAuth: false,
	};
	const manualFlags: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--manual" || arg === "--no-browser") {
			options.manual = true;
			if (!manualFlags.includes(arg)) {
				manualFlags.push(arg);
			}
			continue;
		}
		if (arg === "--device-auth") {
			options.deviceAuth = true;
			continue;
		}
		if (arg === "--org" || arg?.startsWith("--org=")) {
			// Bind this login to a specific workspace/org id (issue #491). Reuses
			// the CODEX_AUTH_ACCOUNT_ID override mechanism so the same email's
			// personal vs business/team workspace can be registered on demand.
			let value: string | undefined;
			if (arg === "--org") {
				value = args[i + 1];
				i += 1;
			} else {
				value = arg.slice("--org=".length);
			}
			const trimmed = value?.trim();
			if (!trimmed || trimmed.startsWith("--")) {
				return {
					ok: false,
					reason: "error",
					message:
						"Missing value for --org. Usage: codex-multi-auth login --org <org_id>",
				};
			}
			options.org = trimmed;
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

	if (options.deviceAuth && options.manual) {
		const conflict =
			manualFlags.length > 0 ? manualFlags.join(" or ") : "--manual";
		return {
			ok: false,
			reason: "error",
			message: `Cannot combine --device-auth with ${conflict}`,
		};
	}

	return { ok: true, options };
}

interface BestCliOptions {
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
			"  codex-multi-auth best [--live] [--json] [--model <model>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend before switching",
			"  --json, -j         Print machine-readable JSON output",
			`  --model, -m        Probe model for live mode (default: ${DEFAULT_LIVE_PROBE_MODEL})`,
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
		model: DEFAULT_LIVE_PROBE_MODEL,
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
			const value = args[i + 1]?.trim();
			if (!value || value.startsWith("-")) {
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
			if (!value || value.startsWith("-")) {
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
