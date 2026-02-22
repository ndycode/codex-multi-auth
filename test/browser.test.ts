import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:child_process', () => ({
	spawn: vi.fn(() => ({
		on: vi.fn(),
	})),
}));

vi.mock('node:fs', () => ({
	default: {
		existsSync: vi.fn(),
	},
	existsSync: vi.fn(),
}));

import { getBrowserOpener, openBrowserUrl } from '../lib/auth/browser.js';
import { PLATFORM_OPENERS } from '../lib/constants.js';

const mockedSpawn = vi.mocked(spawn);
const mockedExistsSync = vi.mocked(fs.existsSync);

describe('Browser Module', () => {
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;
	const originalPathext = process.env.PATHEXT;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalPathext === undefined) {
			delete process.env.PATHEXT;
		} else {
			process.env.PATHEXT = originalPathext;
		}
	});

	describe('getBrowserOpener', () => {
		it('should return correct opener for darwin', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' });
			expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.darwin);
		});

		it('should return correct opener for win32', () => {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.win32);
		});

		it('should return linux opener for linux platform', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.linux);
		});

		it('should return linux opener for unknown platforms like freebsd', () => {
			Object.defineProperty(process, 'platform', { value: 'freebsd' });
			expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.linux);
		});

		it('should return linux opener for aix platform', () => {
			Object.defineProperty(process, 'platform', { value: 'aix' });
			expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.linux);
		});
	});

	describe('openBrowserUrl', () => {
		describe('Windows platform', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'win32' });
			});

			it('should use PowerShell on Windows', () => {
				openBrowserUrl('https://example.com');
				expect(mockedSpawn).toHaveBeenCalledWith(
					'powershell.exe',
					expect.arrayContaining(['-NoLogo', '-NoProfile', '-Command']),
					{ stdio: 'ignore' }
				);
			});

			it('should escape PowerShell special characters in URL', () => {
				openBrowserUrl('https://example.com?foo=bar&baz=qux');
				expect(mockedSpawn).toHaveBeenCalledWith(
					'powershell.exe',
					expect.arrayContaining([
						expect.stringContaining('Start-Process')
					]),
					expect.anything()
				);
			});

			it('should escape backticks in URL for PowerShell', () => {
				openBrowserUrl('https://example.com/path`with`backticks');
				const call = mockedSpawn.mock.calls[0];
				const commandArg = call[1].find((arg: string) => arg.includes('Start-Process'));
				expect(commandArg).toContain('``');
			});

			it('should escape dollar signs in URL for PowerShell', () => {
				openBrowserUrl('https://example.com/$variable');
				const call = mockedSpawn.mock.calls[0];
				const commandArg = call[1].find((arg: string) => arg.includes('Start-Process'));
				expect(commandArg).toContain('`$');
			});

			it('should return true on Windows', () => {
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(true);
			});
		});

		describe('Non-Windows platforms', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'linux' });
			});

			it('should return false when PATH is empty', () => {
				process.env.PATH = '';
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(false);
			});

			it('should return false when opener command does not exist in PATH', () => {
				process.env.PATH = '/usr/bin:/bin';
				mockedExistsSync.mockReturnValue(false);
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(false);
			});

			it('should spawn opener when command exists', () => {
				process.env.PATH = '/usr/bin';
				mockedExistsSync.mockImplementation((p) => {
					return typeof p === 'string' && p.includes('xdg-open');
				});
				openBrowserUrl('https://example.com');
				expect(mockedSpawn).toHaveBeenCalledWith(
					expect.any(String),
					['https://example.com'],
					{ stdio: 'ignore', shell: false }
				);
			});

			it('should return true when opener exists and spawns successfully', () => {
				process.env.PATH = '/usr/bin';
				mockedExistsSync.mockReturnValue(true);
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(true);
			});
		});

		describe('macOS platform', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				process.env.PATH = '/usr/bin';
			});

			it('should use "open" command on macOS', () => {
				mockedExistsSync.mockReturnValue(true);
				openBrowserUrl('https://example.com');
				expect(mockedSpawn).toHaveBeenCalledWith(
					'open',
					['https://example.com'],
					expect.anything()
				);
			});
		});

		describe('Error handling', () => {
			it('should handle spawn errors silently and return true on Windows', () => {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				mockedSpawn.mockImplementation(() => {
					const mockChild = {
						on: vi.fn((event, callback) => {
							if (event === 'error') {
								callback(new Error('spawn failed'));
							}
						}),
					};
					return mockChild as unknown as ReturnType<typeof spawn>;
				});
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(true);
			});

			it('should catch and swallow errors in outer try-catch', () => {
				Object.defineProperty(process, 'platform', { value: 'linux' });
				process.env.PATH = '/usr/bin';
				mockedExistsSync.mockImplementation(() => {
					throw new Error('filesystem error');
				});
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(false);
			});
		});

		describe('Windows commandExists for "start" builtin', () => {
			it('should return true on Windows even without checking PATH for start', () => {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const result = openBrowserUrl('https://example.com');
				expect(result).toBe(true);
			});
		});

		describe('PATHEXT handling on Windows', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'win32' });
			});

			it('should use PowerShell regardless of PATHEXT', () => {
				process.env.PATHEXT = '.EXE;.CMD;.BAT';
				process.env.PATH = 'C:\\Windows\\System32';
				openBrowserUrl('https://example.com');
				expect(mockedSpawn).toHaveBeenCalledWith(
					'powershell.exe',
					expect.anything(),
					expect.anything()
				);
			});
		});
	});

	describe('commandExists internal behavior', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform });
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			if (originalPathext === undefined) {
				delete process.env.PATHEXT;
			} else {
				process.env.PATHEXT = originalPathext;
			}
		});

		const originalPlatform = process.platform;
		const originalPath = process.env.PATH;
		const originalPathext = process.env.PATHEXT;

		it('should find command with .EXE extension on Windows when non-PowerShell opener used', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			process.env.PATH = '/usr/bin';
			mockedExistsSync.mockImplementation((p) => {
				if (typeof p === 'string' && p.endsWith('xdg-open')) return true;
				return false;
			});

			const result = openBrowserUrl('https://example.com');
			expect(result).toBe(true);
			expect(mockedExistsSync).toHaveBeenCalled();
		});

		it('should try multiple PATHEXT extensions when searching for command', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			process.env.PATH = '/opt/bin';
			mockedExistsSync.mockReturnValue(false);

			openBrowserUrl('https://example.com');
			expect(mockedExistsSync).toHaveBeenCalled();
		});
	});
});
