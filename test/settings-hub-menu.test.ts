import { describe, expect, it } from "vitest";
import {
	buildSettingsHubItems,
	findSettingsHubInitialCursor,
} from "../lib/codex-manager/settings-hub-menu.js";

const copy = {
	sectionTitle: "Sections",
	accountList: "Account list",
	summaryFields: "Summary fields",
	behavior: "Behavior",
	theme: "Theme",
	advancedTitle: "Advanced",
	experimental: "Experimental",
	backend: "Backend",
	exitTitle: "Exit",
	back: "Back",
};

describe("settings hub menu helpers", () => {
	it("builds the expected menu skeleton", () => {
		const items = buildSettingsHubItems(copy);
		expect(items.map((item) => item.label)).toContain("Account list");
		expect(items.map((item) => item.label)).toContain("Experimental");
		expect(items.at(-1)?.label).toBe("Back");
	});

	it("finds the initial cursor for selectable actions", () => {
		const items = buildSettingsHubItems(copy);
		expect(findSettingsHubInitialCursor(items, "account-list")).toBe(1);
		expect(findSettingsHubInitialCursor(items, "backend")).toBe(8);
	});
});
