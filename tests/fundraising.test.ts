import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { initDatabase } from '../server/src/db';
import { applyFundraisingGifts, parseFundraisingGifts } from '../server/src/fundraising';
import { foldLedger, recordDonation, updateEventState, voidDonation } from '../server/src/ledger';
import { getStageState } from '../server/src/projection';

let db: Database;
beforeEach(() => { db = initDatabase(':memory:'); });
afterEach(() => db.close());
const response = (patch = {}) => ({ forms: [{ id: '42', summary: { totalTransactions: 1 }, transactions: [{ id: '123', formId: '42', transStatus: 'Accepted', firstName: 'Private', lastName: 'Donor', value: '52.00', giftAssist: '2.00', paymentType: 'Credit Card', transactionWasAnonymous: 'y', ...patch }] }] });

test('imports gift excluding fee assistance once; it reaches the wall at once with stage privacy intact while a manual gift still waits out the staging delay', () => {
  updateEventState(db, { stage_delay_ms: 8000 });
  const gifts = parseFundraisingGifts(response(), '42');
  expect(applyFundraisingGifts(db, '42', gifts)).toBe(1);
  expect(applyFundraisingGifts(db, '42', gifts)).toBe(0);
  expect(foldLedger(db).direct_raised_cents).toBe(5000);
  recordDonation(db, { donation_id: 'typed', donor_name: 'Typed By Hand', amount_cents: 7000 });
  const stage = getStageState(db);
  expect(stage.total_raised_cents).toBe(5000);
  expect(stage.chyrons.map(c => c.amount_cents)).toEqual([5000]);
  const text = JSON.stringify(stage);
  expect(text).not.toContain('Private');
  expect(text).toContain('Anonymous Supporter');
});

test('partial and full refunds release matching funds without changing a manual gift', () => {
  updateEventState(db, { is_match_active: 1, match_total_cents: 1000000 });
  recordDonation(db, { donation_id: 'manual', donor_name: 'Manual Gift', amount_cents: 1000 });
  applyFundraisingGifts(db, '42', parseFundraisingGifts(response(), '42'));
  expect(foldLedger(db).total_raised_cents).toBe(12000);
  applyFundraisingGifts(db, '42', parseFundraisingGifts(response({ refunds: { refund: { value: '10.00' } } }), '42'));
  expect(foldLedger(db).total_raised_cents).toBe(10000);
  applyFundraisingGifts(db, '42', parseFundraisingGifts(response({ transStatus: 'Refunded' }), '42'));
  expect(foldLedger(db).total_raised_cents).toBe(2000);
  expect(foldLedger(db).active_donations.get('manual')?.amount_cents).toBe(1000);
});

test('polling does not resurrect a gift deleted by an operator', () => {
  applyFundraisingGifts(db, '42', parseFundraisingGifts(response(), '42'));
  voidDonation(db, 'qgiv-42-123', 'Event lead');
  applyFundraisingGifts(db, '42', parseFundraisingGifts(response({ value: '102.00' }), '42'));
  expect(foldLedger(db).total_raised_cents).toBe(0);
});

test('rejects wrong form, incomplete response, and malformed financial values before import', () => {
  expect(() => parseFundraisingGifts(response(), '99')).toThrow();
  expect(() => parseFundraisingGifts({ forms: [{ id: '42', summary: { totalTransactions: 2 }, transactions: [] }] }, '42')).toThrow();
  expect(() => parseFundraisingGifts(response({ value: '52oops' }), '42')).toThrow();
  expect(() => parseFundraisingGifts(response({ value: undefined }), '42')).toThrow();
});

test('the sync polls every 5 seconds, a failure backs the timer off for 30 seconds, and Sync now still runs at once', async () => {
  const { createFundraisingSync } = await import('../server/src/fundraising');
  db.query("UPDATE fundraising_sync SET form_id = '42', start_date = '2026-01-01', enabled = 1 WHERE id = 1").run();
  const calls: number[] = [];
  let fail = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    if (fail) return new Response('nope', { status: 500 });
    return Response.json(response());
  }) as unknown as typeof fetch;
  const realSetInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  let intervalMs = 0;
  globalThis.setInterval = ((fn: () => void, ms: number) => { tick = fn; intervalMs = ms; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
  try {
    const sync = createFundraisingSync(db, () => 'token');
    expect(sync.status().interval_seconds).toBe(5);
    sync.start();
    await new Promise(r => setTimeout(r, 20));
    expect(intervalMs).toBe(5000);
    expect(calls).toHaveLength(1);
    expect(foldLedger(db).total_raised_cents).toBe(5000);

    fail = true;
    tick!();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toHaveLength(2);
    expect(sync.status().last_error).toContain('HTTP 500');
    tick!();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toHaveLength(2); // backed off: the next tick is skipped

    fail = false;
    await sync.sync(); // Sync now ignores the back-off
    expect(calls).toHaveLength(3);
    expect(sync.status().last_error).toBe('');
    tick!();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toHaveLength(4); // a success clears the back-off
    sync.stop();
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
  }
});
