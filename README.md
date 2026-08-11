# n8n-nodes-scrapier

n8n community node for the [Scrapier](https://app.scrapier.io) web scraping
API — Google, Amazon, Instagram, TikTok, LinkedIn and 20+ more platforms as
structured data.

## Features

- **Scrapier credential type** — API key sent as `X-API-Key`, validated
  against `GET /me` (shows your account email on the credential).
- **12 operations** — 11 curated scrapers plus **Custom Scrape**, which calls
  any of the ~150 endpoints by slug with a JSON parameter object.
- **Rows as items** — scraped rows are emitted as individual n8n items by
  default (toggle off to get the raw API response).
- **Webhook-friendly** — every operation has an optional Webhook URL field;
  point it at an n8n Webhook node to receive async job results push-style.

Operation and field definitions are **generated** from the app's endpoint
catalog:

```bash
python3 scripts/generate-catalog.py   # refresh nodes/Scrapier/catalog.json
npm run build
```

## Install (users)

**Self-hosted n8n:** Settings → Community Nodes → Install → enter
`n8n-nodes-scrapier`.

**n8n Cloud:** available after the node passes n8n's verification (see below).

## Develop

```bash
npm install
npm run build     # tsc + asset copy into dist/
npm test          # offline structural checks

# Try it in a local n8n:
npm link
cd ~/.n8n/custom  # create if missing
npm link n8n-nodes-scrapier
n8n start
```

## Publish to npm (maintainer)

n8n's verification requires (since May 2026) publishing via **GitHub Actions
with a provenance statement**:

1. Push this directory to its own GitHub repo (or keep in the monorepo with a
   workflow scoped to this path).
2. Add an `NPM_TOKEN` secret and a workflow that runs
   `npm publish --provenance --access public` on tag push.
3. After the first publish, submit for verification from your n8n account
   (Settings → Community Nodes → Submit) — guidelines:
   https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/

Checklist already satisfied by this package: name prefix `n8n-nodes-`,
keyword `n8n-community-node-package`, TypeScript, English-only UI, no
filesystem or environment access, one service per package, credentials and
nodes declared under the `n8n` key in `package.json`.
