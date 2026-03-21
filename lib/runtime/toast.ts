export async function showRuntimeToast(
	client: {
		tui?: {
			showToast?: (payload: {
				body: {
					message: string;
					variant: "info" | "success" | "warning" | "error";
					title?: string;
					duration?: number;
				};
			}) => Promise<void>;
		};
	},
	message: string,
	variant: "info" | "success" | "warning" | "error" = "success",
	options?: { title?: string; duration?: number },
): Promise<void> {
	try {
		await client.tui?.showToast?.({
			body: {
				message,
				variant,
				...(options?.title && { title: options.title }),
				...(options?.duration && { duration: options.duration }),
			},
		});
	} catch {
		// Ignore when TUI is not available.
	}
}
