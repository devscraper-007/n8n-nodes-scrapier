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

### Breaking: Google Search

- **Removed** fields (the API no longer accepts them; they are not aliases):
  `cursor`, `site`, `quickDateRange`, `beforeDate`, `afterDate`,
  `mobileResults`, `aiMode`, `hl`, `gl`, `maxPagesPerQuery`.
- **Added** fields: `page`, `dateRange` (`any_time`, `past_7_days`,
  `past_3_weeks`, `past_6_months`, `past_2_years`, `custom`), `raw_data`.
  `countryCode` and `languageCode` replace `gl` and `hl`.
- Google Search **pages by number**: set `page` (1-50, 10 results per page)
  and continue while `has_next_page` is true; `next_page` is the next number.
  There is no cursor.

### Other changes

- **Youtube Search Full**: removed `max_pages_per_query`; added `sort_by`,
  `upload_date`, `duration`, `country`, `language`.
- **Amazon Product**: added `location_name`, `language_name`, `se_domain`,
  `zip_code`, `set_delivery_location`, `price_min`, `price_max`, `sort_by`,
  `department`, `search_param`, `tag`, `depth`, `max_crawl_pages`.
- Every operation: added optional `raw_data`.
- Credit costs in operation descriptions now match the API: Amazon Product 3
  (was shown as 1), Amazon Search 2 (was 1), Youtube Search Full 5 (was 1).
  Billing itself did not change.

## 1.1.0

Moved to API v2 (see the README's upgrade notes).
