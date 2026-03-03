import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	__resetConfigWarningCacheForTests,
	loadPluginConfig,
	getCodexMode,
	getCodexTuiV2,
	getCodexTuiColorProfile,
	getCodexTuiGlyphMode,
	getFastSession,
	getFastSessionStrategy,
	getFastSessionMaxInputItems,
	getUnsupportedCodexPolicy,
	getFallbackOnUnsupportedCodexModel,
	getTokenRefreshSkewMs,
	getRetryAllAccountsMaxRetries,
	getFallbackToGpt52OnUnsupportedGpt53,
	getUnsupportedCodexFallbackChain,
	getFetchTimeoutMs,
	getStreamStallTimeoutMs,
	getPreemptiveQuotaEnabled,
	getPreemptiveQuotaRemainingPercent5h,
	getPreemptiveQuotaRemainingPercent7d,
	getPreemptiveQuotaMaxDeferralMs,
} from '../lib/config.js';
import type { PluginConfig } from '../lib/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as logger from '../lib/logger.js';

// Mock the fs module
vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

// Mock the logger module to track warnings
vi.mock('../lib/logger.js', async () => {
	const actual = await vi.importActual<typeof import('../lib/logger.js')>('../lib/logger.js');
	return {
		...actual,
		logWarn: vi.fn(),
	};
});

describe('Plugin Configuration', () => {
	const mockExistsSync = vi.mocked(fs.existsSync);
	const mockReadFileSync = vi.mocked(fs.readFileSync);
	const envKeys = [
		'CODEX_HOME',
		'CODEX_MULTI_AUTH_DIR',
		'CODEX_MODE',
		'CODEX_TUI_V2',
		'CODEX_TUI_COLOR_PROFILE',
		'CODEX_TUI_GLYPHS',
		'CODEX_AUTH_FAST_SESSION',
		'CODEX_AUTH_FAST_SESSION_STRATEGY',
		'CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS',
		'CODEX_AUTH_UNSUPPORTED_MODEL_POLICY',
		'CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL',
		'CODEX_AUTH_FALLBACK_GPT53_TO_GPT52',
		'CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED',
		'CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT',
		'CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT',
		'CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS',
	] as const;
	const originalEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

	beforeEach(() => {
		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
		}
		__resetConfigWarningCacheForTests();
		vi.clearAllMocks();
	});

	afterEach(() => {
		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	describe('loadPluginConfig', () => {
		it('should return default config when file does not exist', () => {
			mockExistsSync.mockReturnValue(false);

			const config = loadPluginConfig();

			expect(config).toEqual({
				codexMode: true,
				codexTuiV2: true,
				codexTuiColorProfile: 'truecolor',
				codexTuiGlyphMode: 'ascii',
				fastSession: false,
				fastSessionStrategy: 'hybrid',
				fastSessionMaxInputItems: 30,
				retryAllAccountsRateLimited: true,
				retryAllAccountsMaxWaitMs: 0,
				retryAllAccountsMaxRetries: Infinity,
				unsupportedCodexPolicy: 'strict',
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
				unsupportedCodexFallbackChain: {},
				tokenRefreshSkewMs: 60_000,
				rateLimitToastDebounceMs: 60_000,
				toastDurationMs: 5_000,
				perProjectAccounts: true,
				sessionRecovery: true,
				autoResume: true,
				parallelProbing: false,
				parallelProbingMaxConcurrency: 2,
				emptyResponseMaxRetries: 2,
				emptyResponseRetryDelayMs: 1_000,
				pidOffsetEnabled: false,
				fetchTimeoutMs: 60_000,
				streamStallTimeoutMs: 45_000,
				liveAccountSync: true,
				liveAccountSyncDebounceMs: 250,
				liveAccountSyncPollMs: 2_000,
				sessionAffinity: true,
				sessionAffinityTtlMs: 20 * 60_000,
				sessionAffinityMaxEntries: 512,
				proactiveRefreshGuardian: true,
				proactiveRefreshIntervalMs: 60_000,
				proactiveRefreshBufferMs: 5 * 60_000,
				networkErrorCooldownMs: 6_000,
				serverErrorCooldownMs: 4_000,
				storageBackupEnabled: true,
				preemptiveQuotaEnabled: true,
				preemptiveQuotaRemainingPercent5h: 5,
				preemptiveQuotaRemainingPercent7d: 5,
				preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
			});
			// existsSync is called with multiple candidate config paths (primary + legacy fallbacks)
			expect(mockExistsSync).toHaveBeenCalled();
			expect(mockExistsSync.mock.calls.some(([p]) =>
				typeof p === 'string' && p.includes('config') && p.includes('codex')
			)).toBe(true);
		});

		it('should load config from file when it exists', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({ codexMode: false }));

			const config = loadPluginConfig();

			expect(config).toEqual({
				codexMode: false,
				codexTuiV2: true,
				codexTuiColorProfile: 'truecolor',
				codexTuiGlyphMode: 'ascii',
				fastSession: false,
				fastSessionStrategy: 'hybrid',
				fastSessionMaxInputItems: 30,
				retryAllAccountsRateLimited: true,
				retryAllAccountsMaxWaitMs: 0,
				retryAllAccountsMaxRetries: Infinity,
				unsupportedCodexPolicy: 'strict',
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
				unsupportedCodexFallbackChain: {},
				tokenRefreshSkewMs: 60_000,
				rateLimitToastDebounceMs: 60_000,
				toastDurationMs: 5_000,
				perProjectAccounts: true,
				sessionRecovery: true,
				autoResume: true,
				parallelProbing: false,
				parallelProbingMaxConcurrency: 2,
				emptyResponseMaxRetries: 2,
				emptyResponseRetryDelayMs: 1_000,
				pidOffsetEnabled: false,
				fetchTimeoutMs: 60_000,
				streamStallTimeoutMs: 45_000,
				liveAccountSync: true,
				liveAccountSyncDebounceMs: 250,
				liveAccountSyncPollMs: 2_000,
				sessionAffinity: true,
				sessionAffinityTtlMs: 20 * 60_000,
				sessionAffinityMaxEntries: 512,
				proactiveRefreshGuardian: true,
				proactiveRefreshIntervalMs: 60_000,
				proactiveRefreshBufferMs: 5 * 60_000,
				networkErrorCooldownMs: 6_000,
				serverErrorCooldownMs: 4_000,
				storageBackupEnabled: true,
				preemptiveQuotaEnabled: true,
				preemptiveQuotaRemainingPercent5h: 5,
				preemptiveQuotaRemainingPercent7d: 5,
				preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
			});
		});

		it('retries transient config read lock errors and succeeds', () => {
			mockExistsSync.mockReturnValue(true);
			const transientReadError = Object.assign(new Error('Resource busy'), { code: 'EBUSY' });
			mockReadFileSync
				.mockImplementationOnce(() => {
					throw transientReadError;
				})
				.mockReturnValueOnce(JSON.stringify({ codexMode: false }));

			const config = loadPluginConfig();

			expect(config.codexMode).toBe(false);
			expect(mockReadFileSync).toHaveBeenCalledTimes(2);
			const failedLoadWarnings = vi
				.mocked(logger.logWarn)
				.mock.calls.filter(([message]) => String(message).includes('Failed to load config'));
			expect(failedLoadWarnings).toHaveLength(0);
		});

		it('retries transient config read lock errors (EPERM) and succeeds', () => {
			mockExistsSync.mockReturnValue(true);
			const transientReadError = Object.assign(new Error('Operation not permitted'), {
				code: 'EPERM',
			});
			mockReadFileSync
				.mockImplementationOnce(() => {
					throw transientReadError;
				})
				.mockReturnValueOnce(JSON.stringify({ codexMode: false }));

			const config = loadPluginConfig();

			expect(config.codexMode).toBe(false);
			expect(mockReadFileSync).toHaveBeenCalledTimes(2);
			const failedLoadWarnings = vi
				.mocked(logger.logWarn)
				.mock.calls.filter(([message]) => String(message).includes('Failed to load config'));
			expect(failedLoadWarnings).toHaveLength(0);
		});

		it('should detect CODEX_HOME legacy auth config path before global legacy path', async () => {
			const runWithCodexHome = async (codexHomePath: string) => {
				vi.resetModules();
				process.env.CODEX_HOME = codexHomePath;
				const expectedPath = path.join(codexHomePath, 'openai-codex-auth-config.json');

				const existsSyncMock = vi.fn((candidate: unknown) =>
					typeof candidate === 'string' && candidate === expectedPath
				);
				const readFileSyncMock = vi.fn((filePath: unknown) => {
					if (filePath === expectedPath) {
						return JSON.stringify({ codexMode: false });
					}
					throw new Error('ENOENT');
				});
				const logWarnMock = vi.fn();

				vi.doMock('node:fs', async () => {
					const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
					return {
						...actual,
						existsSync: existsSyncMock,
						readFileSync: readFileSyncMock,
					};
				});
				vi.doMock('../lib/logger.js', async () => {
					const actual = await vi.importActual<typeof import('../lib/logger.js')>('../lib/logger.js');
					return {
						...actual,
						logWarn: logWarnMock,
					};
				});

				try {
					const cfg = await import('../lib/config.js');
					const config = cfg.loadPluginConfig();
					return { config, expectedPath, readFileSyncMock, logWarnMock };
				} finally {
					vi.doUnmock('node:fs');
					vi.doUnmock('../lib/logger.js');
				}
			};

			const posixResult = await runWithCodexHome(path.join(process.cwd(), '.tmp-codex-home'));
			expect(posixResult.config.codexMode).toBe(false);
			expect(posixResult.readFileSyncMock).toHaveBeenCalledWith(posixResult.expectedPath, 'utf-8');
			expect(posixResult.logWarnMock).toHaveBeenCalledWith(
				expect.stringContaining(posixResult.expectedPath),
			);

			const windowsHome = String.raw`C:\Users\test\.codex-home`;
			const windowsResult = await runWithCodexHome(windowsHome);
			expect(windowsResult.config.codexMode).toBe(false);
			expect(windowsResult.expectedPath).toContain('\\');
			expect(windowsResult.readFileSyncMock).toHaveBeenCalledWith(
				windowsResult.expectedPath,
				'utf-8',
			);
			expect(windowsResult.logWarnMock).toHaveBeenCalledWith(
				expect.stringContaining(windowsResult.expectedPath),
			);
		});

		it('should detect CODEX_HOME legacy plugin config path before global legacy path', async () => {
			const runWithCodexHome = async (codexHomePath: string) => {
				vi.resetModules();
				process.env.CODEX_HOME = codexHomePath;
				const expectedPath = path.join(codexHomePath, 'codex-multi-auth-config.json');

				const existsSyncMock = vi.fn(
					(candidate: unknown) => typeof candidate === 'string' && candidate === expectedPath,
				);
				const readFileSyncMock = vi.fn((filePath: unknown) => {
					if (filePath === expectedPath) {
						return JSON.stringify({ codexMode: false });
					}
					throw new Error('ENOENT');
				});
				const logWarnMock = vi.fn();

				vi.doMock('node:fs', async () => {
					const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
					return {
						...actual,
						existsSync: existsSyncMock,
						readFileSync: readFileSyncMock,
					};
				});
				vi.doMock('../lib/logger.js', async () => {
					const actual = await vi.importActual<typeof import('../lib/logger.js')>('../lib/logger.js');
					return {
						...actual,
						logWarn: logWarnMock,
					};
				});

				try {
					const cfg = await import('../lib/config.js');
					const config = cfg.loadPluginConfig();
					return { config, expectedPath, readFileSyncMock, logWarnMock };
				} finally {
					vi.doUnmock('node:fs');
					vi.doUnmock('../lib/logger.js');
				}
			};

			const posixResult = await runWithCodexHome(path.join(process.cwd(), '.tmp-codex-home'));
			expect(posixResult.config.codexMode).toBe(false);
			expect(posixResult.readFileSyncMock).toHaveBeenCalledWith(posixResult.expectedPath, 'utf-8');
			expect(posixResult.logWarnMock).toHaveBeenCalledWith(
				expect.stringContaining(posixResult.expectedPath),
			);

			const windowsHome = String.raw`C:\Users\test\.codex-home`;
			const windowsResult = await runWithCodexHome(windowsHome);
			expect(windowsResult.config.codexMode).toBe(false);
			expect(windowsResult.expectedPath).toContain('\\');
			expect(windowsResult.readFileSyncMock).toHaveBeenCalledWith(
				windowsResult.expectedPath,
				'utf-8',
			);
			expect(windowsResult.logWarnMock).toHaveBeenCalledWith(
				expect.stringContaining(windowsResult.expectedPath),
			);
		});

		it('prefers primary CONFIG_PATH over CODEX_HOME legacy path when both exist', async () => {
			const runWithCodexHome = async (codexHomePath: string) => {
				vi.resetModules();
				process.env.CODEX_HOME = codexHomePath;
				const expectedLegacyPath = path.join(codexHomePath, 'codex-multi-auth-config.json');
				const isWindowsStyle = codexHomePath.includes('\\');

				const existsSyncMock = vi.fn((candidate: unknown) => {
					if (typeof candidate !== 'string') return false;
					const normalized = candidate.replace(/\\/g, '/');
					return (
						normalized.endsWith('/multi-auth/config.json') ||
						candidate === expectedLegacyPath
					);
				});
				const readFileSyncMock = vi.fn((filePath: unknown) => {
					if (typeof filePath !== 'string') throw new Error('ENOENT');
					const normalized = filePath.replace(/\\/g, '/');
					if (normalized.endsWith('/multi-auth/config.json')) {
						return JSON.stringify({ codexMode: true });
					}
					if (filePath === expectedLegacyPath) {
						return JSON.stringify({ codexMode: false });
					}
					throw new Error('ENOENT');
				});
				const logWarnMock = vi.fn();

				vi.doMock('node:fs', async () => {
					const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
					return {
						...actual,
						existsSync: existsSyncMock,
						readFileSync: readFileSyncMock,
					};
				});
				vi.doMock('../lib/logger.js', async () => {
					const actual = await vi.importActual<typeof import('../lib/logger.js')>('../lib/logger.js');
					return {
						...actual,
						logWarn: logWarnMock,
					};
				});

				try {
					const cfg = await import('../lib/config.js');
					const config = cfg.loadPluginConfig();
					return { config, expectedLegacyPath, readFileSyncMock, logWarnMock, isWindowsStyle };
				} finally {
					vi.doUnmock('node:fs');
					vi.doUnmock('../lib/logger.js');
				}
			};

			const posixResult = await runWithCodexHome(path.join(process.cwd(), '.tmp-codex-home'));
			expect(posixResult.config.codexMode).toBe(true);
			expect(posixResult.readFileSyncMock).toHaveBeenCalledWith(
				expect.stringMatching(/multi-auth[\\/]config\.json$/),
				'utf-8',
			);
			expect(posixResult.logWarnMock).not.toHaveBeenCalledWith(
				expect.stringContaining(posixResult.expectedLegacyPath),
			);

			const windowsResult = await runWithCodexHome(String.raw`C:\Users\test\.codex-home`);
			expect(windowsResult.isWindowsStyle).toBe(true);
			expect(windowsResult.config.codexMode).toBe(true);
			expect(windowsResult.readFileSyncMock).toHaveBeenCalledWith(
				expect.stringMatching(/multi-auth[\\/]config\.json$/),
				'utf-8',
			);
			expect(windowsResult.logWarnMock).not.toHaveBeenCalledWith(
				expect.stringContaining(windowsResult.expectedLegacyPath),
			);
		});

		it('should merge user config with defaults', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({}));

			const config = loadPluginConfig();

			expect(config).toEqual({
				codexMode: true,
				codexTuiV2: true,
				codexTuiColorProfile: 'truecolor',
				codexTuiGlyphMode: 'ascii',
				fastSession: false,
				fastSessionStrategy: 'hybrid',
				fastSessionMaxInputItems: 30,
				retryAllAccountsRateLimited: true,
				retryAllAccountsMaxWaitMs: 0,
				retryAllAccountsMaxRetries: Infinity,
				unsupportedCodexPolicy: 'strict',
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
				unsupportedCodexFallbackChain: {},
				tokenRefreshSkewMs: 60_000,
				rateLimitToastDebounceMs: 60_000,
				toastDurationMs: 5_000,
				perProjectAccounts: true,
				sessionRecovery: true,
				autoResume: true,
				parallelProbing: false,
				parallelProbingMaxConcurrency: 2,
				emptyResponseMaxRetries: 2,
				emptyResponseRetryDelayMs: 1_000,
				pidOffsetEnabled: false,
				fetchTimeoutMs: 60_000,
				streamStallTimeoutMs: 45_000,
				liveAccountSync: true,
				liveAccountSyncDebounceMs: 250,
				liveAccountSyncPollMs: 2_000,
				sessionAffinity: true,
				sessionAffinityTtlMs: 20 * 60_000,
				sessionAffinityMaxEntries: 512,
				proactiveRefreshGuardian: true,
				proactiveRefreshIntervalMs: 60_000,
				proactiveRefreshBufferMs: 5 * 60_000,
				networkErrorCooldownMs: 6_000,
				serverErrorCooldownMs: 4_000,
				storageBackupEnabled: true,
				preemptiveQuotaEnabled: true,
				preemptiveQuotaRemainingPercent5h: 5,
				preemptiveQuotaRemainingPercent7d: 5,
				preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
			});
		});

		it('should parse UTF-8 BOM-prefixed config files', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue('\ufeff{"codexMode":false}');

			const config = loadPluginConfig();

			expect(config.codexMode).toBe(false);
		});

	it('should handle invalid JSON gracefully', () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue('invalid json');

		const mockLogWarn = vi.mocked(logger.logWarn);
		mockLogWarn.mockClear();
		const config = loadPluginConfig();

	expect(config).toEqual({
		codexMode: true,
		codexTuiV2: true,
		codexTuiColorProfile: 'truecolor',
		codexTuiGlyphMode: 'ascii',
		fastSession: false,
		fastSessionStrategy: 'hybrid',
		fastSessionMaxInputItems: 30,
		retryAllAccountsRateLimited: true,
		retryAllAccountsMaxWaitMs: 0,
		retryAllAccountsMaxRetries: Infinity,
		unsupportedCodexPolicy: 'strict',
		fallbackOnUnsupportedCodexModel: false,
		fallbackToGpt52OnUnsupportedGpt53: true,
		unsupportedCodexFallbackChain: {},
		tokenRefreshSkewMs: 60_000,
		rateLimitToastDebounceMs: 60_000,
		toastDurationMs: 5_000,
		perProjectAccounts: true,
		sessionRecovery: true,
		autoResume: true,
		parallelProbing: false,
		parallelProbingMaxConcurrency: 2,
		emptyResponseMaxRetries: 2,
		emptyResponseRetryDelayMs: 1_000,
		pidOffsetEnabled: false,
		fetchTimeoutMs: 60_000,
		streamStallTimeoutMs: 45_000,
				liveAccountSync: true,
				liveAccountSyncDebounceMs: 250,
				liveAccountSyncPollMs: 2_000,
				sessionAffinity: true,
				sessionAffinityTtlMs: 20 * 60_000,
				sessionAffinityMaxEntries: 512,
				proactiveRefreshGuardian: true,
				proactiveRefreshIntervalMs: 60_000,
				proactiveRefreshBufferMs: 5 * 60_000,
				networkErrorCooldownMs: 6_000,
				serverErrorCooldownMs: 4_000,
				storageBackupEnabled: true,
				preemptiveQuotaEnabled: true,
				preemptiveQuotaRemainingPercent5h: 5,
				preemptiveQuotaRemainingPercent7d: 5,
				preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
	});
		expect(mockLogWarn).toHaveBeenCalled();
	});

		it('should handle file read errors gracefully', () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockImplementation(() => {
			throw new Error('Permission denied');
		});

		const mockLogWarn = vi.mocked(logger.logWarn);
		mockLogWarn.mockClear();
		const config = loadPluginConfig();

		expect(config).toEqual({
			codexMode: true,
			codexTuiV2: true,
			codexTuiColorProfile: 'truecolor',
			codexTuiGlyphMode: 'ascii',
			fastSession: false,
			fastSessionStrategy: 'hybrid',
			fastSessionMaxInputItems: 30,
			retryAllAccountsRateLimited: true,
			retryAllAccountsMaxWaitMs: 0,
			retryAllAccountsMaxRetries: Infinity,
			unsupportedCodexPolicy: 'strict',
			fallbackOnUnsupportedCodexModel: false,
			fallbackToGpt52OnUnsupportedGpt53: true,
			unsupportedCodexFallbackChain: {},
			tokenRefreshSkewMs: 60_000,
			rateLimitToastDebounceMs: 60_000,
			toastDurationMs: 5_000,
			perProjectAccounts: true,
			sessionRecovery: true,
			autoResume: true,
			parallelProbing: false,
			parallelProbingMaxConcurrency: 2,
			emptyResponseMaxRetries: 2,
			emptyResponseRetryDelayMs: 1_000,
			pidOffsetEnabled: false,
			fetchTimeoutMs: 60_000,
			streamStallTimeoutMs: 45_000,
				liveAccountSync: true,
				liveAccountSyncDebounceMs: 250,
				liveAccountSyncPollMs: 2_000,
				sessionAffinity: true,
				sessionAffinityTtlMs: 20 * 60_000,
				sessionAffinityMaxEntries: 512,
				proactiveRefreshGuardian: true,
				proactiveRefreshIntervalMs: 60_000,
				proactiveRefreshBufferMs: 5 * 60_000,
				networkErrorCooldownMs: 6_000,
				serverErrorCooldownMs: 4_000,
				storageBackupEnabled: true,
				preemptiveQuotaEnabled: true,
				preemptiveQuotaRemainingPercent5h: 5,
				preemptiveQuotaRemainingPercent7d: 5,
				preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
		});
		expect(mockLogWarn).toHaveBeenCalled();
	});

		it('should deduplicate repeated validation warnings across multiple loads', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(
				JSON.stringify({
					unsupportedCodexFallbackChain: {
						'gpt-5.3-codex-spark': 'gpt-5-codex',
					},
				})
			);

			const mockLogWarn = vi.mocked(logger.logWarn);
			mockLogWarn.mockClear();

			loadPluginConfig();
			loadPluginConfig();

			const validationWarnings = mockLogWarn.mock.calls.filter(([message]) =>
				String(message).includes('Plugin config validation warnings:')
			);
			expect(validationWarnings).toHaveLength(1);
		});

		it('sanitizes invalid config fields while preserving valid settings', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(
				JSON.stringify({
					codexMode: false,
					unsupportedCodexPolicy: 'fallback',
					emptyResponseMaxRetries: 4,
					fetchTimeoutMs: 'invalid-timeout',
					preemptiveQuotaRemainingPercent5h: 'invalid-percent',
				}),
			);

			const config = loadPluginConfig();

			expect(config.codexMode).toBe(false);
			expect(config.unsupportedCodexPolicy).toBe('fallback');
			expect(config.emptyResponseMaxRetries).toBe(4);
			// Invalid values should be dropped and defaulted safely.
			expect(config.fetchTimeoutMs).toBe(60_000);
			expect(config.preemptiveQuotaRemainingPercent5h).toBe(5);
		});
	});

	describe('getCodexMode', () => {
		it('should return true by default', () => {
			delete process.env.CODEX_MODE;
			const config: PluginConfig = {};

			const result = getCodexMode(config);

			expect(result).toBe(true);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_MODE;
			const config: PluginConfig = { codexMode: false };

			const result = getCodexMode(config);

			expect(result).toBe(false);
		});

		it('should prioritize env var CODEX_MODE=1 over config', () => {
			process.env.CODEX_MODE = '1';
			const config: PluginConfig = { codexMode: false };

			const result = getCodexMode(config);

			expect(result).toBe(true);
		});

		it('should prioritize env var CODEX_MODE=0 over config', () => {
			process.env.CODEX_MODE = '0';
			const config: PluginConfig = { codexMode: true };

			const result = getCodexMode(config);

			expect(result).toBe(false);
		});

		it('should handle env var with any value other than "1" as false', () => {
			process.env.CODEX_MODE = 'false';
			const config: PluginConfig = { codexMode: true };

			const result = getCodexMode(config);

			expect(result).toBe(false);
		});

		it('should use config codexMode=true when explicitly set', () => {
			delete process.env.CODEX_MODE;
			const config: PluginConfig = { codexMode: true };

			const result = getCodexMode(config);

			expect(result).toBe(true);
		});
	});

	describe('getCodexTuiV2', () => {
		it('should default to true', () => {
			delete process.env.CODEX_TUI_V2;
			expect(getCodexTuiV2({})).toBe(true);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_TUI_V2;
			expect(getCodexTuiV2({ codexTuiV2: false })).toBe(false);
		});

		it('should prioritize env value over config', () => {
			process.env.CODEX_TUI_V2 = '0';
			expect(getCodexTuiV2({ codexTuiV2: true })).toBe(false);
			process.env.CODEX_TUI_V2 = '1';
			expect(getCodexTuiV2({ codexTuiV2: false })).toBe(true);
		});
	});

	describe('getCodexTuiColorProfile', () => {
		it('should default to truecolor', () => {
			delete process.env.CODEX_TUI_COLOR_PROFILE;
			expect(getCodexTuiColorProfile({})).toBe('truecolor');
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_TUI_COLOR_PROFILE;
			expect(getCodexTuiColorProfile({ codexTuiColorProfile: 'ansi16' })).toBe('ansi16');
		});

		it('should prioritize valid env value over config', () => {
			process.env.CODEX_TUI_COLOR_PROFILE = 'ansi256';
			expect(getCodexTuiColorProfile({ codexTuiColorProfile: 'ansi16' })).toBe('ansi256');
		});

		it('should ignore invalid env value and fallback to config/default', () => {
			process.env.CODEX_TUI_COLOR_PROFILE = 'invalid-profile';
			expect(getCodexTuiColorProfile({ codexTuiColorProfile: 'ansi16' })).toBe('ansi16');
			expect(getCodexTuiColorProfile({})).toBe('truecolor');
		});
	});

	describe('getCodexTuiGlyphMode', () => {
		it('should default to ascii', () => {
			delete process.env.CODEX_TUI_GLYPHS;
			expect(getCodexTuiGlyphMode({})).toBe('ascii');
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_TUI_GLYPHS;
			expect(getCodexTuiGlyphMode({ codexTuiGlyphMode: 'unicode' })).toBe('unicode');
		});

		it('should prioritize valid env value over config', () => {
			process.env.CODEX_TUI_GLYPHS = 'auto';
			expect(getCodexTuiGlyphMode({ codexTuiGlyphMode: 'ascii' })).toBe('auto');
		});

		it('should ignore invalid env value and fallback to config/default', () => {
			process.env.CODEX_TUI_GLYPHS = 'invalid';
			expect(getCodexTuiGlyphMode({ codexTuiGlyphMode: 'unicode' })).toBe('unicode');
			expect(getCodexTuiGlyphMode({})).toBe('ascii');
		});
	});

	describe('getFastSession', () => {
		it('should default to false', () => {
			delete process.env.CODEX_AUTH_FAST_SESSION;
			expect(getFastSession({})).toBe(false);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_AUTH_FAST_SESSION;
			expect(getFastSession({ fastSession: true })).toBe(true);
		});

		it('should prioritize env var over config', () => {
			process.env.CODEX_AUTH_FAST_SESSION = '0';
			expect(getFastSession({ fastSession: true })).toBe(false);
			process.env.CODEX_AUTH_FAST_SESSION = '1';
			expect(getFastSession({ fastSession: false })).toBe(true);
		});
	});

	describe('getFallbackToGpt52OnUnsupportedGpt53', () => {
		it('should default to true', () => {
			delete process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52;
			expect(getFallbackToGpt52OnUnsupportedGpt53({})).toBe(true);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52;
			expect(
				getFallbackToGpt52OnUnsupportedGpt53({
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
			).toBe(true);
		});

		it('should prioritize env var over config', () => {
			process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52 = '0';
			expect(
				getFallbackToGpt52OnUnsupportedGpt53({
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
			).toBe(false);
			process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52 = '1';
			expect(
				getFallbackToGpt52OnUnsupportedGpt53({
					fallbackToGpt52OnUnsupportedGpt53: false,
				}),
			).toBe(true);
		});
	});

	describe('getUnsupportedCodexPolicy', () => {
		it('should default to strict', () => {
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			delete process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL;
			expect(getUnsupportedCodexPolicy({})).toBe('strict');
		});

		it('should use config policy when set', () => {
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			expect(getUnsupportedCodexPolicy({ unsupportedCodexPolicy: 'fallback' })).toBe('fallback');
		});

		it('should prioritize env policy over config', () => {
			process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY = 'strict';
			expect(getUnsupportedCodexPolicy({ unsupportedCodexPolicy: 'fallback' })).toBe('strict');
			process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY = 'fallback';
			expect(getUnsupportedCodexPolicy({ unsupportedCodexPolicy: 'strict' })).toBe('fallback');
		});

		it('should map legacy fallback flag to fallback policy when policy key missing', () => {
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			expect(getUnsupportedCodexPolicy({ fallbackOnUnsupportedCodexModel: true })).toBe('fallback');
		});

		it('should map legacy env fallback toggle when policy env is unset', () => {
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL = '1';
			expect(getUnsupportedCodexPolicy({})).toBe('fallback');
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL = '0';
			expect(getUnsupportedCodexPolicy({})).toBe('strict');
		});
	});

	describe('getFallbackOnUnsupportedCodexModel', () => {
		it('should default to false (strict policy)', () => {
			delete process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL;
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			expect(getFallbackOnUnsupportedCodexModel({})).toBe(false);
		});

		it('should use explicit policy when set', () => {
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			delete process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL;
			expect(getFallbackOnUnsupportedCodexModel({ unsupportedCodexPolicy: 'fallback' })).toBe(true);
			expect(getFallbackOnUnsupportedCodexModel({ unsupportedCodexPolicy: 'strict' })).toBe(false);
		});

		it('should still support legacy env toggle', () => {
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL = '0';
			delete process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY;
			expect(getFallbackOnUnsupportedCodexModel({})).toBe(false);
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL = '1';
			expect(getFallbackOnUnsupportedCodexModel({})).toBe(true);
		});

		it('policy env overrides legacy toggles', () => {
			process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY = 'strict';
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL = '1';
			expect(getFallbackOnUnsupportedCodexModel({ unsupportedCodexPolicy: 'fallback' })).toBe(false);
			process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY = 'fallback';
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL = '0';
			expect(getFallbackOnUnsupportedCodexModel({ unsupportedCodexPolicy: 'strict' })).toBe(true);
		});
	});

	describe('getUnsupportedCodexFallbackChain', () => {
		it('returns normalized fallback chain entries', () => {
			const result = getUnsupportedCodexFallbackChain({
				unsupportedCodexFallbackChain: {
					'OpenAI/GPT-5.3-CODEX-SPARK': [' gpt-5.3-codex ', 'gpt-5.2-codex'],
				},
			});

			expect(result).toEqual({
				'gpt-5.3-codex-spark': ['gpt-5.3-codex', 'gpt-5.2-codex'],
			});
		});

		it('returns empty object for missing/invalid chain', () => {
			expect(getUnsupportedCodexFallbackChain({})).toEqual({});
			expect(
				getUnsupportedCodexFallbackChain({
					unsupportedCodexFallbackChain: {
						'': ['   '],
					},
				}),
			).toEqual({});
		});
	});

	describe('getFastSessionMaxInputItems', () => {
		it('should default to 30', () => {
			delete process.env.CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS;
			expect(getFastSessionMaxInputItems({})).toBe(30);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS;
			expect(getFastSessionMaxInputItems({ fastSessionMaxInputItems: 18 })).toBe(18);
		});

		it('should clamp to minimum 8', () => {
			process.env.CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS = '2';
			expect(getFastSessionMaxInputItems({})).toBe(8);
		});
	});

	describe('getFastSessionStrategy', () => {
		it('should default to hybrid', () => {
			delete process.env.CODEX_AUTH_FAST_SESSION_STRATEGY;
			expect(getFastSessionStrategy({})).toBe('hybrid');
		});

		it('should use config value', () => {
			delete process.env.CODEX_AUTH_FAST_SESSION_STRATEGY;
			expect(getFastSessionStrategy({ fastSessionStrategy: 'always' })).toBe('always');
		});

		it('should prioritize env value', () => {
			process.env.CODEX_AUTH_FAST_SESSION_STRATEGY = 'always';
			expect(getFastSessionStrategy({ fastSessionStrategy: 'hybrid' })).toBe('always');
			process.env.CODEX_AUTH_FAST_SESSION_STRATEGY = 'hybrid';
			expect(getFastSessionStrategy({ fastSessionStrategy: 'always' })).toBe('hybrid');
		});
	});

	describe('Priority order', () => {
		it('should follow priority: env var > config file > default', () => {
			// Test 1: env var overrides config
			process.env.CODEX_MODE = '0';
			expect(getCodexMode({ codexMode: true })).toBe(false);

			// Test 2: config overrides default
			delete process.env.CODEX_MODE;
			expect(getCodexMode({ codexMode: false })).toBe(false);

			// Test 3: default when neither set
			expect(getCodexMode({})).toBe(true);
		});
	});

	describe('Schema validation warnings', () => {
		it('should log warning when config has invalid properties', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({ 
				codexMode: 'not-a-boolean',
				unknownProperty: 'value'
			}));

			const mockLogWarn = vi.mocked(logger.logWarn);
			mockLogWarn.mockClear();
			loadPluginConfig();

			expect(mockLogWarn).toHaveBeenCalledWith(
				expect.stringContaining('Plugin config validation warnings')
			);
		});
	});

	describe('resolveNumberSetting without min option', () => {
		it('should return candidate without min constraint via getRetryAllAccountsMaxRetries', () => {
			delete process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
			const config: PluginConfig = { retryAllAccountsMaxRetries: 5 };
			const result = getRetryAllAccountsMaxRetries(config);
			expect(result).toBe(5);
		});

		it('should return env value without min constraint', () => {
			process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS = '30000';
			const config: PluginConfig = { tokenRefreshSkewMs: 60000 };
			const result = getTokenRefreshSkewMs(config);
			expect(result).toBe(30000);
			delete process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS;
		});
	});

	describe('timeout settings', () => {
		it('should read fetch timeout from config', () => {
			const config: PluginConfig = { fetchTimeoutMs: 120000 };
			expect(getFetchTimeoutMs(config)).toBe(120000);
		});

		it('should read stream stall timeout from env', () => {
			process.env.CODEX_AUTH_STREAM_STALL_TIMEOUT_MS = '30000';
			expect(getStreamStallTimeoutMs({})).toBe(30000);
			delete process.env.CODEX_AUTH_STREAM_STALL_TIMEOUT_MS;
		});
	});

	describe('preemptive quota settings', () => {
		it('should use default thresholds', () => {
			expect(getPreemptiveQuotaEnabled({})).toBe(true);
			expect(getPreemptiveQuotaRemainingPercent5h({})).toBe(5);
			expect(getPreemptiveQuotaRemainingPercent7d({})).toBe(5);
			expect(getPreemptiveQuotaMaxDeferralMs({})).toBe(2 * 60 * 60_000);
		});

		it('should prioritize environment overrides', () => {
			process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED = '0';
			process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT = '9';
			process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT = '11';
			process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS = '123000';
			expect(getPreemptiveQuotaEnabled({ preemptiveQuotaEnabled: true })).toBe(false);
			expect(getPreemptiveQuotaRemainingPercent5h({ preemptiveQuotaRemainingPercent5h: 1 })).toBe(9);
			expect(getPreemptiveQuotaRemainingPercent7d({ preemptiveQuotaRemainingPercent7d: 2 })).toBe(11);
			expect(getPreemptiveQuotaMaxDeferralMs({ preemptiveQuotaMaxDeferralMs: 2_000 })).toBe(123000);
		});
	});
});

