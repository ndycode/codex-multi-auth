import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    normalizeModel,
    getModelConfig,
    filterInput,
    addToolRemapMessage,
    isHostSystemPrompt,
    filterHostSystemPrompts,
    filterHostSystemPromptsWithCachedPrompt,
    addCodexBridgeMessage,
    transformRequestBody,
} from '../lib/request/request-transformer.js';
import { TOOL_REMAP_MESSAGE } from '../lib/prompts/codex.js';
import { CODEX_HOST_BRIDGE } from '../lib/prompts/codex-host-bridge.js';
import type { RequestBody, UserConfig, InputItem } from '../lib/types.js';

describe('Request Transformer Module', () => {
	describe('normalizeModel', () => {
		it('keeps codex families canonical', async () => {
			expect(normalizeModel('gpt-5-codex')).toBe('gpt-5-codex');
			expect(normalizeModel('openai/gpt-5-codex')).toBe('gpt-5-codex');
			expect(normalizeModel('gpt-5.3-codex-spark-high')).toBe('gpt-5-codex');
			expect(normalizeModel('gpt-5.1-codex-max-high')).toBe('gpt-5.1-codex-max');
			expect(normalizeModel('codex-mini-latest')).toBe('gpt-5.1-codex-mini');
		});

		it('keeps GPT-5.4 era general models first-class', async () => {
			expect(normalizeModel('gpt-5.4')).toBe('gpt-5.4');
			expect(normalizeModel('gpt-5.4-pro-high')).toBe('gpt-5.4-pro');
			expect(normalizeModel('gpt-5')).toBe('gpt-5');
			expect(normalizeModel('gpt-5-pro-high')).toBe('gpt-5-pro');
		});

		it('maps GPT-5.4 mini and nano aliases onto the current small-model IDs', async () => {
			expect(normalizeModel('gpt-5.4-mini')).toBe('gpt-5-mini');
			expect(normalizeModel('gpt-5.4-mini-high')).toBe('gpt-5-mini');
			expect(normalizeModel('gpt-5.4-nano')).toBe('gpt-5-nano');
			expect(normalizeModel('gpt-5.4-nano-high')).toBe('gpt-5-nano');
			expect(normalizeModel('gpt-5-mini')).toBe('gpt-5-mini');
			expect(normalizeModel('gpt-5-nano')).toBe('gpt-5-nano');
		});

		it('defaults unknown requests to GPT-5.4 instead of GPT-5.1', async () => {
			expect(normalizeModel('unknown-model')).toBe('gpt-5.4');
			expect(normalizeModel('gpt-4')).toBe('gpt-5.4');
			expect(normalizeModel(undefined)).toBe('gpt-5.4');
			expect(normalizeModel('')).toBe('gpt-5.4');
		});

		it('still prioritizes codex detection when model names contain both codex and GPT-5', async () => {
			expect(normalizeModel('gpt-5-codex-low')).toBe('gpt-5-codex');
			expect(normalizeModel('my-gpt-5-codex-model')).toBe('gpt-5-codex');
		});

		it('handles case and formatting variations', async () => {
			expect(normalizeModel('GPT-5.4')).toBe('gpt-5.4');
			expect(normalizeModel('GPT-5-HIGH')).toBe('gpt-5');
			expect(normalizeModel('Gpt-5.4-Pro')).toBe('gpt-5.4-pro');
			expect(normalizeModel('GPT 5 High (ChatGPT Subscription)')).toBe('gpt-5.4');
			expect(normalizeModel('GPT 5 Codex Low (ChatGPT Subscription)')).toBe('gpt-5-codex');
		});
	});

	describe('getModelConfig', () => {
		describe('Per-model options (Bug Fix Verification)', () => {
			it('should find per-model options using config key', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5-codex-low': {
							options: { reasoningEffort: 'low', textVerbosity: 'low' }
						}
					}
				};

				const result = getModelConfig('gpt-5-codex-low', userConfig);
				expect(result.reasoningEffort).toBe('low');
				expect(result.textVerbosity).toBe('low');
			});

			it('should resolve provider-prefixed model ids to base model config', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5.2-codex': {
							options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
						},
					},
				};

				const result = getModelConfig('openai/gpt-5.2-codex', userConfig);
				expect(result.reasoningEffort).toBe('xhigh');
				expect(result.reasoningSummary).toBe('detailed');
			});

			it('should apply variants from modern base-model config when variant suffix is used', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
					models: {
						'gpt-5.2-codex': {
							options: { reasoningSummary: 'auto' },
							variants: {
								xhigh: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
							},
						},
					},
				};

				const result = getModelConfig('openai/gpt-5.2-codex-xhigh', userConfig);
				expect(result.reasoningEffort).toBe('xhigh');
				expect(result.reasoningSummary).toBe('detailed');
			});

			it('should merge global and per-model options (per-model wins)', async () => {
				const userConfig: UserConfig = {
					global: {
						reasoningEffort: 'medium',
						textVerbosity: 'medium',
						include: ['reasoning.encrypted_content']
					},
					models: {
						'gpt-5-codex-high': {
							options: { reasoningEffort: 'high' }  // Override only effort
						}
					}
				};

				const result = getModelConfig('gpt-5-codex-high', userConfig);
				expect(result.reasoningEffort).toBe('high');  // From per-model
				expect(result.textVerbosity).toBe('medium');  // From global
				expect(result.include).toEqual(['reasoning.encrypted_content']);  // From global
			});

			it('should return global options when model not in config', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5-codex-low': { options: { reasoningEffort: 'low' } }
					}
				};

				// Looking up different model
				const result = getModelConfig('gpt-5-codex', userConfig);
				expect(result.reasoningEffort).toBe('medium');  // Global only
			});

			it('should handle empty config', async () => {
				const result = getModelConfig('gpt-5-codex', { global: {}, models: {} });
				expect(result).toEqual({});
			});

			it('should handle missing models object', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'low' },
					models: undefined as any
				};
				const result = getModelConfig('gpt-5', userConfig);
				expect(result.reasoningEffort).toBe('low');
			});
		});

		describe('Backwards compatibility', () => {
			it('should work with old verbose config keys', async () => {
				const userConfig: UserConfig = {
					global: {},
					models: {
						'GPT 5 Codex Low (ChatGPT Subscription)': {
							options: { reasoningEffort: 'low' }
						}
					}
				};

				const result = getModelConfig('GPT 5 Codex Low (ChatGPT Subscription)', userConfig);
				expect(result.reasoningEffort).toBe('low');
			});

			it('should work with old configs that have id field', async () => {
				const userConfig: UserConfig = {
					global: {},
					models: {
						'gpt-5-codex-low': {
							id: 'gpt-5-codex',  // id field present but should be ignored
							options: { reasoningEffort: 'low' }
						}
					}
				};

				const result = getModelConfig('gpt-5-codex-low', userConfig);
				expect(result.reasoningEffort).toBe('low');
			});
		});

		describe('Default models (no custom config)', () => {
			it('should return global options for default gpt-5-codex', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'high' },
					models: {}
				};

				const result = getModelConfig('gpt-5-codex', userConfig);
				expect(result.reasoningEffort).toBe('high');
			});

			it('should return empty when no config at all', async () => {
				const result = getModelConfig('gpt-5', undefined);
				expect(result).toEqual({});
			});
		});
	});

	describe('filterInput', () => {
		it('should keep items without IDs unchanged', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterInput(input);
			expect(result).toEqual(input);
			expect(result![0]).not.toHaveProperty('id');
		});

		it('should remove ALL message IDs (rs_, msg_, etc.) for store:false compatibility', async () => {
			const input: InputItem[] = [
				{ id: 'rs_123', type: 'message', role: 'assistant', content: 'hello' },
				{ id: 'msg_456', type: 'message', role: 'user', content: 'world' },
				{ id: 'assistant_789', type: 'message', role: 'assistant', content: 'test' },
			];
			const result = filterInput(input);

			// All items should remain (no filtering), but ALL IDs removed
			expect(result).toHaveLength(3);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![1]).not.toHaveProperty('id');
			expect(result![2]).not.toHaveProperty('id');
			expect(result![0].content).toBe('hello');
			expect(result![1].content).toBe('world');
			expect(result![2].content).toBe('test');
		});

		it('should strip ID field but preserve all other properties', async () => {
			const input: InputItem[] = [
				{
					id: 'msg_123',
					type: 'message',
					role: 'user',
					content: 'test',
					metadata: { some: 'data' }
				},
			];
			const result = filterInput(input);

			expect(result).toHaveLength(1);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![0].type).toBe('message');
			expect(result![0].role).toBe('user');
			expect(result![0].content).toBe('test');
			expect(result![0]).toHaveProperty('metadata');
		});

		it('should handle mixed items with and without IDs', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: '1' },
				{ id: 'rs_stored', type: 'message', role: 'assistant', content: '2' },
				{ id: 'msg_123', type: 'message', role: 'user', content: '3' },
			];
			const result = filterInput(input);

			// All items kept, IDs removed from items that had them
			expect(result).toHaveLength(3);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![1]).not.toHaveProperty('id');
			expect(result![2]).not.toHaveProperty('id');
			expect(result![0].content).toBe('1');
			expect(result![1].content).toBe('2');
			expect(result![2].content).toBe('3');
		});

			it('should handle custom ID formats (future-proof)', async () => {
				const input: InputItem[] = [
					{ id: 'custom_id_format', type: 'message', role: 'user', content: 'test' },
					{ id: 'another-format-123', type: 'message', role: 'user', content: 'test2' },
				];
				const result = filterInput(input);

				expect(result).toHaveLength(2);
				expect(result![0]).not.toHaveProperty('id');
				expect(result![1]).not.toHaveProperty('id');
			});

			it('should skip sparse entries without throwing', async () => {
				const sparse = new Array<InputItem | undefined>(3);
				sparse[0] = { id: 'msg_1', type: 'message', role: 'user', content: 'test' };
				sparse[2] = { id: 'msg_2', type: 'message', role: 'assistant', content: 'reply' };

				const result = filterInput(sparse as InputItem[]);

				expect(result).toHaveLength(2);
				expect(result![0]).not.toHaveProperty('id');
				expect(result![1]).not.toHaveProperty('id');
			});

			it('should return undefined for undefined input', async () => {
				expect(filterInput(undefined)).toBeUndefined();
			});

			it('should remove empty-string id values', async () => {
				const input: InputItem[] = [
					{ id: '', type: 'message', role: 'user', content: 'hello' },
				];
				const result = filterInput(input);

				expect(result).toHaveLength(1);
				expect(result![0]).not.toHaveProperty('id');
			});

		it('should return non-array input as-is', async () => {
			const notArray = { notAnArray: true };
			expect(filterInput(notArray as any)).toBe(notArray);
		});

		it('should handle empty array', async () => {
			const input: InputItem[] = [];
			const result = filterInput(input);
			expect(result).toEqual([]);
		});
	});

	describe('addToolRemapMessage', () => {
		it('should prepend tool remap message when tools present', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = addToolRemapMessage(input, true);

			expect(result).toHaveLength(2);
			expect(result![0].role).toBe('developer');
			expect(result![0].type).toBe('message');
			expect((result![0].content as any)[0].text).toContain('apply_patch');
			expect((result![0].content as any)[0].text).toContain('patch (preferred if available)');
		});

		it('should not modify input when tools not present', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = addToolRemapMessage(input, false);
			expect(result).toEqual(input);
		});

		it('should return undefined for undefined input', async () => {
			expect(addToolRemapMessage(undefined, true)).toBeUndefined();
		});

		it('should handle non-array input', async () => {
			const notArray = { notAnArray: true };
			expect(addToolRemapMessage(notArray as any, true)).toBe(notArray);
		});
	});

	describe('isHostSystemPrompt', () => {
		it('should detect host system prompt with string content', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: 'You are a coding agent running in the Codex, a terminal-based coding assistant.',
			};
			expect(isHostSystemPrompt(item, null)).toBe(true);
		});

		it('should detect host system prompt with array content', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: [
					{
						type: 'input_text',
						text: 'You are a coding agent running in the Codex, a terminal-based coding assistant.',
					},
				],
			};
			expect(isHostSystemPrompt(item, null)).toBe(true);
		});

		it('should detect with system role', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'system',
				content: 'You are a coding agent running in the Codex, a terminal-based coding assistant.',
			};
			expect(isHostSystemPrompt(item, null)).toBe(true);
		});

		it('should not detect non-system roles', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'user',
				content: 'You are a coding agent running in the Codex, a terminal-based coding assistant.',
			};
			expect(isHostSystemPrompt(item, null)).toBe(false);
		});

		it('should not detect different content', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: 'Different message',
			};
			expect(isHostSystemPrompt(item, null)).toBe(false);
		});

		it('should NOT detect AGENTS.md content', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: '# Project Guidelines\n\nThis is custom AGENTS.md content for the project.',
			};
			expect(isHostSystemPrompt(item, null)).toBe(false);
		});

		it('should NOT detect environment info concatenated with AGENTS.md', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: 'Environment: /path/to/project\nDate: 2025-01-01\n\n# AGENTS.md\n\nCustom instructions here.',
			};
			expect(isHostSystemPrompt(item, null)).toBe(false);
		});

		it('should NOT detect content with codex signature in the middle', async () => {
			const cachedPrompt = 'You are a coding agent running in the Codex.';
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				// Has codex.txt content but with environment prepended (like Codex does)
				content: 'Environment info here\n\nYou are a coding agent running in the Codex.',
			};
			// First 200 chars won't match because of prepended content
			expect(isHostSystemPrompt(item, cachedPrompt)).toBe(false);
		});

		it('should detect with cached prompt exact match', async () => {
			const cachedPrompt = 'You are a coding agent running in the Codex';
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: 'You are a coding agent running in the Codex',
			};
			expect(isHostSystemPrompt(item, cachedPrompt)).toBe(true);
		});

		it('should detect alternative Codex prompt signatures', async () => {
			const item: InputItem = {
				type: 'message',
				role: 'developer',
				content: "You are Codex, an agent - please keep going until the user's query is completely resolved.",
			};
			expect(isHostSystemPrompt(item, null)).toBe(true);
		});
	});

	describe('filterHostSystemPrompts', () => {
		it('should filter out host system prompts', async () => {
			const input: InputItem[] = [
				{
					type: 'message',
					role: 'developer',
					content: 'You are a coding agent running in the Codex',
				},
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterHostSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(1);
			expect(result![0].role).toBe('user');
		});

		it('should keep user messages', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'message 1' },
				{ type: 'message', role: 'user', content: 'message 2' },
			];
			const result = filterHostSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(2);
		});

		it('should keep non-host developer messages', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'developer', content: 'Custom instruction' },
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterHostSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(2);
		});

		it('should keep AGENTS.md content (not filter it)', async () => {
			const input: InputItem[] = [
				{
					type: 'message',
					role: 'developer',
					content: 'You are a coding agent running in the Codex', // This is codex.txt
				},
				{
					type: 'message',
					role: 'developer',
					content: '# Project Guidelines\n\nThis is AGENTS.md content.', // This is AGENTS.md
				},
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterHostSystemPromptsWithCachedPrompt(input, null);
			// Should filter codex.txt but keep AGENTS.md
			expect(result).toHaveLength(2);
			expect(result![0].content).toContain('AGENTS.md');
			expect(result![1].role).toBe('user');
		});

		it('should strip Codex prompt but keep concatenated env/instructions', async () => {
			const input: InputItem[] = [
				{
					type: 'message',
					role: 'developer',
					content: [
						'You are a coding agent running in the Codex, a terminal-based coding assistant.',
						'Here is some useful information about the environment you are running in:',
						'<env>',
						'  Working directory: /path/to/project',
						'</env>',
						'Instructions from: /path/to/AGENTS.md',
						'# Project Guidelines',
					].join('\n'),
				},
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterHostSystemPromptsWithCachedPrompt(input, null);
			expect(result).toHaveLength(2);
			const preserved = String(result![0].content);
			expect(preserved).toContain('Here is some useful information about the environment');
			expect(preserved).toContain('Instructions from: /path/to/AGENTS.md');
			expect(preserved).not.toContain('You are a coding agent running in the Codex');
		});

		it('should keep environment+AGENTS.md concatenated message', async () => {
			const input: InputItem[] = [
				{
					type: 'message',
					role: 'developer',
					content: 'You are a coding agent running in the Codex', // codex.txt alone
				},
				{
					type: 'message',
					role: 'developer',
					// environment + AGENTS.md joined (like Codex does)
					content: 'Working directory: /path/to/project\nDate: 2025-01-01\n\n# AGENTS.md\n\nCustom instructions.',
				},
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterHostSystemPromptsWithCachedPrompt(input, null);
			// Should filter first message (codex.txt) but keep second (env+AGENTS.md)
			expect(result).toHaveLength(2);
			expect(result![0].content).toContain('AGENTS.md');
			expect(result![1].role).toBe('user');
		});

		it('should return undefined for undefined input', async () => {
			expect(await filterHostSystemPrompts(undefined)).toBeUndefined();
		});
	});

	describe('addCodexBridgeMessage', () => {
		it('should prepend bridge message when tools present', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = addCodexBridgeMessage(input, true);

			expect(result).toHaveLength(2);
			expect(result![0].role).toBe('developer');
			expect(result![0].type).toBe('message');
			expect((result![0].content as any)[0].text).toContain(CODEX_HOST_BRIDGE);
		});

		it('should not modify input when tools not present', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = addCodexBridgeMessage(input, false);
			expect(result).toEqual(input);
		});

		it('should return undefined for undefined input', async () => {
			expect(addCodexBridgeMessage(undefined, true)).toBeUndefined();
		});
	});

		describe('transformRequestBody', () => {
			const codexInstructions = 'Test Codex Instructions';

			it('preserves existing prompt_cache_key passed by host (Codex)', async () => {
				const body: RequestBody = {
					model: 'gpt-5-codex',
					input: [],
					// Host-provided key (Codex session id)
					prompt_cache_key: 'ses_host_key_123',
				};
				const result: any = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_key).toBe('ses_host_key_123');
			});

			it('leaves prompt_cache_key unset when host does not supply one', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [],
				};
				const result: any = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_key).toBeUndefined();
			});

			it('preserves host-provided previous_response_id', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: [],
					previous_response_id: 'resp_prior_123',
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.previous_response_id).toBe('resp_prior_123');
			});

			it('preserves prompt_cache_retention settings', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: [],
					prompt_cache_key: 'ses_cache_key_123',
					prompt_cache_retention: '24h',
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_key).toBe('ses_cache_key_123');
				expect(result.prompt_cache_retention).toBe('24h');
			});

			it('uses prompt_cache_retention from providerOptions when body omits it', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: [],
					providerOptions: {
						openai: {
							promptCacheRetention: '1h',
						},
					},
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_retention).toBe('1h');
			});

			it('prefers providerOptions prompt_cache_retention over user config defaults', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: [],
					providerOptions: {
						openai: {
							promptCacheRetention: '1h',
						},
					},
				};
				const userConfig: UserConfig = {
					global: { promptCacheRetention: '7d' },
					models: {},
				};
				const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.prompt_cache_retention).toBe('1h');
			});

			it('prefers body prompt_cache_retention over providerOptions', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: [],
					prompt_cache_retention: '24h',
					providerOptions: {
						openai: {
							promptCacheRetention: '1h',
						},
					},
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_retention).toBe('24h');
			});

			it('preserves text.format when applying text verbosity defaults', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: [],
					text: {
						format: {
							type: 'json_schema',
							name: 'contract_response',
							schema: {
								type: 'object',
								properties: {
									answer: { type: 'string' },
								},
								required: ['answer'],
							},
							strict: true,
						},
					},
				};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('medium');
			expect(result.text?.format).toEqual(body.text?.format);
		});

			it('defers fast-session input trimming when requested for downstream compaction', async () => {
				const body: RequestBody = {
					model: 'gpt-5.4',
					input: Array.from({ length: 12 }, (_value, index) => ({
						type: 'message',
						role: index === 0 ? 'developer' : 'user',
						content: index === 0 ? 'system prompt' : `message-${index}`,
					})),
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					{ global: {}, models: {} },
					true,
					true,
					'always',
					8,
					true,
				);
				expect(result.input).toHaveLength(12);
			});

		it('should set required Codex fields', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);

			expect(result.store).toBe(false);
			expect(result.stream).toBe(true);
			expect(result.instructions).toBe(codexInstructions);
		});

		it('should normalize model name', async () => {
			const body: RequestBody = {
				model: 'gpt-5-mini',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.model).toBe('gpt-5-mini');
		});

		it('should apply default reasoning config', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);

			expect(result.reasoning?.effort).toBe('medium');
			expect(result.reasoning?.summary).toBe('auto');
		});

		it('should clamp reasoning/text for fast session on codex models', async () => {
			const body: RequestBody = {
				model: 'gpt-5.3-codex',
				input: [],
				reasoning: { effort: 'xhigh', summary: 'detailed' },
				text: { verbosity: 'high' },
			};
			const result = await transformRequestBody(
				body,
				codexInstructions,
				undefined,
				true,
				true,
			);

			expect(result.reasoning?.effort).toBe('low');
			expect(result.reasoning?.summary).toBe('auto');
			expect(result.text?.verbosity).toBe('low');
		});

		it('should allow none reasoning for fast session on gpt-5.1 general', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1',
				input: [],
				reasoning: { effort: 'high', summary: 'auto' },
			};
			const result = await transformRequestBody(
				body,
				codexInstructions,
				undefined,
				true,
				true,
			);

			expect(result.reasoning?.effort).toBe('none');
			expect(result.reasoning?.summary).toBe('auto');
			expect(result.text?.verbosity).toBe('low');
		});

			it('should keep full-depth settings for complex prompts in hybrid strategy', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{
							type: 'message',
							role: 'user',
							content:
								'Please handle this request in depth:\n1. Inspect auth flow state transitions.\n2. Compare retry and backoff behavior.\n3. Explain likely failure modes.\n4. Propose fixes with tradeoffs.',
						},
					],
					tools: [{ type: 'function', function: { name: 'read_file' } }],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
			const result = await transformRequestBody(
				body,
				codexInstructions,
				undefined,
				true,
				true,
				'hybrid',
			);

			expect(result.reasoning?.effort).toBe('xhigh');
				expect(result.reasoning?.summary).toBe('detailed');
				expect(result.text?.verbosity).toBe('high');
			});

			it('should compact long instructions for trivial turns in hybrid strategy', async () => {
				const longInstructions = 'RULES\n' + 'x'.repeat(5000);
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [{ type: 'message', role: 'user', content: 'hi' }],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
				};
				const result = await transformRequestBody(
					body,
					longInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.instructions?.length ?? 0).toBeLessThan(longInstructions.length);
				expect(result.instructions).toContain('Fast session mode');
				expect(result.reasoning?.summary).toBe('auto');
			});

			it('should keep long instructions for complex turns in hybrid strategy', async () => {
				const longInstructions = 'RULES\n' + 'x'.repeat(5000);
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{
							type: 'message',
							role: 'user',
							content:
								'Please perform deep analysis:\n1. inspect auth flow\n2. inspect retries\n3. explain tradeoffs',
						},
					],
				};
				const result = await transformRequestBody(
					body,
					longInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.instructions).toBe(longInstructions);
			});

			it('should apply fast settings for simple prompts in hybrid strategy even with tools available', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{ type: 'message', role: 'user', content: 'hi' },
					],
					tools: [{ type: 'function', function: { name: 'read_file' } }],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.reasoning?.effort).toBe('low');
				expect(result.reasoning?.summary).toBe('auto');
				expect(result.text?.verbosity).toBe('low');
				expect(result.tools).toBeUndefined();
			});

			it('should keep fast settings for short multi-turn chat in hybrid strategy', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{ type: 'message', role: 'user', content: 'hi' },
						{ type: 'message', role: 'assistant', content: 'hey' },
						{ type: 'message', role: 'user', content: 'yo' },
						{ type: 'message', role: 'assistant', content: 'sup' },
						{ type: 'message', role: 'user', content: 'ok' },
					],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.reasoning?.effort).toBe('low');
				expect(result.reasoning?.summary).toBe('auto');
				expect(result.text?.verbosity).toBe('low');
			});

			it('should drop medium-length head scaffolds for trivial turns in fast mode', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{ type: 'message', role: 'developer', content: `HEAD ${'x'.repeat(700)}` },
						{ type: 'message', role: 'user', content: 'hello' },
					],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				const hasHeadScaffold = (result.input ?? []).some((item) => {
					if (item.role !== 'developer') return false;
					const content = item.content;
					if (typeof content === 'string') return content.includes('HEAD');
					if (Array.isArray(content)) {
						return content.some((part) => {
							if (!part || typeof part !== 'object') return false;
							const textPart = (part as { text?: unknown }).text;
							return typeof textPart === 'string' && textPart.includes('HEAD');
						});
					}
					return false;
				});

				expect(hasHeadScaffold).toBe(false);
				expect(result.reasoning?.summary).toBe('auto');
			});

			it('should ultra-compact trivial turns in hybrid strategy across model variants', async () => {
				const history = Array.from({ length: 18 }, (_v, i) => ({
					type: 'message',
					role: i % 2 === 0 ? 'assistant' : 'user',
					content: `history-${i}`,
				}));
				const body: RequestBody = {
					model: 'gpt-5.1',
					input: [
						{ type: 'message', role: 'developer', content: 'Small stable scaffold' },
						...history,
						{ type: 'message', role: 'user', content: 'yo' },
					],
					reasoning: { effort: 'high', summary: 'auto' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
					8,
				);

				expect(result.input?.length).toBeLessThanOrEqual(2);
				const latestUser = [...(result.input ?? [])]
					.reverse()
					.find((item) => item.role === 'user');
				expect(latestUser?.content).toBe('yo');
				expect(result.reasoning?.summary).toBe('auto');
				expect(result.text?.verbosity).toBe('low');
			});

			it('should apply fast settings in hybrid strategy when developer scaffold is long but user prompt is simple', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{ type: 'message', role: 'developer', content: `SYSTEM ${'x'.repeat(4000)}` },
						{ type: 'message', role: 'user', content: 'hi' },
					],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.reasoning?.effort).toBe('low');
				expect(result.reasoning?.summary).toBe('auto');
				expect(result.text?.verbosity).toBe('low');
				const containsHugeScaffold = (result.input ?? []).some((item) => {
					if (item.role !== 'developer') return false;
					const content = item.content;
					if (typeof content === 'string') return content.includes('SYSTEM xxxx');
					if (Array.isArray(content)) {
						return content.some((part) => {
							if (!part || typeof part !== 'object') return false;
							const textPart = (part as { text?: unknown }).text;
							return typeof textPart === 'string' && textPart.includes('SYSTEM xxxx');
						});
					}
					return false;
				});
				expect(containsHugeScaffold).toBe(false);
			});

			it('should apply fast settings in hybrid strategy when tool history is old but recent turn is simple', async () => {
				const oldToolCall = { type: 'function_call_output', call_id: 'old_1', name: 'read_file', output: '{}' } as any;
				const fillerMessages = Array.from({ length: 20 }, (_v, i) => ({
					type: 'message',
					role: i % 2 === 0 ? 'assistant' : 'user',
					content: `filler-${i}`,
				}));
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						oldToolCall,
						...fillerMessages,
						{ type: 'message', role: 'user', content: 'hi' },
					],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.reasoning?.effort).toBe('low');
				expect(result.reasoning?.summary).toBe('auto');
				expect(result.text?.verbosity).toBe('low');
			});

			it('should keep full-depth settings in hybrid strategy when recent tool-call history exists', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{ type: 'message', role: 'user', content: 'quick check' },
						{ type: 'function_call_output', call_id: 'recent_1', name: 'read_file', output: '{}' } as any,
					],
					tools: [{ type: 'function', function: { name: 'read_file' } }],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.reasoning?.effort).toBe('xhigh');
				expect(result.reasoning?.summary).toBe('detailed');
				expect(result.text?.verbosity).toBe('high');
				expect(result.tools).toEqual([{ type: 'function', function: { name: 'read_file' } }]);
			});

			it('should apply fast settings in hybrid strategy when latest user prompt is trivial even if previous user prompt was complex', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{
							type: 'message',
							role: 'user',
							content:
								'Please analyze this thoroughly:\n- identify failure paths\n- map dependencies\n- suggest mitigations\n- call out risks',
						},
						{ type: 'message', role: 'assistant', content: 'Understood.' },
						{ type: 'message', role: 'user', content: 'hi' },
					],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'hybrid',
				);

				expect(result.reasoning?.effort).toBe('low');
				expect(result.reasoning?.summary).toBe('auto');
				expect(result.text?.verbosity).toBe('low');
			});

			it('should compact long context without overriding universal instructions in always strategy', async () => {
				const history = Array.from({ length: 24 }, (_v, i) => ({
					type: 'message',
					role: i % 2 === 0 ? 'assistant' : 'user',
					content: `history-${i}`,
				}));
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
						{ type: 'message', role: 'developer', content: 'Core instruction scaffold' },
						...history,
						{ type: 'message', role: 'user', content: 'hi' },
					],
					reasoning: { effort: 'xhigh', summary: 'detailed' },
					text: { verbosity: 'high' },
				};
				const result = await transformRequestBody(
					body,
					codexInstructions,
					undefined,
					true,
					true,
					'always',
					12,
				);

				expect(result.input?.length).toBeLessThanOrEqual(12);
				const lastUser = [...(result.input ?? [])]
					.reverse()
					.find((item) => item.role === 'user');
				expect(lastUser?.content).toBe('hi');
				expect(result.instructions).toBe(codexInstructions);
				expect(result.reasoning?.effort).toBe('low');
				expect(result.text?.verbosity).toBe('low');
			});

			it('should force fast settings for complex prompts in always strategy', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [
					{
						type: 'message',
						role: 'user',
						content:
							'Please perform a full review:\n1. inspect account rotation\n2. inspect refresh queue\n3. inspect retry windows\n4. summarize issues and improvements',
					},
				],
				tools: [{ type: 'function', function: { name: 'read_file' } }],
				reasoning: { effort: 'xhigh', summary: 'detailed' },
				text: { verbosity: 'high' },
			};
			const result = await transformRequestBody(
				body,
				codexInstructions,
				undefined,
				true,
				true,
				'always',
			);

			expect(result.reasoning?.effort).toBe('low');
			expect(result.reasoning?.summary).toBe('auto');
			expect(result.text?.verbosity).toBe('low');
			expect(result.tools).toEqual([{ type: 'function', function: { name: 'read_file' } }]);
		});

		it('should disable tools for trivial turns in always strategy', async () => {
			const body: RequestBody = {
				model: 'gpt-5.3-codex',
				input: [{ type: 'message', role: 'user', content: 'hi' }],
				tools: [{ type: 'function', function: { name: 'read_file' } }],
				reasoning: { effort: 'xhigh', summary: 'detailed' },
				text: { verbosity: 'high' },
			};
			const result = await transformRequestBody(
				body,
				codexInstructions,
				undefined,
				true,
				true,
				'always',
			);

			expect(result.reasoning?.effort).toBe('low');
			expect(result.reasoning?.summary).toBe('auto');
			expect(result.text?.verbosity).toBe('low');
			expect(result.tools).toBeUndefined();
		});

		it('should apply user reasoning config', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: {
					reasoningEffort: 'high',
					reasoningSummary: 'detailed',
				},
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);

			expect(result.reasoning?.effort).toBe('high');
			expect(result.reasoning?.summary).toBe('detailed');
		});

		it('should respect reasoning config already set in body', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				reasoning: {
					effort: 'low',
					summary: 'auto',
				},
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);

			expect(result.reasoning?.effort).toBe('low');
			expect(result.reasoning?.summary).toBe('auto');
		});

		it('should use reasoning config from providerOptions when present', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				providerOptions: {
					openai: {
						reasoningEffort: 'high',
						reasoningSummary: 'detailed',
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions);

			expect(result.reasoning?.effort).toBe('high');
			expect(result.reasoning?.summary).toBe('detailed');
		});

		it('should apply default text verbosity', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('medium');
		});

		it('should apply user text verbosity', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { textVerbosity: 'low' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.text?.verbosity).toBe('low');
		});

		it('should use text verbosity from providerOptions when present', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				providerOptions: {
					openai: {
						textVerbosity: 'low',
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('low');
		});

		it('should inherit prompt_cache_retention from user config', async () => {
			const body: RequestBody = {
				model: 'gpt-5.4',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { promptCacheRetention: '7d' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.prompt_cache_retention).toBe('7d');
		});

		it('should inherit prompt_cache_retention from model-specific user config', async () => {
			const body: RequestBody = {
				model: 'gpt-5.4',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { promptCacheRetention: '7d' },
				models: {
					'gpt-5.4': {
						options: { promptCacheRetention: '24h' },
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.prompt_cache_retention).toBe('24h');
		});

		it('should inherit model-specific prompt_cache_retention in named params overload', async () => {
			const userConfig: UserConfig = {
				global: { promptCacheRetention: '7d' },
				models: {
					'gpt-5.4': {
						options: { promptCacheRetention: '24h' },
					},
				},
			};
			const result = await transformRequestBody({
				body: {
					model: 'gpt-5.4',
					input: [],
				},
				codexInstructions,
				userConfig,
			});
			expect(result.prompt_cache_retention).toBe('24h');
		});

		it('should prefer body text verbosity over providerOptions', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				text: { verbosity: 'high' },
				providerOptions: {
					openai: {
						textVerbosity: 'low',
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('high');
		});

		it('should set default include for encrypted reasoning', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.include).toEqual(['reasoning.encrypted_content']);
		});

		it('should use user-configured include', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { include: ['custom_field', 'reasoning.encrypted_content'] },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.include).toEqual(['custom_field', 'reasoning.encrypted_content']);
		});

		it('should always include reasoning.encrypted_content when include provided', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				include: ['custom_field'],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.include).toEqual(['custom_field', 'reasoning.encrypted_content']);
		});

		it('should remove IDs from input array (keep all items, strip IDs)', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [
					{ id: 'rs_123', type: 'message', role: 'assistant', content: 'old' },
					{ type: 'message', role: 'user', content: 'new' },
				],
			};
			const result = await transformRequestBody(body, codexInstructions);

			// All items kept, IDs removed
			expect(result.input).toHaveLength(2);
			expect(result.input![0]).not.toHaveProperty('id');
			expect(result.input![1]).not.toHaveProperty('id');
			expect(result.input![0].content).toBe('old');
			expect(result.input![1].content).toBe('new');
		});

		it('should add tool remap message when tools present', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [{ type: 'message', role: 'user', content: 'hello' }],
				tools: [{ name: 'test_tool' }],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.input![0].role).toBe('developer');
		});

		it('should not add tool remap message when tools absent', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [{ type: 'message', role: 'user', content: 'hello' }],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.input![0].role).toBe('user');
		});

		it('should remove unsupported parameters', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				max_output_tokens: 1000,
				max_completion_tokens: 2000,
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.max_output_tokens).toBeUndefined();
			expect(result.max_completion_tokens).toBeUndefined();
		});

		it('should normalize minimal to low for gpt-5-codex', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'minimal' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should clamp xhigh to high for codex-mini', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-mini-high',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'xhigh' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should clamp none to medium for codex-mini', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-mini-medium',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('medium');
		});

		it('should default codex-max to high effort', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-max',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.reasoning?.effort).toBe('high');
		});

			it('should default gpt-5.2-codex to high effort after canonicalization', async () => {
				const body: RequestBody = {
					model: 'gpt-5.2-codex',
					input: [],
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('high');
			});

			it('should default gpt-5.3-codex to high effort after canonicalization', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [],
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('high');
			});

			it('should default gpt-5.3-codex-spark to high effort after canonicalization', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex-spark',
					input: [],
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('high');
			});

		it('should preserve xhigh for codex-max when requested', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-max-xhigh',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningSummary: 'auto' },
				models: {
					'gpt-5.1-codex-max-xhigh': {
						options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1-codex-max');
			expect(result.reasoning?.effort).toBe('xhigh');
			expect(result.reasoning?.summary).toBe('detailed');
		});

			it('should preserve requested xhigh for gpt-5.2-codex', async () => {
				const body: RequestBody = {
					model: 'gpt-5.2-codex-xhigh',
					input: [],
				};
			const userConfig: UserConfig = {
				global: { reasoningSummary: 'auto' },
				models: {
					'gpt-5.2-codex-xhigh': {
						options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('xhigh');
				expect(result.reasoning?.summary).toBe('detailed');
			});

			it('should preserve requested xhigh for gpt-5.3-codex', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex-xhigh',
					input: [],
				};
				const userConfig: UserConfig = {
					global: { reasoningSummary: 'auto' },
					models: {
						'gpt-5.3-codex-xhigh': {
							options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
						},
					},
				};
				const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('xhigh');
				expect(result.reasoning?.summary).toBe('detailed');
			}, 10_000);

		it('should preserve xhigh for non-max codex when the normalized model supports it', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-high',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'xhigh' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5-codex');
			expect(result.reasoning?.effort).toBe('xhigh');
		});

		it('should downgrade xhigh to high for non-max general models', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-high',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'xhigh' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1');
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should preserve none for GPT-5.2', async () => {
			const body: RequestBody = {
				model: 'gpt-5.2-none',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.2');
			expect(result.reasoning?.effort).toBe('none');
		});

			it('should upgrade none to low for GPT-5.2-codex (codex does not support none)', async () => {
				const body: RequestBody = {
					model: 'gpt-5.2-codex',
					input: [],
				};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('low');
			});

			it('should upgrade none to low for GPT-5.3-codex (codex does not support none)', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [],
				};
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'none' },
					models: {},
				};
				const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('low');
			});

			it('should upgrade none to low for GPT-5.3-codex-spark (codex does not support none)', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex-spark',
					input: [],
				};
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'none' },
					models: {},
				};
				const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('low');
			});

			it('should normalize minimal to low for gpt-5.2-codex', async () => {
				const body: RequestBody = {
					model: 'gpt-5.2-codex',
					input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'minimal' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('low');
			});

			it('should normalize minimal to low for gpt-5.3-codex', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [],
				};
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'minimal' },
					models: {},
				};
				const result = await transformRequestBody(body, codexInstructions, userConfig);
				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('low');
			});

		it('should preserve none for GPT-5.1 general purpose', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-none',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1');
			expect(result.reasoning?.effort).toBe('none');
		});

		it('should upgrade none to low for GPT-5.1-codex (codex does not support none)', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5-codex');
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should upgrade none to medium for GPT-5.1-codex-max (codex max does not support none)', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-max',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1-codex-max');
			expect(result.reasoning?.effort).toBe('medium');
		});

		it('should preserve minimal for non-codex models', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'minimal' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('minimal');
		});

		it('should use minimal effort for lightweight models', async () => {
			const body: RequestBody = {
				model: 'gpt-5-nano',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.reasoning?.effort).toBe('medium');
		});

		it('should convert orphaned function_call_output to message to preserve context', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{ type: 'function_call_output', role: 'assistant', call_id: 'orphan_call', name: 'read', output: '{}' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.tools).toBeUndefined();
			expect(result.input).toHaveLength(2);
			expect(result.input![0].type).toBe('message');
			expect(result.input![1].type).toBe('message');
			expect(result.input![1].role).toBe('assistant');
			expect(result.input![1].content).toContain('[Previous read result; call_id=orphan_call]');
		});

		it('should keep matched function_call pairs when no tools present (for compaction)', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{ type: 'function_call', call_id: 'call_1', name: 'write', arguments: '{}' } as any,
					{ type: 'function_call_output', call_id: 'call_1', output: 'success' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.tools).toBeUndefined();
			expect(result.input).toHaveLength(3);
			expect(result.input![1].type).toBe('function_call');
			expect(result.input![2].type).toBe('function_call_output');
		});

		it('should treat local_shell_call as a match for function_call_output', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{
						type: 'local_shell_call',
						call_id: 'shell_call',
						action: { type: 'exec', command: ['ls'] },
					} as any,
					{ type: 'function_call_output', call_id: 'shell_call', output: 'ok' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.input).toHaveLength(3);
			expect(result.input![1].type).toBe('local_shell_call');
			expect(result.input![2].type).toBe('function_call_output');
		});

		it('should keep matching custom_tool_call_output items', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{
						type: 'custom_tool_call',
						call_id: 'custom_call',
						name: 'mcp_tool',
						input: '{}',
					} as any,
					{ type: 'custom_tool_call_output', call_id: 'custom_call', output: 'done' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.input).toHaveLength(3);
			expect(result.input![1].type).toBe('custom_tool_call');
			expect(result.input![2].type).toBe('custom_tool_call_output');
		});

		it('should convert orphaned custom_tool_call_output to message', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{ type: 'custom_tool_call_output', call_id: 'orphan_custom', output: 'oops' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.input).toHaveLength(2);
			expect(result.input![1].type).toBe('message');
			expect(result.input![1].content).toContain('[Previous tool result; call_id=orphan_custom]');
		});

		describe('CODEX_MODE parameter', () => {
			it('should use bridge message when codexMode=true and tools present (default)', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [{ type: 'message', role: 'user', content: 'hello' }],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions, undefined, true);

				expect(result.input).toHaveLength(2);
				expect(result.input![0].role).toBe('developer');
				expect((result.input![0].content as any)[0].text).toContain(CODEX_HOST_BRIDGE);
			});

			it('should filter Codex prompts when codexMode=true', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [
						{
							type: 'message',
							role: 'developer',
							content: 'You are a coding agent running in the Codex',
						},
						{ type: 'message', role: 'user', content: 'hello' },
					],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions, undefined, true);

				// Should have bridge message + user message (Codex prompt filtered out)
				expect(result.input).toHaveLength(2);
				expect(result.input![0].role).toBe('developer');
				expect((result.input![0].content as any)[0].text).toContain(CODEX_HOST_BRIDGE);
				expect(result.input![1].role).toBe('user');
			});

			it('should not add bridge message when codexMode=true but no tools', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [{ type: 'message', role: 'user', content: 'hello' }],
				};
				const result = await transformRequestBody(body, codexInstructions, undefined, true);

				expect(result.input).toHaveLength(1);
				expect(result.input![0].role).toBe('user');
			});

			it('should use tool remap message when codexMode=false', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [{ type: 'message', role: 'user', content: 'hello' }],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions, undefined, false);

				expect(result.input).toHaveLength(2);
				expect(result.input![0].role).toBe('developer');
				expect((result.input![0].content as any)[0].text).toContain('apply_patch');
				expect((result.input![0].content as any)[0].text).toContain('patch (preferred if available)');
			});

			it('should not filter Codex prompts when codexMode=false', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [
						{
							type: 'message',
							role: 'developer',
							content: 'You are a coding agent running in the Codex',
						},
						{ type: 'message', role: 'user', content: 'hello' },
					],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions, undefined, false);

				// Should have tool remap + Codex prompt + user message
				expect(result.input).toHaveLength(3);
				expect(result.input![0].role).toBe('developer');
				expect((result.input![0].content as any)[0].text).toContain('apply_patch');
				expect((result.input![0].content as any)[0].text).toContain('patch (preferred if available)');
				expect(result.input![1].role).toBe('developer');
				expect(result.input![2].role).toBe('user');
			});

			it('should default to codexMode=true when parameter not provided', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [{ type: 'message', role: 'user', content: 'hello' }],
					tools: [{ name: 'test_tool' }],
				};
				// Not passing codexMode parameter - should default to true
				const result = await transformRequestBody(body, codexInstructions);

				// Should use bridge message (codexMode=true by default)
				expect(result.input![0].role).toBe('developer');
				expect((result.input![0].content as any)[0].text).toContain(CODEX_HOST_BRIDGE);
			});

			it('should remove request_user_input tool in default collaboration mode', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [
						{
							type: 'message',
							role: 'developer',
							content: [{ type: 'input_text', text: '# Collaboration Mode: Default' }],
						},
					],
					tools: [
						{ type: 'function', function: { name: 'request_user_input', parameters: { type: 'object', properties: {} } } },
						{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } },
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				const toolNames = ((result.tools ?? []) as Array<{ function?: { name?: string } }>)
					.map((tool) => tool.function?.name)
					.filter(Boolean);

				expect(toolNames).toEqual(['exec_command']);
			});

			it('should keep request_user_input tool in plan collaboration mode', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [
						{
							type: 'message',
							role: 'developer',
							content: [{ type: 'input_text', text: '# Collaboration Mode: Plan' }],
						},
					],
					tools: [
						{ type: 'function', function: { name: 'request_user_input', parameters: { type: 'object', properties: {} } } },
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				const toolNames = ((result.tools ?? []) as Array<{ function?: { name?: string } }>)
					.map((tool) => tool.function?.name)
					.filter(Boolean);

				expect(toolNames).toEqual(['request_user_input']);
			});

			it('removes nested request_user_input tools outside plan collaboration mode', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [],
					tools: [
						{
							type: 'namespace',
							name: 'planner',
							tools: [
								{ type: 'function', function: { name: 'request_user_input', parameters: { type: 'object', properties: {} } } },
								{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } },
							],
						},
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				expect(result.tools).toEqual([
					{
						type: 'namespace',
						name: 'planner',
						tools: [
							expect.objectContaining({
								type: 'function',
								function: expect.objectContaining({
									name: 'exec_command',
								}),
							}),
						],
					},
				]);
			});

			it('removes tool_search tools when the selected model lacks search capability', async () => {
				const body: RequestBody = {
					model: 'gpt-5-nano',
					input: [],
					tools: [
						{ type: 'tool_search', max_num_results: 3 },
						{
							type: 'mcp',
							server_label: 'docs',
							server_url: 'https://mcp.example.com',
							defer_loading: true,
						},
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				expect(result.tools).toEqual([
					{
						type: 'mcp',
						server_label: 'docs',
						server_url: 'https://mcp.example.com',
						defer_loading: true,
					},
				]);
			});

			it('removes computer tools when the selected model lacks computer-use capability', async () => {
				const body: RequestBody = {
					model: 'gpt-5-nano',
					input: [],
					tools: [
						{
							type: 'computer_use_preview',
							display_width: 1024,
							display_height: 768,
							environment: 'browser',
						},
						{ type: 'tool_search', max_num_results: 1 },
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				expect(result.tools).toBeUndefined();
				expect(result.input).toEqual([]);
			});

			it('filters unsupported namespace tool entries while keeping supported remote MCP tools', async () => {
				const body: RequestBody = {
					model: 'gpt-5-nano',
					input: [],
					tools: [
						{
							type: 'namespace',
							name: 'search_suite',
							tools: [
								{ type: 'tool_search', max_num_results: 2 },
								{
									type: 'mcp',
									server_label: 'remote-docs',
									server_url: 'https://mcp.example.com',
									defer_loading: true,
								},
							],
						},
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				expect(result.tools).toEqual([
					{
						type: 'namespace',
						name: 'search_suite',
						tools: [
							{
								type: 'mcp',
								server_label: 'remote-docs',
								server_url: 'https://mcp.example.com',
								defer_loading: true,
							},
						],
					},
				]);
			});

			it('filters unsupported tools from nested namespaces without dropping supported descendants', async () => {
				const body: RequestBody = {
					model: 'gpt-5-nano',
					input: [],
					tools: [
						{
							type: 'namespace',
							name: 'outer_suite',
							tools: [
								{
									type: 'namespace',
									name: 'inner_suite',
									tools: [
										{ type: 'tool_search', max_num_results: 2 },
										{
											type: 'mcp',
											server_label: 'remote-docs',
											server_url: 'https://mcp.example.com',
											defer_loading: true,
										},
									],
								},
							],
						},
					] as any,
				};

				const result = await transformRequestBody(body, codexInstructions);
				expect(result.tools).toEqual([
					{
						type: 'namespace',
						name: 'outer_suite',
						tools: [
							{
								type: 'namespace',
								name: 'inner_suite',
								tools: [
									{
										type: 'mcp',
										server_label: 'remote-docs',
										server_url: 'https://mcp.example.com',
										defer_loading: true,
									},
								],
							},
						],
					},
				]);
			});
		});

		// NEW: Integration tests for all config scenarios
		describe('Integration: Complete Config Scenarios', () => {
			describe('Scenario 1: Default models (no custom config)', () => {
				it('should handle gpt-5-codex with global options only', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: []
					};
					const userConfig: UserConfig = {
						global: { reasoningEffort: 'high' },
						models: {}
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.model).toBe('gpt-5-codex');  // gpt-5-codex remains canonical
					expect(result.reasoning?.effort).toBe('high');  // From global
					expect(result.store).toBe(false);
				});

				it('should handle gpt-5-mini without silently downgrading it to gpt-5.1', async () => {
					const body: RequestBody = {
						model: 'gpt-5-mini',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions);

					expect(result.model).toBe('gpt-5-mini');
					expect(result.reasoning?.effort).toBe('medium');
				});
			});

			describe('Scenario 2: Custom preset names (new style)', () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium', include: ['reasoning.encrypted_content'] },
					models: {
						'gpt-5-codex-low': {
							options: { reasoningEffort: 'low' }
						},
						'gpt-5-codex-high': {
							options: { reasoningEffort: 'high', reasoningSummary: 'detailed' }
						}
					}
				};

				it('should apply per-model options for gpt-5-codex-low', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex-low',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.model).toBe('gpt-5-codex');  // gpt-5-codex remains canonical
					expect(result.reasoning?.effort).toBe('low');  // From per-model
					expect(result.include).toEqual(['reasoning.encrypted_content']);  // From global
				});

				it('should apply per-model options for gpt-5-codex-high', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex-high',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.model).toBe('gpt-5-codex');  // gpt-5-codex remains canonical
					expect(result.reasoning?.effort).toBe('high');  // From per-model
					expect(result.reasoning?.summary).toBe('detailed');  // From per-model
				});

				it('should use global options for default gpt-5-codex', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.model).toBe('gpt-5-codex');  // gpt-5-codex remains canonical
					expect(result.reasoning?.effort).toBe('medium');  // From global (no per-model)
				});
			});

			describe('Scenario 3: Backwards compatibility (old verbose names)', () => {
				const userConfig: UserConfig = {
					global: {},
					models: {
						'GPT 5 Codex Low (ChatGPT Subscription)': {
							options: { reasoningEffort: 'low', textVerbosity: 'low' }
						}
					}
				};

				it('should find and apply old config format', async () => {
					const body: RequestBody = {
						model: 'GPT 5 Codex Low (ChatGPT Subscription)',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.model).toBe('gpt-5-codex');  // gpt-5-codex remains canonical
					expect(result.reasoning?.effort).toBe('low');  // From per-model (old format)
					expect(result.text?.verbosity).toBe('low');
				});
			});

			describe('Scenario 4: Mixed default + custom models', () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5-codex-low': {
							options: { reasoningEffort: 'low' }
						}
					}
				};

				it('should use per-model for custom variant', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex-low',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.reasoning?.effort).toBe('low');  // Per-model
				});

				it('should use global for default model', async () => {
					const body: RequestBody = {
						model: 'gpt-5',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.reasoning?.effort).toBe('medium');  // Global
				});
			});

			describe('Scenario 5: Message ID filtering with multi-turn', () => {
				it('should remove ALL IDs in multi-turn conversation', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [
							{ id: 'msg_turn1', type: 'message', role: 'user', content: 'first' },
							{ id: 'rs_response1', type: 'message', role: 'assistant', content: 'response' },
							{ id: 'msg_turn2', type: 'message', role: 'user', content: 'second' },
							{ id: 'assistant_123', type: 'message', role: 'assistant', content: 'reply' },
						]
					};

					const result = await transformRequestBody(body, codexInstructions);

					// All items kept, ALL IDs removed
					expect(result.input).toHaveLength(4);
					expect(result.input!.every(item => !item.id)).toBe(true);
					expect(result.store).toBe(false);  // Stateless mode
					expect(result.include).toEqual(['reasoning.encrypted_content']);
				});
			});

			describe('Scenario 6: Complete end-to-end transformation', () => {
				it('should handle full transformation: custom model + IDs + tools', async () => {
					const userConfig: UserConfig = {
						global: { include: ['reasoning.encrypted_content'] },
						models: {
							'gpt-5-codex-low': {
								options: {
									reasoningEffort: 'low',
									textVerbosity: 'low',
									reasoningSummary: 'auto'
								}
							}
						}
					};

					const body: RequestBody = {
						model: 'gpt-5-codex-low',
						input: [
							{ id: 'msg_1', type: 'message', role: 'user', content: 'test' },
							{ id: 'rs_2', type: 'message', role: 'assistant', content: 'reply' }
						],
						tools: [{ name: 'edit' }]
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					// Model normalized (gpt-5-codex remains canonical)
					expect(result.model).toBe('gpt-5-codex');

					// IDs removed
					expect(result.input!.every(item => !item.id)).toBe(true);

					// Per-model options applied
					expect(result.reasoning?.effort).toBe('low');
					expect(result.reasoning?.summary).toBe('auto');
					expect(result.text?.verbosity).toBe('low');

					// Codex fields set
					expect(result.store).toBe(false);
					expect(result.stream).toBe(true);
					expect(result.instructions).toBe(codexInstructions);
					expect(result.include).toEqual(['reasoning.encrypted_content']);
				});
			});

			describe('Scenario 7: Tool Schema Cleaning (Require Logic)', () => {
				it('should remove invalid required fields from tool definitions', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [],
						tools: [
							{
								type: 'function',
								function: {
									name: 'test_tool',
									parameters: {
										type: 'object',
										properties: {
											valid_param: { type: 'string' }
										},
										required: ['valid_param', 'invalid_param']
									}
								}
							}
						]
					};

					const result = await transformRequestBody(body, codexInstructions);
					const tool = (result.tools as any)[0];
					expect(tool.function.parameters.required).toEqual(['valid_param']);
				});

				it('should remove required array if all fields are invalid', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [],
						tools: [
							{
								type: 'function',
								function: {
									name: 'test_tool',
									parameters: {
										type: 'object',
										properties: {
											valid_param: { type: 'string' }
										},
										required: ['invalid_param']
									}
								}
							}
						]
					};

					const result = await transformRequestBody(body, codexInstructions);
					const tool = (result.tools as any)[0];
					expect(tool.function.parameters.required).toBeUndefined();
				});

				it('should inject placeholder for empty object parameters', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [],
						tools: [
							{
								type: 'function',
								function: {
									name: 'void_tool',
									parameters: {
										type: 'object',
										properties: {}
									}
								}
							}
						]
					};

					const result = await transformRequestBody(body, codexInstructions);
					const tool = (result.tools as any)[0];
					expect(tool.function.parameters.properties).toHaveProperty('_placeholder');
				});

				it('should flatten anyOf with const values to enum', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [],
						tools: [
							{
								type: 'function',
								function: {
									name: 'enum_tool',
									parameters: {
										type: 'object',
										properties: {
											choice: {
												anyOf: [
													{ const: 'A' },
													{ const: 'B' }
												]
											}
										}
									}
								}
							}
						]
					};

					const result = await transformRequestBody(body, codexInstructions);
					const tool = (result.tools as any)[0];
					const prop = tool.function.parameters.properties.choice;
					expect(prop.anyOf).toBeUndefined();
					expect(prop.enum).toEqual(['A', 'B']);
					expect(prop.type).toBe('string');
				});

				it('should normalize nullable array types to single type + description', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [],
						tools: [
							{
								type: 'function',
								function: {
									name: 'null_tool',
									parameters: {
										type: 'object',
										properties: {
											optional_str: {
												type: ['string', 'null'],
												description: 'An optional string'
											}
										}
									}
								}
							}
						]
					};

					const result = await transformRequestBody(body, codexInstructions);
					const tool = (result.tools as any)[0];
					const prop = tool.function.parameters.properties.optional_str;
					expect(prop.type).toBe('string');
					expect(prop.description).toBe('An optional string (nullable)');
				});

				it('should remove unsupported keywords', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [],
						tools: [
							{
								type: 'function',
								function: {
									name: 'clean_tool',
									parameters: {
										type: 'object',
										properties: {
											prop: { type: 'string', const: 'fixed' }
										},
										additionalProperties: false,
										$schema: 'http://json-schema.org/draft-07/schema#'
									}
								}
							}
						]
					};

					const result = await transformRequestBody(body, codexInstructions);
					const tool = (result.tools as any)[0];
					const params = tool.function.parameters;
					expect(params.additionalProperties).toBeUndefined();
					expect(params.$schema).toBeUndefined();
					expect(params.properties.prop.const).toBeUndefined();
				});

				it('supports named-parameter options form', async () => {
					const baseBody: RequestBody = {
						model: 'gpt-5-codex-low',
						input: [
							{ type: 'message', role: 'user', content: 'hello' },
						],
						tools: [
							{
								type: 'function',
								function: {
									name: 'echo',
									parameters: {
										type: 'object',
										properties: {
											value: { type: 'string' },
										},
									},
								},
							},
						] as any,
					};

					const positional = await transformRequestBody(
						JSON.parse(JSON.stringify(baseBody)),
						codexInstructions,
						{ global: {}, models: {} },
						true,
						true,
						'always',
						12,
					);
					const named = await transformRequestBody({
						body: JSON.parse(JSON.stringify(baseBody)),
						codexInstructions,
						userConfig: { global: {}, models: {} },
						codexMode: true,
						fastSession: true,
						fastSessionStrategy: 'always',
						fastSessionMaxInputItems: 12,
					});

					expect(named).toEqual(positional);
				});

				it('throws clear TypeError when named-parameter body is invalid', async () => {
					await expect(
						transformRequestBody({
							body: null as unknown as RequestBody,
							codexInstructions,
						}),
					).rejects.toThrowError('transformRequestBody requires body');
				});
			});
		});
	});
});



