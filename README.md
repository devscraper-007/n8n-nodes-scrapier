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
- **Pagination** — most operations have an optional **Cursor** field. Set it
  to the previous page's `next_cursor` (e.g. `{{ $json.next_cursor }}` in a
  loop) to fetch the next page; required inputs are ignored when a cursor is
  supplied. `next_cursor` is `null` on the last page. **Google Search is the
  exception: it pages by number.** Set **Page** (1-50, 10 results per page)
  and keep going while the response's `has_next_page` is `true` (`next_page`
  is the next number, `null` on the last page); it has no cursor.
- **Errors** — a failed call (`"success": false`) fails the node with the
  API's error message, or outputs `{ "error": "..." }` when *Continue On
  Fail* is enabled.

## Pricing

Each successful call costs the endpoint's credit price, however many
results the page holds, empty pages included. Curated operations cost 1 to
5 credits each (each operation's description lists it); Custom Scrape bills
the chosen endpoint's own price (up to 100). Failed calls are free.

## Upgrading to 1.2.0

The operation definitions were regenerated from the live API catalog.
**Google Search is a breaking change for existing workflows:**

- Removed fields: **Cursor**, **Site**, **Quick Date Range**, **Before
  Date**, **After Date**, **Mobile Results**, **AI Mode**, **hl**, **gl**,
  **Max Pages Per Query**. The API no longer accepts them (they are not
  aliases), so a workflow that set one must change.
- Added fields: **Page**, **Date Range** (`any_time`, `past_7_days`,
  `past_3_weeks`, `past_6_months`, `past_2_years`, `custom`) and **Raw Data**.
  Use **Country Code** / **Language Code** in place of gl / hl.
- Google Search now pages by **Page** / `next_page` / `has_next_page`, not
  by cursor.
- **Youtube Search Full**: **Max Pages Per Query** is removed; **Sort By**,
  **Upload Date**, **Duration**, **Country** and **Language** are added.
- Every operation gains an optional **Raw Data** field. Amazon Product gains
  the location, price, department and crawl-depth fields its API accepts.
- Credit costs in the descriptions now match the API: Amazon Product 3,
  Amazon Search 2, Youtube Search Full 5 (they previously read 1).

See `CHANGELOG.md`.

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

Inside the scrapier-app repo the generator reads `../src/assets/endpoints.json`
(refresh it with `npm run sync:endpoints` at the repo root first). Elsewhere pass
`--source /path/to/endpoints.json` or set `ENDPOINTS_JSON`; there is no default.
Credit costs are read from each endpoint's `cost_credit`. A curated endpoint
the catalog marks `disabled` stops the run (dropping an operation breaks
workflows using it) unless you pass `--allow-drop <slug>`.

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
