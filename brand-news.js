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

const buildPrompt = (brand) => `Search the web and determine whether the beverage brand "${brand}" has had a genuine CHANGE OF STATUS in the last 18 months.

Report ONLY these event types:
- ownership: the brand was acquired, sold, or divested to a different company
- distribution: the brand changed its national importer or distributor
- discontinued: the brand or that specific product was discontinued
- recall: the product was recalled

Do NOT report any of the following, they are not status changes:
- marketing campaigns, rebrands, or packaging redesigns
- new product launches or line extensions
- awards, rankings, sponsorships, or partnerships
- executive hires or departures
- sales figures, growth, or decline
- rumours, "exploring a sale", or reports without a named source

Respond with ONLY a JSON object and no other text:
{"changed": true, "type": "ownership", "summary": "one sentence, 25 words maximum", "from": "previous owner or null", "to": "new owner or null", "date": "YYYY-MM or null", "source_url": "https://...", "confidence": "high"}

confidence is "high" only when a reputable trade or business outlet reported the completed transaction. Use "medium" when reported but details are thin, "low" when the evidence is weak.

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

  const allowed = ['ownership', 'distribution', 'discontinued', 'recall'];
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
    errors,
  });
});

export default router;
