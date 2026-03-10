import type { LoginMenuResult } from "../../lib/cli.js";
import type { AuthDashboardViewModel } from "../../lib/codex-manager/auth-ui-controller.js";
import type { KeyEvent } from "@opentui/core";
import type {
	OpenTuiShellSelection,
	OpenTuiWorkspaceAction,
} from "./app.js";
import {
	filterOpenTuiDashboardAccounts,
	resolveOpenTuiAccountSourceIndex,
} from "./account-workspace.js";
import {
	resolveOpenTuiAuthShellBootstrap,
	startOpenTuiAuthShell,
	type OpenTuiBootstrapOptions,
} from "./bootstrap.js";

type OpenTuiAuthNavActionLabel =
	| "Add"
	| "Check"
	| "Forecast"
	| "Fix"
	| "Verify"
	| "Deep Check";

const NAV_ACTION_RESULTS: Record<OpenTuiAuthNavActionLabel, LoginMenuResult> = {
	Add: { mode: "add" },
	Check: { mode: "check" },
	Forecast: { mode: "forecast" },
	Fix: { mode: "fix" },
	Verify: { mode: "verify-flagged" },
	"Deep Check": { mode: "deep-check" },
};

const EMPTY_SELECTION: OpenTuiShellSelection = {
	navIndex: 0,
	navLabel: "Accounts",
	accountIndex: 0,
	accountLabel: "",
	focusTarget: "workspace",
};

function isEnterKey(event: KeyEvent): boolean {
	return event.name === "enter" || event.name === "return";
}

function resolveNavActionResult(label: string): LoginMenuResult | null {
	return NAV_ACTION_RESULTS[label as OpenTuiAuthNavActionLabel] ?? null;
}

function resolveSelectedAccountResult(
	dashboard: AuthDashboardViewModel,
	selection: OpenTuiShellSelection,
	searchQuery: string,
	raw: string,
): LoginMenuResult | null {
	if (selection.navLabel !== "Accounts" || selection.focusTarget !== "workspace") {
		return null;
	}

	const visibleAccounts = filterOpenTuiDashboardAccounts(dashboard, searchQuery);
	const account = visibleAccounts[selection.accountIndex];
	if (!account) {
		return null;
	}

	const sourceIndex = resolveOpenTuiAccountSourceIndex(account);
	if (sourceIndex < 0) {
		return null;
	}

	switch (raw) {
		case "s":
			return { mode: "manage", switchAccountIndex: sourceIndex };
		case "r":
			return { mode: "manage", refreshAccountIndex: sourceIndex };
		case "e":
			return { mode: "manage", toggleAccountIndex: sourceIndex };
		case "d":
			return { mode: "manage", deleteAccountIndex: sourceIndex };
		default:
			return null;
	}
}

export interface PromptOpenTuiAuthDashboardOptions extends OpenTuiBootstrapOptions {
	dashboard: AuthDashboardViewModel;
}

export async function promptOpenTuiAuthDashboard(
	options: PromptOpenTuiAuthDashboardOptions,
): Promise<LoginMenuResult | null> {
	const support = resolveOpenTuiAuthShellBootstrap(options);
	if (!support.supported) {
		return null;
	}

	let settled = false;
	let searchQuery = "";
	let selection = EMPTY_SELECTION;
	let destroyRenderer: (() => void) | null = null;

	return await new Promise<LoginMenuResult | null>((resolve, reject) => {
		const finish = (result: LoginMenuResult | null) => {
			if (settled) return;
			settled = true;
			try {
				destroyRenderer?.();
			} catch {
				// best effort cleanup
			}
			resolve(result);
		};

		void startOpenTuiAuthShell({
			...options,
			onReady: (context) => {
				destroyRenderer = () => {
					if (!context.renderer.isDestroyed) {
						context.renderer.destroy();
					}
				};
				options.onReady?.(context);
			},
			onSelectionChange: (nextSelection) => {
				selection = nextSelection;
				options.onSelectionChange?.(nextSelection);
			},
			onWorkspaceAction: (action: OpenTuiWorkspaceAction) => {
				if (action.type === "search") {
					searchQuery = action.query;
				}
				if (action.type === "quick-switch") {
					finish({ mode: "manage", switchAccountIndex: action.sourceIndex });
					return;
				}
				options.onWorkspaceAction?.(action);
			},
			onExit: (reason, renderer) => {
				if (!destroyRenderer) {
					destroyRenderer = () => {
						if (!renderer.isDestroyed) {
							renderer.destroy();
						}
					};
				}
				options.onExit?.(reason, renderer);
				finish({ mode: "cancel" });
			},
			onKeyPress: (event) => {
				options.onKeyPress?.(event);
				const raw = (event.sequence ?? event.name ?? "").toLowerCase();

				if (isEnterKey(event) && selection.navLabel !== "Accounts") {
					const navAction = resolveNavActionResult(selection.navLabel);
					if (navAction) {
						finish(navAction);
						return;
					}
				}

				const selectedAccountResult = resolveSelectedAccountResult(
					options.dashboard,
					selection,
					searchQuery,
					raw,
				);
				if (selectedAccountResult) {
					finish(selectedAccountResult);
				}
			},
		})
			.then((renderResult) => {
				if (!settled && renderResult === null) {
					finish(null);
				}
			})
			.catch((error) => {
				if (settled) return;
				reject(error);
			});
	});
}
