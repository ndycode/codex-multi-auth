import { logDebug, logWarn } from "../logger.js";
import type { InputItem, RequestBody } from "../types.js";
import { isRecord } from "../utils.js";
import { getModelCapabilities } from "./helpers/model-map.js";
import { trimInputForFastSession } from "./request-transformer.js";

export interface DeferredFastSessionInputTrim {
	maxItems: number;
	preferLatestUserOnly: boolean;
}

export interface ResponseCompactionResult {
	body: RequestBody;
	mode: "compacted" | "trimmed" | "unchanged";
}

export interface ApplyResponseCompactionParams {
	body: RequestBody;
	requestUrl: string;
	headers: Headers;
	trim: DeferredFastSessionInputTrim;
	fetchImpl: typeof fetch;
	signal?: AbortSignal | null;
	timeoutMs?: number;
}

function isInputItemArray(value: unknown): value is InputItem[] {
	return Array.isArray(value) && value.every((item) => isRecord(item));
}

function extractCompactedInput(payload: unknown): InputItem[] | undefined {
	if (!isRecord(payload)) return undefined;
	if (isInputItemArray(payload.output)) return payload.output;
	if (isInputItemArray(payload.input)) return payload.input;

	const response = payload.response;
	if (!isRecord(response)) return undefined;
	if (isInputItemArray(response.output)) return response.output;
	if (isInputItemArray(response.input)) return response.input;
	return undefined;
}

function buildCompactionUrl(requestUrl: string): string {
	return requestUrl.endsWith("/compact") ? requestUrl : `${requestUrl}/compact`;
}

function createFallbackBody(
	body: RequestBody,
	trim: DeferredFastSessionInputTrim,
): RequestBody | undefined {
	if (!Array.isArray(body.input)) return undefined;
	const trimmedInput =
		trimInputForFastSession(body.input, trim.maxItems, {
			preferLatestUserOnly: trim.preferLatestUserOnly,
		}) ?? body.input;

	return trimmedInput === body.input ? undefined : { ...body, input: trimmedInput };
}

function createTimedAbortSignal(
	signal: AbortSignal | null | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error("Response compaction timeout"));
	}, timeoutMs);

	const onAbort = () => {
		controller.abort(signal?.reason ?? new Error("Aborted"));
	};

	if (signal?.aborted) {
		onAbort();
	} else if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

export async function applyResponseCompaction(
	params: ApplyResponseCompactionParams,
): Promise<ResponseCompactionResult> {
	const fallbackBody = createFallbackBody(params.body, params.trim);
	if (!fallbackBody) {
		return { body: params.body, mode: "unchanged" };
	}

	if (!getModelCapabilities(params.body.model).compaction) {
		return { body: fallbackBody, mode: "trimmed" };
	}

	const compactionHeaders = new Headers(params.headers);
	compactionHeaders.set("accept", "application/json");
	compactionHeaders.set("content-type", "application/json");
	const { signal, cleanup } = createTimedAbortSignal(
		params.signal,
		Math.max(250, params.timeoutMs ?? 4_000),
	);

	try {
		const response = await params.fetchImpl(buildCompactionUrl(params.requestUrl), {
			method: "POST",
			headers: compactionHeaders,
			body: JSON.stringify({
				model: params.body.model,
				input: params.body.input,
			}),
			signal,
		});

		if (!response.ok) {
			logWarn("Responses compaction request failed; using trim fallback.", {
				status: response.status,
				statusText: response.statusText,
				model: params.body.model,
			});
			return { body: fallbackBody, mode: "trimmed" };
		}

		const payload = (await response.json()) as unknown;
		const compactedInput = extractCompactedInput(payload);
		if (!compactedInput || compactedInput.length === 0) {
			logWarn("Responses compaction returned no reusable input; using trim fallback.", {
				model: params.body.model,
			});
			return { body: fallbackBody, mode: "trimmed" };
		}

		logDebug("Applied server-side response compaction.", {
			model: params.body.model,
			originalInputLength: Array.isArray(params.body.input) ? params.body.input.length : 0,
			compactedInputLength: compactedInput.length,
		});
		return { body: { ...params.body, input: compactedInput }, mode: "compacted" };
	} catch (error) {
		if (signal.aborted && params.signal?.aborted) {
			throw params.signal.reason instanceof Error
				? params.signal.reason
				: new Error("Aborted");
		}

		logWarn("Responses compaction failed; using trim fallback.", {
			model: params.body.model,
			error: error instanceof Error ? error.message : String(error),
		});
		return { body: fallbackBody, mode: "trimmed" };
	} finally {
		cleanup();
	}
}
