/**
 * Unit tests for OAuth server logic
 * Tests request handling without actual port binding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// Mock http module before importing server
vi.mock('node:http', () => {
	const mockServer = {
		listen: vi.fn(),
		close: vi.fn(),
		unref: vi.fn(),
		on: vi.fn(),
		_lastCode: undefined as string | undefined,
	};

	return {
		default: {
			createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
				// Store the handler for later invocation
				(mockServer as unknown as { _handler: typeof handler })._handler = handler;
				return mockServer;
			}),
		},
	};
});

vi.mock('node:fs', () => ({
	default: {
		readFileSync: vi.fn(() => '<html>Success</html>'),
	},
}));

vi.mock('../lib/logger.js', () => ({
	logError: vi.fn(),
	logWarn: vi.fn(),
}));

import http from 'node:http';
import { startLocalOAuthServer } from '../lib/auth/server.js';
import { logError, logWarn } from '../lib/logger.js';

describe('OAuth Server Unit Tests', () => {
	let mockServer: ReturnType<typeof http.createServer> & {
		_handler?: (req: IncomingMessage, res: ServerResponse) => void;
		_lastCode?: string;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockServer = http.createServer(() => {}) as typeof mockServer;
		mockServer._lastCode = undefined;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('server creation', () => {
		it('should call http.createServer', async () => {
			// Make listen succeed immediately
			(mockServer.listen as ReturnType<typeof vi.fn>).mockImplementation(
				(_port: number, _host: string, callback: () => void) => {
					callback();
					return mockServer;
				}
			);
			(mockServer.on as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

			const result = await startLocalOAuthServer({ state: 'test-state' });
			expect(http.createServer).toHaveBeenCalled();
			expect(result.port).toBe(1455);
			expect(result.ready).toBe(true);
		});

		it('should set ready=false when port binding fails', async () => {
			(mockServer.listen as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);
			(mockServer.on as ReturnType<typeof vi.fn>).mockImplementation(
				(event: string, handler: (err: NodeJS.ErrnoException) => void) => {
					if (event === 'error') {
						// Simulate EADDRINUSE
						const error = new Error('Address in use') as NodeJS.ErrnoException;
						error.code = 'EADDRINUSE';
						setTimeout(() => handler(error), 0);
					}
					return mockServer;
				}
			);

			const result = await startLocalOAuthServer({ state: 'test-state' });
			expect(result.ready).toBe(false);
			expect(result.port).toBe(1455);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Failed to bind http://127.0.0.1:1455')
			);
		});
	});

	describe('request handler', () => {
		let requestHandler: (req: IncomingMessage, res: ServerResponse) => void;

		beforeEach(() => {
			(mockServer.listen as ReturnType<typeof vi.fn>).mockImplementation(
				(_port: number, _host: string, callback: () => void) => {
					callback();
					return mockServer;
				}
			);
			(mockServer.on as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

			// Start server to capture request handler
			startLocalOAuthServer({ state: 'test-state' });
			requestHandler = mockServer._handler!;
		});

		function createMockRequest(url: string): IncomingMessage {
			const req = new EventEmitter() as IncomingMessage;
			req.url = url;
			return req;
		}

		function createMockResponse(): ServerResponse & { _body: string; _headers: Record<string, string> } {
			const res = {
				statusCode: 200,
				_body: '',
				_headers: {} as Record<string, string>,
				setHeader: vi.fn((name: string, value: string) => {
					res._headers[name.toLowerCase()] = value;
				}),
				end: vi.fn((body?: string) => {
					if (body) res._body = body;
				}),
			};
			return res as unknown as ServerResponse & { _body: string; _headers: Record<string, string> };
		}

		it('should return 404 for non-callback paths', () => {
			const req = createMockRequest('/other-path');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(404);
			expect(res.end).toHaveBeenCalledWith('Not found');
		});

		it('should return 400 for state mismatch', () => {
			const req = createMockRequest('/auth/callback?code=abc&state=wrong-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(400);
			expect(res.end).toHaveBeenCalledWith('State mismatch');
		});

		it('should return 400 for missing code', () => {
			const req = createMockRequest('/auth/callback?state=test-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(400);
			expect(res.end).toHaveBeenCalledWith('Missing authorization code');
		});

		it('should return 200 with HTML for valid callback', () => {
			const req = createMockRequest('/auth/callback?code=test-code&state=test-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
			expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
			expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
			expect(res.setHeader).toHaveBeenCalledWith(
				'Content-Security-Policy',
				"default-src 'self'; script-src 'none'"
			);
			expect(res.end).toHaveBeenCalledWith('<html>Success</html>');
		});

		it('should store the code in server._lastCode', () => {
			const req = createMockRequest('/auth/callback?code=captured-code&state=test-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(mockServer._lastCode).toBe('captured-code');
		});

		it('should handle request handler errors gracefully', () => {
			const req = createMockRequest('/auth/callback?code=test&state=test-state');
			const res = createMockResponse();
			(res.setHeader as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error('setHeader failed');
			});

			expect(() => requestHandler(req, res)).not.toThrow();
			expect(res.statusCode).toBe(500);
			expect(res.end).toHaveBeenCalledWith('Internal error');
			expect(logError).toHaveBeenCalledWith(expect.stringContaining('Request handler error'));
		});
	});

	describe('close function', () => {
		it('should call server.close when ready=true', async () => {
			(mockServer.listen as ReturnType<typeof vi.fn>).mockImplementation(
				(_port: number, _host: string, callback: () => void) => {
					callback();
					return mockServer;
				}
			);
			(mockServer.on as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

			const result = await startLocalOAuthServer({ state: 'test-state' });
			result.close();

			expect(mockServer.close).toHaveBeenCalled();
		});

		it('should handle close error when ready=false', async () => {
			(mockServer.listen as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);
			(mockServer.on as ReturnType<typeof vi.fn>).mockImplementation(
				(event: string, handler: (err: NodeJS.ErrnoException) => void) => {
					if (event === 'error') {
						const error = new Error('Address in use') as NodeJS.ErrnoException;
						error.code = 'EADDRINUSE';
						setTimeout(() => handler(error), 0);
					}
					return mockServer;
				}
			);
			(mockServer.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error('Close failed');
			});

			const result = await startLocalOAuthServer({ state: 'test-state' });
			
			// Should not throw even if close fails
			expect(() => result.close()).not.toThrow();
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Failed to close OAuth server')
			);
		});
	});

	describe('waitForCode function', () => {
		it('should return null immediately when ready=false', async () => {
			(mockServer.listen as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);
			(mockServer.on as ReturnType<typeof vi.fn>).mockImplementation(
				(event: string, handler: (err: NodeJS.ErrnoException) => void) => {
					if (event === 'error') {
						const error = new Error('Address in use') as NodeJS.ErrnoException;
						error.code = 'EADDRINUSE';
						setTimeout(() => handler(error), 0);
					}
					return mockServer;
				}
			);

			const result = await startLocalOAuthServer({ state: 'test-state' });
			const code = await result.waitForCode('test-state');

			expect(code).toBeNull();
		});

		it('should return code when available', async () => {
			(mockServer.listen as ReturnType<typeof vi.fn>).mockImplementation(
				(_port: number, _host: string, callback: () => void) => {
					callback();
					return mockServer;
				}
			);
			(mockServer.on as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

			const result = await startLocalOAuthServer({ state: 'test-state' });
			
			mockServer._lastCode = 'the-code';
			
			const code = await result.waitForCode('test-state');
			expect(code).toEqual({ code: 'the-code' });
		});

		it('should return null after 5 minute timeout', async () => {
			vi.useFakeTimers();
			
			(mockServer.listen as ReturnType<typeof vi.fn>).mockImplementation(
				(_port: number, _host: string, callback: () => void) => {
					callback();
					return mockServer;
				}
			);
			(mockServer.on as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

			const result = await startLocalOAuthServer({ state: 'test-state' });
			
			const codePromise = result.waitForCode('test-state');
			
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
			
			const code = await codePromise;
			expect(code).toBeNull();
			expect(logWarn).toHaveBeenCalledWith('OAuth poll timeout after 5 minutes');
			
			vi.useRealTimers();
		});
	});
});
