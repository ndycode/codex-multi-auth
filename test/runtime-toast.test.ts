import { describe, expect, it, vi } from "vitest";
import { showRuntimeToast } from "../lib/runtime/toast.js";

describe("showRuntimeToast", () => {
	it("preserves variant, title, and zero duration in the TUI toast payload", async () => {
		const showToast = vi.fn(async () => {});
		await showRuntimeToast(
			{ tui: { showToast } },
			"Saved",
			"info",
			{ title: "Heads up", duration: 0 },
		);
		expect(showToast).toHaveBeenCalledWith({
			body: { message: "Saved", variant: "info", title: "Heads up", duration: 0 },
		});
	});

	it("silently ignores missing TUI clients", async () => {
		await expect(showRuntimeToast({}, "Saved")).resolves.toBeUndefined();
	});
});
