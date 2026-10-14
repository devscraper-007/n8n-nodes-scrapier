#!/usr/bin/env python3
"""Generate nodes/Scrapier/catalog.json from the app's endpoint catalog (the
API v2 snapshot, src/assets/endpoints.json in the scrapier-app repo) so the
node's operations, fields and credit costs never drift from the real API.

Credit costs are read from each endpoint's cost_credit, never hardcoded; an
endpoint without one stops the run. Endpoints the catalog marks `disabled` are
not callable. A curated endpoint that is disabled stops the run (dropping an
operation breaks workflows using it) unless it is named with --allow-drop.

Usage (from n8n-nodes-scrapier/):
    python3 scripts/generate-catalog.py [--source PATH/TO/endpoints.json] [--allow-drop SLUG ...]

The source is, in order: --source, the ENDPOINTS_JSON environment variable, or
(only when this folder sits inside the scrapier-app repo) that repo's
src/assets/endpoints.json. Anywhere else there is no default: a stale copy
would silently bake stale prices into the node, so the run stops instead.
Refresh the snapshot first with `npm run sync:endpoints` in scrapier-app.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'nodes', 'Scrapier', 'catalog.json')

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


def credit_text(slug, api):
    # v2 bills cost_credit once per successful call, whatever the page holds.
    cost = api.get('cost_credit')
    if not isinstance(cost, (int, float)) or isinstance(cost, bool) or cost <= 0:
        raise SystemExit(f'{slug}: catalog has no usable cost_credit ({cost!r}); refusing to guess a price.')
    cost = int(cost) if float(cost).is_integer() else cost
    return f'{cost} credit' if cost == 1 else f'{cost} credits'


def resolve_source(cli_value):
    """--source, then $ENDPOINTS_JSON, then the in-repo file when (and only
    when) this folder lives inside the scrapier-app repo."""
    explicit = cli_value or os.environ.get('ENDPOINTS_JSON')
    if explicit:
        path = os.path.abspath(explicit)
        if not os.path.isfile(path):
            raise SystemExit(f'Endpoint catalog not found: {path}\n(from {"--source" if cli_value else "$ENDPOINTS_JSON"})')
        return path
    root = os.path.abspath(os.path.join(HERE, '..', '..'))
    pkg = os.path.join(root, 'package.json')
    candidate = os.path.join(root, 'src', 'assets', 'endpoints.json')
    try:
        with open(pkg) as f:
            in_monorepo = json.load(f).get('name') == 'scrapier-app'
    except (OSError, ValueError):
        in_monorepo = False
    if in_monorepo and os.path.isfile(candidate):
        return candidate
    raise SystemExit(
        'No endpoint catalog given. Pass --source PATH or set ENDPOINTS_JSON to the scrapier-app\n'
        'repo\'s src/assets/endpoints.json (run `npm run sync:endpoints` there first so it is current).\n'
        'There is deliberately no default outside the scrapier-app repo.')


def build(source, allow_drop=()):
    with open(source) as f:
        data = json.load(f)

    by_slug = {}
    for platform in data['endpoints']:
        for api in platform['apis']:
            by_slug[api['endpoint'].strip('/')] = api

    missing = [s for s in CHOSEN if s not in by_slug]
    if missing:
        raise SystemExit(f'Endpoints missing from endpoints.json: {missing}')

    disabled = [s for s in CHOSEN if by_slug[s].get('disabled')]
    blocked = [s for s in disabled if s not in allow_drop]
    if blocked:
        raise SystemExit(
            'BREAKING: these curated endpoints are disabled in the catalog and would be silently\n'
            f'dropped from the node: {", ".join(blocked)}\n'
            'Users of those operations would break on the next publish. Re-enable them upstream, remove\n'
            'them from CHOSEN on purpose, or re-run with '
            + ' '.join(f'--allow-drop {s}' for s in blocked) + ' to accept the removal.')
    for s in disabled:
        print(f'WARNING: {s} is disabled in the catalog; dropped from the node (--allow-drop).', file=sys.stderr)

    operations = []
    for slug in (s for s in CHOSEN if s not in disabled):
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
            'description': f'{label(slug)} ({credit_text(slug, api)} per successful call)',
            'fields': fields,
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(operations, f, indent=2)
        f.write('\n')
    print(f'Wrote {len(operations)} operations to {OUT} (from {source})')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--source', help='path to the scrapier-app endpoints.json (or set ENDPOINTS_JSON)')
    ap.add_argument('--allow-drop', action='append', default=[], metavar='SLUG',
                    help='accept removing this curated endpoint because the catalog marks it disabled '
                         '(without it the run stops: dropping an operation breaks workflows that use it)')
    args = ap.parse_args()
    build(resolve_source(args.source), set(args.allow_drop))
