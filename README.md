# n8n-nodes-scrapier

n8n community node for the [Scrapier](https://app.scrapier.io) web scraping
API — Google, Amazon, Instagram, TikTok, LinkedIn and 20+ more platforms as
structured data.

## Features

- **Scrapier API v2** — calls `https://proxy.scrapier.io/api/v2`. Every
  scrape is synchronous: one call returns one page of results, with no jobs
  to poll.
- **Scrapier credential type** — API key sent as `X-API-Key`, validated
  against `GET /api/v2/me` (shows your account email on the credential).
- **11 operations** — 10 curated scrapers plus **Custom Scrape**, which calls
  any endpoint in the [v2 catalog](https://proxy.scrapier.io/api/v2/endpoints)
  by slug with a JSON parameter object.
- **One page per item** — each call outputs the page object (the results
  under an endpoint-specific key such as `results`, `products` or `posts`,
  plus `next_cursor`) as a single n8n item. If the API returns an array, you
  get one item per element instead.
- **Cursor pagination** — most operations have an optional **Cursor** field.
  Set it to the previous page's `next_cursor` (e.g.
  `{{ $json.next_cursor }}` in a loop) to fetch the next page; required
  inputs are ignored when a cursor is supplied. `next_cursor` is `null` on
  the last page.
- **Errors** — a failed call (`"success": false`) fails the node with the
  API's error message, or outputs `{ "error": "..." }` when *Continue On
  Fail* is enabled.

## Pricing

Each successful call costs the endpoint's credit price (shown in each
operation's description; 1 credit for every built-in operation today),
however many results the page holds, empty pages included. Failed calls are
free.

## Upgrading from 1.0.x (API v1)

Version 1.1.0 moves to API v2 and is a breaking change for some workflows:

- **Google Map Reviews** is removed (not available in API v2).
- **Youtube Search** is replaced by **Youtube Search Full**.
- The **Webhook URL** option is removed; v2 returns results directly.
- The **Split Rows Into Items** option is removed; output is one item per
  page (see above).

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
