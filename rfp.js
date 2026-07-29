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

// --- reminder engine config ------------------------------------------------

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL || '';
const FROM_NAME = process.env.FROM_NAME || process.env.SENDGRID_FROM_NAME || 'Ignite Creative Services';

// Grace: a reminder still fires if it's within this many days past its target
// day; older than that and it's treated as missed and skipped. Default 0 means
// "fire only on the exact day, skip anything already past" — which is what makes
// a late-created RFP skip its already-passed D-7/D-3 windows. Raise it only if
// you want tolerance for a scheduler outage (see the note in the deploy steps).
const GRACE_DAYS = Number(process.env.RFP_REMINDER_GRACE_DAYS || 0);

// In-process hourly scheduler. Set RFP_CRON_ENABLED=false to turn it off and
// drive sweeps manually via POST /api/cron/sweep instead.
const CRON_ENABLED = process.env.RFP_CRON_ENABLED !== 'false';
const CRON_SECRET = process.env.RFP_CRON_SECRET || '';

// The three reminder slots, newest-deadline-first is irrelevant here; order is
// D-7, D-3, D-1. Each maps to its "sent at" and "skipped" fields on the signup.
const SLOTS = [
  { key: 'fu1', offset: 7, sentField: F.suFu1, skipField: F.suFu1Skip },
  { key: 'fu2', offset: 3, sentField: F.suFu2, skipField: F.suFu2Skip },
  { key: 'fu3', offset: 1, sentField: F.suFu3, skipField: F.suFu3Skip },
];

// --- WordPress config ------------------------------------------------------
// Used to create RFP landing pages. Set WP_API_URL to staging now, flip it to
// production later — no code change needed. The app password may contain spaces
// as WordPress displays it; they're stripped here.
const WP_URL = (process.env.WP_API_URL || '').replace(/\/+$/, '');
const WP_USER = process.env.WP_USER || '';
const WP_APP_PASSWORD = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');
const wpConfigured = () => Boolean(WP_URL && WP_USER && WP_APP_PASSWORD);

function wpAuthHeader() {
  return `Basic ${Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64')}`;
}

async function wpFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${WP_URL}/wp-json${path}`, {
    method,
    headers: { Authorization: wpAuthHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A Basic Auth wall or an HTML error page shows up here as non-JSON.
    const err = new Error(`WordPress returned non-JSON (${res.status}) — the site may still be behind Basic Auth or the URL is wrong`);
    err.status = 502;
    err.detail = text.slice(0, 200);
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.message || `WordPress error ${res.status}`);
    err.status = res.status;
    err.detail = data?.code || null;
    throw err;
  }
  return data;
}

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

// ===========================================================================
// Reminder engine
// ===========================================================================

// How many whole days is `today` past the target day? Negative = target is in
// the future. Both are compared at UTC midnight so DST and clock time never
// enter into it.
function daysPast(targetMs, utcTodayMs) {
  return Math.round((utcTodayMs - targetMs) / 86400000);
}

// Classify a single reminder slot for a given deadline: 'pending' (its day
// hasn't come), 'due' (fire now), or 'missed' (its day passed — skip silently).
function classifySlot(offset, dueMs, utcTodayMs) {
  const targetMs = dueMs - offset * 86400000;
  const past = daysPast(targetMs, utcTodayMs);
  if (past < 0) return 'pending';
  if (past <= GRACE_DAYS) return 'due';
  return 'missed';
}

function buildReminderEmail(rfp, signup, offset) {
  const daysLeft = offset; // by definition, this reminder fires `offset` days out
  const dueStr = (() => {
    const d = new Date(`${String(rfp[F.deadline] || rfp.deadline).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? String(rfp.deadline)
      : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  })();

  const name = signup.name ? ` ${signup.name.split(' ')[0]}` : '';
  const client = rfp.client ? ` for ${rfp.client}` : '';
  const dayWord = daysLeft === 1 ? 'day' : 'days';
  const lpLine = rfp.lp_url ? `\nDetails and submission: ${rfp.lp_url}\n` : '';

  const subject = `Reminder: ${rfp.name} — ${daysLeft} ${dayWord} left`;
  const text =
`Hi${name},

A quick reminder that the RFP "${rfp.name}"${client} is due ${dueStr} — ${daysLeft} ${dayWord} from now.
${lpLine}
If you've already submitted, thank you and please disregard.

— ${FROM_NAME}`;

  return { subject, text };
}

async function sendViaSendGrid({ to, subject, text, rfpId }) {
  if (!SENDGRID_KEY || !FROM_EMAIL) {
    throw new Error('SendGrid not configured (need SENDGRID_API_KEY and FROM_EMAIL)');
  }
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], custom_args: { rfp_id: rfpId } }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: 'text/plain', value: text }],
      // Categories let the Phase 4 stats/webhook work filter by this RFP.
      categories: ['rfp-reminder', `rfp:${rfpId}`],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`SendGrid ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return true;
}

// One full pass. Returns a summary; never throws (per-item errors are collected
// so one bad address can't abort the whole sweep).
async function sweepOnce({ dryRun = false } = {}) {
  const started = new Date().toISOString();
  const summary = { started, dryRun, rfps: 0, signups: 0, sent: 0, skipped: 0, pending: 0, errors: [], plan: [] };

  if (!configured()) {
    summary.errors.push('Airtable not configured');
    return summary;
  }

  const today = new Date();
  const utcTodayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  let rfpRecords;
  try {
    rfpRecords = await listAll(RFPS_TABLE);
  } catch (e) {
    summary.errors.push(`Load RFPs: ${e.message}`);
    return summary;
  }

  for (const rec of rfpRecords) {
    const f = rec.fields || {};
    const status = f[F.status] || 'active';
    const deadline = f[F.deadline];
    if (status !== 'active' || !deadline) continue;

    const dueMs = (() => {
      const d = new Date(`${String(deadline).slice(0, 10)}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    })();
    if (dueMs == null) continue;

    summary.rfps += 1;
    const rfpShaped = shapeRfp(rec);

    // Pull this RFP's signups.
    let signups;
    try {
      const formula = `{${F.suRfpId}}="${esc(rec.id)}"`;
      signups = await listAll(SIGNUPS_TABLE, `?filterByFormula=${encodeURIComponent(formula)}`);
    } catch (e) {
      summary.errors.push(`RFP ${rec.id} signups: ${e.message}`);
      continue;
    }

    for (const su of signups) {
      summary.signups += 1;
      const sf = su.fields || {};
      const suShaped = shapeSignup(su);

      for (const slot of SLOTS) {
        // Already handled?
        if (sf[slot.sentField] || sf[slot.skipField]) continue;

        const state = classifySlot(slot.offset, dueMs, utcTodayMs);
        if (state === 'pending') { summary.pending += 1; continue; }

        if (state === 'missed') {
          summary.skipped += 1;
          if (dryRun) {
            summary.plan.push({ action: 'skip', slot: slot.key, email: suShaped.email, rfp: rfpShaped.name });
          } else {
            try {
              await airtable(SIGNUPS_TABLE, {
                method: 'PATCH',
                query: `/${su.id}`,
                body: { fields: { [slot.skipField]: true }, typecast: true },
              });
            } catch (e) {
              summary.errors.push(`Skip ${slot.key} for ${suShaped.email}: ${e.message}`);
            }
          }
          continue;
        }

        // state === 'due' -> send
        if (!suShaped.email) { summary.errors.push(`Signup ${su.id} has no email`); continue; }

        if (dryRun) {
          summary.sent += 1;
          summary.plan.push({ action: 'send', slot: slot.key, offset: slot.offset, email: suShaped.email, rfp: rfpShaped.name });
          continue;
        }

        const { subject, text } = buildReminderEmail(rfpShaped, suShaped, slot.offset);
        try {
          await sendViaSendGrid({ to: suShaped.email, subject, text, rfpId: rec.id });
          await airtable(SIGNUPS_TABLE, {
            method: 'PATCH',
            query: `/${su.id}`,
            body: { fields: { [slot.sentField]: new Date().toISOString(), [F.suMailStatus]: `sent ${slot.key}` }, typecast: true },
          });
          summary.sent += 1;
          console.log(`[rfp] reminder ${slot.key} (D-${slot.offset}) -> ${suShaped.email} for "${rfpShaped.name}"`);
        } catch (e) {
          // Don't stamp sent — leave it for the next sweep to retry.
          summary.errors.push(`Send ${slot.key} to ${suShaped.email}: ${e.message}`);
          try {
            await airtable(SIGNUPS_TABLE, {
              method: 'PATCH',
              query: `/${su.id}`,
              body: { fields: { [F.suMailStatus]: `error: ${String(e.message).slice(0, 80)}` }, typecast: true },
            });
          } catch { /* status write is best-effort */ }
        }
      }
    }
  }

  summary.finished = new Date().toISOString();
  return summary;
}

// POST /api/cron/sweep -----------------------------------------------------
// Manual trigger + test hook. Body/query { dryRun: true } or ?dry=1 reports
// what it *would* do without sending or writing anything.
router.post('/cron/sweep', async (req, res) => {
  if (CRON_SECRET) {
    const supplied = req.get('x-cron-secret') || req.query.secret;
    if (supplied !== CRON_SECRET) return res.status(401).json({ error: 'Bad or missing cron secret' });
  }
  const dryRun = req.body?.dryRun === true || req.query.dry === '1' || req.query.dry === 'true';
  try {
    const summary = await sweepOnce({ dryRun });
    res.json(summary);
  } catch (e) {
    console.error('[rfp] sweep failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// In-process hourly scheduler ----------------------------------------------
// The Railway web service runs 24/7, so a plain interval is enough — no extra
// service or dependency. Single instance only; if you ever scale to multiple
// replicas, move this to one dedicated worker to avoid double-sends.
let sweeping = false;
async function scheduledSweep() {
  if (sweeping) return; // don't overlap runs
  sweeping = true;
  try {
    const s = await sweepOnce({ dryRun: false });
    if (s.sent || s.skipped || s.errors.length) {
      console.log(`[rfp] sweep: ${s.sent} sent, ${s.skipped} skipped, ${s.pending} pending, ${s.errors.length} errors`);
      for (const err of s.errors) console.warn('[rfp]   ', err);
    }
  } catch (e) {
    console.error('[rfp] scheduled sweep crashed:', e.message);
  } finally {
    sweeping = false;
  }
}

if (CRON_ENABLED && configured()) {
  // Wait a beat after boot so the server is fully up, then run hourly.
  setTimeout(scheduledSweep, 30_000).unref?.();
  setInterval(scheduledSweep, 60 * 60 * 1000).unref?.();
  console.log(`[rfp] reminder scheduler on (hourly, grace ${GRACE_DAYS}d)`);
} else {
  console.log('[rfp] reminder scheduler off' + (configured() ? ' (RFP_CRON_ENABLED=false)' : ' (Airtable not configured)'));
}

// ===========================================================================
// WordPress — connection test (landing-page creation comes next)
// ===========================================================================

// GET /api/wp/ping — confirms the app password authenticates and reports who
// we're connected as, plus whether the ACF landing fields are exposed to REST.
router.get('/wp/ping', async (req, res) => {
  if (!wpConfigured()) {
    return res.status(200).json({
      ok: false,
      error: 'WordPress not configured',
      need: ['WP_API_URL', 'WP_USER', 'WP_APP_PASSWORD'].filter((v) => !process.env[v]),
    });
  }
  try {
    const me = await wpFetch('/wp/v2/users/me?context=edit');
    const canPublish = Boolean(me.capabilities?.publish_pages ?? me.capabilities?.edit_pages ?? true);

    // Best-effort ACF check: read one page in edit context and see if an `acf`
    // key comes back. On a site with no pages yet this is inconclusive, so we
    // report it as unknown rather than a failure.
    let acfExposed = 'unknown';
    try {
      const pages = await wpFetch('/wp/v2/pages?per_page=1&context=edit&status=any');
      if (Array.isArray(pages) && pages.length) {
        acfExposed = Object.prototype.hasOwnProperty.call(pages[0], 'acf');
      }
    } catch { /* non-fatal */ }

    res.json({
      ok: true,
      connectedAs: me.name,
      username: me.slug,
      userId: me.id,
      canPublishPages: canPublish,
      acfExposedToRest: acfExposed,
      wp: WP_URL,
    });
  } catch (e) {
    res.status(200).json({ ok: false, status: e.status || null, error: e.message, detail: e.detail || null });
  }
});

// POST /api/rfp/:id/landing --------------------------------------------------
// Clone a WordPress template into a filled landing page for this RFP, then save
// the new page's id + URL back onto the RFP row.
// Body: { template_page_id: number, status?: 'draft'|'publish' }
router.post('/rfp/:id/landing', async (req, res) => {
  if (!configured()) return notConfigured(res);
  if (!wpConfigured()) return res.status(400).json({ error: 'WordPress not configured (need WP_API_URL, WP_USER, WP_APP_PASSWORD)' });

  const status = req.body?.status === 'publish' ? 'publish' : 'draft';

  try {
    let record;
    try {
      record = await airtable(RFPS_TABLE, { query: `/${encodeURIComponent(req.params.id)}` });
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: 'RFP not found' });
      throw e;
    }
    const rfp = shapeRfp(record);

    const templatePageId = Number(req.body?.template_page_id || rfp.template_id);
    if (!templatePageId) {
      return res.status(400).json({ error: 'template_page_id is required (or set template_id on the RFP first)' });
    }

    const acf = {
      rfp_logo: rfp.logo_url || '',
      rfp_description: rfp.description || '',
      rfp_deadline: rfp.deadline || '',
      rfp_client: rfp.client || '',
      rfp_id: rfp.id,
    };

    const wp = await wpFetch('/ics/v1/clone-landing', {
      method: 'POST',
      body: { template_page_id: templatePageId, title: rfp.name || 'RFP Landing', status, acf },
    });

    // Persist the page id + URL (and the template used) back onto the RFP.
    const updated = await airtable(RFPS_TABLE, {
      method: 'PATCH',
      query: `/${encodeURIComponent(req.params.id)}`,
      body: {
        fields: { [F.wpPageId]: String(wp.id), [F.lpUrl]: wp.url, [F.templateId]: String(templatePageId) },
        typecast: true,
      },
    });

    console.log(`[rfp] landing page ${wp.id} (${wp.status}) for "${rfp.name}" -> ${wp.url}`);
    res.status(201).json({ rfp: shapeRfp(updated), landing: wp });
  } catch (e) {
    console.error('[rfp] landing creation failed:', e.message, e.detail || '');
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(code).json({ error: e.message, detail: e.detail || null });
  }
});

export default router;
