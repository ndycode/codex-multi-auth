import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetCreditService, type ResetTarget } from '../lib/runtime/reset-credits.js';
import { removeWithRetry } from './helpers/remove-with-retry.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'reset-exhaustion-')); });
afterEach(async () => { await removeWithRetry(dir, { recursive: true, force: true }); });
const target = (id: string): ResetTarget => ({ key: id, accountId: id });
const start = 1_800_000_000_000;
function fixture() {
 let now = start;
 let allowed: boolean | null = true;
 let credits = 1;
 const payload = (t: ResetTarget, permission = allowed) => ({ accountId: t.accountId,
  ordinaryUsageAllowed: permission, rateLimitResetCredits: { availableCount: credits },
  rateLimits: { planType: 'pro', primary: { usedPercent: 100, resetsAt: now / 1000 + 3600 }, secondary: {} } });
 const read = vi.fn(async (t: ResetTarget) => payload(t));
 const consume = vi.fn(async () => { allowed = true; credits -= 1; return { outcome: 'reset' }; });
 const io = { read, consume, now: () => now };
 const service = new ResetCreditService(join(dir, 'state.json'), io);
 return { service, read, consume, payload, io,
  advance: (ms = 100) => { now += ms; }, exhaust: () => { allowed = false; },
  setCredits: (value: number) => { credits = value; },
  evidence: (id = 'a') => ({ ...target(id), observedAt: now }),
 };
}

describe('new exhaustion after a healthy native reset check', () => {
 it('rechecks all targets and resets immediately on fresh exhaustion evidence', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort');
  await f.service.automatic([target('a'), target('b')]);
  f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a'), target('b')], [f.evidence()])).toEqual({ key: 'a', outcome: 'reset' });
  expect(f.read.mock.calls.map(([t]) => t.key)).toEqual(['a', 'b', 'a', 'b', 'a']);
  expect(f.consume).toHaveBeenCalledTimes(1);
 });

 it.each([
  ['same observation', { observedAt: start }],
  ['future observation', { observedAt: start + 101 }],
  ['stale observation', { observedAt: start - 60_001 }],
  ['non-finite observation', { observedAt: Number.NaN }],
  ['infinite observation', { observedAt: Number.POSITIVE_INFINITY }],
  ['wrong scope', { key: 'other' }],
  ['wrong native account', { accountId: 'other' }],
 ])('does not bypass for %s', async (_name, patch) => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a')], [{ ...f.evidence(), ...patch }])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.consume).not.toHaveBeenCalled();
 });

 it('requires a recorded healthy native baseline', async () => {
  const f = fixture(); f.exhaust(); f.setCredits(0); await f.service.setPolicy('last-resort');
  await f.service.automatic([target('a')]); f.advance(); f.setCredits(1);
  expect(await f.service.automatic([target('a')], [f.evidence()])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.consume).not.toHaveBeenCalled();
 });

 it('uses evidence only to reread, and never rereads the same evidence twice', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  f.advance(); const evidence = [f.evidence()];
  expect(await f.service.automatic([target('a')], evidence)).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.consume).not.toHaveBeenCalled();
  f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a')], evidence)).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.consume).not.toHaveBeenCalled();
 });

 it.each(['healthy', 'unknown', 'failed'] as const)('still refuses spending when another fresh target read is %s', async kind => {
  const f = fixture(); const targets = [target('a'), target('b')];
  await f.service.setPolicy('last-resort'); await f.service.automatic(targets); f.advance(); f.exhaust();
  f.read.mockImplementation(async t => {
   if (t.key !== 'b') return f.payload(t);
   if (kind === 'failed') throw Error('synthetic failed native read');
   return f.payload(t, kind === 'healthy' ? true : null);
  });
  expect(await f.service.automatic(targets, [f.evidence()])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(4); expect(f.consume).not.toHaveBeenCalled();
 });

 it('preserves the five-minute redemption guard even with newer exhaustion', async () => {
  const f = fixture(); f.exhaust(); await f.service.setPolicy('last-resort');
  await f.service.automatic([target('a')]); f.advance(); f.exhaust(); f.setCredits(1);
  expect(await f.service.automatic([target('a')], [f.evidence()])).toBeNull();
  expect(f.consume).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(2);
 });

 it('preserves manual policy with newer exhaustion', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  await f.service.setPolicy('manual'); f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a')], [f.evidence()])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.consume).not.toHaveBeenCalled();
 });

 it('coalesces concurrent new evidence across services into one redemption', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  f.advance(); f.exhaust(); const other = new ResetCreditService(join(dir, 'state.json'), f.io);
  await Promise.all([f.service.automatic([target('a')], [f.evidence()]), other.automatic([target('a')], [f.evidence()])]);
  expect(f.consume).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(3);
 });

 it.each([true, false])('reevaluates a joined negative check only for newer evidence: %s', async newer => {
  const f = fixture(); await f.service.setPolicy('last-resort');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  let parked = false;
  f.read.mockImplementation(async t => {
   if (t.key === 'b' && !parked) { parked = true; entered(); await gate; }
   return f.payload(t, t.key === 'b' ? false : undefined);
  });
  const targets = [target('a'), target('b')];
  const first = f.service.automatic(targets); await started;
  // Let the already-resolved first target be timestamped before the later observation.
  await Promise.resolve(); await Promise.resolve();
  f.advance(); f.exhaust();
  const second = f.service.automatic(targets, [{ ...f.evidence(), observedAt: newer ? f.io.now() : start }]);
  release(); expect(await first).toEqual(newer ? { key: 'a', outcome: 'reset' } : null);
  expect(await second).toEqual(newer ? { key: 'a', outcome: 'reset' } : null);
  expect(f.consume).toHaveBeenCalledTimes(newer ? 1 : 0);
  expect(f.read).toHaveBeenCalledTimes(newer ? 5 : 2);
 });
});


it.each([
 ['stale then fresh', [false, true]],
 ['fresh then stale', [true, false]],
 ['many stale before fresh', [false, false, false, true]],
 ['fresh among stale', [false, true, false, false]],
 ['high fan-in', Array.from({ length: 60 }, (_unused, index) => index > 20 && index % 3 === 0)],
] as const)('retains newest evidence from concurrent waiters: %s', async (_name, order) => {
 const f = fixture(); await f.service.setPolicy('last-resort');
 let release!: () => void; let entered!: () => void;
 const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
 let parked = false;
 f.read.mockImplementation(async t => {
  if (t.key === 'b' && !parked) { parked = true; entered(); await gate; }
  return f.payload(t, t.key === 'b' ? false : undefined);
 });
 const targets = [target('a'), target('b')];
 const first = f.service.automatic(targets); await started;
 await Promise.resolve(); await Promise.resolve();
 f.advance(); f.exhaust();
 const waiters = order.map(fresh => f.service.automatic(targets, [{ ...f.evidence(), observedAt: fresh ? f.io.now() : start }]));
 release();
 const results = await Promise.all([first, ...waiters]);
 expect(results).toEqual(Array.from({ length: order.length + 1 }, () => ({ key: 'a', outcome: 'reset' })));
 expect(f.consume).toHaveBeenCalledTimes(1);
 expect(f.read).toHaveBeenCalledTimes(5);
});

it('retains newer evidence that arrives during the first coalesced recheck', async () => {
 const f = fixture(); await f.service.setPolicy('last-resort');
 const releases: Array<() => void> = [];
 const entries: Array<() => void> = [];
 const gates = Array.from({ length: 2 }, () => new Promise<void>(r => releases.push(r)));
 const started = Array.from({ length: 2 }, () => new Promise<void>(r => entries.push(r)));
 let bReads = 0;
 f.read.mockImplementation(async t => {
  if (t.key === 'b' && bReads < 2) {
   const index = bReads++; entries[index]!(); await gates[index];
  }
  return f.payload(t, t.key === 'b' ? false : undefined);
 });
 const targets = [target('a'), target('b')];
 const first = f.service.automatic(targets); await started[0];
 await Promise.resolve(); await Promise.resolve();
 f.advance();
 const second = f.service.automatic(targets, [f.evidence()]);
 releases[0]!(); await started[1];
 await Promise.resolve(); await Promise.resolve();
 f.advance(); f.exhaust();
 const third = f.service.automatic(targets, [f.evidence()]);
 releases[1]!();
 await first; await second;
 expect(await third).toEqual({ key: 'a', outcome: 'reset' });
 expect(f.read).toHaveBeenCalledTimes(7); expect(f.consume).toHaveBeenCalledTimes(1);
});

it('coalesces repeated identical evidence without a native read storm', async () => {
 const f = fixture(); await f.service.setPolicy('last-resort');
 const releases: Array<() => void> = [];
 const entries: Array<() => void> = [];
 const gates = Array.from({ length: 2 }, () => new Promise<void>(r => releases.push(r)));
 const started = Array.from({ length: 2 }, () => new Promise<void>(r => entries.push(r)));
 let bReads = 0;
 f.read.mockImplementation(async t => {
  if (t.key === 'b' && bReads < 2) {
   const index = bReads++; entries[index]!(); await gates[index];
  }
  return f.payload(t, t.key === 'b' ? false : undefined);
 });
 const targets = [target('a'), target('b')];
 const first = f.service.automatic(targets); await started[0];
 await Promise.resolve(); await Promise.resolve();
 f.advance(); const evidence = [f.evidence()];
 const waiters = Array.from({ length: 20 }, () => f.service.automatic(targets, evidence));
 releases[0]!(); await started[1];
 waiters.push(...Array.from({ length: 20 }, () => f.service.automatic(targets, evidence)));
 releases[1]!();
 expect(await Promise.all([first, ...waiters])).toEqual(Array(41).fill(null));
 expect(f.read).toHaveBeenCalledTimes(4); expect(f.consume).not.toHaveBeenCalled();
});

it('keeps valid joined proof when later waiters supply invalid newer evidence', async () => {
 const f = fixture(); await f.service.setPolicy('last-resort');
 let release!: () => void; let entered!: () => void;
 const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
 let parked = false;
 f.read.mockImplementation(async t => {
  if (t.key === 'b' && !parked) { parked = true; entered(); await gate; }
  return f.payload(t, t.key === 'b' ? false : undefined);
 });
 const targets = [target('a'), target('b')];
 const first = f.service.automatic(targets); await started;
 await Promise.resolve(); await Promise.resolve();
 f.advance(); f.exhaust();
 const fresh = f.service.automatic(targets, [f.evidence()]);
 const invalid = [
  { ...f.evidence(), observedAt: f.io.now() + 1 },
  { ...f.evidence(), accountId: 'other', observedAt: f.io.now() },
  { ...f.evidence(), key: 'other' },
  { ...f.evidence(), observedAt: Infinity },
  { ...f.evidence(), observedAt: NaN },
 ].map(proof => f.service.automatic(targets, [proof]));
 release(); await first; await Promise.all(invalid);
 expect(await fresh).toEqual({ key: 'a', outcome: 'reset' });
 expect(f.read).toHaveBeenCalledTimes(5); expect(f.consume).toHaveBeenCalledTimes(1);
});

it('bounds continuously newer evidence to three passes before a later request retries', async () => {
 const f = fixture(); await f.service.setPolicy('last-resort');
 const releases: Array<() => void> = [];
 const entries: Array<() => void> = [];
 const gates = Array.from({ length: 3 }, () => new Promise<void>(r => releases.push(r)));
 const started = Array.from({ length: 3 }, () => new Promise<void>(r => entries.push(r)));
 let bReads = 0;
 f.read.mockImplementation(async t => {
  if (t.key === 'b' && bReads < 3) {
   const index = bReads++; entries[index]!(); await gates[index];
  }
  return f.payload(t, t.key === 'b' ? false : undefined);
 });
 const targets = [target('a'), target('b')];
 const first = f.service.automatic(targets); const waiters = [first];
 for (let pass = 0; pass < 3; pass++) {
  await started[pass]; await Promise.resolve(); await Promise.resolve();
  f.advance();
  if (pass === 2) f.exhaust();
  waiters.push(f.service.automatic(targets, [f.evidence()]));
  releases[pass]!();
 }
 expect(await Promise.all(waiters)).toEqual(Array(4).fill(null));
 expect(f.read).toHaveBeenCalledTimes(6); expect(f.consume).not.toHaveBeenCalled();
 expect(await f.service.automatic(targets, [f.evidence()])).toEqual({ key: 'a', outcome: 'reset' });
 expect(f.read).toHaveBeenCalledTimes(9); expect(f.consume).toHaveBeenCalledTimes(1);
});

it('starts a new batch when proof arrives after completion but before promise cleanup', async () => {
 const f = fixture();
 let finish!: (result: null) => void;
 const finished = new Promise<null>(resolve => { finish = resolve; });
 // Control only the locked-check boundary; exercise the real batch scheduler.
 let finishSecond!: (result: { key: string; outcome: 'reset' }) => void;
 const secondFinished = new Promise<{ key: string; outcome: 'reset' }>(resolve => { finishSecond = resolve; });
 const locked = vi.fn().mockImplementationOnce(() => finished)
  .mockImplementationOnce(() => secondFinished)
  .mockResolvedValue(null);
 Reflect.set(f.service, 'automaticLocked', locked);
 const first = f.service.automatic([target('a')]);
 finish(null);
 await Promise.resolve();
 const second = f.service.automatic([target('a')], [f.evidence()]);
 expect(await first).toBeNull();
 const third = f.service.automatic([target('a')], [f.evidence()]);
 finishSecond({ key: 'a', outcome: 'reset' });
 expect(await second).toEqual({ key: 'a', outcome: 'reset' });
 expect(await third).toEqual({ key: 'a', outcome: 'reset' });
 expect(locked).toHaveBeenCalledTimes(2);
});
