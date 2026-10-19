# n8n-nodes-scrapier

n8n community node for the [Scrapier](https://app.scrapier.io) web scraping
API — Google, Amazon, Instagram, TikTok, LinkedIn and many more platforms as
structured data. The node always reaches the full live endpoint catalog: new
endpoints are callable the day they ship, with no node update.

## Features

- **Scrapier API v2** — calls `https://proxy.scrapier.io/api/v2`. Every
  scrape is synchronous: one call returns one page of results, with no jobs
  to poll.
- **Scrapier credential type** — API key sent as `X-API-Key`, validated
  against `GET /api/v2/me` (shows your account email on the credential).
- **Curated operations plus Custom Scrape** — dedicated operations for the
  most-used scrapers, and **Custom Scrape (Any Endpoint)**, which calls every
  current and future endpoint in the
  [v2 catalog](https://proxy.scrapier.io/api/v2/endpoints)
  (`GET /api/v2/endpoints`) by slug with a JSON parameter object. Pick the
  slug from the *Pick From Catalog* dropdown (loaded live from the public
  catalog) or type it.

<!-- catalog:start -->
The live catalog currently has **197 callable endpoints across 36 platforms**; this node has **11 operations** (10 curated scrapers plus **Custom Scrape**, which reaches every other endpoint by slug).
<!-- catalog:end -->

- **One page per item** — each call outputs the page object (the results
  under an endpoint-specific key such as `results`, `products` or `posts`,
  plus `next_cursor`) as a single n8n item. If the API returns an array, you
  get one item per element instead.
- **Pagination** — most operations have an optional **Cursor** field. Set it
  to the previous page's `next_cursor` (e.g. `{{ $json.next_cursor }}` in a
  loop) to fetch the next page; required inputs are ignored when a cursor is
  supplied. `next_cursor` is `null` on the last page. **Google Search is the
  exception: it pages by number.** Set **Page** and keep going while the
  response's `has_next_page` is `true` (`next_page` is the next number, `null` on
  the last page); it has no cursor. The field description shows the allowed range.
- **Errors** — a failed call (`"success": false`) fails the node with the
  API's error message, or outputs `{ "error": "..." }` when *Continue On
  Fail* is enabled.

## Pricing

<!-- pricing:start -->
Each successful call costs the endpoint's credit price (from 1 credit per successful call, up to 100 for the heaviest endpoints), however many results the page holds, empty pages included. Each curated operation's description shows its price; for Custom Scrape see the endpoint's `cost_credit` in the catalog. Failed calls are free.
<!-- pricing:end -->

## Upgrading to 1.2.0

The operation definitions were regenerated from the live API catalog.
**Google Search is a breaking change for existing workflows:**

- Removed fields: `cursor`, `site`, `quickDateRange`, `beforeDate`,
  `afterDate`, `mobileResults`, `aiMode`, `hl`, `gl`, `maxPagesPerQuery`. The
  API no longer accepts them (they are not aliases) and silently ignores
  unknown parameters, so a workflow that set one keeps running but loses that
  setting: check every Google Search node.
- Added fields: `page`, `dateRange` (`any_time`, `past_7_days`,
  `past_3_weeks`, `past_6_months`, `past_2_years`, `custom`) and `raw_data`.
  Use `countryCode` / `languageCode` in place of `gl` / `hl`.
- Google Search now pages by `page` / `next_page` / `has_next_page`, not by
  cursor.
- **YouTube Search** (`youtube_search_full`): `max_pages_per_query` is removed;
  `sort_by`, `upload_date`, `duration`, `country` and `language` are added.
- Every operation gains an optional `raw_data` field. Amazon Product gains the
  location, price, department and crawl-depth fields its API accepts.
- Default changes that happen without any error: Google Maps `use_proxy`
  `false` -> `true`; YouTube Search `max_results_video` `10` -> `20`. Set them
  explicitly if you rely on the old values.
- Number fields without a catalog default (e.g. Amazon Product `price_min` /
  `price_max`) are now empty and not sent; earlier builds sent `0`.
- Operation descriptions now show the credit price from the catalog. Amazon
  Product, Amazon Search and YouTube Search used to show a stale 1 credit;
  billing itself did not change.

See `CHANGELOG.md`.

## Upgrading from 1.0.x (API v1)

Version 1.1.0 moves to API v2 and is a breaking change for some workflows:

- **Google Map Reviews** is removed (not available in API v2).
- **Youtube Search** is replaced by **YouTube Search** (`youtube_search_full`).
- The **Webhook URL** option is removed; v2 returns results directly.
- The **Split Rows Into Items** option is removed; output is one item per
  page (see above).

Operation and field definitions are **generated** from the app's endpoint
catalog:

```bash
python3 scripts/generate-catalog.py   # refresh nodes/Scrapier/catalog.json
npm run build
```

The generator reads the **live** catalog (`GET https://proxy.scrapier.io/api/v2/endpoints`)
by default, with retries. Pass `--source PATH_OR_URL` or set `ENDPOINTS_JSON`
to use a saved copy instead. Names, input schemas and credit costs are read
from the catalog (`name`, `input`, `cost_credit`); only the list of curated
slugs (`CHOSEN` in the script) is maintained by hand. It refuses a catalog
with fewer than 100 endpoints or 5 platforms, or one more than 20% smaller
than the last run (`--force` overrides), and a curated endpoint that is
missing or `disabled` stops the run (dropping an operation breaks workflows
using it) unless you pass `--allow-drop <slug>`. Each run prints a review
summary (new endpoints, endpoints without a dedicated operation by platform,
repriced curated operations, new required parameters); `--summary-file FILE`
also saves it as Markdown.

`.github/workflows/regenerate-catalog.yml` runs this weekly and opens a pull
request only when the output changed. It never publishes or tags; releasing
(version bump, tag) stays a manual step.

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
