import { describe, it, expect, vi } from 'vitest';
import {
	attachResponseIdCapture,
	ensureContentType,
	convertSseToJson,
	isEmptyResponse,
} from '../lib/request/response-handler.js';

describe('Response Handler Module', () => {
	describe('ensureContentType', () => {
		it('should preserve existing content-type', () => {
			const headers = new Headers();
			headers.set('content-type', 'application/json');
			const result = ensureContentType(headers);
			expect(result.get('content-type')).toBe('application/json');
		});

		it('should add default content-type if missing', () => {
			const headers = new Headers();
			const result = ensureContentType(headers);
			expect(result.get('content-type')).toBe('text/event-stream; charset=utf-8');
		});

		it('should not modify original headers', () => {
			const headers = new Headers();
			const result = ensureContentType(headers);
			expect(headers.has('content-type')).toBe(false);
			expect(result.has('content-type')).toBe(true);
		});
	});

	describe('convertSseToJson', () => {
		it('should throw error if response has no body', async () => {
			const response = new Response(null);
			const headers = new Headers();

			await expect(convertSseToJson(response, headers)).rejects.toThrow(
				'Response has no body'
			);
		});

		it('should parse SSE stream with response.done event', async () => {
			const sseContent = `data: {"type":"response.started"}
data: {"type":"response.done","response":{"id":"resp_123","output":"test"}}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_123', output: 'test' });
			expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
		});

		it('should parse SSE stream with response.completed event', async () => {
			const sseContent = `data: {"type":"response.started"}
data: {"type":"response.completed","response":{"id":"resp_456","output":"done"}}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_456', output: 'done' });
		});

		it('synthesizes output_text and reasoning summaries from semantic SSE events', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_semantic_123","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"final_answer"}}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello ","phase":"final_answer"}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"world","phase":"final_answer"}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello world","phase":"final_answer"}',
				'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_123","type":"reasoning"}}',
				'data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Need more context."}',
				'data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":"Need more context."}',
				'data: {"type":"response.completed","response":{"id":"resp_semantic_123","object":"response"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				id: string;
				output?: Array<{
					type?: string;
					role?: string;
					phase?: string;
					content?: Array<{ type?: string; text?: string }>;
					summary?: Array<{ type?: string; text?: string }>;
				}>;
				output_text?: string;
				reasoning_summary_text?: string;
				phase?: string;
				final_answer_text?: string;
				phase_text?: Record<string, string>;
			};

			expect(body.id).toBe('resp_semantic_123');
			expect(body.output_text).toBe('Hello world');
			expect(body.reasoning_summary_text).toBe('Need more context.');
			expect(body.phase).toBe('final_answer');
			expect(body.final_answer_text).toBe('Hello world');
			expect(body.phase_text).toEqual({ final_answer: 'Hello world' });
			expect(body.output?.[0]?.content?.[0]).toEqual({
				type: 'output_text',
				text: 'Hello world',
			});
			expect(body.output?.[1]?.summary?.[0]).toEqual({
				type: 'summary_text',
				text: 'Need more context.',
			});
		});

		it('preserves canonical terminal reasoning_summary_text over synthesized semantic text', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_semantic_canonical","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_456","type":"reasoning"}}',
				'data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Draft summary"}',
				'data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":"Draft summary"}',
				'data: {"type":"response.completed","response":{"id":"resp_semantic_canonical","object":"response","reasoning_summary_text":"Canonical summary"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				reasoning_summary_text?: string;
				output?: Array<{ summary?: Array<{ text?: string }> }>;
			};

			expect(body.reasoning_summary_text).toBe('Canonical summary');
			expect(body.output?.[1]?.summary?.[0]?.text).toBe('Draft summary');
		});

		it('preserves whitespace-only semantic deltas when no done events override them', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_whitespace_delta","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_space","type":"message","role":"assistant","phase":"final_answer"}}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello","phase":"final_answer"}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" ","phase":"final_answer"}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"world","phase":"final_answer"}',
				'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_space","type":"reasoning"}}',
				'data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Need"}',
				'data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":" "}',
				'data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"context."}',
				'data: {"type":"response.done","response":{"id":"resp_whitespace_delta","object":"response"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				output_text?: string;
				final_answer_text?: string;
				reasoning_summary_text?: string;
				output?: Array<{
					content?: Array<{ text?: string }>;
					summary?: Array<{ text?: string }>;
				}>;
			};

			expect(body.output?.[0]?.content?.[0]?.text).toBe('Hello world');
			expect(body.output_text).toBe('Hello world');
			expect(body.final_answer_text).toBe('Hello world');
			expect(body.output?.[1]?.summary?.[0]?.text).toBe('Need context.');
			expect(body.reasoning_summary_text).toBe('Need context.');
		});

		it('preserves richer terminal output when semantic items arrive with empty content arrays', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_rich_123","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","content":[]}}',
				'data: {"type":"response.completed","response":{"id":"resp_rich_123","object":"response","output":[{"id":"msg_123","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello rich world"},{"type":"annotation","label":"kept"}]}]}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				id: string;
				output?: Array<{
					content?: Array<{ type?: string; text?: string; label?: string }>;
				}>;
			};

			expect(body.id).toBe('resp_rich_123');
			expect(body.output?.[0]?.content).toEqual([
				{ type: 'output_text', text: 'Hello rich world' },
				{ type: 'annotation', label: 'kept' },
			]);
		});

		it('tracks commentary and final_answer phase text separately when phase labels are present', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_phase_123","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"commentary"}}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Thinking...","phase":"commentary"}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Thinking...","phase":"commentary"}',
				'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"final_answer"}}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":1,"text":"Done.","phase":"final_answer"}',
				'data: {"type":"response.done","response":{"id":"resp_phase_123","object":"response"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				phase?: string;
				commentary_text?: string;
				final_answer_text?: string;
				phase_text?: Record<string, string>;
				output_text?: string;
			};

			expect(body.phase).toBe('final_answer');
			expect(body.commentary_text).toBe('Thinking...');
			expect(body.final_answer_text).toBe('Done.');
			expect(body.phase_text).toEqual({
				commentary: 'Thinking...',
				final_answer: 'Done.',
			});
			expect(body.output_text).toBe('Thinking...Done.');
		});

		it('replaces phase text when output_text.done corrects earlier deltas', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_phase_fix","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_fix","type":"message","role":"assistant","phase":"final_answer"}}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hellp","phase":"final_answer"}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello","phase":"final_answer"}',
				'data: {"type":"response.done","response":{"id":"resp_phase_fix","object":"response"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				output_text?: string;
				final_answer_text?: string;
				phase_text?: Record<string, string>;
				output?: Array<{ content?: Array<{ text?: string }> }>;
			};

			expect(body.output?.[0]?.content?.[0]?.text).toBe('Hello');
			expect(body.output_text).toBe('Hello');
			expect(body.final_answer_text).toBe('Hello');
			expect(body.phase_text).toEqual({ final_answer: 'Hello' });
		});

		it('replaces phase text when output_text.done omits phase after earlier deltas set it', async () => {
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_phase_fix_missing","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_fix_missing","type":"message","role":"assistant","phase":"final_answer"}}',
				'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hellp","phase":"final_answer"}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello"}',
				'data: {"type":"response.done","response":{"id":"resp_phase_fix_missing","object":"response"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json() as {
				output_text?: string;
				final_answer_text?: string;
				phase_text?: Record<string, string>;
				output?: Array<{ content?: Array<{ text?: string }> }>;
			};

			expect(body.output?.[0]?.content?.[0]?.text).toBe('Hello');
			expect(body.output_text).toBe('Hello');
			expect(body.final_answer_text).toBe('Hello');
			expect(body.phase_text).toEqual({ final_answer: 'Hello' });
		});

		it('should return original text if no final response found', async () => {
			const sseContent = `data: {"type":"response.started"}
data: {"type":"chunk","delta":"text"}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const text = await result.text();

			expect(text).toBe(sseContent);
		});

		it('should skip malformed JSON in SSE stream', async () => {
			const sseContent = `data: not-json
data: {"type":"response.done","response":{"id":"resp_789"}}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_789' });
		});

		it('should handle empty SSE stream', async () => {
			const response = new Response('');
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const text = await result.text();

			expect(text).toBe('');
		});

		it('should preserve response status and statusText', async () => {
			const sseContent = `data: {"type":"response.done","response":{"id":"x"}}`;
			const response = new Response(sseContent, {
				status: 200,
				statusText: 'OK',
			});
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);

			expect(result.status).toBe(200);
			expect(result.statusText).toBe('OK');
		});

		it('should report the final response id while converting SSE to JSON', async () => {
			const onResponseId = vi.fn();
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_123","object":"response"}}',
				'data: {"type":"response.done","response":{"id":"resp_123","output":"test"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers, { onResponseId });
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_123', output: 'test' });
			expect(onResponseId).toHaveBeenCalledWith('resp_123');
			expect(onResponseId).toHaveBeenCalledTimes(1);
		});

		it('should return the raw SSE text when an error event arrives before response.done', async () => {
			const onResponseId = vi.fn();
			const sseContent = [
				'data: {"type":"response.created","response":{"id":"resp_bad_123","object":"response"}}',
				'',
				'data: {"type":"error","message":"quota exceeded"}',
				'',
				'data: {"type":"response.done","response":{"id":"resp_bad_123","output":"bad"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers, { onResponseId });
			const text = await result.text();

			expect(text).toBe(sseContent);
			expect(onResponseId).not.toHaveBeenCalled();
		});

		it('should throw error if SSE stream exceeds size limit', async () => {
			const largeContent = 'a'.repeat(20 * 1024 * 1024 + 1);
			const response = new Response(largeContent);
			const headers = new Headers();

			await expect(convertSseToJson(response, headers)).rejects.toThrow(
				/exceeds.*bytes limit/
			);
		});

		it('should throw error when stream read fails', async () => {
			const mockReader = {
				read: vi.fn().mockRejectedValue(new Error('Stream read error')),
				releaseLock: vi.fn(),
			};
			const response = {
				body: {
					getReader: () => mockReader,
				},
				status: 200,
				statusText: 'OK',
			} as unknown as Response;
			const headers = new Headers();

			await expect(convertSseToJson(response, headers)).rejects.toThrow('Stream read error');
			expect(mockReader.releaseLock).toHaveBeenCalled();
		});

		it('should throw when stream stalls past timeout', async () => {
			vi.useFakeTimers();
			const mockReader = {
				read: vi.fn(() => new Promise<{ done: boolean; value?: Uint8Array }>(() => {})),
				cancel: vi.fn(async () => undefined),
				releaseLock: vi.fn(),
			};
			const response = {
				body: {
					getReader: () => mockReader,
				},
				status: 200,
				statusText: 'OK',
			} as unknown as Response;

			const pending = convertSseToJson(response, new Headers(), { streamStallTimeoutMs: 1000 });
			const assertion = expect(pending).rejects.toThrow(/stalled/);
			await vi.advanceTimersByTimeAsync(1100);

			await assertion;
			expect(mockReader.cancel).toHaveBeenCalled();
			expect(mockReader.releaseLock).toHaveBeenCalled();
			vi.useRealTimers();
		});
	});

	describe('attachResponseIdCapture', () => {
		it('should capture response ids while preserving the SSE stream', async () => {
			const onResponseId = vi.fn();
			const sseContent = [
				'data: {"type":"response.started"}',
				'',
				'data: {"type":"response.done","response":{"id":"resp_stream_123","output":"done"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers({ 'content-type': 'text/event-stream' });

			const captured = attachResponseIdCapture(response, headers, onResponseId);
			const text = await captured.text();

			expect(text).toBe(sseContent);
			expect(onResponseId).toHaveBeenCalledTimes(1);
			expect(onResponseId).toHaveBeenCalledWith('resp_stream_123');
			expect(captured.headers.get('content-type')).toBe('text/event-stream');
		});

		it('should stop capturing response ids after an SSE error event', async () => {
			const onResponseId = vi.fn();
			const sseContent = [
				'data: {"type":"error","message":"quota exceeded"}',
				'',
				'data: {"type":"response.done","response":{"id":"resp_bad_123","output":"done"}}',
				'',
			].join('\n');
			const response = new Response(sseContent);
			const headers = new Headers({ 'content-type': 'text/event-stream' });

			const captured = attachResponseIdCapture(response, headers, onResponseId);
			const text = await captured.text();

			expect(text).toBe(sseContent);
			expect(onResponseId).not.toHaveBeenCalled();
		});
	});

	describe('isEmptyResponse', () => {
		it('should return true for null', () => {
			expect(isEmptyResponse(null)).toBe(true);
		});

		it('should return true for undefined', () => {
			expect(isEmptyResponse(undefined)).toBe(true);
		});

		it('should return true for empty string', () => {
			expect(isEmptyResponse('')).toBe(true);
			expect(isEmptyResponse('   ')).toBe(true);
		});

		it('should return true for empty object', () => {
			expect(isEmptyResponse({})).toBe(true);
		});

		it('should return true for response object without meaningful content', () => {
			expect(isEmptyResponse({ id: 'resp_123' })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', model: 'gpt-5.2' })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', object: 'response' })).toBe(true);
		});

		it('should return true for response with null/undefined output', () => {
			expect(isEmptyResponse({ id: 'resp_123', output: null })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', output: undefined })).toBe(true);
		});

		it('should return true for response with empty choices array', () => {
			expect(isEmptyResponse({ id: 'resp_123', choices: [] })).toBe(true);
		});

		it('should return false for response with output', () => {
			expect(isEmptyResponse({ output: [{ text: 'hello' }] })).toBe(false);
			expect(isEmptyResponse({ id: 'resp_123', output: 'some output' })).toBe(false);
		});

		it('should return false for response with choices', () => {
			expect(isEmptyResponse({ choices: [{ message: { content: 'hi' } }] })).toBe(false);
		});

		it('should return true for response with empty choice objects', () => {
			expect(isEmptyResponse({ id: 'resp_123', choices: [{}] })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', choices: [null] })).toBe(true);
		});

		it('should return false for response with content', () => {
			expect(isEmptyResponse({ content: 'hello world' })).toBe(false);
			expect(isEmptyResponse({ id: 'resp_123', content: [] })).toBe(false);
		});

		it('should return true for response with empty string content', () => {
			expect(isEmptyResponse({ id: 'resp_123', content: '' })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', content: '   ' })).toBe(true);
		});

		it('should return false for non-object primitives', () => {
			expect(isEmptyResponse(123)).toBe(false);
			expect(isEmptyResponse(true)).toBe(false);
			expect(isEmptyResponse('non-empty string')).toBe(false);
		});

		it('should return false for objects that are not response-like', () => {
			// Objects without id/object/model are considered valid (not response objects)
			expect(isEmptyResponse({ foo: 'bar' })).toBe(false);
			expect(isEmptyResponse({ data: [1, 2, 3] })).toBe(false);
		});
	});
});
