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
		await expect(showRuntimeToast({ tui: {} }, "Saved")).resolves.toBeUndefined();
	});

	it("swallows TUI toast errors", async () => {
		const showToast = vi.fn(async () => {
			throw new Error("tui offline");
		});
		await expect(showRuntimeToast({ tui: { showToast } }, "Saved", "error")).resolves.toBeUndefined();
		expect(showToast).toHaveBeenCalledTimes(1);
	});

	it("omits title and duration when they are not provided", async () => {
		const showToast = vi.fn().mockResolvedValue(undefined);

		await showRuntimeToast({ tui: { showToast } }, "hello");

		expect(showToast).toHaveBeenCalledWith({
			body: {
				message: "hello",
				variant: "success",
			},
		});
	});
});
