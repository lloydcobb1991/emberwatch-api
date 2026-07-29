// rfp.js — RFP Pipeline router (first slice)
//
// Self-contained Express router, written as an ES module to match this repo
// (package.json has "type": "module"). Mount it in server.js with two lines:
//
//     import rfpRouter from './rfp.js';        // with the other imports
//     app.use('/api', rfpRouter);              // after cors + express.json
//
// The .js extension in that import path is required in ESM.
//
// Reuses AIRTABLE_API_KEY and AIRTABLE_BASE_ID already set in Railway.
// No sends, no cron, no WordPress. Intake -> storage -> display only.
//
// Endpoints:
//   GET    /api/rfps          list RFPs (newest first), with signup counts
//   POST   /api/rfp           create an RFP
//   GET    /api/rfp/:id       one RFP with its signups
//   PATCH  /api/rfp/:id       update fields (typically status)
//   POST   /api/signup        inbound landing-page signup (upsert by email)

import express from 'express';

const router = express.Router();

const AIRTABLE_API = 'https://api.airtable.com/v0';
const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;

// Table names. Override via env if your Airtable tables are named differently.
const RFPS_TABLE = process.env.AIRTABLE_RFPS_TABLE || 'rfps';
const SIGNUPS_TABLE = process.env.AIRTABLE_SIGNUPS_TABLE || 'signups';

// Airtable field names are case-sensitive. Change them here, not inline below.
const F = {
  // rfps
  name: 'name',
  client: 'client',
  deadline: 'deadline',
  description: 'description',
  logoUrl: 'logo_url',
  lpUrl: 'lp_url',
  wpPageId: 'wp_page_id',
  templateId: 'template_id',
  status: 'status',
  createdAt: 'created_at',
  // signups
  suRfpId: 'rfp_id', // plain text: the Airtable record id of the parent RFP
  suRfpLink: 'RFP', // optional link-to-rfps field, for the human-visible grid
  suEmail: 'email',
  suName: 'name',
  suOrg: 'organisation',
  suSignedUpAt: 'signed_up_at',
  suFu1: 'fu1_sent_at',
  suFu2: 'fu2_sent_at',
  suFu3: 'fu3_sent_at',
  suFu1Skip: 'fu1_skipped',
  suFu2Skip: 'fu2_skipped',
  suFu3Skip: 'fu3_skipped',
  suMailStatus: 'mail_status',
};

const configured = () => Boolean(KEY && BASE);

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------

async function airtable(table, { method = 'GET', query = '', body } = {}) {
  const url = `${AIRTABLE_API}/${BASE}/${encodeURIComponent(table)}${query}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Airtable returned something that isn't JSON — surface it as-is.
    const err = new Error(`Airtable returned non-JSON (${res.status})`);
    err.status = 502;
    err.detail = text.slice(0, 300);
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error?.type || `Airtable error ${res.status}`);
    err.status = res.status === 404 ? 404 : 502;
    err.detail = data?.error || null;
    throw err;
  }

  return data;
}

// Airtable caps at 100 records per page; follow the offset cursor.
async function listAll(table, query = '') {
  const out = [];
  let offset;
  do {
    const sep = query.includes('?') ? '&' : '?';
    const q = `${query}${offset ? `${sep}offset=${offset}` : ''}`;
    const page = await airtable(table, { query: q });
    out.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return out;
}

// Escape a value for safe interpolation into a filterByFormula string.
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((d.getTime() - utcToday) / 86400000);
}

function shapeRfp(record) {
  const f = record.fields || {};
  const deadline = f[F.deadline] || null;
  return {
    id: record.id,
    name: f[F.name] || '',
    client: f[F.client] || '',
    deadline,
    days_until: daysUntil(deadline),
    description: f[F.description] || '',
    logo_url: f[F.logoUrl] || '',
    lp_url: f[F.lpUrl] || '',
    wp_page_id: f[F.wpPageId] || null,
    template_id: f[F.templateId] || '',
    status: f[F.status] || 'active',
    created_at: f[F.createdAt] || record.createdTime,
  };
}

function shapeSignup(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    rfp_id: f[F.suRfpId] || '',
    email: f[F.suEmail] || '',
    name: f[F.suName] || '',
    organisation: f[F.suOrg] || '',
    signed_up_at: f[F.suSignedUpAt] || record.createdTime,
    reminders: {
      fu1: { sent_at: f[F.suFu1] || null, skipped: Boolean(f[F.suFu1Skip]) },
      fu2: { sent_at: f[F.suFu2] || null, skipped: Boolean(f[F.suFu2Skip]) },
      fu3: { sent_at: f[F.suFu3] || null, skipped: Boolean(f[F.suFu3Skip]) },
    },
    mail_status: f[F.suMailStatus] || '',
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const notConfigured = (res, extra = {}) =>
  res.status(200).json({ error: 'Airtable not configured', ...extra });

// GET /api/rfps ------------------------------------------------------------
router.get('/rfps', async (req, res) => {
  if (!configured()) return notConfigured(res, { rfps: [] });

  try {
    const rfpRecords = await listAll(RFPS_TABLE);
    const rfps = rfpRecords.map(shapeRfp);

    // One pass over signups to build counts, rather than a query per RFP.
    const counts = {};
    try {
      const signupRecords = await listAll(SIGNUPS_TABLE, `?fields%5B%5D=${encodeURIComponent(F.suRfpId)}`);
      for (const r of signupRecords) {
        const key = r.fields?.[F.suRfpId];
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    } catch (e) {
      // A missing signups table shouldn't blank the dashboard.
      console.warn('[rfp] signup counts unavailable:', e.message);
    }

    for (const r of rfps) r.signup_count = counts[r.id] || 0;

    // Soonest deadline first; undated RFPs sink to the bottom.
    rfps.sort((a, b) => {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    });

    res.json({ rfps });
  } catch (e) {
    console.error('[rfp] GET /rfps failed:', e.message, e.detail || '');
    res.status(e.status || 500).json({ error: e.message, rfps: [] });
  }
});

// POST /api/rfp ------------------------------------------------------------
router.post('/rfp', async (req, res) => {
  if (!configured()) return notConfigured(res);

  const { name, client, deadline, description, logo_url, template_id, status } = req.body || {};

  const missing = [];
  if (!name || !String(name).trim()) missing.push('name');
  if (!client || !String(client).trim()) missing.push('client');
  if (!deadline) missing.push('deadline');
  if (missing.length) {
    return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
  }

  const day = String(deadline).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'deadline must be a date in YYYY-MM-DD form' });
  }

  const fields = {
    [F.name]: String(name).trim(),
    [F.client]: String(client).trim(),
    [F.deadline]: day,
    [F.status]: status || 'active',
    [F.createdAt]: new Date().toISOString(),
  };
  if (description) fields[F.description] = String(description);
  if (logo_url) fields[F.logoUrl] = String(logo_url);
  if (template_id) fields[F.templateId] = String(template_id);

  try {
    const created = await airtable(RFPS_TABLE, { method: 'POST', body: { fields, typecast: true } });
    const rfp = shapeRfp(created);
    rfp.signup_count = 0;
    console.log(`[rfp] created ${rfp.id} — "${rfp.name}" for ${rfp.client}, due ${rfp.deadline}`);
    res.status(201).json({ rfp });
  } catch (e) {
    console.error('[rfp] POST /rfp failed:', e.message, e.detail || '');
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/rfp/:id ---------------------------------------------------------
router.get('/rfp/:id', async (req, res) => {
  if (!configured()) return notConfigured(res, { rfp: null, signups: [] });

  try {
    const record = await airtable(RFPS_TABLE, { query: `/${encodeURIComponent(req.params.id)}` });
    const rfp = shapeRfp(record);

    let signups = [];
    try {
      const formula = `{${F.suRfpId}}="${esc(req.params.id)}"`;
      const recs = await listAll(SIGNUPS_TABLE, `?filterByFormula=${encodeURIComponent(formula)}`);
      signups = recs.map(shapeSignup);
      signups.sort((a, b) => String(b.signed_up_at).localeCompare(String(a.signed_up_at)));
    } catch (e) {
      console.warn('[rfp] signups unavailable:', e.message);
    }

    rfp.signup_count = signups.length;
    res.json({ rfp, signups });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'RFP not found' });
    console.error('[rfp] GET /rfp/:id failed:', e.message, e.detail || '');
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PATCH /api/rfp/:id -------------------------------------------------------
router.patch('/rfp/:id', async (req, res) => {
  if (!configured()) return notConfigured(res);

  const allowed = {
    name: F.name,
    client: F.client,
    deadline: F.deadline,
    description: F.description,
    logo_url: F.logoUrl,
    lp_url: F.lpUrl,
    wp_page_id: F.wpPageId,
    template_id: F.templateId,
    status: F.status,
  };

  const fields = {};
  for (const [key, field] of Object.entries(allowed)) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      fields[field] = key === 'deadline' ? String(req.body[key]).slice(0, 10) : req.body[key];
    }
  }

  if (!Object.keys(fields).length) {
    return res.status(400).json({ error: 'No updatable fields supplied' });
  }

  try {
    const updated = await airtable(RFPS_TABLE, {
      method: 'PATCH',
      query: `/${encodeURIComponent(req.params.id)}`,
      body: { fields, typecast: true },
    });
    console.log(`[rfp] updated ${req.params.id}: ${Object.keys(fields).join(', ')}`);
    res.json({ rfp: shapeRfp(updated) });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'RFP not found' });
    console.error('[rfp] PATCH /rfp/:id failed:', e.message, e.detail || '');
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/signup ---------------------------------------------------------
// Inbound from the landing page. Upserts on (rfp_id, email) so a resubmit
// updates the existing row instead of creating a duplicate.
router.post('/signup', async (req, res) => {
  if (!configured()) return notConfigured(res);

  const { rfp_id, email, name, organisation } = req.body || {};

  if (!rfp_id) return res.status(400).json({ error: 'Missing required field: rfp_id' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();

  try {
    // Confirm the RFP exists before recording anything against it.
    let parent;
    try {
      parent = await airtable(RFPS_TABLE, { query: `/${encodeURIComponent(rfp_id)}` });
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: 'Unknown rfp_id' });
      throw e;
    }

    const fields = {
      [F.suRfpId]: rfp_id,
      [F.suRfpLink]: [rfp_id],
      [F.suEmail]: cleanEmail,
      [F.suSignedUpAt]: new Date().toISOString(),
    };
    if (name) fields[F.suName] = String(name).trim();
    if (organisation) fields[F.suOrg] = String(organisation).trim();

    const formula = `AND({${F.suRfpId}}="${esc(rfp_id)}",LOWER({${F.suEmail}})="${esc(cleanEmail)}")`;
    const existing = await listAll(
      SIGNUPS_TABLE,
      `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`
    );

    // The link-to-rfps field is a nicety for the Airtable grid. If the table
    // doesn't have it, drop it and retry rather than failing the signup.
    const write = async (opts) => {
      try {
        return await airtable(SIGNUPS_TABLE, opts);
      } catch (e) {
        const unknownField = /UNKNOWN_FIELD_NAME|Unknown field name/i.test(
          `${e.message} ${JSON.stringify(e.detail || '')}`
        );
        if (unknownField && F.suRfpLink in opts.body.fields) {
          console.warn(`[rfp] "${F.suRfpLink}" link field not found in ${SIGNUPS_TABLE} — writing without it`);
          const retry = { ...opts.body.fields };
          delete retry[F.suRfpLink];
          return airtable(SIGNUPS_TABLE, { ...opts, body: { ...opts.body, fields: retry } });
        }
        throw e;
      }
    };

    let record;
    let created = false;
    if (existing.length) {
      // Don't overwrite the original signup timestamp on a resubmit.
      delete fields[F.suSignedUpAt];
      record = await write({
        method: 'PATCH',
        query: `/${existing[0].id}`,
        body: { fields, typecast: true },
      });
    } else {
      record = await write({ method: 'POST', body: { fields, typecast: true } });
      created = true;
    }

    const rfpName = parent.fields?.[F.name] || rfp_id;
    console.log(`[rfp] signup ${created ? 'created' : 'updated'}: ${cleanEmail} -> "${rfpName}"`);
    res.status(created ? 201 : 200).json({ signup: shapeSignup(record), created });
  } catch (e) {
    console.error('[rfp] POST /signup failed:', e.message, e.detail || '');
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
