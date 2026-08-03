#!/usr/bin/env node
/* LION Clearance Tracker — headless health check.
 *
 * WHY THIS EXISTS
 * The tracker is a browser app: its data lives in Firestore and is only ever read
 * through index.html. That means nobody finds out a shipment is missing its R
 * number, or got billed twice under the same AWB, until somebody scrolls the Form
 * Log and notices. This script reads the same Firestore collections directly — no
 * browser, no GitHub Pages, no eFaas session — so a scheduled Claude routine can
 * run it unattended and push a short "here's what needs a human" list.
 *
 * WHAT IT DOES NOT DO
 * It never writes. It cannot look anything up on the Maldives Customs portal —
 * that portal is unreachable from the remote container and its login rides on
 * Jaamiz's own signed-in Chrome. So this reports WHICH rows need an R number; the
 * r-number-filler skill (browser, run by hand) still does the filling.
 *
 * CREDENTIALS
 * A Firebase service-account JSON, supplied as an environment variable so the key
 * never lands in this repo (which is public on Pages):
 *   LION_FB_SA   raw JSON, or the same JSON base64-encoded, or a path to the file
 * GOOGLE_APPLICATION_CREDENTIALS (a path) is accepted as a fallback.
 *
 * USAGE
 *   node tools/tracker-check.mjs            # markdown report on stdout
 *   node tools/tracker-check.mjs --json     # same findings as JSON
 *   node tools/tracker-check.mjs --quiet    # print nothing when everything is clean
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const quiet = args.has('--quiet');

/* ---------- credentials ---------- */

// The env var may hold the JSON itself, base64 of it, or a path to it. Accepting all
// three means the routine works whichever way the key got pasted in.
function loadServiceAccount() {
  const raw = process.env.LION_FB_SA || '';
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  let text = '';

  if (raw.trim().startsWith('{')) text = raw;
  else if (raw.trim()) {
    try { text = readFileSync(raw.trim(), 'utf8'); }
    catch { text = Buffer.from(raw.trim(), 'base64').toString('utf8'); }
  } else if (path) {
    text = readFileSync(path, 'utf8');
  } else {
    throw new Error('No credentials. Set LION_FB_SA to the Firebase service-account JSON (raw, base64, or a file path).');
  }

  let sa;
  try { sa = JSON.parse(text); }
  catch { throw new Error('LION_FB_SA is not valid JSON (nor base64 of it, nor a readable path).'); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('Service-account JSON is missing client_email / private_key / project_id.');
  }
  return sa;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Standard two-legged OAuth: sign a JWT with the service account's private key and
// trade it for an access token. No SDK needed, which keeps this script dependency-free.
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${body.error_description || body.error || 'unknown'}`);
  return body.access_token;
}

/* ---------- Firestore REST ---------- */

// Firestore wraps every scalar in a typed envelope; unwrap back to plain JS so the
// checks below can read r.rNo the same way index.html does.
export function decode(value) {
  if (value == null) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decode(v);
  return out;
}

async function listCollection(projectId, token, col) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${col}`;
  const docs = [];
  let pageToken = '';
  do {
    const url = `${base}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Read of "${col}" failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const body = await res.json();
    for (const d of body.documents || []) {
      const rec = decodeFields(d.fields || {});
      rec.id = rec.id || d.name.split('/').pop();
      docs.push(rec);
    }
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return docs;
}

/* ---------- the same predicates index.html uses ---------- */

const isDone = (r) => r.status === 'Cleared' || r.status === 'Delivered';

// Billing-only rows are cleared without documentation (STELCO sea, BILL serials).
// They never get an R number, so flagging them as "missing" would be pure noise.
const stelcoCno = (customers) => {
  const c = customers.find((x) => (x.name || '').toUpperCase().includes('STATE ELECTRIC'));
  return (c && String(c.cno || '').toUpperCase()) || 'C2873';
};
const isBillOnly = (r, cno) => !!(r.billOnly || String(r.cno || '').toUpperCase() === cno);

// The portal stores AWBs with stray spaces and dashes ("986-9288 6905"), and staff
// type them either way. Compare on the stripped form or duplicates slip through.
export const normAwb = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const label = (r) => `NO ${r.no ?? '—'} · ${r.cno || '—'} ${r.customer || '—'}`;

/* ---------- checks ---------- */

export function analyse({ entries, customers, messages }) {
  const cno = stelcoCno(customers);
  const real = entries.filter((r) => !isBillOnly(r, cno));

  // 1. Assessed (or already billed) but the R number was never copied over.
  //    Split by whether we even have an AWB — without one there is nothing to look up.
  const missingR = real.filter((r) => !String(r.rNo || '').trim() && (isDone(r) || String(r.billNo || '').trim()));
  const missingRLookupable = missingR.filter((r) => String(r.awbBl || '').trim());
  const missingRNoAwb = missingR.filter((r) => !String(r.awbBl || '').trim());

  // 2. Same AWB/BL entered twice — one shipment risks being billed twice.
  const byAwb = new Map();
  for (const r of entries) {
    const k = normAwb(r.awbBl);
    if (!k) continue;
    if (!byAwb.has(k)) byAwb.set(k, []);
    byAwb.get(k).push(r);
  }
  const duplicateAwb = [...byAwb.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([awb, rows]) => ({ awb, rows: rows.map((r) => ({ no: r.no, cno: r.cno, customer: r.customer, billNo: r.billNo || '', status: r.status || '', label: label(r) })) }));

  // 3. Delivered means invoiced — saving a BILL NO is what sets it. A Delivered row
  //    with no BILL NO means the invoice never got recorded.
  const deliveredUnbilled = real.filter((r) => r.status === 'Delivered' && !String(r.billNo || '').trim());

  // 4. Messages customers left on their status page that nobody has opened.
  const unreadMessages = messages.filter((m) => !m.read);

  return { missingRLookupable, missingRNoAwb, duplicateAwb, deliveredUnbilled, unreadMessages, counts: { entries: entries.length, billOnly: entries.length - real.length } };
}

/* ---------- report ---------- */

export function toMarkdown(f) {
  const lines = [];
  const total = f.missingRLookupable.length + f.missingRNoAwb.length + f.duplicateAwb.length + f.deliveredUnbilled.length + f.unreadMessages.length;

  lines.push('# LION Tracker check');
  lines.push('');
  if (!total) {
    lines.push(`Nothing needs attention. ${f.counts.entries} entries scanned.`);
    return lines.join('\n');
  }

  if (f.missingRLookupable.length) {
    lines.push(`## Missing R number — ${f.missingRLookupable.length} to look up`);
    lines.push('');
    lines.push('Assessed or already billed, R NO still blank. Run the `r-number-filler` skill in Chrome for these:');
    lines.push('');
    lines.push('| NO | C NO | Customer | AWB / BL | Status | Bill |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of f.missingRLookupable.slice(0, 40)) {
      lines.push(`| ${r.no ?? '—'} | ${r.cno || '—'} | ${r.customer || '—'} | ${r.awbBl} | ${r.status || '—'} | ${r.billNo || '—'} |`);
    }
    if (f.missingRLookupable.length > 40) lines.push(`| … | | ${f.missingRLookupable.length - 40} more not shown | | | |`);
    lines.push('');
  }

  if (f.missingRNoAwb.length) {
    lines.push(`## Missing R number, and no AWB / BL — ${f.missingRNoAwb.length}`);
    lines.push('');
    lines.push('These cannot be looked up on the portal until the AWB / BL is entered:');
    for (const r of f.missingRNoAwb.slice(0, 20)) lines.push(`- ${label(r)} (${r.status || '—'})`);
    lines.push('');
  }

  if (f.duplicateAwb.length) {
    lines.push(`## Duplicate AWB / BL — ${f.duplicateAwb.length}`);
    lines.push('');
    lines.push('The same shipment entered more than once — check before invoicing:');
    for (const d of f.duplicateAwb.slice(0, 20)) {
      lines.push(`- **${d.awb}** — ${d.rows.map((r) => `${r.label}${r.billNo ? ` (billed ${r.billNo})` : ''}`).join(' · ')}`);
    }
    lines.push('');
  }

  if (f.deliveredUnbilled.length) {
    lines.push(`## Delivered but no BILL NO — ${f.deliveredUnbilled.length}`);
    lines.push('');
    for (const r of f.deliveredUnbilled.slice(0, 20)) lines.push(`- ${label(r)} — AWB ${r.awbBl || '—'}`);
    lines.push('');
  }

  if (f.unreadMessages.length) {
    lines.push(`## Unread customer messages — ${f.unreadMessages.length}`);
    lines.push('');
    for (const m of f.unreadMessages.slice(0, 20)) lines.push(`- ${m.at || '—'} — ${String(m.text || m.msg || '').slice(0, 160)}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/* ---------- main ---------- */

// Only run when invoked directly; importing this file (the tests do) must not fire
// off a live Firestore read.
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) try {
  const sa = loadServiceAccount();
  const token = await accessToken(sa);
  const [entries, customers, messages] = await Promise.all([
    listCollection(sa.project_id, token, 'entries'),
    listCollection(sa.project_id, token, 'customers'),
    // The status-page message collection may not exist on a fresh project; that is
    // not a failure of the check, so treat a read error here as "no messages".
    listCollection(sa.project_id, token, 'portalmsg').catch(() => []),
  ]);

  const findings = analyse({ entries, customers, messages });
  const total = findings.missingRLookupable.length + findings.missingRNoAwb.length
    + findings.duplicateAwb.length + findings.deliveredUnbilled.length + findings.unreadMessages.length;

  if (quiet && !total) process.exit(0);
  console.log(asJson ? JSON.stringify(findings, null, 2) : toMarkdown(findings));
} catch (err) {
  console.error(`tracker-check failed: ${err.message}`);
  process.exit(1);
}
