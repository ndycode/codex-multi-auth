import { describe, expect, it } from "vitest";
import {
	formatAutoReturnDelayLabel,
	reorderStatuslineField,
} from "../lib/codex-manager/settings-panels.js";

describe("settings panel helpers", () => {
	it("reorders statusline fields safely", () => {
		expect(
			reorderStatuslineField(["last-used", "limits", "status"], "limits", -1),
		).toEqual(["limits", "last-used", "status"]);
		expect(reorderStatuslineField(["last-used"], "last-used", -1)).toEqual([
			"last-used",
		]);
	});

	it("formats auto return delay labels", () => {
		expect(formatAutoReturnDelayLabel(0)).toBe("Instant return");
		expect(formatAutoReturnDelayLabel(4000)).toBe("4s auto-return");
	});
});
