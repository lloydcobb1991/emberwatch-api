// Emberwatch API server
// Express server running on Railway. Replaces the Vercel serverless functions
// so the analyze response is no longer capped at 4.5 MB.

import express from 'express';
import cors from 'cors';
import contactsRouter from './contacts.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------------

// Allow the Vercel frontend (and local dev) to call this API. ALLOWED_ORIGINS
// is a comma-separated env var, e.g.
//   ALLOWED_ORIGINS=https://project-2zss9.vercel.app,http://localhost:5173
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / curl / server-to-server (no Origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true); // permissive if unset
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);

// Large body limit — the whole point of moving off Vercel.
app.use(express.json({ limit: '50mb' }));

// ----------------------------------------------------------------------------
// Health check (useful for Railway and for sanity-testing the URL)
// ----------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'emberwatch-api' });
});
app.use('/api', contactsRouter);
// ----------------------------------------------------------------------------
// POST /api/analyze
// Pass-through proxy to Anthropic. Frontend builds the full Claude request
// (model, messages, PDF, prompt); we just attach the key and forward it.
// ----------------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error:
        'Server is missing ANTHROPIC_API_KEY. Set it in the Railway service variables.',
    });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body || {}),
    });

    const data = await upstream.json();

    // Strip raw control chars inside any text blocks Claude returns. These
    // are illegal inside JSON string values and were the cause of an earlier
    // "Bad control character in string literal" parse error on the frontend.
    if (data && Array.isArray(data.content)) {
      data.content = data.content.map((block) => {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          return { ...block, text: block.text.replace(/[\u0000-\u001F]/g, ' ') };
        }
        return block;
      });
    }

    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Analyze proxy error:', err);
    return res
      .status(500)
      .json({ error: 'Proxy error', message: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/send-emails
// Body: { emails: [{ to, subject, body, supplier }, ...] }
// Sends each report via SendGrid.
// ----------------------------------------------------------------------------
app.post('/api/send-emails', async (req, res) => {
  if (!process.env.SENDGRID_API_KEY) {
    return res
      .status(500)
      .json({ error: 'Server is missing SENDGRID_API_KEY.' });
  }
  if (!process.env.FROM_EMAIL) {
    return res
      .status(500)
      .json({ error: 'Server is missing FROM_EMAIL.' });
  }

  const { emails } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'No emails provided' });
  }

  const results = [];

  for (const email of emails) {
    try {
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [
            { to: [{ email: email.to }], subject: email.subject },
          ],
          from: {
            email: process.env.FROM_EMAIL,
            name: process.env.FROM_NAME || 'Emberwatch Reports',
          },
          reply_to: process.env.REPLY_TO_EMAIL
            ? { email: process.env.REPLY_TO_EMAIL }
            : undefined,
          content: [{ type: 'text/plain', value: email.body }],
        }),
      });

      if (sgRes.ok) {
        results.push({ supplier: email.supplier, to: email.to, status: 'sent' });
      } else {
        const errText = await sgRes.text();
        console.error(`SendGrid failed for ${email.to}:`, errText);
        results.push({
          supplier: email.supplier,
          to: email.to,
          status: 'failed',
          error: errText.slice(0, 300),
        });
      }
    } catch (err) {
      console.error(`Send error for ${email.to}:`, err);
      results.push({
        supplier: email.supplier,
        to: email.to,
        status: 'failed',
        error: err.message,
      });
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return res.status(200).json({
    success: failed === 0,
    sent,
    failed,
    results,
  });
});

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Emberwatch API listening on port ${PORT}`);
  if (allowedOrigins.length) {
    console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
  } else {
    console.log('CORS: permissive (no ALLOWED_ORIGINS set)');
  }
});
