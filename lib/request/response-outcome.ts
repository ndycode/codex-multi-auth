import { isRecord } from "../utils.js";

export interface StreamCompletion {
	success: boolean;
	errorCode: string | null;
	missingTerminal: boolean;
}

/** Protocol completion, separate from socket delivery. Never retain output or error messages. */
export class ResponseOutcome {
	private terminal: "completed" | "failed" | "incomplete" | "cancelled" | undefined;
	rejection: { error: { code?: string; param?: string } } | undefined;

	constructor(private readonly requireTerminal: boolean) {}

	observe(value: unknown): void {
		if (!isRecord(value)) return;
		let type = value.type ?? (value.object === "response" && typeof value.status === "string" ? `response.${value.status}` : undefined);
		// SSE `response.done` carries its outcome in the nested status.
		if (type === "response.done") {
			const status = isRecord(value.response) ? value.response.status : undefined;
			type = typeof status === "string" ? `response.${status}` : "response.completed";
		}
		if (type === "response.completed") {
			if (!this.terminal) this.terminal = "completed";
			return;
		}
		const failure = type === "response.failed" || type === "error";
		if (!failure && type !== "response.incomplete" && type !== "response.cancelled") return;
		this.terminal = failure ? "failed" : type === "response.incomplete" ? "incomplete" : "cancelled";
		const response = isRecord(value.response) ? value.response : value;
		const error = isRecord(response.error) ? response.error : type === "error" ? value : undefined;
		if (error) {
			const safe = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(v) ? v : undefined;
			this.rejection = { error: { code: safe(error.code), param: safe(error.param) } };
		}
	}

	/**
	 * `response.incomplete` (e.g. max_output_tokens) is a delivered response, not an
	 * account failure: it counts as success for health and affinity, and its terminal
	 * type survives only as the usage annotation in `errorCode`.
	 */
	finish(): StreamCompletion {
		const missingTerminal = this.requireTerminal && !this.terminal;
		const success = !missingTerminal && (!this.terminal || this.terminal === "completed" || this.terminal === "incomplete");
		return {
			success,
			missingTerminal,
			errorCode: missingTerminal ? "upstream_missing_terminal" : this.terminal && this.terminal !== "completed" ? `upstream_response_${this.terminal}` : null,
		};
	}
}
