#!/usr/bin/env python3
"""Generate nodes/Scrapier/catalog.json from the app's endpoint catalog so the
node's operations and fields never drift from the real API.

Usage: python3 scripts/generate-catalog.py   (from n8n-nodes-scrapier/)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
# Works from inside the scrapier-app monorepo or from this standalone repo
# checked out next to it.
_CANDIDATES = [
    os.path.join(HERE, '..', '..', 'src', 'assets', 'endpoints.json'),
    os.path.join(HERE, '..', '..', 'scrapier-app', 'src', 'assets', 'endpoints.json'),
]
ENDPOINTS_JSON = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[0])
OUT = os.path.join(HERE, '..', 'nodes', 'Scrapier', 'catalog.json')

CHOSEN = [
    'google-search',
    'google-maps',
    'google-map-reviews',
    'amazon-product',
    'amazon-search',
    'youtube-search',
    'tiktok-profile',
    'instagram-profile-posts',
    'linkedin-profile',
    'facebook-page',
    'duckduckgo-search',
]

TYPE_MAP = {'string': 'string', 'integer': 'number', 'number': 'number', 'boolean': 'boolean'}


def label(slug):
    return ' '.join(w.capitalize() for w in slug.replace('_', '-').split('-'))


def build():
    with open(ENDPOINTS_JSON) as f:
        data = json.load(f)

    by_slug = {}
    for platform in data['endpoints']:
        for api in platform['apis']:
            by_slug[api['endpoint'].strip('/')] = api

    missing = [s for s in CHOSEN if s not in by_slug]
    if missing:
        raise SystemExit(f'Endpoints missing from endpoints.json: {missing}')

    operations = []
    for slug in CHOSEN:
        api = by_slug[slug]
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
        operations.append({
            'key': slug.replace('-', '_'),
            'slug': slug,
            'label': label(slug),
            'description': f'{label(slug)} ({api.get("cost_credit", 1)} credit per row returned)',
            'fields': fields,
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(operations, f, indent=2)
        f.write('\n')
    print(f'Wrote {len(operations)} operations to {OUT}')


if __name__ == '__main__':
    build()
