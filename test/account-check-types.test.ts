import { describe, expect, it } from "vitest";

import { createAccountCheckWorkingState } from "../lib/runtime/account-check-types.js";

describe("createAccountCheckWorkingState", () => {
	it("initializes empty counters, flags, and removal set", () => {
		const flaggedStorage = { version: 1 as const, accounts: [] };

		const state = createAccountCheckWorkingState(flaggedStorage);

		expect(state.storageChanged).toBe(false);
		expect(state.flaggedChanged).toBe(false);
		expect(state.ok).toBe(0);
		expect(state.errors).toBe(0);
		expect(state.disabled).toBe(0);
		expect(state.removeFromActive.size).toBe(0);
		expect(state.flaggedStorage).toBe(flaggedStorage);
	});
});
