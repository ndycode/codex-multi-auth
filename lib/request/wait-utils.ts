export function createAbortableSleep(
	abortSignal?: AbortSignal | null,
): (ms: number) => Promise<void> {
	return (ms: number): Promise<void> =>
		new Promise((resolve, reject) => {
			if (abortSignal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			const timeout = setTimeout(() => {
				cleanup();
				resolve();
			}, ms);

			const onAbort = () => {
				cleanup();
				reject(new Error("Aborted"));
			};

			const cleanup = () => {
				clearTimeout(timeout);
				abortSignal?.removeEventListener("abort", onAbort);
			};

			abortSignal?.addEventListener("abort", onAbort, { once: true });
		});
}

export async function sleepWithCountdown(params: {
	totalMs: number;
	message: string;
	sleep: (ms: number) => Promise<void>;
	showToast: (
		message: string,
		variant: "warning",
		options: { duration: number },
	) => Promise<void>;
	formatWaitTime: (ms: number) => string;
	toastDurationMs: number;
	abortSignal?: AbortSignal | null;
	intervalMs?: number;
}): Promise<void> {
	const startTime = Date.now();
	const endTime = startTime + params.totalMs;
	const intervalMs = params.intervalMs ?? 5000;

	while (Date.now() < endTime) {
		if (params.abortSignal?.aborted) {
			throw new Error("Aborted");
		}

		const remaining = Math.max(0, endTime - Date.now());
		const waitLabel = params.formatWaitTime(remaining);
		await params.showToast(
			`${params.message} (${waitLabel} remaining)`,
			"warning",
			{
				duration: Math.min(intervalMs + 1000, params.toastDurationMs),
			},
		);

		const sleepTime = Math.min(intervalMs, remaining);
		if (sleepTime > 0) {
			await params.sleep(sleepTime);
		} else {
			break;
		}
	}
}
