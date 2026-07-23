// ---------------------------------------------------------------------------
// brand-news.js — checks APL brands for ownership / distribution changes.
//
// ES module router, same pattern as contacts.js. Mount in server.js:
//
//     import brandNewsRouter from './brand-news.js';   // with the other imports
//     app.use('/api', brandNewsRouter);                // next to the contacts mount
//
// Uses the existing ANTHROPIC_API_KEY. No new variables required.
//
// WHY THIS EXISTS: when a brand changes hands, the supplier mapping in the APL
// goes stale, and every impression report afterwards credits the wrong company.
// This is a data-integrity check on the reports, not a news feed.
//
// WHAT IT DELIBERATELY DOES NOT DO: it never edits the APL or the supplier
// mapping. Beverage M&A gets reported as rumour months before it closes, and a
// search-grounded model can still confabulate a deal that didn't happen. One
// bad auto-update would silently corrupt every report downstream. A human
// confirms, then the APL gets edited by hand.
// ---------------------------------------------------------------------------

import express from 'express';

const router = express.Router();

// Results are cached in memory. A brand's ownership doesn't change twice in a
// week, and this keeps a re-run from re-billing every search. The cache dies on
// redeploy, which is fine — it just rebuilds.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map(); // brand (lowercased) -> { at: epochMs, event: object|null }

const CONCURRENCY = 4; // parallel searches; higher risks Anthropic rate limits
const MAX_BRANDS = 90; // hard ceiling per request
const MODEL = 'claude-sonnet-4-6';

const buildPrompt = (brand) => `Search the web and determine whether the beverage brand "${brand}" has had a change in the last 24 months that would affect WHICH COMPANY SUPPLIES IT IN THE UNITED STATES.

Report ONLY these:
- ownership: the brand was acquired, sold, or divested — its parent company changed
- importer: the brand's US national importer or brand owner changed
- discontinued: the brand or this product was discontinued in the US
- recall: this exact product was recalled in the US

Do NOT report any of the following. These are common, and none of them change who supplies a brand:
- three-tier wholesaler or distributor-of-record changes (RNDC, Southern Glazer's, Breakthru, Johnson Brothers, and state or regional wholesalers)
- any distribution change outside the United States
- state-level or regional distribution agreements
- marketing campaigns, rebrands, or packaging changes
- new product launches or line extensions
- awards, rankings, sponsorships, or partnerships
- executive hires or departures
- sales figures, growth, or decline
- rumours, "exploring a sale", or reports without a named source

THE TEST: would this change which company we credit when this brand appears on a US drinks menu? A brand switching wholesalers does NOT change that — the brand owner is the same. If the answer is no, report nothing.

Respond with ONLY a JSON object and no other text:
{"changed": true, "type": "ownership", "summary": "one sentence, 25 words maximum", "from": "previous owner or null", "to": "new owner or null", "date": "YYYY-MM or null", "source_url": "https://...", "confidence": "high"}

confidence is "high" only when a reputable trade or business outlet reported the completed transaction. Use "medium" when reported but thin on detail, "low" when the evidence is weak.

If you find nothing that qualifies, respond with exactly: {"changed": false}`;

// Extract JSON from the model's text output. It may arrive fenced, or with a
// sentence around it, so fall back to a balanced-brace scan.
function parseJsonLoose(text) {
  const stripped = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch (_) {
    // fall through
  }
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

async function checkBrand(brand) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: buildPrompt(brand) }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();

  // The response interleaves text with tool-use and tool-result blocks. Only
  // the text blocks carry the answer.
  const text = (data.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  const parsed = parseJsonLoose(text);
  if (!parsed || parsed.changed !== true) return null;

  // An event with no source is unverifiable, so it's worse than no event at
  // all — it costs review time and can't be confirmed. Drop it.
  const source = String(parsed.source_url || '').trim();
  if (!/^https?:\/\//i.test(source)) return null;

  const allowed = ['ownership', 'importer', 'discontinued', 'recall'];
  const type = allowed.includes(parsed.type) ? parsed.type : 'ownership';

  return {
    brand,
    type,
    summary: String(parsed.summary || '').slice(0, 300),
    from: parsed.from || null,
    to: parsed.to || null,
    date: parsed.date || null,
    source_url: source,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence)
      ? parsed.confidence
      : 'low',
  };
}

// ---------------------------------------------------------------------------
// Review registry (Airtable). Records what a human decided about an event so
// the same finding doesn't come back every run. Keyed on brand + source URL:
// the same brand can legitimately have more than one event over time, but the
// same brand reporting the same article is the same finding.
//
// Reuses AIRTABLE_API_KEY / AIRTABLE_BASE_ID from contacts.js. Table defaults
// to "BrandWatch".
//
// Fields (all single line text except where noted):
//   Brand, Status, Type, Summary, From, To, EventDate, SourceURL,
//   Confidence, Notes (long text), ReviewedAt (date)
//
// Status is plain text, not a single-select, for the same reason Locations is
// in contacts.js — a select rejects writes for options that don't exist yet.
// ---------------------------------------------------------------------------

const AT_KEY = process.env.AIRTABLE_API_KEY;
const AT_BASE = process.env.AIRTABLE_BASE_ID;
const AT_TABLE = process.env.AIRTABLE_BRANDWATCH_TABLE || 'BrandWatch';

const registryConfigured = () => Boolean(AT_KEY && AT_BASE);
const atUrl = () =>
  `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}`;
const atHeaders = () => ({
  Authorization: `Bearer ${AT_KEY}`,
  'Content-Type': 'application/json',
});

const reviewKey = (brand, sourceUrl) =>
  `${String(brand || '').trim().toLowerCase()}::${String(sourceUrl || '').trim()}`;

async function loadRegistry() {
  if (!registryConfigured()) return [];
  const records = [];
  let offset;
  do {
    const url = new URL(atUrl());
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers: atHeaders() });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Airtable ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);

  return records.map((r) => ({
    id: r.id,
    brand: r.fields.Brand || '',
    status: (r.fields.Status || 'pending').toLowerCase(),
    type: r.fields.Type || '',
    summary: r.fields.Summary || '',
    from: r.fields.From || null,
    to: r.fields.To || null,
    date: r.fields.EventDate || null,
    source_url: r.fields.SourceURL || '',
    confidence: r.fields.Confidence || 'low',
    notes: r.fields.Notes || '',
    reviewedAt: r.fields.ReviewedAt || null,
  }));
}

// GET /api/brand-news/registry
router.get('/brand-news/registry', async (_req, res) => {
  if (!registryConfigured()) {
    return res.status(501).json({ error: 'Airtable not configured', records: [] });
  }
  try {
    res.json({ records: await loadRegistry() });
  } catch (err) {
    console.error('[brand-news] registry load failed:', err);
    res.status(500).json({ error: err.message, records: [] });
  }
});

// POST /api/brand-news/review
// Body: { event: {...}, status: "confirmed"|"dismissed", notes?: string }
router.post('/brand-news/review', async (req, res) => {
  if (!registryConfigured()) {
    return res.status(501).json({ error: 'Airtable not configured' });
  }

  const event = req.body?.event || {};
  const status = String(req.body?.status || '').toLowerCase();
  if (!['confirmed', 'dismissed', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'status must be confirmed, dismissed, or pending' });
  }
  if (!event.brand || !event.source_url) {
    return res.status(400).json({ error: 'event needs brand and source_url' });
  }

  const fields = {
    Brand: String(event.brand),
    Status: status,
    Type: String(event.type || ''),
    Summary: String(event.summary || ''),
    From: event.from ? String(event.from) : '',
    To: event.to ? String(event.to) : '',
    EventDate: event.date ? String(event.date) : '',
    SourceURL: String(event.source_url),
    Confidence: String(event.confidence || ''),
    Notes: String(req.body?.notes || ''),
    ReviewedAt: new Date().toISOString().split('T')[0],
  };

  try {
    const existing = await loadRegistry();
    const key = reviewKey(event.brand, event.source_url);
    const match = existing.find((r) => reviewKey(r.brand, r.source_url) === key);

    const res2 = match
      ? await fetch(atUrl(), {
          method: 'PATCH',
          headers: atHeaders(),
          body: JSON.stringify({
            records: [{ id: match.id, fields }],
            typecast: true,
          }),
        })
      : await fetch(atUrl(), {
          method: 'POST',
          headers: atHeaders(),
          body: JSON.stringify({ records: [{ fields }], typecast: true }),
        });

    if (!res2.ok) {
      const detail = await res2.text().catch(() => '');
      throw new Error(`Airtable ${res2.status}: ${detail.slice(0, 200)}`);
    }
    res.json({ ok: true, status, updated: Boolean(match) });
  } catch (err) {
    console.error('[brand-news] review failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Run tasks with a fixed worker pool rather than all at once — 90 simultaneous
// search-enabled calls would hit rate limits immediately.
async function runPooled(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// POST /api/brand-news
// Body: { brands: ["Ketel One", "Bulleit Bourbon", ...], force?: boolean }
router.post('/brand-news', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }

  const raw = Array.isArray(req.body?.brands) ? req.body.brands : [];
  const force = req.body?.force === true;

  // Dedupe case-insensitively, keeping the first spelling seen.
  const seen = new Set();
  const brands = [];
  for (const b of raw) {
    const name = String(b || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    brands.push(name);
  }

  if (brands.length === 0) {
    return res.status(400).json({ error: 'No brands provided' });
  }
  if (brands.length > MAX_BRANDS) {
    return res
      .status(400)
      .json({ error: `Too many brands (${brands.length}). Max ${MAX_BRANDS}.` });
  }

  const now = Date.now();
  const events = [];
  const errors = [];
  let fromCache = 0;

  const toCheck = [];
  for (const brand of brands) {
    const hit = cache.get(brand.toLowerCase());
    if (!force && hit && now - hit.at < CACHE_TTL_MS) {
      fromCache++;
      if (hit.event) events.push(hit.event);
    } else {
      toCheck.push(brand);
    }
  }

  await runPooled(
    toCheck,
    async (brand) => {
      try {
        const event = await checkBrand(brand);
        cache.set(brand.toLowerCase(), { at: Date.now(), event });
        if (event) events.push(event);
      } catch (err) {
        console.error(`[brand-news] ${brand}:`, err.message);
        errors.push({ brand, error: err.message });
      }
    },
    CONCURRENCY
  );

  // Fold in prior review decisions. Anything already confirmed or dismissed
  // drops out unless explicitly asked for — the point of the registry is that
  // reviewing something once is enough.
  let reviewed = [];
  let registryError = null;
  try {
    reviewed = await loadRegistry();
  } catch (err) {
    registryError = err.message;
  }
  const byKey = new Map(reviewed.map((r) => [reviewKey(r.brand, r.source_url), r]));

  const includeReviewed = req.body?.includeReviewed === true;
  const annotated = events.map((e) => {
    const prior = byKey.get(reviewKey(e.brand, e.source_url));
    return { ...e, status: prior ? prior.status : 'new', notes: prior?.notes || '' };
  });
  const visible = includeReviewed
    ? annotated
    : annotated.filter((e) => e.status === 'new' || e.status === 'pending');
  const suppressed = annotated.length - visible.length;

  events.length = 0;
  events.push(...visible);

  const rank = { high: 0, medium: 1, low: 2 };
  events.sort(
    (a, b) =>
      (rank[a.confidence] ?? 3) - (rank[b.confidence] ?? 3) ||
      a.brand.localeCompare(b.brand)
  );

  return res.json({
    events,
    checked: brands.length,
    searched: toCheck.length,
    cached: fromCache,
    suppressed,
    registryError,
    errors,
  });
});

export default router;
