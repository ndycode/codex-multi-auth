import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResetCreditService, type ResetTarget } from '../lib/runtime/reset-credits.js';
import { removeWithRetry } from './helpers/remove-with-retry.js';

let dir: string;
const now = 1_800_000_000_000;
const seconds = now / 1000;
const target = (key: string): ResetTarget => ({ key, accountId: key });
const credit = (id: string, expiresAt: number | null = seconds + 3600) => ({
 id, expiresAt, grantedAt: seconds - 3600, status: 'available', resetType: 'codexRateLimits',
});
const payload = (key: string, credits: unknown[] | null, availableCount = credits?.length ?? 1) => ({
 accountId: key, ordinaryUsageAllowed: false,
 rateLimitResetCredits: { availableCount, credits },
 rateLimits: { planType: 'pro', primary: { usedPercent: 100, resetsAt: seconds + 7200 }, secondary: { usedPercent: 10 } },
});
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'reset-expiry-')); });
afterEach(async () => { await removeWithRetry(dir, { recursive: true, force: true }); });
function fixture(rows: Record<string, ReturnType<typeof payload>>) {
 const read = vi.fn(async (t: ResetTarget) => rows[t.key]);
 const consume = vi.fn(async (_t: ResetTarget, _key: string, _creditId?: string) => ({ outcome: 'reset' }));
 const io = { read, consume, now: () => now };
 const service = new ResetCreditService(join(dir, 'state.json'), io);
 return { service, io, read, consume };
}

it('redeems the earliest-expiring credit across accounts despite preferred input order and later list position', async () => {
 const f = fixture({
  preferred: payload('preferred', [credit('preferred-later', seconds + 3000)]),
  other: payload('other', [credit('other-later', seconds + 2000), credit('earliest', seconds + 300)]),
 });
 await f.service.setPolicy('last-resort');
 expect(await f.service.automatic([target('preferred'), target('other')])).toEqual({ key: 'other', outcome: 'reset' });
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('other'), expect.any(String), 'earliest');
});

it('uses freshly returned expiries rather than a previously refreshed snapshot', async () => {
 const rows = { a: payload('a', [credit('a-soon', seconds + 100)]), b: payload('b', [credit('b-later', seconds + 300)]) };
 const f = fixture(rows);
 await f.service.refresh([target('a'), target('b')]);
 rows.a = payload('a', [credit('a-now-later', seconds + 600)]);
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a'), target('b')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('b'), expect.any(String), 'b-later');
});

it.each([null, [], [credit('never', null)], [{ ...credit('unknown'), expiresAt: undefined }]])('prefers a known expiry over undated or unavailable details (%j)', async credits => {
 const f = fixture({ a: payload('a', credits, 1), b: payload('b', [credit('dated')]) });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a'), target('b')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('b'), expect.any(String), 'dated');
});

it('retains account and credit order for equal expiry timestamps', async () => {
 const f = fixture({ a: payload('a', [credit('first'), credit('same-deadline')]), b: payload('b', [credit('other')]) });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a'), target('b')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('a'), expect.any(String), 'first');
});

it('ignores expired, unavailable, unsupported and malformed credit rows without preventing another valid choice', async () => {
 const invalid = [
  credit('expired', seconds - 1), credit('expires-now', seconds),
  { ...credit('redeemed', seconds + 1), status: 'redeemed' },
  { ...credit('redeeming', seconds + 1), status: 'redeeming' },
  { ...credit('unknown-status', seconds + 1), status: 'unknown' },
  { ...credit('wrong-type', seconds + 1), resetType: 'unknown' },
  credit('', seconds + 1), credit('fractional', seconds + 0.5),
  credit('infinite', Infinity), { ...credit('bad-date'), expiresAt: 'tomorrow' },
 ];
 const f = fixture({ a: payload('a', invalid), b: payload('b', [credit('valid')]) });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a'), target('b')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('b'), expect.any(String), 'valid');
});

it('does not redeem a listed credit when its authoritative available count is zero', async () => {
 const f = fixture({ a: payload('a', [credit('unavailable', seconds + 1)], 0), b: payload('b', [credit('available')]) });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a'), target('b')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('b'), expect.any(String), 'available');
});

it('keeps count-only recovery deterministic when no dated credits are exposed', async () => {
 const f = fixture({ a: payload('a', null, 2), b: payload('b', [], 3) });
 await f.service.setPolicy('last-resort');
 expect(await f.service.automatic([target('a'), target('b')])).toEqual({ key: 'a', outcome: 'reset' });
 expect(f.consume).toHaveBeenCalledTimes(1);
 expect(f.consume.mock.calls[0]?.[2]).toBeUndefined();
});

it('uses an explicit nonexpiring credit when it is the only known available choice', async () => {
 const f = fixture({ a: payload('a', [credit('never', null)]) });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('a'), expect.any(String), 'never');
});

it.each(['consume', 'follow-up read'])('persists the chosen credit with its idempotency key after an ambiguous %s', async failure => {
 const f = fixture({ a: payload('a', [credit('chosen')]) });
 await f.service.setPolicy('last-resort');
 if (failure === 'consume') f.consume.mockRejectedValueOnce(Error('lost reply'));
 else f.read.mockResolvedValueOnce(payload('a', [credit('chosen')])).mockRejectedValueOnce(Error('lost reply'));
 await expect(f.service.automatic([target('a')])).rejects.toThrow('lost reply');
 const pending = (await f.service.status()).pending;
 expect(pending).toMatchObject({ key: 'a', creditId: 'chosen' });
 expect((await f.service.status()).version).toBe(2); // Old readers must reject, never strip the credit ID.
 // Snapshots keep only the display projection; the credit ID lives solely in pending.
 expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).snapshots.a.credits).toEqual([{ expiresAt: expect.any(Number) }]);
 const restarted = new ResetCreditService(join(dir, 'state.json'), f.io);
 expect(await restarted.automatic([target('a')])).toBeNull();
 await restarted.redeem(target('a'));
 expect(f.consume.mock.calls[1]).toEqual(f.consume.mock.calls[0]);
 expect((await restarted.status()).pending).toBeUndefined();
 expect((await restarted.status()).version).toBe(3); // Completed per-scope receipts require the new reader.
 expect(await readFile(join(dir, 'state.json'), 'utf8')).not.toContain('chosen');
});

it('retries a legacy pending attempt without attaching a newly discovered credit ID', async () => {
 const f = fixture({ a: payload('a', [credit('newly-discovered')]) });
 const idempotencyKey = randomUUID();
 await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, policy: 'last-resort', snapshots: {}, pending: { key: 'a', idempotencyKey } }));
 await f.service.redeem(target('a'));
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('a'), idempotencyKey, undefined);
});

it('does not explicitly select duplicate credit IDs, including conflicting statuses', async () => {
 const f = fixture({
  a: payload('a', [credit('duplicate', seconds + 1), { ...credit('duplicate', seconds + 2), status: 'redeemed' }]),
  b: payload('b', [credit('unique')]),
 });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a'), target('b')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('b'), expect.any(String), 'unique');
});

it('keeps authoritative count-only recovery for duplicate-only details', async () => {
 const f = fixture({ a: payload('a', [credit('duplicate'), credit('duplicate')], 4) });
 await f.service.setPolicy('last-resort');
 await f.service.automatic([target('a')]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('a'), expect.any(String), undefined);
});

it('serializes concurrent expiry-based recovery to one credit', async () => {
 const f = fixture({ a: payload('a', [credit('later', seconds + 3000)]), b: payload('b', [credit('soon', seconds + 300)]) });
 await f.service.setPolicy('last-resort');
 const other = new ResetCreditService(join(dir, 'state.json'), f.io);
 await Promise.all([f.service.automatic([target('a'), target('b')]), other.automatic([target('a'), target('b')])]);
 expect(f.consume).toHaveBeenCalledExactlyOnceWith(target('b'), expect.any(String), 'soon');
});
