/* Tests for the headless tracker check. Run: node --test tools/tracker-check.test.mjs
 *
 * These cover the logic that decides what gets reported — the part that would
 * quietly go wrong and either spam the routine's push notification or, worse,
 * stay silent about a shipment that really is missing its R number. The network
 * layer (JWT + Firestore REST) is left to the live run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse, toMarkdown, decodeFields, normAwb } from './tracker-check.mjs';

const customers = [{ name: 'STATE ELECTRIC COMPANY LTD', cno: 'C2873' }];
const run = (entries, messages = []) => analyse({ entries, customers, messages });

test('flags a delivered row whose R NO is blank', () => {
  const f = run([{ no: 1225, cno: 'C29567', customer: 'SIMER', awbBl: '157-52207875', status: 'Delivered', billNo: 'B1', rNo: '' }]);
  assert.equal(f.missingRLookupable.length, 1);
  assert.equal(f.missingRLookupable[0].no, 1225);
});

test('leaves a row that already has an R NO alone', () => {
  const f = run([{ no: 1, status: 'Delivered', awbBl: '157-1', rNo: '78584' }]);
  assert.equal(f.missingRLookupable.length, 0);
});

test('ignores a Pending row with no bill — not assessed yet', () => {
  const f = run([{ no: 2, status: 'Pending', awbBl: '157-2', rNo: '' }]);
  assert.equal(f.missingRLookupable.length, 0);
});

test('still flags a Pending row once it has been billed', () => {
  const f = run([{ no: 3, status: 'Pending', awbBl: '157-3', rNo: '', billNo: 'B9' }]);
  assert.equal(f.missingRLookupable.length, 1);
});

test('billing-only rows never count as missing an R number', () => {
  const f = run([
    { no: 4, cno: 'C2873', customer: 'STELCO', status: 'Delivered', awbBl: 'MSC1', rNo: '' },
    { no: 5, billOnly: true, status: 'Delivered', awbBl: 'MSC2', rNo: '' },
  ]);
  assert.equal(f.missingRLookupable.length, 0);
  assert.equal(f.counts.billOnly, 2);
});

test('separates blanks that have no AWB to look up', () => {
  const f = run([{ no: 6, status: 'Cleared', awbBl: '', rNo: '' }]);
  assert.equal(f.missingRLookupable.length, 0);
  assert.equal(f.missingRNoAwb.length, 1);
});

test('whitespace-only R NO counts as blank', () => {
  const f = run([{ no: 7, status: 'Delivered', awbBl: '157-7', rNo: '   ' }]);
  assert.equal(f.missingRLookupable.length, 1);
});

test('duplicate AWBs match across spacing and dashes', () => {
  const f = run([
    { no: 8, awbBl: '986-9288 6905', status: 'Delivered', rNo: '1' },
    { no: 9, awbBl: '9869288690 5', status: 'Delivered', rNo: '2' },
  ]);
  assert.equal(f.duplicateAwb.length, 1);
  assert.equal(f.duplicateAwb[0].rows.length, 2);
});

test('blank AWBs are not treated as duplicates of each other', () => {
  const f = run([{ no: 10, awbBl: '' }, { no: 11, awbBl: '' }, { no: 12 }]);
  assert.equal(f.duplicateAwb.length, 0);
});

test('delivered with no BILL NO is reported', () => {
  const f = run([
    { no: 13, status: 'Delivered', billNo: '', awbBl: '157-13', rNo: '5' },
    { no: 14, status: 'Delivered', billNo: 'B14', awbBl: '157-14', rNo: '6' },
  ]);
  assert.equal(f.deliveredUnbilled.length, 1);
  assert.equal(f.deliveredUnbilled[0].no, 13);
});

test('only unread customer messages are reported', () => {
  const f = run([], [{ at: '2026-08-01', text: 'where is my cargo', read: false }, { at: '2026-08-02', text: 'thanks', read: true }]);
  assert.equal(f.unreadMessages.length, 1);
});

test('a clean tracker produces a clean report', () => {
  const md = toMarkdown(run([{ no: 15, status: 'Delivered', billNo: 'B15', awbBl: '157-15', rNo: '99' }]));
  assert.match(md, /Nothing needs attention/);
});

test('report names each finding it found', () => {
  const md = toMarkdown(run([{ no: 16, cno: 'C1', customer: 'ACME', status: 'Delivered', awbBl: '157-16', rNo: '' }]));
  assert.match(md, /Missing R number/);
  assert.match(md, /157-16/);
  assert.match(md, /ACME/);
  assert.doesNotMatch(md, /Duplicate AWB/);
});

test('decodes the Firestore typed-value envelope', () => {
  const rec = decodeFields({
    no: { integerValue: '1225' },
    customer: { stringValue: 'SIMER' },
    billOnly: { booleanValue: true },
    rNo: { nullValue: null },
    attachments: { arrayValue: { values: [{ mapValue: { fields: { name: { stringValue: 'doc.pdf' } } } }] } },
  });
  assert.deepEqual(rec, { no: 1225, customer: 'SIMER', billOnly: true, rNo: null, attachments: [{ name: 'doc.pdf' }] });
});

test('a null rNo from Firestore is treated as blank, not as a value', () => {
  const f = run([{ no: 17, status: 'Delivered', awbBl: '157-17', rNo: null }]);
  assert.equal(f.missingRLookupable.length, 1);
});

test('normAwb strips everything that is not alphanumeric', () => {
  assert.equal(normAwb(' 986-9288 6905 '), '98692886905');
  assert.equal(normAwb(null), '');
});
