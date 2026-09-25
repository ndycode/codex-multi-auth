import { createUsageStreamScanner } from "../usage/usage-extraction.js";
import { isRecord } from "../utils.js";
import type { CodexQuotaSnapshot } from "../quota-probe.js";

/** Only personal included subscriptions may receive an automatic first-use probe. */
export function needsSubscriptionFirstUse(snapshot: Omit<CodexQuotaSnapshot, "model">, now: number): boolean {
	if (snapshot.status !== 200 || !["plus", "pro", "prolite"].includes(snapshot.planType?.toLowerCase() ?? "")) return false;
	const allWindows = [snapshot.primary, snapshot.secondary];
	if (allWindows.some(window => typeof window.usedPercent === "number" && window.usedPercent !== 0)) return false;
	const windows = allWindows.filter(window => window.windowMinutes !== 0);
	if (!windows.length || windows.some(window => window.usedPercent !== 0)) return false;
	// A full relative window can be a placeholder on an unused account. A
	// countdown already shorter than its duration needs no extra consumption.
	return windows.every(window => window.resetAtMs === undefined ||
		(typeof window.windowMinutes === "number" && window.windowMinutes > 0 &&
		 window.resetAtMs - now >= window.windowMinutes * 60_000 - 2_000));
}

export class FirstUseProbeError extends Error {
	constructor(readonly reason: "timed out" | "stream ended early" | "upstream failed" | "response too large" | "network error" = "stream ended early") {
		super(`First-use probe did not complete (${reason}); reset timer is unconfirmed.`);
	}
}

/** Consume the already-open tiny response, never start a second request. */
export async function finishSubscriptionFirstUse(response: Response, timeoutMs: number): Promise<void> {
	if (!response.body) throw new FirstUseProbeError();
	const reader = response.body.getReader();
	let completed = false, failed = false, bytes = 0;
	const scanner = createUsageStreamScanner({ contentType: "text/event-stream", onEvent(event) {
		if (!isRecord(event)) return;
		if (event.type === "response.completed" || (event.type === "response.done" && isRecord(event.response) && event.response.status === "completed")) completed = true;
		if (["response.failed", "response.incomplete", "error"].includes(String(event.type))) failed = true;
	} });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FirstUseProbeError("timed out")), timeoutMs); });
	try {
		while (!completed && !failed) {
			const chunk = await Promise.race([reader.read(), expired]);
			if (chunk.done) { scanner.result(); break; }
			bytes += chunk.value.byteLength;
			if (bytes > 1024 * 1024) throw new FirstUseProbeError("response too large");
			scanner.push(chunk.value);
		}
		if (!completed || failed) throw new FirstUseProbeError(failed ? "upstream failed" : "stream ended early");
	} catch (error) { throw error instanceof FirstUseProbeError ? error : new FirstUseProbeError("network error"); }
	finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => undefined);
	}
}
