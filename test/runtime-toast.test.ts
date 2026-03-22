import { describe, expect, it, vi } from "vitest";

import { showRuntimeToast } from "../lib/runtime/toast.js";

describe("showRuntimeToast", () => {
	it("passes through an explicit zero duration", async () => {
		const showToast = vi.fn().mockResolvedValue(undefined);

		await showRuntimeToast(
			{ tui: { showToast } },
			"hello",
			"info",
			{ duration: 0 },
		);

		expect(showToast).toHaveBeenCalledWith({
			body: {
				message: "hello",
				variant: "info",
				duration: 0,
			},
		});
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

	it("swallows TUI errors", async () => {
		const showToast = vi.fn().mockRejectedValue(new Error("toast failed"));

		await expect(
			showRuntimeToast({ tui: { showToast } }, "hello", "warning", {
				title: "Heads up",
				duration: 2500,
			}),
		).resolves.toBeUndefined();
	});
});
