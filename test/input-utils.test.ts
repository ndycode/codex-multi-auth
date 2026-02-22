import { describe, it, expect } from "vitest";
import {
	injectMissingToolOutputs,
	normalizeOrphanedToolOutputs,
	getContentText,
	isOpenCodeSystemPrompt,
	filterOpenCodeSystemPromptsWithCachedPrompt,
} from "../lib/request/helpers/input-utils.js";
import type { InputItem } from "../lib/types.js";

describe("Tool Output Normalization", () => {
	describe("injectMissingToolOutputs", () => {
		it("returns empty array for empty input", () => {
			expect(injectMissingToolOutputs([])).toEqual([]);
		});

		it("passes through input with no function_calls", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "Hello" },
				{ type: "message", role: "assistant", content: "Hi there" },
			];
			expect(injectMissingToolOutputs(input)).toEqual(input);
		});

		it("passes through function_call with matching output", () => {
			const input: InputItem[] = [
				{ type: "function_call", role: "assistant", call_id: "call_1", name: "test" },
				{ type: "function_call_output", role: "tool", call_id: "call_1", output: "result" },
			];
			const result = injectMissingToolOutputs(input);
			expect(result).toHaveLength(2);
			expect(result[0]?.type).toBe("function_call");
			expect(result[1]?.type).toBe("function_call_output");
		});

		it("injects output for orphaned function_call", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "run the tool" },
				{ type: "function_call", role: "assistant", call_id: "call_orphan", name: "read_file" },
			];
			const result = injectMissingToolOutputs(input);
			
			expect(result).toHaveLength(3);
			expect(result[2]?.type).toBe("function_call_output");
			expect((result[2] as { call_id?: string }).call_id).toBe("call_orphan");
			expect((result[2] as { output?: string }).output).toBe("Operation cancelled by user");
		});

		it("injects output for orphaned local_shell_call", () => {
			const input: InputItem[] = [
				{ type: "local_shell_call", role: "assistant", call_id: "shell_1", command: "ls" },
			];
			const result = injectMissingToolOutputs(input);
			
			expect(result).toHaveLength(2);
			expect(result[1]?.type).toBe("local_shell_call_output");
			expect((result[1] as { call_id?: string }).call_id).toBe("shell_1");
		});

		it("injects output for orphaned custom_tool_call", () => {
			const input: InputItem[] = [
				{ type: "custom_tool_call", role: "assistant", call_id: "custom_1", name: "my_tool" },
			];
			const result = injectMissingToolOutputs(input);
			
			expect(result).toHaveLength(2);
			expect(result[1]?.type).toBe("custom_tool_call_output");
		});

		it("handles multiple orphaned calls", () => {
			const input: InputItem[] = [
				{ type: "function_call", role: "assistant", call_id: "call_1", name: "tool1" },
				{ type: "function_call", role: "assistant", call_id: "call_2", name: "tool2" },
				{ type: "function_call", role: "assistant", call_id: "call_3", name: "tool3" },
			];
			const result = injectMissingToolOutputs(input);
			
			expect(result).toHaveLength(6);
			expect(result.filter(i => i.type === "function_call_output")).toHaveLength(3);
		});

		it("only injects for calls without outputs", () => {
			const input: InputItem[] = [
				{ type: "function_call", role: "assistant", call_id: "call_with_output", name: "tool1" },
				{ type: "function_call_output", role: "tool", call_id: "call_with_output", output: "done" },
				{ type: "function_call", role: "assistant", call_id: "call_without_output", name: "tool2" },
			];
			const result = injectMissingToolOutputs(input);
			
			expect(result).toHaveLength(4);
			const outputs = result.filter(i => i.type === "function_call_output");
			expect(outputs).toHaveLength(2);
		});

		it("skips calls without call_id", () => {
			const input: InputItem[] = [
				{ type: "function_call", role: "assistant", name: "no_id_tool" },
			];
			const result = injectMissingToolOutputs(input);
			expect(result).toHaveLength(1);
		});

		it("places injected output immediately after the call", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "start" },
				{ type: "function_call", role: "assistant", call_id: "call_A", name: "toolA" },
				{ type: "message", role: "user", content: "middle" },
				{ type: "function_call", role: "assistant", call_id: "call_B", name: "toolB" },
				{ type: "message", role: "user", content: "end" },
			];
			const result = injectMissingToolOutputs(input);
			
			expect(result).toHaveLength(7);
			expect(result[0]?.type).toBe("message");
			expect(result[1]?.type).toBe("function_call");
			expect(result[2]?.type).toBe("function_call_output");
			expect((result[2] as { call_id?: string }).call_id).toBe("call_A");
			expect(result[3]?.type).toBe("message");
			expect(result[4]?.type).toBe("function_call");
			expect(result[5]?.type).toBe("function_call_output");
			expect((result[5] as { call_id?: string }).call_id).toBe("call_B");
			expect(result[6]?.type).toBe("message");
		});
	});

	describe("normalizeOrphanedToolOutputs", () => {
		it("converts orphaned function_call_output to message", () => {
			const input: InputItem[] = [
				{ type: "function_call_output", role: "tool", call_id: "orphan_call", output: "some result" },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(1);
			expect(result[0]?.type).toBe("message");
			expect(result[0]?.role).toBe("assistant");
		});

		it("preserves function_call_output with matching call", () => {
			const input: InputItem[] = [
				{ type: "function_call", role: "assistant", call_id: "matched_call", name: "test" },
				{ type: "function_call_output", role: "tool", call_id: "matched_call", output: "result" },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(2);
			expect(result[1]?.type).toBe("function_call_output");
		});

		it("converts orphaned local_shell_call_output to message", () => {
			const input: InputItem[] = [
				{ type: "local_shell_call_output", role: "tool", call_id: "orphan_shell", output: "shell result" },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(1);
			expect(result[0]?.type).toBe("message");
			expect(result[0]?.role).toBe("assistant");
		});

		it("preserves local_shell_call_output with matching local_shell_call", () => {
			const input: InputItem[] = [
				{ type: "local_shell_call", role: "assistant", call_id: "shell_matched", command: "ls" },
				{ type: "local_shell_call_output", role: "tool", call_id: "shell_matched", output: "files" },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(2);
			expect(result[1]?.type).toBe("local_shell_call_output");
		});

		it("truncates very long output content", () => {
			const longOutput = "x".repeat(20000);
			const input: InputItem[] = [
				{ type: "function_call_output", role: "tool", call_id: "orphan_long", output: longOutput },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(1);
			expect(result[0]?.type).toBe("message");
			const content = (result[0] as { content?: string }).content ?? "";
			expect(content.length).toBeLessThan(20000);
			expect(content).toContain("[truncated]");
		});

		it("handles non-string output by converting to JSON", () => {
			const input: InputItem[] = [
				{ type: "function_call_output", role: "tool", call_id: "orphan_obj", output: { key: "value" } },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(1);
			expect(result[0]?.type).toBe("message");
			const content = (result[0] as { content?: string }).content ?? "";
			expect(content).toContain("key");
			expect(content).toContain("value");
		});

		it("handles output with circular references gracefully", () => {
			const circular: Record<string, unknown> = { a: 1 };
			circular.self = circular;
			const input: InputItem[] = [
				{ type: "function_call_output", role: "tool", call_id: "orphan_circ", output: circular },
			];
			const result = normalizeOrphanedToolOutputs(input);
			
			expect(result).toHaveLength(1);
			expect(result[0]?.type).toBe("message");
		});
	});

	describe("combined normalization flow", () => {
		it("handles both orphaned calls and outputs", () => {
			const input: InputItem[] = [
				{ type: "function_call_output", role: "tool", call_id: "orphan_output", output: "lost result" },
				{ type: "function_call", role: "assistant", call_id: "orphan_call", name: "new_tool" },
			];
			
			const normalized = normalizeOrphanedToolOutputs(input);
			const injected = injectMissingToolOutputs(normalized);
			
			expect(injected.filter(i => i.type === "message")).toHaveLength(1);
			expect(injected.filter(i => i.type === "function_call")).toHaveLength(1);
			expect(injected.filter(i => i.type === "function_call_output")).toHaveLength(1);
		});
	});

	describe("getContentText edge cases", () => {
		it("returns empty string when content is neither string nor array", () => {
			const item = { type: "message", role: "user", content: undefined } as unknown as InputItem;
			expect(getContentText(item)).toBe("");
		});

		it("returns empty string when content is null", () => {
			const item = { type: "message", role: "user", content: null } as unknown as InputItem;
			expect(getContentText(item)).toBe("");
		});

		it("returns empty string when content is a number", () => {
			const item = { type: "message", role: "user", content: 123 } as unknown as InputItem;
			expect(getContentText(item)).toBe("");
		});
	});

	describe("isOpenCodeSystemPrompt with cached prompt", () => {
		it("returns true when content starts with cached prompt", () => {
			const cachedPrompt = "You are OpenCode, an agent";
			const item: InputItem = {
				type: "message",
				role: "system",
				content: "You are OpenCode, an agent with additional context appended here",
			};
			expect(isOpenCodeSystemPrompt(item, cachedPrompt)).toBe(true);
		});

		it("returns true when first 200 chars match cached prompt prefix", () => {
			const longText = "A".repeat(250);
			const cachedPrompt = longText;
			const item: InputItem = {
				type: "message",
				role: "system",
				content: longText.slice(0, 200) + "B".repeat(100),
			};
			expect(isOpenCodeSystemPrompt(item, cachedPrompt)).toBe(true);
		});

		it("returns false for non-system roles even with matching content", () => {
			const cachedPrompt = "You are OpenCode, an agent";
			const item: InputItem = {
				type: "message",
				role: "user",
				content: "You are OpenCode, an agent",
			};
			expect(isOpenCodeSystemPrompt(item, cachedPrompt)).toBe(false);
		});

		it("returns false when content is empty", () => {
			const cachedPrompt = "You are OpenCode, an agent";
			const item: InputItem = {
				type: "message",
				role: "system",
				content: "",
			};
			expect(isOpenCodeSystemPrompt(item, cachedPrompt)).toBe(false);
		});

		it("returns true for developer role with matching signature", () => {
			const item: InputItem = {
				type: "message",
				role: "developer",
				content: "You are OpenCode, an interactive CLI agent that does stuff",
			};
			expect(isOpenCodeSystemPrompt(item, null)).toBe(true);
		});
	});

	describe("filterOpenCodeSystemPromptsWithCachedPrompt", () => {
		it("returns undefined for undefined input", () => {
			expect(filterOpenCodeSystemPromptsWithCachedPrompt(undefined, null)).toBeUndefined();
		});

		it("preserves user messages unchanged", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "Hello" },
			];
			const result = filterOpenCodeSystemPromptsWithCachedPrompt(input, null);
			expect(result).toEqual(input);
		});

		it("filters out OpenCode system prompt without context", () => {
			const input: InputItem[] = [
				{ type: "message", role: "system", content: "You are OpenCode, an agent doing things" },
			];
			const result = filterOpenCodeSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(0);
		});

		it("preserves context when filtering OpenCode system prompt", () => {
			const input: InputItem[] = [
				{
					type: "message",
					role: "system",
					content: "You are OpenCode, an agent\n\nHere is some useful information about the environment you are running in:\n<env>test</env>",
				},
			];
			const result = filterOpenCodeSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(1);
			expect((result?.[0] as { content: string }).content).toContain("Here is some useful information");
		});

		it("replaces array content with text when preserving context", () => {
			const input: InputItem[] = [
				{
					type: "message",
					role: "system",
					content: [
						{ type: "input_text", text: "You are OpenCode, an agent\n\n<instructions>\nDo things</instructions>" },
					],
				},
			];
			const result = filterOpenCodeSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(1);
			const content = (result?.[0] as { content: unknown }).content;
			// Content is replaced with array containing extracted context
			expect(Array.isArray(content)).toBe(true);
			expect((content as { text: string }[])[0]?.text).toContain("<instructions>");
		});

		it("handles content that is neither string nor array when preserving context (line 41 coverage)", () => {
			const input: InputItem[] = [
				{
					type: "message",
					role: "system",
					content: { weird: "object" } as unknown as string,
				},
			];
			const result = filterOpenCodeSystemPromptsWithCachedPrompt(input, "{ weird: 'object' }");
			expect(result).toBeDefined();
		});
	});
});
