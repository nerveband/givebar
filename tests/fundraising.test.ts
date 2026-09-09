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

test('imports gift excluding fee assistance once and retains stage privacy and review delay', () => {
  updateEventState(db, { stage_delay_ms: 8000 });
  const gifts = parseFundraisingGifts(response(), '42');
  expect(applyFundraisingGifts(db, '42', gifts)).toBe(1);
  expect(applyFundraisingGifts(db, '42', gifts)).toBe(0);
  expect(foldLedger(db).direct_raised_cents).toBe(5000);
  expect(getStageState(db).total_raised_cents).toBe(0);
  updateEventState(db, { stage_delay_ms: 0 });
  const stage = JSON.stringify(getStageState(db));
  expect(stage).not.toContain('Private');
  expect(stage).toContain('Anonymous Supporter');
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
