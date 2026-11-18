import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ exists: vi.fn(), stat: vi.fn(), access: vi.fn(), resolve: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: f.exists, statSync: f.stat, accessSync: f.access }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: f.resolve }) }));
import { resolveNativeUsageCommand } from '../lib/runtime/native-rate-limits.js';
const modern = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const legacy = '/Applications/ChatGPT.app/Contents/Resources/codex';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
 vi.clearAllMocks();
 vi.stubEnv('CODEX_MULTI_AUTH_USAGE_CODEX_BIN', '');
 f.exists.mockReturnValue(false);
 f.stat.mockImplementation((path: string) => { if (!f.exists(path)) throw Object.assign(Error('missing'), {code:'ENOENT'}); return {isFile:()=>true}; });
 f.access.mockImplementation(() => undefined);
 f.resolve.mockReturnValue('/fixture/npm/codex.js');
});
it('finds the relocated desktop backend before the npm fallback', () => {
 f.exists.mockImplementation((path: string) => path === modern);
 expect(resolveNativeUsageCommand('darwin')).toEqual([modern]);
 expect(f.resolve).not.toHaveBeenCalled();
});
it('prefers the current desktop layout when both paths exist', () => {
 f.exists.mockReturnValue(true);
 expect(resolveNativeUsageCommand('darwin')).toEqual([modern]);
});
it('supports the previous desktop layout', () => {
 f.exists.mockImplementation((path: string) => path === legacy);
 expect(resolveNativeUsageCommand('darwin')).toEqual([legacy]);
});
it('honors the explicit executable override before discovery', () => {
 vi.stubEnv('CODEX_MULTI_AUTH_USAGE_CODEX_BIN', '/fixture/native');
 f.exists.mockReturnValue(true);
 expect(resolveNativeUsageCommand('darwin')).toEqual(['/fixture/native']);
});
it('rejects an unavailable override instead of silently choosing another backend', () => {
 vi.stubEnv('CODEX_MULTI_AUTH_USAGE_CODEX_BIN', '/fixture/missing');
 expect(() => resolveNativeUsageCommand('darwin')).toThrow(/existing absolute path/);
 expect(f.resolve).not.toHaveBeenCalled();
});
it.each(['linux', 'win32', 'darwin'] as const)('uses the npm fallback when no desktop backend is available on %s', platform => {
 expect(resolveNativeUsageCommand(platform)).toEqual([process.execPath, '/fixture/npm/codex.js']);
});
it('reports unavailable backends without exposing module loader details', () => {
 f.resolve.mockImplementation(() => { throw Error('private path'); });
 expect(() => resolveNativeUsageCommand('linux')).toThrow(/Native usage backend unavailable/);
});

it.each(['directory', 'permission', 'stat-failure'])('skips a modern backend that is unusable due to %s', reason => {
 f.exists.mockReturnValue(true);
 if (reason === 'directory') f.stat.mockImplementation((path: string) => ({isFile:()=>path !== modern}));
 if (reason === 'permission') f.access.mockImplementation((path: string) => {if (path === modern) throw Object.assign(Error('denied'), {code:'EACCES'});});
 if (reason === 'stat-failure') f.stat.mockImplementation((path: string) => {if (path === modern) throw Object.assign(Error('busy'), {code:'EBUSY'});return {isFile:()=>true};});
 expect(resolveNativeUsageCommand('darwin')).toEqual([legacy]);
 expect(f.resolve).not.toHaveBeenCalled();
});
it('checks execution permission for the selected bundled file', async () => {
 const {constants}=await import('node:fs');
 f.exists.mockReturnValue(true);
 resolveNativeUsageCommand('darwin');
 expect(f.access).toHaveBeenCalledWith(modern,constants.X_OK);
});
