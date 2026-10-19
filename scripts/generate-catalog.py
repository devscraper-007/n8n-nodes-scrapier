#!/usr/bin/env python3
"""Generate nodes/Scrapier/catalog.json from the live Scrapier endpoint
catalog (GET https://proxy.scrapier.io/api/v2/endpoints) so the node's
operations, fields, names and credit costs never drift from the real API.

The live catalog is the single source of truth. CHOSEN below is the curated
list of endpoints that get a dedicated operation; every other endpoint stays
reachable through the "Custom Scrape (Any Endpoint)" operation. Names, input
schemas and prices are read from the catalog, never typed here. A curated
endpoint that is missing or disabled stops the run (dropping an operation
breaks workflows using it) unless it is named with --allow-drop.

Usage (from n8n-nodes-scrapier/):
    python3 scripts/generate-catalog.py [--source PATH_OR_URL] [--force]
                                        [--allow-drop SLUG ...] [--summary-file FILE]

Source, in order: --source, $ENDPOINTS_JSON (file path or URL), else the live
catalog (fetched with retries). The payload is validated (>=100 endpoints,
>=5 platforms) and a catalog >20% smaller than the last committed run
(scripts/catalog-index.json) is refused unless --force. The run ends with a
review summary: new endpoints, endpoints without a dedicated operation by
platform, repriced curated operations and new required parameters.
Output is deterministic: a run with no upstream change produces no diff.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catalog_source as cs  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
OUT = os.path.join(ROOT, 'nodes', 'Scrapier', 'catalog.json')
INDEX = os.path.join(HERE, 'catalog-index.json')
README = os.path.join(ROOT, 'README.md')

CHOSEN = [
    'google-search',
    'google-maps',
    'amazon-product',
    'amazon-search',
    'youtube-search-full',
    'tiktok-profile',
    'instagram-profile-posts',
    'linkedin-profile',
    'facebook-page',
    'duckduckgo-search',
]

TYPE_MAP = {'string': 'string', 'integer': 'number', 'number': 'number', 'boolean': 'boolean'}


def label(slug):
    return ' '.join(w.capitalize() for w in slug.replace('_', '-').split('-'))


def build(source, force=False, allow_drop=(), summary_file=None):
    data, origin = cs.load_catalog(source)
    by_slug = cs.index_catalog(data)
    prev = cs.read_index(INDEX)
    cs.check_shrink(by_slug, prev, force)
    active = cs.select_curated(by_slug, CHOSEN, set(allow_drop))

    operations = []
    for slug in active:
        api = by_slug[slug][1]
        fields = []
        for pname, meta in (api.get('input') or {}).items():
            if not isinstance(meta, dict):
                continue
            ftype = TYPE_MAP.get(meta.get('type', 'string'), 'string')
            default = meta.get('default_value')
            if ftype == 'boolean':
                default = str(default).lower() == 'true'
            elif ftype == 'number':
                try:
                    default = int(float(default)) if default not in (None, '') else None
                except ValueError:
                    default = None
            fields.append({
                'name': pname,
                'label': label(pname),
                'type': ftype,
                'required': bool(meta.get('required')),
                'description': meta.get('description', ''),
                'default': default,
            })
        name = api.get('name') or label(slug)
        operations.append({
            'key': slug.replace('-', '_'),
            'slug': slug,
            'label': name,
            # v2 bills cost_credit once per successful call, whatever the page holds.
            'description': f'{name} ({cs.credit_text(cs.cost_of(slug, api))} per successful call)',
            'fields': fields,
        })

    with open(OUT, 'w') as f:
        json.dump(operations, f, indent=2)
        f.write('\n')
    print(f'Wrote {len(operations)} operations to {OUT} (from {origin})')

    st = cs.stats(by_slug)
    cs.update_marked_block(README, (
        f'The live catalog currently has **{st["endpoints"]} callable endpoints across {st["platforms"]} platforms**; '
        f'this node has **{len(operations) + 1} operations** ({len(operations)} curated scrapers plus '
        '**Custom Scrape**, which reaches every other endpoint by slug).'))
    cs.update_marked_block(README, (
        f'Each successful call costs the endpoint\'s credit price ({cs.price_range_text(st)} across the '
        'catalog), however many results the page holds, empty pages included. Each curated operation\'s '
        'description shows its price; for Custom Scrape see the endpoint\'s `cost_credit` in the catalog. '
        'Failed calls are free.'), name='pricing')
    cs.finish(INDEX, by_slug, active, origin, prev, summary_file)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    cs.add_common_args(ap)
    args = ap.parse_args()
    build(args.source, args.force, args.allow_drop, args.summary_file)
