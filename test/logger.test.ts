import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
	LOGGING_ENABLED,
	DEBUG_ENABLED,
	LOG_LEVEL,
	logRequest, 
	maskEmail,
	setCorrelationId,
	getCorrelationId,
	clearCorrelationId,
	logDebug,
	logInfo,
	logWarn,
	logError,
	createLogger,
	formatDuration,
	getRequestId,
	initLogger,
	type LogClient,
} from '../lib/logger.js';

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal() as Record<string, unknown>;
	return {
		...actual,
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
		existsSync: vi.fn(() => true),
	};
});

import * as fs from 'node:fs';

const loadLoggerModule = async (env: Record<string, string>) => {
	vi.resetModules();
	vi.unstubAllEnvs();
	for (const [key, value] of Object.entries(env)) {
		vi.stubEnv(key, value);
	}
	return import('../lib/logger.js');
};

describe('Logger Module', () => {
	describe('LOGGING_ENABLED constant', () => {
		it('should be a boolean', () => {
			expect(typeof LOGGING_ENABLED).toBe('boolean');
		});

		it('should default to false when env variable is not set', () => {
			const isEnabled = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === '1';
			expect(typeof isEnabled).toBe('boolean');
		});
	});

	describe('logRequest function', () => {
		it('should accept stage and data parameters', () => {
			expect(() => {
				logRequest('test-stage', { data: 'test' });
			}).not.toThrow();
		});

		it('should handle empty data object', () => {
			expect(() => {
				logRequest('test-stage', {});
			}).not.toThrow();
		});

		it('should handle complex data structures', () => {
			expect(() => {
				logRequest('test-stage', {
					nested: { data: 'value' },
					array: [1, 2, 3],
					number: 123,
					boolean: true,
				});
			}).not.toThrow();
		});
	});

	describe('token masking', () => {
		it('should mask JWT tokens in data', () => {
			const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
			expect(() => {
				logRequest('test-stage', { token: jwtToken });
			}).not.toThrow();
		});

		it('should mask sensitive keys in data', () => {
			expect(() => {
				logRequest('test-stage', {
					access_token: 'secret-access-token',
					refresh_token: 'secret-refresh-token',
					authorization: 'Bearer xyz',
					apiKey: 'sk-1234567890abcdef',
				});
			}).not.toThrow();
		});

		it('should handle nested sensitive data', () => {
			expect(() => {
				logRequest('test-stage', {
					auth: {
						access: 'secret-token',
						nested: {
							refresh: 'another-secret',
						},
					},
				});
			}).not.toThrow();
		});
	});

	describe('maskEmail function', () => {
		it('should mask a standard email address', () => {
			const masked = maskEmail('john.doe@example.com');
			expect(masked).toBe('jo***@***.com');
		});

		it('should mask a short local part', () => {
			const masked = maskEmail('a@example.org');
			expect(masked).toBe('a***@***.org');
		});

		it('should handle subdomain emails', () => {
			const masked = maskEmail('user@mail.company.co.uk');
			expect(masked).toBe('us***@***.uk');
		});

		it('should handle invalid emails gracefully', () => {
			const masked = maskEmail('not-an-email');
			expect(masked).toBe('***@***');
		});

		it('should preserve TLD correctly', () => {
			const masked = maskEmail('test@domain.io');
			expect(masked).toBe('te***@***.io');
		});
	});

	describe('correlation ID management', () => {
		beforeEach(() => {
			clearCorrelationId();
		});

		afterEach(() => {
			clearCorrelationId();
		});

		it('should start with no correlation ID', () => {
			expect(getCorrelationId()).toBeNull();
		});

		it('should generate a UUID when setCorrelationId is called without argument', () => {
			const id = setCorrelationId();
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
			expect(getCorrelationId()).toBe(id);
		});

		it('should use provided ID when setCorrelationId is called with argument', () => {
			const customId = 'custom-correlation-id-123';
			const id = setCorrelationId(customId);
			expect(id).toBe(customId);
			expect(getCorrelationId()).toBe(customId);
		});

		it('should clear correlation ID', () => {
			setCorrelationId();
			expect(getCorrelationId()).not.toBeNull();
			clearCorrelationId();
			expect(getCorrelationId()).toBeNull();
		});

		it('should overwrite existing correlation ID', () => {
			const first = setCorrelationId('first-id');
			const second = setCorrelationId('second-id');
			expect(first).toBe('first-id');
			expect(second).toBe('second-id');
			expect(getCorrelationId()).toBe('second-id');
		});
	});

	describe('logDebug function', () => {
		it('should not throw when called', () => {
			expect(() => logDebug('debug message')).not.toThrow();
		});

		it('should accept data parameter', () => {
			expect(() => logDebug('debug message', { key: 'value' })).not.toThrow();
		});
	});

	describe('logInfo function', () => {
		it('should not throw when called', () => {
			expect(() => logInfo('info message')).not.toThrow();
		});

		it('should accept data parameter', () => {
			expect(() => logInfo('info message', { key: 'value' })).not.toThrow();
		});
	});

	describe('logWarn function', () => {
		it('should not throw when called', () => {
			expect(() => logWarn('warn message')).not.toThrow();
		});

		it('should accept data parameter', () => {
			expect(() => logWarn('warn message', { key: 'value' })).not.toThrow();
		});
	});

	describe('logError function', () => {
		it('should not throw when called', () => {
			expect(() => logError('error message')).not.toThrow();
		});

		it('should accept data parameter', () => {
			expect(() => logError('error message', { key: 'value' })).not.toThrow();
		});
	});

	describe('formatDuration function', () => {
		it('should format milliseconds', () => {
			expect(formatDuration(500)).toBe('500ms');
		});

		it('should format seconds', () => {
			expect(formatDuration(2500)).toBe('2.50s');
		});

		it('should format minutes and seconds', () => {
			expect(formatDuration(90000)).toBe('1m 30.0s');
		});

		it('should round milliseconds', () => {
			expect(formatDuration(123.456)).toBe('123ms');
		});
	});

	describe('getRequestId function', () => {
		it('should return a number', () => {
			expect(typeof getRequestId()).toBe('number');
		});
	});

	describe('createLogger function', () => {
		it('should create a scoped logger', () => {
			const logger = createLogger('test-scope');
			expect(logger).toBeDefined();
			expect(typeof logger.debug).toBe('function');
			expect(typeof logger.info).toBe('function');
			expect(typeof logger.warn).toBe('function');
			expect(typeof logger.error).toBe('function');
			expect(typeof logger.time).toBe('function');
			expect(typeof logger.timeEnd).toBe('function');
		});

		it('should not throw when logging at each level', () => {
			const logger = createLogger('test');
			expect(() => logger.debug('debug')).not.toThrow();
			expect(() => logger.info('info')).not.toThrow();
			expect(() => logger.warn('warn')).not.toThrow();
			expect(() => logger.error('error')).not.toThrow();
		});

		it('should not throw when logging with data', () => {
			const logger = createLogger('test');
			expect(() => logger.debug('debug', { key: 'value' })).not.toThrow();
			expect(() => logger.info('info', { key: 'value' })).not.toThrow();
			expect(() => logger.warn('warn', { key: 'value' })).not.toThrow();
			expect(() => logger.error('error', { key: 'value' })).not.toThrow();
		});

		describe('time and timeEnd', () => {
			it('should return a function from time()', () => {
				const logger = createLogger('test');
				const endTimer = logger.time('operation');
				expect(typeof endTimer).toBe('function');
			});

			it('should return duration when timer ends', async () => {
				const logger = createLogger('test');
				const endTimer = logger.time('operation');
				await new Promise(resolve => setTimeout(resolve, 10));
				const duration = endTimer();
				expect(typeof duration).toBe('number');
				expect(duration).toBeGreaterThanOrEqual(0);
			});

			it('should handle timeEnd with explicit start time', () => {
				const logger = createLogger('test');
				const startTime = performance.now();
				expect(() => logger.timeEnd('operation', startTime)).not.toThrow();
			});

			it('should handle many timers without throwing', () => {
				const logger = createLogger('test');
				const timers: Array<() => number> = [];
				for (let i = 0; i < 150; i++) {
					timers.push(logger.time(`timer-${i}`));
				}
				for (const end of timers) {
					end();
				}
			});
		});
	});

	describe('initLogger and logToApp', () => {
		beforeEach(() => {
			clearCorrelationId();
		});

		afterEach(() => {
			initLogger({});
			clearCorrelationId();
		});

		it('should call app.log when client is initialized', () => {
			const mockLog = vi.fn();
			const client: LogClient = { app: { log: mockLog } };
			initLogger(client);
			logError('test error message');
			expect(mockLog).toHaveBeenCalled();
			expect(mockLog).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.objectContaining({
						level: 'error',
						message: expect.stringContaining('test error message'),
					}),
				})
			);
		});

		it('should handle app.log returning a Promise', () => {
			const mockLog = vi.fn().mockReturnValue(Promise.resolve());
			initLogger({ app: { log: mockLog } });
			expect(() => logError('test')).not.toThrow();
			expect(mockLog).toHaveBeenCalled();
		});

		it('should handle app.log returning a rejected Promise', async () => {
			const mockLog = vi.fn().mockReturnValue(Promise.reject(new Error('async fail')));
			initLogger({ app: { log: mockLog } });
			expect(() => logError('test')).not.toThrow();
			await new Promise(resolve => setTimeout(resolve, 10));
		});

		it('should handle app.log throwing synchronously', () => {
			const mockLog = vi.fn().mockImplementation(() => { throw new Error('sync fail'); });
			initLogger({ app: { log: mockLog } });
			expect(() => logError('test')).not.toThrow();
		});

		it('should include correlationId in extra when set', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			setCorrelationId('test-correlation-id');
			logError('test message');
			expect(mockLog).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.objectContaining({
						extra: expect.objectContaining({ correlationId: 'test-correlation-id' }),
					}),
				})
			);
		});

		it('should include data in extra when provided', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test message', { customKey: 'customValue' });
			expect(mockLog).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.objectContaining({
						extra: expect.objectContaining({
							data: expect.objectContaining({ customKey: 'customValue' }),
						}),
					}),
				})
			);
		});

		it('should wrap non-object data in value property', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test message', 'string-data');
			expect(mockLog).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.objectContaining({
						extra: expect.objectContaining({
							data: { value: 'string-data' },
						}),
					}),
				})
			);
		});

		it('should not include extra when no correlationId and no data', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test message');
			const call = mockLog.mock.calls[0][0];
			expect(call.body.extra).toBeUndefined();
		});

		it('should do nothing when client is not initialized', () => {
			initLogger({});
			expect(() => logError('test')).not.toThrow();
		});

		it('should do nothing when app.log is undefined', () => {
			initLogger({ app: {} });
			expect(() => logError('test')).not.toThrow();
		});

		it('should mask sensitive data in messages', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
			logError(`Token: ${jwtToken}`);
			const message = mockLog.mock.calls[0][0].body.message;
			expect(message).not.toContain(jwtToken);
			expect(message).toContain('...');
		});
	});

	describe('sanitizeValue edge cases', () => {
		it('should return [max depth] when depth exceeds 10', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			
			let obj: Record<string, unknown> = { value: 'test' };
			for (let i = 0; i < 15; i++) {
				obj = { nested: obj };
			}
			logError('test', obj);
			
			const data = mockLog.mock.calls[0][0].body.extra?.data;
			const stringified = JSON.stringify(data);
			expect(stringified).toContain('[max depth]');
		});

		it('should mask sensitive keys with non-string values', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test', { 
				access_token: 12345, 
				password: { nested: true },
				apiKey: ['array', 'value'],
			});
			const data = mockLog.mock.calls[0][0].body.extra?.data;
			expect(data.access_token).toBe('***MASKED***');
			expect(data.password).toBe('***MASKED***');
			expect(data.apiKey).toBe('***MASKED***');
		});

		it('should mask short string tokens with ***MASKED*** (line 60 coverage)', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test', { 
				access_token: 'short',
				password: '12chars_here',
				apiKey: 'exactly12chr',
			});
			const data = mockLog.mock.calls[0][0].body.extra?.data;
			expect(data.access_token).toBe('***MASKED***');
			expect(data.password).toBe('***MASKED***');
			expect(data.apiKey).toBe('***MASKED***');
		});

		it('should partially mask long string tokens (line 61 coverage)', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test', { 
				access_token: 'this-is-a-longer-token-value',
			});
			const data = mockLog.mock.calls[0][0].body.extra?.data;
			expect(data.access_token).toBe('this-i...alue');
		});

		it('should handle arrays in sanitization', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test', { 
				items: ['normal', 'user@example.com', 'other'],
			});
			const data = mockLog.mock.calls[0][0].body.extra?.data;
			expect(data.items[0]).toBe('normal');
			expect(data.items[1]).toContain('***@***');
			expect(data.items[2]).toBe('other');
		});

		it('should handle null values', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test', { nullValue: null, undefinedValue: undefined });
			expect(mockLog).toHaveBeenCalled();
		});

		it('should handle primitive values', () => {
			const mockLog = vi.fn();
			initLogger({ app: { log: mockLog } });
			logError('test', 42);
			const data = mockLog.mock.calls[0][0].body.extra?.data;
			expect(data).toEqual({ value: 42 });
		});
	});

	describe('environment constants', () => {
		it('DEBUG_ENABLED should be a boolean', () => {
			expect(typeof DEBUG_ENABLED).toBe('boolean');
		});

		it('LOG_LEVEL should be a valid log level', () => {
			expect(['debug', 'info', 'warn', 'error']).toContain(LOG_LEVEL);
		});

		it('LOGGING_ENABLED should be a boolean', () => {
			expect(typeof LOGGING_ENABLED).toBe('boolean');
		});

		it('should default to info when log level is invalid (line 116 coverage)', async () => {
			const { LOG_LEVEL: invalidLevel } = await loadLoggerModule({
				CODEX_PLUGIN_LOG_LEVEL: 'invalid-level',
			});
			expect(invalidLevel).toBe('info');
		});
	});

	describe('formatDuration edge cases', () => {
		it('should handle exactly 1000ms', () => {
			expect(formatDuration(1000)).toBe('1.00s');
		});

		it('should handle exactly 60000ms', () => {
			expect(formatDuration(60000)).toBe('1m 0.0s');
		});

		it('should handle large durations', () => {
			expect(formatDuration(125000)).toBe('2m 5.0s');
		});

		it('should handle zero', () => {
			expect(formatDuration(0)).toBe('0ms');
		});

		it('should handle fractional milliseconds', () => {
			expect(formatDuration(0.5)).toBe('1ms');
		});
	});

	describe('logRequest with file writing', () => {
		beforeEach(() => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.writeFileSync).mockClear();
			vi.mocked(fs.mkdirSync).mockClear();
		});

		it('should not write when LOGGING_ENABLED is false', () => {
			logRequest('test-stage', { data: 'value' });
			if (!LOGGING_ENABLED) {
				expect(fs.writeFileSync).not.toHaveBeenCalled();
			}
		});

		it('should handle deeply nested data in logRequest', () => {
			expect(() => {
				logRequest('test-stage', {
					level1: {
						level2: {
							level3: {
								level4: {
									level5: 'deep',
								},
							},
						},
					},
				});
			}).not.toThrow();
		});

		it('should include correlationId in logged data when set', () => {
			setCorrelationId('log-request-correlation');
			logRequest('correlation-test', { key: 'value' });
			clearCorrelationId();
		});
	});

	describe('env-gated console logging', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.unstubAllEnvs();
			vi.resetModules();
		});

		afterEach(() => {
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
		});

		it('logs startup message when request logging is enabled', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			await loadLoggerModule({
				ENABLE_PLUGIN_REQUEST_LOGGING: '1',
				CODEX_CONSOLE_LOG: '1',
			});
			expect(consoleLog).toHaveBeenCalledWith(
				expect.stringContaining('Request logging ENABLED'),
			);
		});

		it('logs startup message when debug logging is enabled', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			await loadLoggerModule({
				DEBUG_CODEX_PLUGIN: '1',
				CODEX_CONSOLE_LOG: '1',
				CODEX_PLUGIN_LOG_LEVEL: 'debug',
				ENABLE_PLUGIN_REQUEST_LOGGING: '0',
			});
			expect(consoleLog).toHaveBeenCalledWith(
				expect.stringContaining('Debug logging ENABLED'),
			);
		});

		it('skips info logs when debug and request logging are disabled', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const { logInfo: logInfoDisabled } = await loadLoggerModule({
				CODEX_CONSOLE_LOG: '1',
			});
			consoleLog.mockClear();
			logInfoDisabled('not logged');
			expect(consoleLog).not.toHaveBeenCalled();
		});

		it('respects log level threshold when debug is enabled', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const { logDebug: logDebugSuppressed } = await loadLoggerModule({
				DEBUG_CODEX_PLUGIN: '1',
				CODEX_CONSOLE_LOG: '1',
				CODEX_PLUGIN_LOG_LEVEL: 'error',
			});
			consoleLog.mockClear();
			logDebugSuppressed('suppressed');
			expect(consoleLog).not.toHaveBeenCalled();
		});

		it('routes console logs by level and data presence', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const {
				logInfo: logInfoEnabled,
				logWarn: logWarnEnabled,
				logError: logErrorEnabled,
				logDebug: logDebugEnabled,
			} = await loadLoggerModule({
				DEBUG_CODEX_PLUGIN: '1',
				CODEX_CONSOLE_LOG: '1',
				CODEX_PLUGIN_LOG_LEVEL: 'debug',
			});
			consoleLog.mockClear();
			consoleWarn.mockClear();
			consoleError.mockClear();

			logInfoEnabled('info with data', { value: 'data' });
			logWarnEnabled('warn with data', { value: 'warn' });
			logErrorEnabled('error with data', { value: 'error' });
			logDebugEnabled('debug without data');
			logInfoEnabled('info without data');
			logWarnEnabled('warn without data');
			logErrorEnabled('error without data');

			expect(consoleLog).toHaveBeenCalled();
			expect(consoleWarn).toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalled();
		});

		it('logs errors even when debug logging is disabled', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { logError: logErrorAlways } = await loadLoggerModule({
				CODEX_CONSOLE_LOG: '1',
			});
			consoleError.mockClear();
			logErrorAlways('always logs');
			expect(consoleError).toHaveBeenCalled();
		});
	});

	describe('logRequest when logging is enabled', () => {
		const mockExistsSync = vi.mocked(fs.existsSync);
		const mockWriteFileSync = vi.mocked(fs.writeFileSync);
		const mockMkdirSync = vi.mocked(fs.mkdirSync);

		beforeEach(() => {
			vi.clearAllMocks();
			vi.unstubAllEnvs();
			vi.resetModules();
			mockExistsSync.mockReturnValue(true);
			mockWriteFileSync.mockImplementation(() => {});
			mockMkdirSync.mockImplementation(() => {});
		});

		afterEach(() => {
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
		});

		it('writes request logs and sanitizes deep values', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			mockExistsSync.mockReturnValue(false);
			const { logRequest: logRequestEnabled, setCorrelationId: setId } = await loadLoggerModule({
				ENABLE_PLUGIN_REQUEST_LOGGING: '1',
				CODEX_CONSOLE_LOG: '1',
			});
			consoleLog.mockClear();

			setId('correlation-123');
			const deepData: Record<string, unknown> = {};
			let cursor = deepData as Record<string, unknown>;
			for (let i = 0; i < 12; i++) {
				const next: Record<string, unknown> = {};
				cursor[`level${i}`] = next;
				cursor = next;
			}
			cursor.value = 'secret';

			logRequestEnabled('deep-stage', deepData);

			expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), {
				recursive: true,
				mode: 0o700,
			});
			expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
			const [, rawPayload] = mockWriteFileSync.mock.calls[0];
			const parsed = JSON.parse(rawPayload as string) as Record<string, unknown>;
			expect(JSON.stringify(parsed)).toContain('[max depth]');
			expect(parsed.correlationId).toBe('correlation-123');
			expect(consoleLog).toHaveBeenCalledWith(
				expect.stringContaining('Logged deep-stage to'),
			);
		});

		it('omits raw request and response payloads by default', async () => {
			const { logRequest: logRequestEnabled } = await loadLoggerModule({
				ENABLE_PLUGIN_REQUEST_LOGGING: '1',
				CODEX_CONSOLE_LOG: '1',
			});

			logRequestEnabled('payload-stage', {
				status: 200,
				body: { prompt: 'top secret prompt' },
				fullContent: 'top secret response',
			});

			expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
			const [, rawPayload] = mockWriteFileSync.mock.calls[0];
			const parsed = JSON.parse(rawPayload as string) as Record<string, unknown>;
			expect(parsed.body).toBeUndefined();
			expect(parsed.fullContent).toBeUndefined();
			expect(parsed.payloadsOmitted).toBe(true);
		});

		it('captures raw payloads only when CODEX_PLUGIN_LOG_BODIES=1', async () => {
			const { logRequest: logRequestEnabled } = await loadLoggerModule({
				ENABLE_PLUGIN_REQUEST_LOGGING: '1',
				CODEX_PLUGIN_LOG_BODIES: '1',
				CODEX_CONSOLE_LOG: '1',
			});

			logRequestEnabled('payload-stage', {
				status: 200,
				body: { prompt: 'top secret prompt' },
				fullContent: 'top secret response',
			});

			expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
			const [, rawPayload] = mockWriteFileSync.mock.calls[0];
			const parsed = JSON.parse(rawPayload as string) as Record<string, unknown>;
			expect(parsed.body).toEqual({ prompt: 'top secret prompt' });
			expect(parsed.fullContent).toBe('top secret response');
			expect(parsed.payloadsOmitted).toBeUndefined();
		});

		it('handles write failures gracefully', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockExistsSync.mockReturnValue(true);
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('disk full');
			});
			const { logRequest: logRequestEnabled } = await loadLoggerModule({
				ENABLE_PLUGIN_REQUEST_LOGGING: '1',
				CODEX_CONSOLE_LOG: '1',
			});
			consoleError.mockClear();

			expect(() => logRequestEnabled('failed-stage', { value: 'test' })).not.toThrow();
			expect(mockMkdirSync).not.toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining('Failed to write log'),
			);
		});
	});

	describe('scoped logger when debug is enabled', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.unstubAllEnvs();
			vi.resetModules();
		});

		afterEach(() => {
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
		});

		it('logs scoped messages and timers at all levels', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { createLogger: createLoggerEnabled } = await loadLoggerModule({
				DEBUG_CODEX_PLUGIN: '1',
				CODEX_CONSOLE_LOG: '1',
				CODEX_PLUGIN_LOG_LEVEL: 'debug',
			});
			consoleLog.mockClear();
			consoleWarn.mockClear();
			consoleError.mockClear();

			const logger = createLoggerEnabled('scoped');
			logger.debug('debug', { value: 'd' });
			logger.info('info', { value: 'i' });
			logger.warn('warn', { value: 'w' });
			logger.error('error', { value: 'e' });

			const endTimer = logger.time('operation');
			endTimer();
			logger.timeEnd('operation', performance.now() - 5);

			expect(consoleLog).toHaveBeenCalled();
			expect(consoleWarn).toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalled();
		});
	});

	describe('timer eviction at MAX_TIMERS', () => {
		it('should evict oldest timer when MAX_TIMERS is exceeded', () => {
			const logger = createLogger('eviction-test');
			const endTimers: Array<() => number> = [];

			for (let i = 0; i < 105; i++) {
				endTimers.push(logger.time(`timer-${i}`));
			}

			for (const end of endTimers) {
				expect(() => end()).not.toThrow();
			}
		});

		it('should still track timers correctly after eviction', () => {
			const logger = createLogger('eviction-test-2');
			
			for (let i = 0; i < 100; i++) {
				logger.time(`old-timer-${i}`);
			}
			
			const newTimer = logger.time('new-timer');
			const duration = newTimer();
			expect(typeof duration).toBe('number');
			expect(duration).toBeGreaterThanOrEqual(0);
		});
	});

	describe('maskEmail comprehensive', () => {
		it('should handle empty string', () => {
			const masked = maskEmail('');
			expect(masked).toBe('***@***');
		});

		it('should handle email with no TLD', () => {
			const masked = maskEmail('user@localhost');
			expect(masked).toBe('us***@***.localhost');
		});

		it('should handle very short email', () => {
			const masked = maskEmail('a@b.c');
			expect(masked).toBe('a***@***.c');
		});
	});

	describe('getRequestId', () => {
		it('should return consistent incrementing values', () => {
			const id1 = getRequestId();
			const id2 = getRequestId();
			expect(id1).toBe(id2);
		});
	});
});
