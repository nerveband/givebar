import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../client/js/live.js', import.meta.url), 'utf8');
function harness(fetch: typeof globalThis.fetch) {
  let now = 1000;
  let tick = () => {};
  const deadlines = new Map<number, () => void>();
  let nextId = 0;
  const window: any = {};
  runInNewContext(script, {
    window, fetch, AbortController,
    Date: { now: () => now },
    setInterval: (fn: () => void) => { tick = fn; return 1; },
    clearInterval: () => { tick = () => {}; },
    setTimeout: (fn: () => void, ms: number) => { expect(ms).toBe(5000); deadlines.set(++nextId, fn); return nextId; },
    clearTimeout: (id: number) => deadlines.delete(id),
  });
  const states: unknown[] = [];
  const connection = window.GivebarLive.connect({ role: 'stage', onState: (state: unknown) => states.push(state) });
  return { connection, states, deadlines, expire: () => { now += 5000; for (const fn of [...deadlines.values()]) fn(); }, tick: () => tick() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const phase of ['headers', 'body']) {
  test(`a stalled ${phase} request times out and the next poll delivers current totals`, async () => {
    let calls = 0;
    let signal: AbortSignal;
    const h = harness((async (_url, options) => {
      calls++;
      if (calls > 1) return Response.json({ total_raised_cents: 12345 });
      signal = options!.signal!;
      const stalled = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (phase === 'headers') return stalled();
      return { ok: true, status: 200, json: stalled };
    }) as typeof fetch);
    await flush();
    h.expire();
    await flush();
    expect(signal!.aborted).toBe(true);
    h.tick();
    await flush();
    expect(calls).toBe(2);
    expect(h.states).toEqual([{ total_raised_cents: 12345 }]);
    expect(h.deadlines.size).toBe(0);
    h.connection.stop();
  });
}

test('stopping aborts a poll and ignores a late response', async () => {
  let signal: AbortSignal;
  let resolve: (value: unknown) => void;
  const h = harness((async (_url, options) => {
    signal = options!.signal!;
    return { ok: true, status: 200, json: () => new Promise(r => { resolve = r; }) };
  }) as typeof fetch);
  await flush();
  h.connection.stop();
  expect(signal!.aborted).toBe(true);
  resolve!({ total_raised_cents: 999 });
  await flush();
  expect(h.states).toEqual([]);
  expect(h.deadlines.size).toBe(0);
});
