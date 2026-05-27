# emberwatch-api

Backend for Emberwatch (APL impression tracker). Replaces the prior Vercel
serverless functions so the analyze response is no longer capped at 4.5 MB.

## Endpoints

### `POST /api/analyze`
Pass-through to the Anthropic Messages API. The frontend builds the full
Claude request (model, messages, PDF, prompt); this server attaches the
`ANTHROPIC_API_KEY` and forwards it. Control characters in Claude's text
output are stripped before the response is returned, to avoid breaking
`JSON.parse` on the client.

### `POST /api/send-emails`
Body: `{ emails: [{ to, subject, body, supplier }, ...] }`. Sends each report
via SendGrid. Returns a summary of which sent and which failed.

### `GET /`
Health check.

## Required environment variables

| Name | Purpose |
| ---- | ------- |
| `ANTHROPIC_API_KEY` | Claude API key |
| `SENDGRID_API_KEY` | SendGrid API key |
| `FROM_EMAIL` | Sender address on the SendGrid-verified domain |
| `FROM_NAME` | (optional) Display name for the sender |
| `REPLY_TO_EMAIL` | (optional) Address replies go to |
| `ALLOWED_ORIGINS` | Comma-separated list of frontend origins allowed by CORS, e.g. `https://project-2zss9.vercel.app` |
| `PORT` | (optional) Railway sets this automatically |

If `ALLOWED_ORIGINS` is not set, CORS is permissive (any origin). Set it in
production.

## Deploy on Railway

1. Push this repo to GitHub.
2. In Railway, create a new project → Deploy from GitHub repo → pick this repo.
3. Add the env vars above under the service's Variables.
4. Railway exposes the service at a generated `*.railway.app` URL.
5. In the Vercel frontend, point the analyze and send-emails fetches at that URL.

## Local dev

```
npm install
ANTHROPIC_API_KEY=... SENDGRID_API_KEY=... FROM_EMAIL=... npm start
```
