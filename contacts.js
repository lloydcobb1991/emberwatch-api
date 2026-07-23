// ---------------------------------------------------------------------------
// contacts.js — venue-manager address book, backed by Airtable.
//
// Self-contained Express router. Mount it in your existing server file with a
// single line, placed AFTER your cors() and express.json() middleware:
//
//     app.use('/api', require('./contacts'));
//
// Required Railway variables:
//     AIRTABLE_API_KEY   Personal access token (needs data.records:read+write)
//     AIRTABLE_BASE_ID   Looks like appXXXXXXXXXXXXXX
//     AIRTABLE_CONTACTS_TABLE   optional, defaults to "Contacts"
//
// Airtable table schema — create these fields exactly:
//     Email       Single line text   (the unique key)
//     Name        Single line text
//     Role        Single line text
//     Locations   Long text          (comma-separated venue names)
//     TimesUsed   Number (integer)
//     LastUsed    Date
//
// Locations is deliberately a plain text field rather than a multi-select.
// Multi-selects require every option to exist before it can be written, which
// means a new venue name fails the write instead of creating itself.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE = process.env.AIRTABLE_CONTACTS_TABLE || 'Contacts';

const configured = () => Boolean(API_KEY && BASE_ID);
const endpoint = () =>
  `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;

const authHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
});

const splitLocations = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

// Airtable caps writes at 10 records per request.
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Pull every contact, following pagination.
async function listAll() {
  const records = [];
  let offset;
  do {
    const url = new URL(endpoint());
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Airtable ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);

  return records;
}

// GET /api/contacts
router.get('/contacts', async (req, res) => {
  if (!configured()) {
    // 501 rather than 500: the frontend treats any non-OK response as "no
    // address book available" and carries on with manual entry.
    return res
      .status(501)
      .json({ error: 'Airtable not configured', contacts: [] });
  }

  try {
    const records = await listAll();
    const contacts = records
      .map((r) => ({
        id: r.id,
        email: normalizeEmail(r.fields.Email),
        name: r.fields.Name || '',
        role: r.fields.Role || '',
        locations: splitLocations(r.fields.Locations),
        timesUsed: r.fields.TimesUsed || 0,
        lastUsed: r.fields.LastUsed || null,
      }))
      .filter((c) => c.email);

    res.json({ contacts });
  } catch (err) {
    console.error('[contacts] list failed:', err);
    res.status(500).json({ error: err.message, contacts: [] });
  }
});

// POST /api/contacts
// Body: { contacts: [{ email, location, name?, role? }, ...] }
//
// Upserts on email. An existing contact gains the new location (if absent),
// bumps TimesUsed, and refreshes LastUsed. Called after a successful send, so
// failures here are logged and reported but never block anything upstream.
router.post('/contacts', async (req, res) => {
  if (!configured()) {
    return res.status(501).json({ error: 'Airtable not configured' });
  }

  const incoming = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (incoming.length === 0) return res.json({ created: 0, updated: 0 });

  try {
    const existing = await listAll();
    const byEmail = new Map();
    for (const r of existing) {
      const key = normalizeEmail(r.fields.Email);
      if (key) byEmail.set(key, r);
    }

    const today = new Date().toISOString().split('T')[0];
    const toCreate = [];
    const toUpdate = new Map(); // record id -> fields

    for (const entry of incoming) {
      const email = normalizeEmail(entry.email);
      if (!email) continue;
      const location = String(entry.location || '').trim();

      const found = byEmail.get(email);

      if (!found) {
        // May appear twice in one batch (same manager, two venues) — merge
        // rather than creating a duplicate row.
        const pending = toCreate.find((c) => c.fields.Email === email);
        if (pending) {
          const locs = splitLocations(pending.fields.Locations);
          if (location && !locs.includes(location)) {
            locs.push(location);
            pending.fields.Locations = locs.join(', ');
          }
          continue;
        }
        toCreate.push({
          fields: {
            Email: email,
            Name: entry.name || '',
            Role: entry.role || '',
            Locations: location,
            TimesUsed: 1,
            LastUsed: today,
          },
        });
        continue;
      }

      const staged = toUpdate.get(found.id);
      const baseLocations = staged
        ? splitLocations(staged.Locations)
        : splitLocations(found.fields.Locations);
      if (location && !baseLocations.includes(location)) {
        baseLocations.push(location);
      }

      toUpdate.set(found.id, {
        Locations: baseLocations.join(', '),
        TimesUsed: staged
          ? staged.TimesUsed + 1
          : (found.fields.TimesUsed || 0) + 1,
        LastUsed: today,
      });
    }

    for (const batch of chunk(toCreate, 10)) {
      const r = await fetch(endpoint(), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ records: batch, typecast: true }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`Airtable create ${r.status}: ${detail.slice(0, 200)}`);
      }
    }

    const updates = [...toUpdate.entries()].map(([id, fields]) => ({
      id,
      fields,
    }));
    for (const batch of chunk(updates, 10)) {
      const r = await fetch(endpoint(), {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ records: batch, typecast: true }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`Airtable update ${r.status}: ${detail.slice(0, 200)}`);
      }
    }

    res.json({ created: toCreate.length, updated: updates.length });
  } catch (err) {
    console.error('[contacts] save failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
