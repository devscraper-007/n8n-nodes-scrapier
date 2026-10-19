# Changelog

## 1.2.0

> **Read this before upgrading: Google Search fails silently.** The API
> ignores parameters it does not know (upstream `validators.py`: "Unknown
> params -> silently ignored"), so existing workflows that set a removed Google
> Search field (`cursor`, `site`, `quickDateRange`, `beforeDate`, `afterDate`,
> `mobileResults`, `aiMode`, `hl`, `gl`, `maxPagesPerQuery`) will **not
> error**. They quietly lose those filters and always receive **page 1**; a
> loop keyed on `cursor` never advances. Add the new `page` field (and loop on `has_next_page` / `next_page`) before
> updating the node, or check each Google Search node after the update.

Operation definitions regenerated from the live Scrapier API v2 catalog.

### Custom Scrape

- New optional **Pick From Catalog** dropdown, loaded live from the public
  catalog (`GET /api/v2/endpoints`, cached 10 minutes; a failed load is not
  retried for a minute and the last good list is kept; falls back to typing the
  slug). **Endpoint Slug** keeps its name and takes precedence when set; it is no
  longer marked required in the UI (an empty slug with no pick fails with a clear
  message). Operation keys and field names are unchanged.
- The slug (typed or picked) must be lowercase letters, digits, `-` or `_`
  (surrounding slashes and spaces are trimmed). Anything else (`..`, an inner
  `/`, `?`, `#`, spaces, other characters) fails before a request is made.

### Breaking: Google Search

- **Removed** fields (the API no longer accepts them; they are not aliases):
  `cursor`, `site`, `quickDateRange`, `beforeDate`, `afterDate`,
  `mobileResults`, `aiMode`, `hl`, `gl`, `maxPagesPerQuery`.
- **Added** fields: `page`, `dateRange` (`any_time`, `past_7_days`,
  `past_3_weeks`, `past_6_months`, `past_2_years`, `custom`), `raw_data`.
  `countryCode` and `languageCode` replace `gl` and `hl`.
- Google Search **pages by number**: set `page`
  and continue while `has_next_page` is true; `next_page` is the next number.
  There is no cursor.

### Other changes

- **Youtube Search Full**: removed `max_pages_per_query`; added `sort_by`,
  `upload_date`, `duration`, `country`, `language`.
- **Amazon Product**: added `location_name`, `language_name`, `se_domain`,
  `zip_code`, `set_delivery_location`, `price_min`, `price_max`, `sort_by`,
  `department`, `search_param`, `tag`, `depth`, `max_crawl_pages`.
- Every operation: added optional `raw_data`.
- Operation labels now come from the catalog's `name` field (e.g. "YouTube Search",
  "Amazon Product Scraper"); operation values and slugs are unchanged.
- Node description and README no longer hand-type platform or operation counts.
- The catalog generator reads the live catalog by default and validates it; a weekly
  workflow opens a pull request when the catalog changes (it never publishes).

### Silent default changes (no error, different request)

Existing workflows that leave these fields unset now send a different value:

- **Google Maps** `use_proxy`: default `false` -> `true`.
- **YouTube Search** (`youtube_search_full`) `max_results_video`: default `10` -> `20`.

Set the field explicitly in the node if you depend on the old value.

### Fixed

- Number fields that have no default in the catalog (Amazon Search
  `browse_node`, and the new Amazon Product `price_min` / `price_max`) are
  empty by default and are **not sent**. The node used to default them to `0`
  and send `0`, which could filter results out. An explicit `0` you type is
  still sent.

## 1.1.0

Moved to API v2 (see the README's upgrade notes).
