import { describe, it, expect, vi } from 'vitest';
import {
	applyFastSessionDefaults,
	getModelConfig,
	getReasoningConfig,
} from '../lib/request/request-transformer.js';
import * as logger from '../lib/logger.js';
import type { UserConfig } from '../lib/types.js';

describe('Configuration Parsing', () => {
	const providerConfig = {
		options: {
			reasoningEffort: 'medium' as const,
			reasoningSummary: 'auto' as const,
			textVerbosity: 'medium' as const,
		},
		models: {
			'gpt-5-codex': {
				options: {
					reasoningSummary: 'concise' as const,
				},
			},
			'gpt-5': {
				options: {
					reasoningEffort: 'high' as const,
				},
			},
		},
	};

	const userConfig: UserConfig = {
		global: providerConfig.options || {},
		models: providerConfig.models || {},
	};

	describe('getModelConfig', () => {
		it('should merge global and model-specific config for gpt-5-codex', () => {
			const codexConfig = getModelConfig('gpt-5-codex', userConfig);

			expect(codexConfig.reasoningEffort).toBe('medium'); // from global
			expect(codexConfig.reasoningSummary).toBe('concise'); // from model override
			expect(codexConfig.textVerbosity).toBe('medium'); // from global
		});

		it('should merge global and model-specific config for gpt-5', () => {
			const gpt5Config = getModelConfig('gpt-5', userConfig);

			expect(gpt5Config.reasoningEffort).toBe('high'); // from model override
			expect(gpt5Config.reasoningSummary).toBe('auto'); // from global
			expect(gpt5Config.textVerbosity).toBe('medium'); // from global
		});

		it('should return empty config when no config provided', () => {
			const emptyConfig = getModelConfig('gpt-5-codex', { global: {}, models: {} });

			expect(emptyConfig).toEqual({});
		});
	});

	describe('applyFastSessionDefaults', () => {
		it('should set low reasoning effort and verbosity when unset', () => {
			const fast = applyFastSessionDefaults({ global: {}, models: {} });
			expect(fast.global.reasoningEffort).toBe('low');
			expect(fast.global.textVerbosity).toBe('low');
		});

		it('should not override explicit global settings', () => {
			const fast = applyFastSessionDefaults({
				global: { reasoningEffort: 'high', textVerbosity: 'high' },
				models: {},
			});
			expect(fast.global.reasoningEffort).toBe('high');
			expect(fast.global.textVerbosity).toBe('high');
		});
	});

		describe('getReasoningConfig', () => {
			it('should use user settings from merged config for gpt-5-codex', () => {
				const codexConfig = getModelConfig('gpt-5-codex', userConfig);
				const reasoningConfig = getReasoningConfig('gpt-5-codex', codexConfig);

			expect(reasoningConfig.effort).toBe('medium');
			expect(reasoningConfig.summary).toBe('concise');
		});

		it('should return defaults when no config provided', () => {
			const emptyConfig = getModelConfig('gpt-5-codex', { global: {}, models: {} });
			const defaultReasoning = getReasoningConfig('gpt-5-codex', emptyConfig);

			// Retired gpt-5-codex runs on gpt-5.6-sol, whose default is low.
			expect(defaultReasoning.effort).toBe('low');
			expect(defaultReasoning.summary).toBe('auto');
		});

		it('should give retired gpt-5-nano the medium default of gpt-5.6-luna, its replacement', () => {
			const nanoReasoning = getReasoningConfig('gpt-5-nano', {});

			expect(nanoReasoning.effort).toBe('medium');
			expect(nanoReasoning.summary).toBe('auto');
		});

		it('should warn when a reasoning request is coerced to a supported effort', () => {
			const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});

			try {
				// gpt-5.5-pro now runs on gpt-6-astra, whose ladder starts at low;
				// `none` is what it cannot accept.
				const proReasoning = getReasoningConfig('gpt-5.5-pro', {
					reasoningEffort: 'none',
				});

				expect(proReasoning.effort).toBe('low');
				expect(warnSpy).toHaveBeenCalledWith(
					'Coercing unsupported reasoning effort for model',
					expect.objectContaining({
						// The warn names the normalized model the effort was checked
						// against, not the retired alias the caller sent.
						model: 'gpt-6-astra',
						requestedEffort: 'none',
						effectiveEffort: 'low',
					}),
				);
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('should normalize "minimal" to "low" for gpt-5-codex', () => {
			const codexMinimalConfig = { reasoningEffort: 'minimal' as const };
			const codexMinimalReasoning = getReasoningConfig('gpt-5-codex', codexMinimalConfig);

			expect(codexMinimalReasoning.effort).toBe('low');
			expect(codexMinimalReasoning.summary).toBe('auto');
		});

		it('should coerce minimal effort on stale bare GPT-5 aliases routed to GPT-5.5', () => {
			const gpt5MinimalConfig = { reasoningEffort: 'minimal' as const };
			const gpt5MinimalReasoning = getReasoningConfig('gpt-5', gpt5MinimalConfig);

			expect(gpt5MinimalReasoning.effort).toBe('low');
		});

		it('should give retired GPT-5.4 the medium default of GPT-6 Sol, its replacement', () => {
			const gpt54Reasoning = getReasoningConfig('gpt-5.4', {});
			expect(gpt54Reasoning.effort).toBe('medium');
		});

		it('should default the retired GPT-5.5 alias to the medium default of GPT-6 Sol, its replacement', () => {
			const gpt55Reasoning = getReasoningConfig('gpt-5.5', {});
			expect(gpt55Reasoning.effort).toBe('medium');
		});

		it('should handle high effort setting', () => {
			const highConfig = { reasoningEffort: 'high' as const };
			const highReasoning = getReasoningConfig('gpt-5', highConfig);

			expect(highReasoning.effort).toBe('high');
			expect(highReasoning.summary).toBe('auto');
		});

			it('should respect custom summary setting', () => {
				const detailedConfig = { reasoningSummary: 'detailed' as const };
				const detailedReasoning = getReasoningConfig('gpt-5-codex', detailedConfig);

				expect(detailedReasoning.summary).toBe('detailed');
			});

			it('should give retired codex-mini aliases the default of gpt-5.6-terra, their replacement', () => {
				const codexMiniReasoning = getReasoningConfig('gpt-5-codex-mini', {});
				expect(codexMiniReasoning.effort).toBe('medium');
			});

			it('should use the replacement model reasoning bounds for retired codex-mini aliases', () => {
				const minimal = getReasoningConfig('gpt-5-codex-mini', {
					reasoningEffort: 'minimal',
				});
				const low = getReasoningConfig('gpt-5-codex-mini-high', {
					reasoningEffort: 'low',
				});

				expect(minimal.effort).toBe('low');
				expect(low.effort).toBe('low');
			});

		it('should keep codex-mini high effort when requested', () => {
			const high = getReasoningConfig('codex-mini-latest', {
				reasoningEffort: 'high',
			});
			expect(high.effort).toBe('high');
		});

		it('should preserve xhigh for retired codex-mini aliases routed to gpt-5.6-terra', () => {
			const xhigh = getReasoningConfig('gpt-5-codex-mini', {
				reasoningEffort: 'xhigh',
			});
			expect(xhigh.effort).toBe('xhigh');
		});

		it('should clamp codex-mini unknown effort to the replacement model default', () => {
			const unknown = getReasoningConfig('gpt-5-codex-mini', {
				reasoningEffort: 'invalid-effort' as never,
			});
			expect(unknown.effort).toBe('medium');
		});
	});

	describe('Model-specific behavior', () => {
		it('should detect lightweight models correctly', () => {
			const miniReasoning = getReasoningConfig('gpt-5-mini', {});
			expect(miniReasoning.effort).toBe('medium');
		});

		it('should detect codex models correctly', () => {
			const codexConfig = { reasoningEffort: 'minimal' as const };
			const codexReasoning = getReasoningConfig('gpt-5-codex', codexConfig);
			expect(codexReasoning.effort).toBe('low'); // normalized
		});

		it('should handle standard gpt-5 model', () => {
			const gpt5Reasoning = getReasoningConfig('gpt-5', {});
			expect(gpt5Reasoning.effort).toBe('low');
		});

		it('should clamp unsupported none effort on GPT-5.4-pro up to low', () => {
			const gpt54ProReasoning = getReasoningConfig('gpt-5.4-pro', {
				reasoningEffort: 'none',
			});
			expect(gpt54ProReasoning.effort).toBe('low');
		});

		it('should clamp unsupported none effort on GPT-5.5-pro up to low', () => {
			const gpt55ProReasoning = getReasoningConfig('gpt-5.5-pro', {
				reasoningEffort: 'none',
			});
			expect(gpt55ProReasoning.effort).toBe('low');
		});
	});
});
