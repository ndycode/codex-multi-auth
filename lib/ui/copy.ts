export const UI_COPY = {
	mainMenu: {
		title: "Accounts Dashboard",
		searchSubtitlePrefix: "Search:",
		quickStart: "Quick Actions",
		addAccount: "Add New Account",
		checkAccounts: "Run Health Check",
		bestAccount: "Pick Best Account",
		fixIssues: "Auto-Repair Issues",
		settings: "Settings",
		moreChecks: "Advanced Checks",
		healthSummary: "Health Summary",
		refreshChecks: "Refresh All Accounts",
		checkFlagged: "Check Problem Accounts",
		accounts: "Saved Accounts",
		loadingLimits: "Fetching account limits...",
		noSearchMatches: "No accounts match your search",
		recovery: "Recovery",
		restoreBackup: "Restore From Backup",
		dangerZone: "Danger Zone",
		removeAllAccounts: "Delete Saved Accounts",
		resetLocalState: "Reset Local State",
		helpCompact: "↑↓ Move | Enter Select | / Search | 1-9 Switch | Q Back",
		helpDetailed:
			"Arrow keys move, Enter selects, / searches, 1-9 switches account, Q goes back",
	},
	accountDetails: {
		back: "Back",
		enable: "Enable Account",
		disable: "Disable Account",
		setCurrent: "Set As Current",
		refresh: "Re-Login",
		remove: "Delete Account",
		help: "↑↓ Move | Enter Select | S Use | R Sign In | D Delete | Q Back",
	},
	oauth: {
		chooseModeTitle: "Sign-In Method",
		chooseModeSubtitle: "How do you want to sign in?",
		openBrowser: "Open Browser (Easy)",
		manualMode: "Manual / Incognito",
		back: "Back",
		chooseModeHelp: "↑↓ Move | Enter Select | 1 Easy | 2 Manual | Q Back",
		goTo: "Go to:",
		copyOk: "Login link copied.",
		copyFail: "Could not copy login link.",
		pastePrompt: "Paste callback URL or code here (Q to cancel):",
		browserOpened: "Browser opened.",
		browserOpenFail: "Could not open browser. Use this link:",
		waitingCallback: "Waiting for login callback on localhost:1455...",
		callbackMissed: "No callback received. Paste manually.",
		cancelled: "Sign-in cancelled.",
		cancelledBackToMenu: "Sign-in cancelled. Going back to menu.",
	},
	returnFlow: {
		continuePrompt: "Press Enter to go back.",
		actionFailedPrompt: "Action failed. Press Enter to go back.",
		autoReturn: (seconds: number) =>
			`Returning in ${seconds}s... Press any key to pause.`,
		paused: "Paused. Press any key to continue.",
		working: "Running...",
		done: "Done.",
		failed: "Failed.",
	},
	settings: {
		title: "Settings",
		subtitle:
			"Start with everyday dashboard settings. Advanced operator controls stay separate.",
		help: "↑↓ Move | Enter Select | Q Back",
		sectionTitle: "Everyday Settings",
		advancedTitle: "Advanced & Operator",
		exitTitle: "Back",
		accountList: "List Appearance",
		accountListHint:
			"Show badges, sorting, and how much detail each account row shows.",
		syncCenter: "Codex CLI Sync",
		syncCenterHint:
			"Preview and apply one-way sync from Codex CLI account files.",
		summaryFields: "Details Line",
		summaryFieldsHint: "Choose which details appear under each account row.",
		behavior: "Results & Refresh",
		behaviorHint:
			"Control auto-return timing and background limit refresh behavior.",
		theme: "Colors",
		themeHint: "Pick the base palette and accent color.",
		backend: "Advanced Backend Controls",
		backendHint: "Tune retry, quota, sync, recovery, and timeout internals.",
		back: "Back",
		previewHeading: "Live Preview",
		displayHeading: "Options",
		resetDefault: "Reset to Default",
		saveAndBack: "Save and Back",
		backNoSave: "Back Without Saving",
		accountListTitle: "List Appearance",
		accountListSubtitle: "Choose badges, sorting, and row layout",
		accountListHelp:
			"Enter Toggle | Number Toggle | M Sort | L Layout | S Save | Q Back (No Save)",
		summaryTitle: "Details Line",
		summarySubtitle: "Choose and order the details shown under each account",
		summaryHelp:
			"Enter Toggle | 1-3 Toggle | [ ] Reorder | S Save | Q Back (No Save)",
		behaviorTitle: "Results & Refresh",
		behaviorSubtitle: "Control auto-return and limit refresh behavior",
		behaviorHelp:
			"Enter Select | 1-3 Delay | P Pause | L AutoFetch | F Status | T TTL | S Save | Q Back (No Save)",
		themeTitle: "Colors",
		themeSubtitle: "Pick the base palette and accent color",
		themeHelp: "Enter Select | 1-2 Base | S Save | Q Back (No Save)",
		backendTitle: "Advanced Backend Controls",
		backendSubtitle:
			"Expert settings for sync, retry, quota, and timeout behavior",
		backendHelp:
			"Enter Open | 1-4 Category | S Save | R Reset | Q Back (No Save)",
		syncCenterTitle: "Codex CLI Sync",
		syncCenterSubtitle:
			"Inspect source files and preview one-way sync before applying it",
		syncCenterHelp: "Enter Select | A Apply | L Rollback | R Refresh | Q Back",
		syncCenterOverviewHeading: "Sync Overview",
		syncCenterActionsHeading: "Actions",
		syncCenterRefresh: "Refresh Preview",
		syncCenterApply: "Apply Preview To Target",
		syncCenterRollback: "Rollback Last Apply",
		syncCenterBack: "Back",
		backendCategoriesHeading: "Categories",
		backendCategoryTitle: "Backend Category",
		backendCategoryHelp:
			"Enter Toggle/Adjust | +/- or [ ] Number | 1-9 Toggle | R Reset | Q Back",
		backendToggleHeading: "Switches",
		backendNumberHeading: "Numbers",
		backendDecrease: "Decrease Focused Value",
		backendIncrease: "Increase Focused Value",
		backendResetCategory: "Reset Category",
		backendBackToCategories: "Back to Categories",
		baseTheme: "Base Color",
		accentColor: "Accent Color",
		actionTiming: "Auto Return Delay",
		moveUp: "Move Focused Field Up",
		moveDown: "Move Focused Field Down",
	},
	fallback: {
		addAnotherTip:
			"Tip: Use private mode or sign out before adding another account.",
		addAnotherQuestion: (count: number) =>
			`Add another account? (${count} added) (y/n): `,
		selectModePrompt:
			"(a) add, (c) check, (b) best, fi(x), (s) settings, (d) deep, (g) problem, (f) fresh, (r) reset, (q) back [a/c/b/x/s/d/g/f/r/q]: ",
		invalidModePrompt: "Use one of: a, c, b, x, s, d, g, f, r, q.",
	},
} as const;

/**
 * Builds the "Check Problem Accounts" label, appending the flagged count when greater than zero.
 *
 * This function is pure and has no side effects, is safe for concurrent use, performs no filesystem
 * access (including Windows-specific behavior), and does not perform any token redaction.
 *
 * @param flaggedCount - The number of flagged accounts to show; if greater than zero the count is appended in parentheses.
 * @returns The resulting label string: the base label when `flaggedCount` is 0 or less, otherwise the base label followed by ` (count)`.
 */
export function formatCheckFlaggedLabel(flaggedCount: number): string {
	return flaggedCount > 0
		? `${UI_COPY.mainMenu.checkFlagged} (${flaggedCount})`
		: UI_COPY.mainMenu.checkFlagged;
}
