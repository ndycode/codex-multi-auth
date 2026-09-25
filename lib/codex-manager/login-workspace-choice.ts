import {
	isPersonalAccountCandidate,
	type AccountIdCandidate,
} from "../auth/token-utils.js";
import { CodexValidationError } from "../errors.js";
import { stylePromptText } from "./formatters/index.js";
import { select, type MenuItem } from "../ui/select.js";

interface WorkspaceChoiceDeps {
	interactive: boolean;
	select: (items: MenuItem<string>[]) => Promise<string | null>;
	warn?: (message: string) => void;
}

/** Undefined delegates to the unambiguous default; null means cancel without saving. */
export async function chooseLoginWorkspace(
	candidates: AccountIdCandidate[],
	deps: WorkspaceChoiceDeps = {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		select: (items) => select(items, {
			message: "Choose the workspace for this account",
			subtitle: "No unique Personal workspace was identified. Choose explicitly before saving.",
			allowEscape: true,
		}),
	},
): Promise<string | undefined | null> {
	// An org- id is an API organization alias of a workspace (normalized to the
	// token's workspace when saved), so it never adds a real choice on its own.
	const workspaces = candidates.filter((candidate) => !candidate.accountId.startsWith("org-"));
	if (workspaces.length <= 1 || candidates.filter(isPersonalAccountCandidate).length === 1) {
		return undefined;
	}
	if (!deps.interactive) {
		// Scripted logins keep the 2.16.0 automatic choice rather than discarding
		// a completed OAuth exchange.
		(deps.warn ?? ((message: string) => console.warn(stylePromptText(message, "warning"))))(
			"Multiple workspaces found without a unique Personal workspace; saving the automatic choice. Re-run login with --org <workspace-id> to bind a specific workspace.",
		);
		return undefined;
	}
	// An interactive pick is explicit intent and is saved like --org.
	const choice = await deps.select(workspaces.map((candidate) => ({
		label: candidate.label,
		value: candidate.accountId,
	})));
	if (choice === null) return null;
	if (!workspaces.some((candidate) => candidate.accountId === choice)) {
		throw new CodexValidationError("Invalid workspace selection. Account was not saved.");
	}
	return choice;
}
