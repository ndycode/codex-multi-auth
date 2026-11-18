import { afterAll, describe, expect, it, vi } from "vitest";
import { fc } from "./setup.js";
import {
	normalizeModel,
	transformRequestBody,
} from "../../lib/request/request-transformer.js";
import {
	getModelCapabilities,
	getModelProfile,
	resolveNormalizedModel,
} from "../../lib/request/helpers/model-map.js";
import { transformRequestForCodex } from "../../lib/request/fetch-helpers.js";
import type {
	InputItem,
	RequestBody,
	RequestToolDefinition,
	UserConfig,
} from "../../lib/types.js";

// transformRequestBody(codexMode=true) calls getHostCodexPrompt() for the
// host-prompt filter, which fetches codex.txt from GitHub when no cache
// exists. Pin a deterministic prompt so the property stays hermetic while the
// filter still exercises real cached-prompt matching.
const HOST_PROMPT = "HOST CODEX PROMPT FIXTURE TEXT — not a real signature";
vi.mock("../../lib/prompts/host-codex-prompt.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../lib/prompts/host-codex-prompt.js")
		>();
	return {
		...actual,
		getHostCodexPrompt: async () => HOST_PROMPT,
	};
});

// detectCollaborationMode consults CODEX_COLLABORATION_MODE before looking at
// input content; an inherited value would silently flip the mode oracle. Pin
// it unset for this file and restore the ambient value afterwards.
const ambientCollaborationMode = process.env.CODEX_COLLABORATION_MODE;
delete process.env.CODEX_COLLABORATION_MODE;
afterAll(() => {
	if (ambientCollaborationMode === undefined) {
		delete process.env.CODEX_COLLABORATION_MODE;
	} else {
		process.env.CODEX_COLLABORATION_MODE = ambientCollaborationMode;
	}
});

// transformRequestForCodex fetches per-family Codex instructions from GitHub;
// mock only the fetch surface so the rest of prompts/codex.js stays real.
vi.mock("../../lib/prompts/codex.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/prompts/codex.js")>();
	return {
		...actual,
		getCodexInstructions: async (model?: string) =>
			`INSTRUCTIONS for ${model ?? "unknown"}`,
	};
});

const CODEX_INSTRUCTIONS = "test codex instructions";
const VALID_WIRE_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
const VALID_VERBOSITY = ["low", "medium", "high"] as const;
const COMPUTER_TOOL_TYPES = new Set(["computer", "computer_use_preview"]);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbModelSpelling = fc.oneof(
	fc.constantFrom(
		"gpt-5.5",
		"gpt-5.5-pro",
		"gpt-5",
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5-codex",
		"gpt-5.1-codex",
		"gpt-5.1-codex-max",
		"gpt-5.1-codex-mini",
		"gpt-5.2-codex",
		"gpt-5.3-codex",
		"codex-mini-latest",
		// Provider prefixes and effort-suffixed spellings the normalizer maps.
		"openai/gpt-5.5",
		"openai/gpt-5.1-codex",
		"gpt-5.5-high",
		"gpt-5-codex-low",
		"gpt-5.1-codex-max-high",
	),
	// Unknown spellings must still land on a catalog model.
	fc.string({ minLength: 1, maxLength: 30 }),
	fc.constant(undefined),
);

const arbMessageContent = fc.oneof(
	fc.string({ maxLength: 200 }),
	fc.array(
		fc.record({
			type: fc.constantFrom("input_text", "output_text", "refusal"),
			text: fc.string({ maxLength: 200 }),
		}),
		{ maxLength: 4 },
	),
	fc.constantFrom(null, 42, true),
);

const TOOL_OUTPUT_TYPES = new Set([
	"function_call_output",
	"local_shell_call_output",
	"custom_tool_call_output",
]);

const arbInputItem = fc.record({
	id: fc.option(fc.string({ minLength: 1, maxLength: 24 }), {
		nil: undefined,
	}),
	type: fc.constantFrom(
		"message",
		"function_call",
		"function_call_output",
		"item_reference",
		"local_shell_call",
		"local_shell_call_output",
		"custom_tool_call",
		"custom_tool_call_output",
		"reasoning",
	),
	role: fc.constantFrom("user", "assistant", "system", "developer"),
	content: fc.option(arbMessageContent, { nil: undefined }),
	call_id: fc.option(fc.string({ minLength: 1, maxLength: 12 }), {
		nil: undefined,
	}),
	name: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
	// Non-string outputs are deliberate: orphaned *_output rows are JSON-stringified
	// by convertOrphanedOutputToMessage (previously a crash on absent/undefined
	// output — see the pinned regression below), so the property should keep
	// generating them.
	output: fc.option(
		fc.oneof(
			fc.string({ maxLength: 80 }),
			fc.integer(),
			fc.boolean(),
			fc.constant(null),
			fc.dictionary(
				fc.string({ maxLength: 8 }),
				fc.string({ maxLength: 8 }),
				{ maxKeys: 3 },
			),
			fc.array(fc.integer(), { maxLength: 4 }),
		),
		{ nil: undefined },
	),
	phase: fc.option(fc.constantFrom("commentary", "final_answer"), {
		nil: undefined,
	}),
});

const arbJsonSchema = fc.record(
	{
		type: fc.constantFrom("object", "string", "number", "array"),
		properties: fc.option(
			fc.dictionary(
				fc.string({ minLength: 1, maxLength: 8 }),
				fc.record({ type: fc.constantFrom("string", "number", "boolean") }),
				{ maxKeys: 4 },
			),
			{ nil: undefined },
		),
		required: fc.option(
			fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
			{ nil: undefined },
		),
		additionalProperties: fc.option(fc.boolean(), { nil: undefined }),
		description: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
	},
	{ requiredKeys: [] },
);

const arbTool: fc.Arbitrary<RequestToolDefinition> = fc.oneof(
	fc.record({
		type: fc.constant("function" as const),
		function: fc.record({
			name: fc.constantFrom(
				"run_tests",
				"read_file",
				"request_user_input",
				"shell",
			),
			description: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
			parameters: fc.option(arbJsonSchema, { nil: undefined }),
		}),
		defer_loading: fc.option(fc.boolean(), { nil: undefined }),
	}),
	fc.record({
		type: fc.constant("tool_search" as const),
		max_num_results: fc.option(fc.integer({ min: 1, max: 10 }), {
			nil: undefined,
		}),
	}),
	fc.record({
		type: fc.constantFrom("computer" as const, "computer_use_preview" as const),
		display_width: fc.option(fc.integer({ min: 100, max: 4000 }), {
			nil: undefined,
		}),
		display_height: fc.option(fc.integer({ min: 100, max: 4000 }), {
			nil: undefined,
		}),
	}),
	fc.record({
		type: fc.constant("mcp" as const),
		server_label: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
		server_url: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
	}),
);

const arbRequestBody = fc.record(
	{
		model: arbModelSpelling,
		background: fc.option(fc.boolean(), { nil: undefined }),
		store: fc.option(fc.boolean(), { nil: undefined }),
		stream: fc.option(fc.boolean(), { nil: undefined }),
		instructions: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
		input: fc.option(fc.array(arbInputItem, { maxLength: 14 }), {
			nil: undefined,
		}),
		tools: fc.option(fc.array(arbTool, { maxLength: 6 }), { nil: undefined }),
		reasoning: fc.option(
			fc.record(
				{
					effort: fc.option(
						fc.constantFrom(
							"none",
							"minimal",
							"low",
							"medium",
							"high",
							"xhigh",
							"max",
							"ultra",
						),
						{ nil: undefined },
					),
					summary: fc.option(
						fc.constantFrom("auto", "concise", "detailed", "off", "on"),
						{ nil: undefined },
					),
				},
				{ requiredKeys: [] },
			),
			{ nil: undefined },
		),
		text: fc.option(
			fc.record(
				{
					verbosity: fc.option(fc.constantFrom(...VALID_VERBOSITY), {
						nil: undefined,
					}),
					format: fc.option(
						fc.record({ type: fc.constantFrom("text", "json_schema") }),
						{ nil: undefined },
					),
				},
				{ requiredKeys: [] },
			),
			{ nil: undefined },
		),
		include: fc.option(
			fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 4 }),
			{ nil: undefined },
		),
		providerOptions: fc.option(
			fc.record({
				openai: fc.record(
					{
						reasoningEffort: fc.option(
							fc.constantFrom("none", "low", "medium", "high"),
							{ nil: undefined },
						),
						reasoningSummary: fc.option(
							fc.constantFrom("auto", "concise", "detailed"),
							{ nil: undefined },
						),
						textVerbosity: fc.option(fc.constantFrom(...VALID_VERBOSITY), {
							nil: undefined,
						}),
						include: fc.option(
							fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
								maxLength: 3,
							}),
							{ nil: undefined },
						),
						store: fc.option(fc.boolean(), { nil: undefined }),
					},
					{ requiredKeys: [] },
				),
			}),
			{ nil: undefined },
		),
		max_output_tokens: fc.option(fc.integer({ min: 1, max: 100000 }), {
			nil: undefined,
		}),
		max_completion_tokens: fc.option(fc.integer({ min: 1, max: 100000 }), {
			nil: undefined,
		}),
		prompt_cache_key: fc.option(fc.string({ maxLength: 24 }), {
			nil: undefined,
		}),
		previous_response_id: fc.option(fc.string({ maxLength: 24 }), {
			nil: undefined,
		}),
	},
	{ requiredKeys: [] },
) as fc.Arbitrary<RequestBody>;

const PLAN_MODE_TOOL_NAME = "request_user_input";

// The collaboration-mode markers are ≥12-char literals that a random string
// effectively never contains, so without injection the plan/default branches
// of detectCollaborationMode — and therefore the plan-only-tool contract —
// would be exercised ~never. Inject marker text (and optionally the
// request_user_input tool) with real frequency so both directions are hit:
// the tool must survive exactly when mode resolves to "plan" AND it was
// requested — plan mode preserves the tool, it does not inject it.
const arbRequestBodyWithMode = fc
	.tuple(
		arbRequestBody,
		fc.constantFrom("none", "plan", "default", "plan+default"),
		fc.boolean(),
	)
	.map(([body, injection, addPlanTool]): RequestBody => {
		const next: RequestBody = { ...body };
		if (injection !== "none") {
			const markerText =
				injection === "plan"
					? "collaboration mode: plan"
					: injection === "default"
						? "collaboration mode: default"
						: "collaboration mode: plan\ncollaboration mode: default";
			const markerItem: InputItem = {
				type: "message",
				role: "developer",
				content: markerText,
			};
			next.input = [
				...(Array.isArray(next.input) ? next.input : []),
				markerItem,
			];
		}
		if (addPlanTool) {
			const planTool: RequestToolDefinition = {
				type: "function",
				function: { name: PLAN_MODE_TOOL_NAME },
			};
			next.tools = [
				...(Array.isArray(next.tools) ? next.tools : []),
				planTool,
			];
		}
		return next;
	});

const arbUserConfig: fc.Arbitrary<UserConfig> = fc.record(
	{
		global: fc.record(
			{
				reasoningEffort: fc.option(
					fc.constantFrom(
						"none",
						"minimal",
						"low",
						"medium",
						"high",
						"xhigh",
						"max",
						"ultra",
					),
					{ nil: undefined },
				),
				reasoningSummary: fc.option(
					fc.constantFrom("auto", "concise", "detailed", "off", "on"),
					{ nil: undefined },
				),
				textVerbosity: fc.option(fc.constantFrom(...VALID_VERBOSITY), {
					nil: undefined,
				}),
				include: fc.option(
					fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
						maxLength: 3,
					}),
					{ nil: undefined },
				),
			},
			{ requiredKeys: [] },
		),
		models: fc.constant({}),
	},
	{ requiredKeys: ["global", "models"] },
) as fc.Arbitrary<UserConfig>;

// ---------------------------------------------------------------------------
// Helpers mirroring the transformer's own decisions, so assertions encode the
// contract rather than a guess at the input shape.
// ---------------------------------------------------------------------------

type CollaborationMode = "plan" | "default" | "unknown";

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "";
			const typed = item as { text?: unknown };
			return typeof typed.text === "string" ? typed.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

// Mirrors detectCollaborationMode in request-transformer.ts. The suite never
// sets CODEX_COLLABORATION_MODE, so only input content drives detection.
function expectedCollaborationMode(body: RequestBody): CollaborationMode {
	if (!Array.isArray(body.input)) return "unknown";
	let sawPlan = false;
	let sawDefault = false;
	for (const item of body.input) {
		if (!item || typeof item !== "object") continue;
		const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
		if (role !== "developer" && role !== "system") continue;
		const text = extractMessageText(item.content);
		if (!text) continue;
		if (/collaboration mode:\s*plan/i.test(text) || /in Plan mode/i.test(text)) {
			sawPlan = true;
		}
		if (
			/collaboration mode:\s*default/i.test(text) ||
			/in Default mode/i.test(text)
		) {
			sawDefault = true;
		}
	}
	if (sawPlan && !sawDefault) return "plan";
	if (sawDefault) return "default";
	return "unknown";
}

function countCallItems(items: InputItem[] | undefined): number {
	if (!Array.isArray(items)) return 0;
	return items.filter(
		(item) =>
			item !== null &&
			typeof item === "object" &&
			(item.type === "function_call" ||
				item.type === "local_shell_call" ||
				item.type === "custom_tool_call"),
	).length;
}

function walkTools(
	tools: RequestToolDefinition[] | undefined,
	visit: (tool: RequestToolDefinition) => void,
): void {
	if (!Array.isArray(tools)) return;
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		visit(tool);
		const record = tool as { type?: string; tools?: unknown };
		if (record.type === "namespace" && Array.isArray(record.tools)) {
			walkTools(record.tools as RequestToolDefinition[], visit);
		}
	}
}

function walkSchema(value: unknown, visit: (node: Record<string, unknown>) => void): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) walkSchema(item, visit);
		return;
	}
	const record = value as Record<string, unknown>;
	visit(record);
	for (const nested of Object.values(record)) {
		if (nested && typeof nested === "object") walkSchema(nested, visit);
	}
}

// The error contract of assertBackgroundModeCompatibility, restated so each
// generated case knows whether the transform must reject.
function expectedBackgroundError(
	body: RequestBody,
	allowBackground: boolean,
): "disabled" | "store-false" | null {
	if (body.background !== true) return null;
	if (!allowBackground) return "disabled";
	if (body.store === false || body.providerOptions?.openai?.store === false) {
		return "store-false";
	}
	return null;
}

// Mirrors normalizeOrphanedToolOutputs + filterInput: an item keeps its `id`
// iff it survives verbatim — not item_reference, not an orphaned *_output
// (those are rewritten into messages and legitimately lose the id).
function expectedSurvivingItemIds(input: InputItem[]): string[] {
	const callIdOf = (item: InputItem): string | null => {
		const raw = (item as { call_id?: unknown }).call_id;
		if (typeof raw !== "string") return null;
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	};
	const functionCallIds = new Set<string>();
	const localShellCallIds = new Set<string>();
	const customToolCallIds = new Set<string>();
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const callId = callIdOf(item);
		if (!callId) continue;
		if (item.type === "function_call") functionCallIds.add(callId);
		if (item.type === "local_shell_call") localShellCallIds.add(callId);
		if (item.type === "custom_tool_call") customToolCallIds.add(callId);
	}
	const ids: string[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "item_reference") continue;
		if (TOOL_OUTPUT_TYPES.has(item.type ?? "")) {
			const callId = callIdOf(item);
			const matched =
				!!callId &&
				(item.type === "function_call_output"
					? functionCallIds.has(callId) || localShellCallIds.has(callId)
					: item.type === "local_shell_call_output"
						? localShellCallIds.has(callId)
						: customToolCallIds.has(callId));
			if (!matched) continue; // rewritten to a message; id intentionally gone
		}
		if (typeof item.id === "string") ids.push(item.id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("transformRequestBody properties", () => {
	it("satisfies the wire post-conditions on every successful transform", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbRequestBodyWithMode,
				arbUserConfig,
				fc.boolean(),
				fc.boolean(),
				async (body, userConfig, codexMode, allowBackground) => {
					const originalInput = Array.isArray(body.input)
						? (structuredClone(body.input) as InputItem[])
						: undefined;
					const expectedError = expectedBackgroundError(
						body,
						allowBackground,
					);
					const backgroundActive =
						body.background === true && expectedError === null;
					const expectedMode = expectedCollaborationMode(body);

					let result: RequestBody;
					try {
						result = await transformRequestBody(
							structuredClone(body),
							CODEX_INSTRUCTIONS,
							userConfig,
							codexMode,
							false, // fastSession off: its trim/compaction paths are bound separately
							"hybrid",
							30,
							false,
							allowBackground,
						);
					} catch (error) {
						expect(expectedError).not.toBeNull();
						expect(String(error)).toMatch(/background mode/i);
						return;
					}
					expect(expectedError).toBeNull();

					// Model normalization lands on the catalog fixpoint.
					expect(result.model).toBe(normalizeModel(body.model));
					expect(resolveNormalizedModel(result.model)).toBe(result.model);
					expect(() => getModelProfile(result.model)).not.toThrow();

					// Stateless-by-default wire contract.
					expect(result.stream).toBe(true);
					expect(result.store).toBe(backgroundActive);
					expect(result.instructions).toBe(CODEX_INSTRUCTIONS);
					expect(result.max_output_tokens).toBeUndefined();
					expect(result.max_completion_tokens).toBeUndefined();

					// Reasoning/text land inside the model's declared bounds.
					const profile = getModelProfile(result.model);
					expect(
						profile.supportedReasoningEfforts.includes(
							result.reasoning?.effort as never,
						),
					).toBe(true);
					expect(VALID_WIRE_EFFORTS).toContain(result.reasoning?.effort);
					expect(["auto", "concise", "detailed"]).toContain(
						result.reasoning?.summary,
					);
					expect(VALID_VERBOSITY).toContain(result.text?.verbosity);

					// Stateless mode always carries the encrypted-reasoning
					// continuation and deduplicates; background mode may legitimately
					// leave include undefined (pass-through contract).
					if (!backgroundActive) {
						expect(Array.isArray(result.include)).toBe(true);
						expect(result.include).toContain(
							"reasoning.encrypted_content",
						);
						expect(new Set(result.include).size).toBe(
							result.include?.length,
						);
					}
					for (const entry of result.include ?? []) {
						expect(entry).toBeTruthy();
					}

					if (Array.isArray(originalInput) && Array.isArray(result.input)) {
						// Id-stripping removes every top-level `id` in stateless mode and
						// item_reference entries never survive.
						for (const item of result.input) {
							if (item && typeof item === "object") {
								if (!backgroundActive) {
									expect("id" in item).toBe(false);
								}
								expect(item.type).not.toBe("item_reference");
							}
						}
						// Output-input bound: the transform can only add the bridge/remap
						// message (≤1) plus one synthesized output per unmatched call.
						expect(result.input.length).toBeLessThanOrEqual(
							originalInput.length + 1 + countCallItems(originalInput),
						);
					} else if (Array.isArray(originalInput)) {
						expect(Array.isArray(result.input)).toBe(true);
					}

					// Tool surface: plan-only tools only survive plan mode, and
					// capability-gated tool types never outlive the model's profile.
					const capabilities = getModelCapabilities(result.model);
					let sawPlanOnlyTool = false;
					walkTools(result.tools, (tool) => {
						const record = tool as {
							type?: string;
							function?: { name?: unknown };
						};
						if (
							record.type === "tool_search" &&
							!capabilities.toolSearch
						) {
							throw new Error(
								`tool_search survived a ${result.model} transform without support`,
							);
						}
						if (
							COMPUTER_TOOL_TYPES.has(record.type ?? "") &&
							!capabilities.computerUse
						) {
							throw new Error(
								`computer tool survived a ${result.model} transform without support`,
							);
						}
						const name = record.function?.name;
						if (typeof name === "string" && name === PLAN_MODE_TOOL_NAME) {
							sawPlanOnlyTool = true;
						}
					});
					// A plan-only tool survives iff the input actually carried it
					// AND the detected mode is plan — plan mode preserves the tool
					// but never injects one. Asserting sawPlanOnlyTool ===
					// (mode === "plan") alone would false-fail whenever marker text
					// appears without the tool being requested.
					let inputHadPlanOnlyTool = false;
					walkTools(body.tools, (tool) => {
						const record = tool as {
							function?: { name?: unknown };
						};
						if (record.function?.name === PLAN_MODE_TOOL_NAME) {
							inputHadPlanOnlyTool = true;
						}
					});
					expect(sawPlanOnlyTool).toBe(
						expectedMode === "plan" && inputHadPlanOnlyTool,
					);
				},
			),
		);
	});

	it("is deterministic: two transforms of the same body agree exactly", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbRequestBody,
				arbUserConfig,
				fc.boolean(),
				async (body, userConfig, codexMode) => {
					fc.pre(body.background !== true);
					const first = await transformRequestBody(
						structuredClone(body),
						CODEX_INSTRUCTIONS,
						structuredClone(userConfig),
						codexMode,
					);
					const second = await transformRequestBody(
						structuredClone(body),
						CODEX_INSTRUCTIONS,
						structuredClone(userConfig),
						codexMode,
					);
					expect(second).toStrictEqual(first);
				},
			),
		);
	});

	it("cleans function-tool schemas: required ⊆ properties, no banned keywords", async () => {
		await fc.assert(
			fc.asyncProperty(arbRequestBody, async (body) => {
				fc.pre(body.background !== true);
				const result = await transformRequestBody(
					structuredClone(body),
					CODEX_INSTRUCTIONS,
					{ global: {}, models: {} },
					false,
				);
				walkTools(result.tools, (tool) => {
					const record = tool as {
						type?: string;
						function?: { parameters?: unknown };
					};
					if (record.type !== "function") return;
					const parameters = record.function?.parameters;
					if (!parameters || typeof parameters !== "object") return;
					// cleanupSchema filters `required` against `properties` only when
					// `properties` is an object — and injects a `_placeholder` property
					// for empty object schemas after that filter ran. Assert the
					// contract where it applies: a real (non-placeholder) properties
					// map must contain every required name.
					walkSchema(parameters, (node) => {
						const required = node.required;
						const properties = node.properties;
						if (
							!Array.isArray(required) ||
							!properties ||
							typeof properties !== "object" ||
							Array.isArray(properties)
						) {
							return;
						}
						const propertyKeys = Object.keys(
							properties as Record<string, unknown>,
						);
						if (
							propertyKeys.length === 1 &&
							propertyKeys[0] === "_placeholder"
						) {
							return; // injected after required-filtering; source keeps it
						}
						for (const name of required) {
							expect(
								Object.prototype.hasOwnProperty.call(properties, name),
							).toBe(true);
						}
					});
					walkSchema(parameters, (node) => {
						expect("additionalProperties" in node).toBe(false);
						expect("const" in node).toBe(false);
						expect("title" in node).toBe(false);
						expect("$schema" in node).toBe(false);
					});
				});
			}),
		);
	});

	it("background mode contract: rejected without opt-in, stateful with it", async () => {
		await fc.assert(
			fc.asyncProperty(arbRequestBody, async (body) => {
				fc.pre(body.background === true);
				fc.pre(
					body.store !== false &&
						body.providerOptions?.openai?.store !== false,
				);

				// Without the opt-in flag the transform must refuse.
				await expect(
					transformRequestBody(
						structuredClone(body),
						CODEX_INSTRUCTIONS,
						{ global: {}, models: {} },
						false,
						false,
						"hybrid",
						30,
						false,
						false,
					),
				).rejects.toThrow(/background mode/i);

				// With the opt-in it preserves stateful routing and item ids.
				const result = await transformRequestBody(
					structuredClone(body),
					CODEX_INSTRUCTIONS,
					{ global: {}, models: {} },
					false,
					false,
					"hybrid",
					30,
					false,
					true,
				);
				expect(result.store).toBe(true);
				if (Array.isArray(body.input) && Array.isArray(result.input)) {
					const survivingIds = expectedSurvivingItemIds(body.input);
					if (survivingIds.length > 0) {
						const resultIds = new Set(
							result.input
								.filter(
									(item): item is InputItem =>
										item !== null &&
										typeof item === "object" &&
										typeof item.id === "string",
								)
								.map((item) => item.id),
						);
						for (const id of survivingIds) {
							expect(resultIds.has(id)).toBe(true);
						}
					}
				}
			}),
		);
	});

	// REAL BUG, pinned loudly: lib/request/helpers/input-utils.ts
	// convertOrphanedOutputToMessage computes
	//   text = typeof out === "string" ? out : JSON.stringify(out)
	// sat inside a try/catch, but JSON.stringify(undefined) returns undefined —
	// the subsequent `text.length` threw TypeError OUTSIDE the guard. Now
	// guarded with `?? ""`: orphaned outputs without a string output no longer
	// crash transformRequestBody.
	it(
		"orphaned tool outputs without a string output must not crash transformRequestBody",
		async () => {
			for (const type of [
				"function_call_output",
				"local_shell_call_output",
				"custom_tool_call_output",
			] as const) {
				// Absent output (the original crash: JSON.stringify(undefined) →
				// undefined.length) plus the JSON-representable non-string shapes.
				for (const output of [
					undefined,
					null,
					42,
					true,
					{ nested: "value" },
					[1, 2],
				] as const) {
					const result = await transformRequestBody(
						{
							model: "gpt-5.5",
							input: [{ type, call_id: "orphan-call-id", output }],
						} as RequestBody,
						CODEX_INSTRUCTIONS,
						{ global: {}, models: {} },
						false,
					);
					expect(result).toBeDefined();
					expect(
						result.input?.some((item) => item.type === "message"),
					).toBe(true);
				}
			}
		},
	);

	it("rejects malformed calls with TypeError, never silently", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(fc.constant(null), fc.string(), fc.integer()),
				async (notABody) => {
					await expect(
						transformRequestBody(
							notABody as unknown as RequestBody,
							CODEX_INSTRUCTIONS,
						),
					).rejects.toThrow(TypeError);
				},
			),
		);
		await expect(
			transformRequestBody(
				{ model: "gpt-5.5" } as RequestBody,
				undefined as unknown as string,
			),
		).rejects.toThrow(TypeError);
	});
});

describe("transformRequestForCodex properties", () => {
	it("returns undefined for body-less requests and echoes transformed JSON otherwise", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbRequestBody,
				fc.boolean(),
				async (body, codexMode) => {
					fc.pre(body.background !== true);
					const absent = await transformRequestForCodex(
						undefined,
						"https://example.com/responses",
						{ global: {}, models: {} },
						codexMode,
					);
					expect(absent).toBeUndefined();

					const preParsed = structuredClone(
						body,
					) as unknown as Record<string, unknown>;
					const result = await transformRequestForCodex(
						undefined,
						"https://example.com/responses",
						{ global: {}, models: {} },
						codexMode,
						preParsed,
					);
					// hasParsedBody requires a non-empty object: a generated `{}`
					// body is body-less and must return undefined like the absent
					// case — asserting toBeDefined here would false-fail on it.
					if (Object.keys(preParsed).length === 0) {
						expect(result).toBeUndefined();
						return;
					}
					expect(result).toBeDefined();
					const parsed = JSON.parse(
						String(result?.updatedInit.body),
					) as RequestBody;
					expect(parsed).toEqual(result?.body);
					expect(parsed.model).toBe(normalizeModel(body.model));
					expect(parsed.stream).toBe(true);
					expect(parsed.store).toBe(false);
					expect(
						(parsed.instructions ?? "").startsWith("INSTRUCTIONS for"),
					).toBe(true);
				},
			),
		);
	});
});
