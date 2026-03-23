import { createLogger, logRequest, LOGGING_ENABLED } from "../logger.js";
import { PLUGIN_NAME } from "../constants.js";
import { isRecord } from "../utils.js";

import type { SSEEventData } from "../types.js";

const log = createLogger("response-handler");

const MAX_SSE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 45_000;
const MAX_SYNTHESIZED_EVENT_INDEX = 255;

type MutableRecord = Record<string, unknown>;

interface ParsedResponseState {
	finalResponse: MutableRecord | null;
	lastPhase: string | null;
	outputItems: Map<number, MutableRecord>;
	outputText: Map<string, string>;
	outputTextPhases: Map<string, string>;
	phaseTextSegments: Map<string, string>;
	phaseSegmentOrder: Map<string, string[]>;
	phaseText: Map<string, string>;
	reasoningSummaryText: Map<string, string>;
	seenResponseIds: Set<string>;
	encounteredError: boolean;
}

function createParsedResponseState(): ParsedResponseState {
	return {
		finalResponse: null,
		lastPhase: null,
		outputItems: new Map<number, MutableRecord>(),
		outputText: new Map<string, string>(),
		outputTextPhases: new Map<string, string>(),
		phaseTextSegments: new Map<string, string>(),
		phaseSegmentOrder: new Map<string, string[]>(),
		phaseText: new Map<string, string>(),
		reasoningSummaryText: new Map<string, string>(),
		seenResponseIds: new Set<string>(),
		encounteredError: false,
	};
}

function toMutableRecord(value: unknown): MutableRecord | null {
	return isRecord(value) ? { ...value } : null;
}

function getNumberField(record: MutableRecord, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a trimmed, non-empty string field for identifier-like values.
 *
 * For textual payloads where whitespace is meaningful, use a field-specific
 * accessor such as `getDeltaField` instead of reusing this helper.
 */
function getStringField(record: MutableRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getDeltaField(record: MutableRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isValidSynthesizedIndex(index: number | null): index is number {
	return (
		index !== null &&
		Number.isInteger(index) &&
		index >= 0 &&
		index <= MAX_SYNTHESIZED_EVENT_INDEX
	);
}

function cloneContentArray(content: unknown): MutableRecord[] {
	if (!Array.isArray(content)) return [];
	return content.filter(isRecord).map((part) => ({ ...part }));
}

function mergeRecord(base: MutableRecord | null, update: MutableRecord): MutableRecord {
	if (!base) return { ...update };
	const merged: MutableRecord = { ...base, ...update };
	if ("content" in update || "content" in base) {
		const updateContent = cloneContentArray(update.content);
		merged.content =
			updateContent.length > 0 || !("content" in base)
				? updateContent
				: cloneContentArray(base.content);
	}
	return merged;
}

function makeOutputTextKey(outputIndex: number | null, contentIndex: number | null): string | null {
	if (
		!isValidSynthesizedIndex(outputIndex) ||
		!isValidSynthesizedIndex(contentIndex)
	) {
		return null;
	}
	return `${outputIndex}:${contentIndex}`;
}

function makePhaseTextSegmentKey(phase: string, outputTextKey: string): string {
	return `${phase}\u0000${outputTextKey}`;
}

function makeSummaryKey(outputIndex: number | null, summaryIndex: number | null): string | null {
	if (
		!isValidSynthesizedIndex(outputIndex) ||
		!isValidSynthesizedIndex(summaryIndex)
	) {
		return null;
	}
	return `${outputIndex}:${summaryIndex}`;
}

function getPartText(part: unknown): string | null {
	if (!isRecord(part)) return null;
	const text = getStringField(part, "text");
	if (text) return text;
	return null;
}

function capturePhase(
	state: ParsedResponseState,
	phase: unknown,
): void {
	if (typeof phase !== "string" || phase.trim().length === 0) return;
	state.lastPhase = phase.trim();
}

function rememberPhaseSegmentOrder(
	state: ParsedResponseState,
	phase: string,
	segmentKey: string,
): string[] {
	const existingOrder = state.phaseSegmentOrder.get(phase);
	if (existingOrder?.includes(segmentKey)) {
		return existingOrder;
	}
	const nextOrder = [...(existingOrder ?? []), segmentKey];
	state.phaseSegmentOrder.set(phase, nextOrder);
	return nextOrder;
}

function removePhaseSegmentOrder(
	state: ParsedResponseState,
	phase: string,
	segmentKey: string,
): void {
	const existingOrder = state.phaseSegmentOrder.get(phase);
	if (!existingOrder) return;
	const nextOrder = existingOrder.filter((key) => key !== segmentKey);
	if (nextOrder.length === 0) {
		state.phaseSegmentOrder.delete(phase);
		return;
	}
	state.phaseSegmentOrder.set(phase, nextOrder);
}

function rebuildPhaseText(state: ParsedResponseState, phase: string): void {
	const orderedKeys = state.phaseSegmentOrder.get(phase) ?? [];
	const text = orderedKeys
		.map((key) => state.phaseTextSegments.get(key) ?? "")
		.filter((value) => value.length > 0)
		.join("");
	if (text.length === 0) {
		state.phaseText.delete(phase);
		return;
	}
	state.phaseText.set(phase, text);
}

function setPhaseTextSegment(
	state: ParsedResponseState,
	phase: unknown,
	outputTextKey: string,
	text: string | null,
): void {
	const normalizedPhase =
		typeof phase === "string" && phase.trim().length > 0
			? phase.trim()
			: state.outputTextPhases.get(outputTextKey) ?? null;
	if (!normalizedPhase) return;
	state.outputTextPhases.set(outputTextKey, normalizedPhase);
	state.lastPhase = normalizedPhase;
	const segmentKey = makePhaseTextSegmentKey(normalizedPhase, outputTextKey);
	if (!text || text.length === 0) {
		state.phaseTextSegments.delete(segmentKey);
		removePhaseSegmentOrder(state, normalizedPhase, segmentKey);
		rebuildPhaseText(state, normalizedPhase);
		return;
	}
	rememberPhaseSegmentOrder(state, normalizedPhase, segmentKey);
	state.phaseTextSegments.set(segmentKey, text);
	rebuildPhaseText(state, normalizedPhase);
}

function appendPhaseTextSegment(
	state: ParsedResponseState,
	phase: unknown,
	outputTextKey: string,
	delta: string | null,
): void {
	if (!delta || delta.length === 0) {
		return;
	}
	const normalizedPhase =
		typeof phase === "string" && phase.trim().length > 0
			? phase.trim()
			: state.outputTextPhases.get(outputTextKey) ?? null;
	if (!normalizedPhase) return;
	state.outputTextPhases.set(outputTextKey, normalizedPhase);
	state.lastPhase = normalizedPhase;
	const segmentKey = makePhaseTextSegmentKey(normalizedPhase, outputTextKey);
	const phaseOrder = rememberPhaseSegmentOrder(state, normalizedPhase, segmentKey);
	const existing = state.phaseTextSegments.get(segmentKey) ?? "";
	state.phaseTextSegments.set(segmentKey, `${existing}${delta}`);
	if (phaseOrder[phaseOrder.length - 1] === segmentKey) {
		const existingPhaseText = state.phaseText.get(normalizedPhase) ?? "";
		state.phaseText.set(normalizedPhase, `${existingPhaseText}${delta}`);
		return;
	}
	rebuildPhaseText(state, normalizedPhase);
}

function upsertOutputItem(state: ParsedResponseState, outputIndex: number | null, item: unknown): void {
	if (!isValidSynthesizedIndex(outputIndex) || !isRecord(item)) return;
	const current = state.outputItems.get(outputIndex) ?? null;
	const merged = mergeRecord(current, item);
	state.outputItems.set(outputIndex, merged);
	capturePhase(state, merged.phase);
}

function setOutputTextValue(
	state: ParsedResponseState,
	outputIndex: number | null,
	contentIndex: number | null,
	text: string | null,
	phase: unknown = undefined,
): void {
	const key = makeOutputTextKey(outputIndex, contentIndex);
	if (!key) return;
	if (!text) {
		state.outputText.delete(key);
		setPhaseTextSegment(state, phase, key, null);
		return;
	}
	state.outputText.set(key, text);
	setPhaseTextSegment(state, phase, key, text);
}

function appendOutputTextValue(
	state: ParsedResponseState,
	outputIndex: number | null,
	contentIndex: number | null,
	delta: string | null,
	phase: unknown = undefined,
): void {
	if (!delta) return;
	const key = makeOutputTextKey(outputIndex, contentIndex);
	if (!key) return;
	const existing = state.outputText.get(key) ?? "";
	state.outputText.set(key, `${existing}${delta}`);
	appendPhaseTextSegment(state, phase, key, delta);
}

function setReasoningSummaryValue(
	state: ParsedResponseState,
	outputIndex: number | null,
	summaryIndex: number | null,
	text: string | null,
): void {
	const key = makeSummaryKey(outputIndex, summaryIndex);
	if (!key) return;
	if (!text) {
		state.reasoningSummaryText.delete(key);
		return;
	}
	state.reasoningSummaryText.set(key, text);
}

function appendReasoningSummaryValue(
	state: ParsedResponseState,
	outputIndex: number | null,
	summaryIndex: number | null,
	delta: string | null,
): void {
	if (!delta) return;
	const key = makeSummaryKey(outputIndex, summaryIndex);
	if (!key) return;
	const existing = state.reasoningSummaryText.get(key) ?? "";
	state.reasoningSummaryText.set(key, `${existing}${delta}`);
}

function ensureOutputItemAtIndex(output: unknown[], index: number): MutableRecord | null {
	if (!isValidSynthesizedIndex(index)) return null;
	while (output.length <= index) {
		output.push({});
	}
	const current = output[index];
	if (!isRecord(current)) {
		output[index] = {};
	}
	return isRecord(output[index]) ? (output[index] as MutableRecord) : null;
}

function ensureContentPartAtIndex(item: MutableRecord, index: number): MutableRecord | null {
	if (!isValidSynthesizedIndex(index)) return null;
	const content = Array.isArray(item.content) ? [...item.content] : [];
	while (content.length <= index) {
		content.push({});
	}
	const current = content[index];
	if (!isRecord(current)) {
		content[index] = {};
	}
	item.content = content;
	return isRecord(content[index]) ? (content[index] as MutableRecord) : null;
}

function applyAccumulatedOutputText(response: MutableRecord, state: ParsedResponseState): void {
	if (state.outputText.size === 0) return;
	const output = Array.isArray(response.output) ? [...response.output] : [];

	for (const [key, text] of state.outputText.entries()) {
		const [outputIndexText, contentIndexText] = key.split(":");
		const outputIndex = Number.parseInt(outputIndexText ?? "", 10);
		const contentIndex = Number.parseInt(contentIndexText ?? "", 10);
		if (
			!isValidSynthesizedIndex(outputIndex) ||
			!isValidSynthesizedIndex(contentIndex)
		) {
			continue;
		}
		const item = ensureOutputItemAtIndex(output, outputIndex);
		if (!item) continue;
		const part = ensureContentPartAtIndex(item, contentIndex);
		if (!part) continue;
		if (!getStringField(part, "type")) {
			part.type = "output_text";
		}
		if (typeof part.text === "string") {
			setPhaseTextSegment(state, part.phase, key, part.text);
			continue;
		}
		part.text = text;
	}

	if (output.length > 0) {
		response.output = output;
	}
}

function mergeOutputItemsIntoResponse(response: MutableRecord, state: ParsedResponseState): void {
	if (state.outputItems.size === 0) return;
	const output = Array.isArray(response.output) ? [...response.output] : [];

	for (const [outputIndex, item] of state.outputItems.entries()) {
		if (!isValidSynthesizedIndex(outputIndex)) continue;
		while (output.length <= outputIndex) {
			output.push({});
		}
		output[outputIndex] = mergeRecord(toMutableRecord(output[outputIndex]), item);
	}

	response.output = output;
}

function collectMessageOutputText(output: unknown[]): string {
	return output
		.filter(isRecord)
		.map((item) => {
			if (item.type !== "message") return "";
			const content = Array.isArray(item.content) ? item.content : [];
			return content
				.filter(isRecord)
				.map((part) => {
					if (part.type !== "output_text") return "";
					return typeof part.text === "string" ? part.text : "";
				})
				.join("");
		})
		.filter((text) => text.length > 0)
		.join("");
}

function collectReasoningSummaryText(output: unknown[]): string {
	return output
		.filter(isRecord)
		.map((item) => {
			if (item.type !== "reasoning") return "";
			const summary = Array.isArray(item.summary) ? item.summary : [];
			return summary
				.filter(isRecord)
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.filter((text) => text.length > 0)
				.join("\n\n");
		})
		.filter((text) => text.length > 0)
		.join("\n\n");
}

function applyReasoningSummaries(response: MutableRecord, state: ParsedResponseState): void {
	if (state.reasoningSummaryText.size === 0) return;
	const output = Array.isArray(response.output) ? [...response.output] : [];

	for (const [key, text] of state.reasoningSummaryText.entries()) {
		const [outputIndexText, summaryIndexText] = key.split(":");
		const outputIndex = Number.parseInt(outputIndexText ?? "", 10);
		const summaryIndex = Number.parseInt(summaryIndexText ?? "", 10);
		if (
			!isValidSynthesizedIndex(outputIndex) ||
			!isValidSynthesizedIndex(summaryIndex)
		) {
			continue;
		}
		const item = ensureOutputItemAtIndex(output, outputIndex);
		if (!item) continue;
		const summary = Array.isArray(item.summary) ? [...item.summary] : [];
		while (summary.length <= summaryIndex) {
			summary.push({});
		}
		const current = summary[summaryIndex];
		const nextPart = isRecord(current) ? { ...current } : {};
		if (!getStringField(nextPart, "type")) {
			nextPart.type = "summary_text";
		}
		if (typeof nextPart.text === "string") {
			continue;
		}
		nextPart.text = text;
		summary[summaryIndex] = nextPart;
		item.summary = summary;
		if (!getStringField(item, "type")) {
			item.type = "reasoning";
		}
	}

	if (output.length > 0) {
		response.output = output;
	}
}

function finalizeParsedResponse(state: ParsedResponseState): MutableRecord | null {
	const response = state.finalResponse ? { ...state.finalResponse } : null;
	if (!response) return null;
	if (state.encounteredError) return null;

	mergeOutputItemsIntoResponse(response, state);
	applyAccumulatedOutputText(response, state);
	applyReasoningSummaries(response, state);

	const output = Array.isArray(response.output) ? response.output : [];
	if (typeof response.output_text !== "string") {
		const outputText = collectMessageOutputText(output);
		if (outputText.length > 0) {
			response.output_text = outputText;
		}
	}

	const reasoningSummaryText = collectReasoningSummaryText(output);
	if (
		reasoningSummaryText.length > 0 &&
		typeof response.reasoning_summary_text !== "string"
	) {
		response.reasoning_summary_text = reasoningSummaryText;
	}

	if (state.lastPhase && typeof response.phase !== "string") {
		response.phase = state.lastPhase;
	}

	if (state.phaseText.size > 0) {
		const phaseText: MutableRecord = {};
		for (const [phase, text] of state.phaseText.entries()) {
			phaseText[phase] = text;
			if (phase === "commentary") response.commentary_text = text;
			if (phase === "final_answer") response.final_answer_text = text;
		}
		response.phase_text = phaseText;
	}

	return response;
}
function extractResponseId(response: unknown): string | null {
	if (!response || typeof response !== "object") return null;
	const candidate = (response as { id?: unknown }).id;
	return typeof candidate === "string" && candidate.trim().length > 0
		? candidate.trim()
		: null;
}

function notifyResponseId(
	state: ParsedResponseState,
	onResponseId: ((responseId: string) => void) | undefined,
	response: unknown,
): void {
	const responseId = extractResponseId(response);
	if (!responseId || !onResponseId || state.seenResponseIds.has(responseId)) return;
	state.seenResponseIds.add(responseId);
	try {
		onResponseId(responseId);
	} catch (error) {
		log.warn("Failed to persist response id from upstream event", {
			error: String(error),
			responseId,
		});
	}
}

function truncateDiagnosticText(value: unknown, maxLength = 400): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

function logStreamDiagnostics(finalResponse: unknown): void {
	if (!LOGGING_ENABLED || !isRecord(finalResponse)) {
		return;
	}

	const responseId = extractResponseId(finalResponse);
	const phase = getStringField(finalResponse, "phase");
	const commentaryText = truncateDiagnosticText(finalResponse.commentary_text);
	const finalAnswerText = truncateDiagnosticText(finalResponse.final_answer_text);
	const reasoningSummaryText = truncateDiagnosticText(finalResponse.reasoning_summary_text);
	if (phase || commentaryText || finalAnswerText || reasoningSummaryText) {
		logRequest("stream-diagnostics", {
			...(responseId ? { responseId } : {}),
			...(phase ? { phase } : {}),
			...(commentaryText ? { commentaryText } : {}),
			...(finalAnswerText ? { finalAnswerText } : {}),
			...(reasoningSummaryText ? { reasoningSummaryText } : {}),
		});
	}
}

function maybeCaptureResponseEvent(
	state: ParsedResponseState,
	data: SSEEventData,
	onResponseId?: (responseId: string) => void,
): void {
	if (data.type === "error") {
		log.error("SSE error event received", { error: data });
		state.encounteredError = true;
		return;
	}

	if (data.type === "response.done" || data.type === "response.completed") {
		if (isRecord(data.response)) {
			state.finalResponse = { ...data.response };
		}
		notifyResponseId(state, onResponseId, data.response);
		return;
	}

	const eventRecord = toMutableRecord(data);
	if (!eventRecord) return;
	const outputIndex = getNumberField(eventRecord, "output_index");

	if (data.type === "response.output_item.added" || data.type === "response.output_item.done") {
		upsertOutputItem(state, outputIndex, eventRecord.item);
		return;
	}

	if (data.type === "response.output_text.delta") {
		appendOutputTextValue(
			state,
			outputIndex,
			getNumberField(eventRecord, "content_index"),
			getDeltaField(eventRecord, "delta"),
			eventRecord.phase,
		);
		return;
	}

	if (data.type === "response.output_text.done") {
		setOutputTextValue(
			state,
			outputIndex,
			getNumberField(eventRecord, "content_index"),
			getStringField(eventRecord, "text"),
			eventRecord.phase,
		);
		return;
	}

	if (data.type === "response.content_part.added" || data.type === "response.content_part.done") {
		const part = toMutableRecord(eventRecord.part);
		if (!part || getStringField(part, "type") !== "output_text") {
			capturePhase(state, part?.phase);
			return;
		}
		setOutputTextValue(
			state,
			outputIndex,
			getNumberField(eventRecord, "content_index"),
			getPartText(part),
			part.phase,
		);
		return;
	}

	if (data.type === "response.reasoning_summary_text.delta") {
		appendReasoningSummaryValue(
			state,
			outputIndex,
			getNumberField(eventRecord, "summary_index"),
			getDeltaField(eventRecord, "delta"),
		);
		return;
	}

	if (data.type === "response.reasoning_summary_text.done") {
		setReasoningSummaryValue(
			state,
			outputIndex,
			getNumberField(eventRecord, "summary_index"),
			getStringField(eventRecord, "text"),
		);
		return;
	}

	if (
		data.type === "response.reasoning_summary_part.added" ||
		data.type === "response.reasoning_summary_part.done"
	) {
		setReasoningSummaryValue(
			state,
			outputIndex,
			getNumberField(eventRecord, "summary_index"),
			getPartText(eventRecord.part),
		);
		return;
	}

	capturePhase(state, eventRecord.phase);
}

/**

 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(
	sseText: string,
	onResponseId?: (responseId: string) => void,
): unknown | null {
	const lines = sseText.split(/\r?\n/);
	const state = createParsedResponseState();

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine.startsWith('data: ')) {
			const payload = trimmedLine.substring(6).trim();
			if (!payload || payload === '[DONE]') continue;
			try {
				const data = JSON.parse(payload) as SSEEventData;
				maybeCaptureResponseEvent(state, data, onResponseId);
				if (state.encounteredError) return null;
			} catch {
				// Skip malformed JSON
			}
		}
	}

	return finalizeParsedResponse(state);
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @returns Response with JSON body
 */
export async function convertSseToJson(
	response: Response,
	headers: Headers,
	options?: {
		onResponseId?: (responseId: string) => void;
		streamStallTimeoutMs?: number;
	},
): Promise<Response> {
	if (!response.body) {
		throw new Error(`[${PLUGIN_NAME}] Response has no body`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = '';
	const streamStallTimeoutMs = Math.max(
		1_000,
		Math.floor(options?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS),
	);

	try {
		// Consume the entire stream
		while (true) {
			const { done, value } = await readWithTimeout(reader, streamStallTimeoutMs);
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
			if (fullText.length > MAX_SSE_SIZE) {
				throw new Error(`SSE response exceeds ${MAX_SSE_SIZE} bytes limit`);
			}
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		// Parse SSE events to extract the final response
		const finalResponse = parseSseStream(fullText, options?.onResponseId);

		if (!finalResponse) {
			log.warn("Could not find final response in SSE stream");

			logRequest("stream-error", {
				error: "No terminal response event found in SSE stream",
			});

			// Return original stream if we can't parse
			return new Response(fullText, {
				status: response.status,
				statusText: response.statusText,
				headers: headers,
			});
		}

		logStreamDiagnostics(finalResponse);

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		log.error("Error converting stream", { error: String(error) });
		logRequest("stream-error", { error: String(error) });
		if (typeof reader.cancel === "function") {
			await reader.cancel(String(error)).catch(() => {});
		}
		throw error;
	} finally {
		// Release the reader lock to prevent resource leaks
		reader.releaseLock();
	}

}

function createResponseIdCapturingStream(
	body: ReadableStream<Uint8Array>,
	onResponseId: (responseId: string) => void,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let bufferedText = "";
	const state = createParsedResponseState();

	const processBufferedLines = (flush = false): void => {
		if (state.encounteredError) return;
		const lines = bufferedText.split(/\r?\n/);
		if (!flush) {
			bufferedText = lines.pop() ?? "";
		} else {
			bufferedText = "";
		}

		for (const rawLine of lines) {
			const trimmedLine = rawLine.trim();
			if (!trimmedLine.startsWith("data: ")) continue;
			const payload = trimmedLine.slice(6).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				const data = JSON.parse(payload) as SSEEventData;
				maybeCaptureResponseEvent(state, data, onResponseId);
				if (state.encounteredError) break;
			} catch {
				// Ignore malformed SSE lines and keep forwarding the raw stream.
			}
		}
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bufferedText += decoder.decode(chunk, { stream: true });
				processBufferedLines();
				controller.enqueue(chunk);
			},
			flush() {
				bufferedText += decoder.decode();
				processBufferedLines(true);
			},
		}),
	);
}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(
						new Error(
							`SSE stream stalled for ${timeoutMs}ms while waiting for a terminal response event`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Check if a non-streaming response is empty or malformed.
 * Returns true if the response body is empty, null, or lacks meaningful content.
 * @param body - Parsed JSON body from the response
 * @returns True if response should be considered empty/malformed
 */
export function isEmptyResponse(body: unknown): boolean {
	if (body === null || body === undefined) return true;
	if (typeof body === 'string' && body.trim() === '') return true;
	if (typeof body !== 'object') return false;

	const obj = body as Record<string, unknown>;

	if (Object.keys(obj).length === 0) return true;

	const hasOutput = 'output' in obj && obj.output !== null && obj.output !== undefined;
	const hasChoices = 'choices' in obj && Array.isArray(obj.choices) && 
		obj.choices.some(c => c !== null && c !== undefined && typeof c === 'object' && Object.keys(c as object).length > 0);
	const hasContent = 'content' in obj && obj.content !== null && obj.content !== undefined &&
		(typeof obj.content !== 'string' || obj.content.trim() !== '');

	if ('id' in obj || 'object' in obj || 'model' in obj) {
		return !hasOutput && !hasChoices && !hasContent;
	}

	return false;
}

export function attachResponseIdCapture(
	response: Response,
	headers: Headers,
	onResponseId?: (responseId: string) => void,
): Response {
	if (!response.body || !onResponseId) {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	return new Response(createResponseIdCapturingStream(response.body, onResponseId), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
