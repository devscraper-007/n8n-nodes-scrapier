"""Shared catalog loading, validation and review helpers for the Scrapier
connector generators (n8n node, Zapier app, Make app).

The live catalog (GET https://proxy.scrapier.io/api/v2/endpoints) is the
single source of truth. Each connector keeps a CURATED list of endpoints
(`CHOSEN`) that become dedicated actions; everything else stays reachable
through the connector's "call any endpoint by slug" operation. This module:

  * loads the catalog (live by default, or --source / $ENDPOINTS_JSON, which
    may be a file path or an http(s) URL) with retries,
  * validates it (floors on size, structure) and refuses a large shrink
    against the last committed run unless --force,
  * fails loudly when a curated slug is missing or disabled,
  * prints (and optionally writes) a review summary so a human sees what
    changed upstream: new endpoints, uncovered endpoints per platform,
    repriced / new-required-parameter changes on curated actions.

NOTE: this file is duplicated verbatim in three places (n8n-nodes-scrapier/
scripts, scrapier-app/zapier-app/scripts, scrapier-app/make-app/scripts).
Change all copies together; CI in scrapier-app checks the two there match, and
`npm test` in n8n-nodes-scrapier prints this file's sha256 for a manual compare
(`python3 scripts/catalog_source.py --sha256`).
`python3 scripts/catalog_source.py --self-test` runs the built-in checks.
Python 3.8+, standard library only.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

LIVE_URL = 'https://proxy.scrapier.io/api/v2/endpoints'
ENV_VAR = 'ENDPOINTS_JSON'
MIN_ENDPOINTS = 100
MIN_PLATFORMS = 5
MAX_SHRINK = 0.20
USER_AGENT = 'scrapier-connector-generator/1 (+https://app.scrapier.io)'
EXPECTED_CATALOG_SOURCE = 'upstream'


def die(message):
    raise SystemExit(f'ERROR: {message}')


def add_common_args(ap, allow_drop=True):
    ap.add_argument('--source', metavar='PATH_OR_URL',
                    help=f'catalog to generate from: a file path or http(s) URL '
                         f'(default: ${ENV_VAR}, else the live catalog {LIVE_URL})')
    ap.add_argument('--force', action='store_true',
                    help=f'accept a catalog that is more than {int(MAX_SHRINK * 100)}% smaller than the '
                         'last committed run')
    ap.add_argument('--summary-file', metavar='PATH',
                    help='also write the review summary (Markdown) to this file, e.g. for a PR body')
    if allow_drop:
        ap.add_argument('--allow-drop', action='append', default=[], metavar='SLUG',
                        help='accept removing this curated endpoint because the catalog marks it disabled '
                             '(without it the run stops: dropping an action breaks workflows that use it)')


# --------------------------------------------------------------- loading ---

def _fetch(url, retries=4, timeout=60):
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500 and e.code != 429:
                break  # a 4xx will not fix itself
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = e
        if attempt < retries:
            delay = 2 ** attempt
            print(f'  fetch attempt {attempt}/{retries} failed ({last}); retrying in {delay}s', file=sys.stderr)
            time.sleep(delay)
    die(f'could not fetch the catalog from {url}: {last}')


def load_catalog(source=None):
    """Return (payload, origin). Order: --source, $ENDPOINTS_JSON, live URL."""
    explicit = source or os.environ.get(ENV_VAR)
    origin = explicit or LIVE_URL
    if re.match(r'^https?://', origin):
        return _fetch(origin), origin
    path = os.path.abspath(origin)
    if not os.path.isfile(path):
        die(f'catalog file not found: {path} (from {"--source" if source else "$" + ENV_VAR})')
    try:
        with open(path) as f:
            return json.load(f), path
    except ValueError as e:
        die(f'{path} is not valid JSON: {e}')


def check_catalog_meta(data):
    """The live payload carries a `catalog` object ({source, routes, platforms,
    fetched_at, unroutable}). Refuse a catalog the API itself flags as degraded:
    routes that cannot be served, or a source other than the upstream catalog
    (e.g. a fallback snapshot). Lenient when the object or a field is absent
    (saved copies and older payloads)."""
    meta = data.get('catalog')
    if not isinstance(meta, dict):
        return
    unroutable = meta.get('unroutable')
    if isinstance(unroutable, (int, float)) and not isinstance(unroutable, bool) and unroutable > 0:
        die(f'the catalog reports {unroutable} unroutable endpoint(s) (catalog.unroutable); '
            'upstream is degraded, refusing to generate from it.')
    source = meta.get('source')
    if source is not None and source != EXPECTED_CATALOG_SOURCE:
        die(f'the catalog reports catalog.source={source!r}, expected {EXPECTED_CATALOG_SOURCE!r}; '
            'it may be a fallback or stale snapshot, refusing to generate from it.')


def index_catalog(data):
    """Validate the payload and return {slug: (platform, api)} in catalog order."""
    if not isinstance(data, dict) or not isinstance(data.get('endpoints'), list):
        die('catalog payload has no "endpoints" list; refusing to continue')
    check_catalog_meta(data)
    by_slug = {}
    platforms = set()
    for platform in data['endpoints']:
        if not isinstance(platform, dict) or not isinstance(platform.get('apis'), list) or not platform.get('platform'):
            die('catalog has a malformed platform entry; refusing to continue')
        platforms.add(platform['platform'])
        for api in platform['apis']:
            if not isinstance(api, dict) or not isinstance(api.get('endpoint'), str):
                die(f'catalog platform {platform["platform"]!r} has an entry without an "endpoint"')
            slug = api['endpoint'].strip('/')
            if not slug or slug in by_slug:
                die(f'catalog has an empty or duplicate endpoint slug: {slug!r}')
            by_slug[slug] = (platform['platform'], api)
    if len(by_slug) < MIN_ENDPOINTS or len(platforms) < MIN_PLATFORMS:
        die(f'catalog looks truncated: {len(by_slug)} endpoints / {len(platforms)} platforms '
            f'(floor is {MIN_ENDPOINTS} / {MIN_PLATFORMS}); refusing to generate from it')
    return by_slug


def read_index(path):
    """Load the committed run index. Absent -> None (first run; the shrink guard
    is skipped, with a warning). Present but unreadable or malformed -> fail:
    silently skipping the guard would defeat it."""
    if not os.path.exists(path):
        print(f'WARNING: no previous run index at {path}; this looks like a first run, so the '
              'shrink guard and the "changes since last run" review are skipped.', file=sys.stderr)
        return None
    try:
        with open(path) as f:
            prev = json.load(f)
    except (OSError, ValueError) as e:
        die(f'the previous run index {path} exists but cannot be read ({e}); fix or delete it on purpose '
            '(deleting skips the shrink guard once).')
    if (not isinstance(prev, dict) or not isinstance(prev.get('endpoints'), dict)
            or not isinstance(prev.get('curated'), dict)
            or not isinstance(prev.get('disabled', []), list)):
        die(f'the previous run index {path} is malformed (expected "endpoints", "curated" objects); '
            'fix or delete it on purpose (deleting skips the shrink guard once).')
    return prev


def enabled_slugs(by_slug):
    return {s for s, (_, a) in by_slug.items() if not is_disabled(a)}


def check_shrink(by_slug, prev, force):
    """Compare ENABLED endpoint counts: disabled ones are not callable, so they
    do not count as present on either side."""
    if not prev:
        return
    disabled_before = set(prev.get('disabled') or [])
    before = len([s for s in prev['endpoints'] if s not in disabled_before])
    now = len(enabled_slugs(by_slug))
    if before and now < before * (1 - MAX_SHRINK):
        msg = (f'the catalog shrank from {before} to {now} enabled endpoints (more than {int(MAX_SHRINK * 100)}% '
               'smaller than the last committed run)')
        if not force:
            die(msg + '. That usually means an upstream problem, not a real removal. '
                      'Check the catalog, then re-run with --force if it is intended.')
        print(f'WARNING: {msg}; continuing because of --force.', file=sys.stderr)


# --------------------------------------------------------------- curation ---

def is_disabled(api):
    return bool(api.get('disabled'))


def cost_of(slug, api):
    cost = api.get('cost_credit')
    if not isinstance(cost, (int, float)) or isinstance(cost, bool) or cost <= 0:
        die(f'{slug}: catalog has no usable cost_credit ({cost!r}); refusing to guess a price.')
    return int(cost) if float(cost).is_integer() else cost


def credit_text(cost):
    return f'{cost} credit' if cost == 1 else f'{cost} credits'


def select_curated(by_slug, chosen, allow_drop=()):
    """Return the CHOSEN slugs that are live. A missing slug always fails; a
    disabled one fails unless it is named in allow_drop."""
    missing = [s for s in chosen if s not in by_slug]
    if missing:
        die(f'curated endpoints are missing from the catalog: {missing}\n'
            'Remove them from CHOSEN on purpose (this breaks workflows that use them) or fix the catalog.')
    disabled = [s for s in chosen if is_disabled(by_slug[s][1])]
    blocked = [s for s in disabled if s not in allow_drop]
    if blocked:
        die('BREAKING: these curated endpoints are disabled in the catalog and would be silently\n'
            f'dropped: {", ".join(blocked)}\n'
            'Users of those actions would break on the next publish. Re-enable them upstream, remove\n'
            'them from CHOSEN on purpose, or re-run with '
            + ' '.join(f'--allow-drop {s}' for s in blocked) + ' to accept the removal.')
    for s in disabled:
        print(f'WARNING: {s} is disabled in the catalog; dropped (--allow-drop).', file=sys.stderr)
    for s in chosen:
        cost_of(s, by_slug[s][1])  # fail on an unusable price now, not mid-generation
    return [s for s in chosen if s not in disabled]


def curated_state(by_slug, active):
    state = {}
    for slug in active:
        api = by_slug[slug][1]
        inputs = api.get('input') or {}
        fields = {}
        for k, v in inputs.items():
            if not isinstance(v, dict):
                continue
            f = {'type': v.get('type'), 'default': v.get('default_value')}
            if isinstance(v.get('options'), list):
                f['options'] = sorted(v['options'], key=str)
            fields[k] = f
        state[slug] = {
            'cost_credit': cost_of(slug, api),
            'params': sorted(inputs),
            'required': sorted(k for k, v in inputs.items() if isinstance(v, dict) and v.get('required')),
            'fields': fields,
        }
    return state


def stats(by_slug):
    live = [(p, a) for p, a in by_slug.values() if not is_disabled(a)]
    # Non-curated prices are only summarised here, so be tolerant of odd values.
    costs = [a['cost_credit'] for _, a in live
             if isinstance(a.get('cost_credit'), (int, float)) and not isinstance(a.get('cost_credit'), bool)]
    costs = [int(c) if float(c).is_integer() else c for c in costs] or [0]
    return {
        'endpoints': len(live),
        'platforms': len({p for p, _ in live}),
        'min_cost_credit': min(costs),
        'max_cost_credit': max(costs),
    }


def price_range_text(st):
    lo, hi = st['min_cost_credit'], st['max_cost_credit']
    if lo == hi:
        return f'{credit_text(lo)} per successful call'
    return f'from {credit_text(lo)} per successful call, up to {hi} for the heaviest endpoints'


# ----------------------------------------------------------------- review ---

def _show(value):
    return json.dumps(value, sort_keys=True)


def _field_changes(slug, old, cur):
    """Per-parameter default / type / enum-option changes between two curated
    states. Silent default changes alter what existing workflows send, so they
    are reported even though nothing is added or removed."""
    out = []
    old_f, cur_f = old.get('fields'), cur.get('fields') or {}
    if old_f is None:
        return out  # previous run predates the field record; baseline noted separately
    for name in sorted(set(old_f) & set(cur_f)):
        o, c = old_f[name], cur_f[name]
        if o.get('type') != c.get('type'):
            out.append(f'- `{slug}`: param `{name}` TYPE changed {_show(o.get("type"))} -> {_show(c.get("type"))}.')
        if o.get('default') != c.get('default'):
            out.append(f'- `{slug}`: param `{name}` DEFAULT changed {_show(o.get("default"))} -> '
                       f'{_show(c.get("default"))} (existing workflows that leave it unset now send a different value).')
        oo, co = o.get('options'), c.get('options')
        if oo != co:
            added = sorted(set(co or []) - set(oo or []), key=str)
            gone = sorted(set(oo or []) - set(co or []), key=str)
            parts = []
            if added:
                parts.append('added ' + ', '.join(map(str, added)))
            if gone:
                parts.append('removed ' + ', '.join(map(str, gone)))
            if oo is None or co is None:
                parts.append('the list of allowed options ' + ('appeared' if oo is None else 'was dropped'))
            out.append(f'- `{slug}`: param `{name}` OPTIONS changed ({"; ".join(parts)}).')
    return out


def build_review(by_slug, active, state, prev, origin):
    """Return the review summary as a list of Markdown lines."""
    st = stats(by_slug)
    prev_eps = (prev or {}).get('endpoints') or {}
    prev_cur = (prev or {}).get('curated') or {}
    out = [f'## Catalog review ({origin})', '',
           f'{st["endpoints"]} enabled endpoints across {st["platforms"]} platforms; '
           f'{len(active)} curated actions; price range {price_range_text(st)}.', '']

    if prev:
        new = sorted(s for s in by_slug if s not in prev_eps)
        gone = sorted(s for s in prev_eps if s not in by_slug)
        out.append(f'### Changes since the last committed run ({len(prev_eps)} endpoints)')
        out.append('')
        out.append('New endpoints (' + str(len(new)) + '): ' + (', '.join(new) if new else 'none'))
        out.append('Removed endpoints (' + str(len(gone)) + '): ' + (', '.join(gone) if gone else 'none'))
        problems = []
        for slug in active:
            old, cur = prev_cur.get(slug), state[slug]
            if not old:
                problems.append(f'- `{slug}`: newly curated (no previous state).')
                continue
            if old['cost_credit'] != cur['cost_credit']:
                problems.append(f'- `{slug}`: REPRICED {old["cost_credit"]} -> {cur["cost_credit"]} credits.')
            newreq = sorted(set(cur['required']) - set(old['required']))
            if newreq:
                problems.append(f'- `{slug}`: NEW REQUIRED params {", ".join(newreq)} '
                                '(existing workflows that omit them will start failing).')
            added = sorted(set(cur['params']) - set(old['params']) - set(newreq))
            if added:
                problems.append(f'- `{slug}`: new optional params {", ".join(added)}.')
            removed = sorted(set(old['params']) - set(cur['params']))
            if removed:
                problems.append(f'- `{slug}`: REMOVED params {", ".join(removed)} '
                                '(the API ignores unknown params silently; workflows lose the setting).')
            problems.extend(_field_changes(slug, old, cur))
        for slug in sorted(set(prev_cur) - set(active)):
            problems.append(f'- `{slug}`: no longer curated (action dropped).')
        if any('fields' not in prev_cur.get(s, {'fields': 1}) for s in active):
            out.append('')
            out.append('Note: the previous run did not record per-parameter defaults, types or options for '
                       'some curated actions, so changes to those are only visible from this run on.')
        out.append('')
        out.append('Curated actions that changed:' if problems else 'Curated actions: no price or parameter changes.')
        out.extend(problems)
        out.append('')
    else:
        out.append('No previous run recorded (first run with this tooling): "changes since last run" '
                   'is skipped; review the git diff of the generated files instead.')
        out.append('')

    disabled = sorted(s for s, (_, a) in by_slug.items() if is_disabled(a))
    uncovered = {}
    for slug, (platform, api) in by_slug.items():
        if slug not in active and not is_disabled(api):
            uncovered.setdefault(platform, []).append(slug)
    total = sum(len(v) for v in uncovered.values())
    out.append(f'### Endpoints without a dedicated action ({total})')
    out.append('')
    out.append('All of these are still callable through the generic "call any endpoint by slug" '
               'operation. `[new]` marks endpoints not in the previous run.')
    out.append('')
    for platform in sorted(uncovered):
        slugs = sorted(uncovered[platform])
        tagged = [s + (' [new]' if prev and s not in prev_eps else '') for s in slugs]
        out.append(f'- **{platform}** ({len(slugs)}): ' + ', '.join(tagged))
    out.append('')
    out.append('Disabled in the catalog (not callable): ' + (', '.join(disabled) if disabled else 'none'))
    return out


def write_index(path, by_slug, state):
    obj = {
        'stats': stats(by_slug),
        'endpoints': {s: by_slug[s][0] for s in sorted(by_slug)},
        'disabled': sorted(s for s, (_, a) in by_slug.items() if is_disabled(a)),
        'curated': {s: state[s] for s in sorted(state)},
    }
    with open(path, 'w') as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write('\n')


def finish(index_path, by_slug, active, origin, prev, summary_file=None):
    """Print the review, write the summary file and the committed run index."""
    state = curated_state(by_slug, active)
    lines = build_review(by_slug, active, state, prev, origin)
    text = '\n'.join(lines) + '\n'
    print('\n' + text)
    if summary_file:
        with open(summary_file, 'w') as f:
            f.write(text)
    write_index(index_path, by_slug, state)


def update_marked_block(path, text, name='catalog'):
    """Replace the text between <!-- {name}:start --> and <!-- {name}:end -->."""
    start, end = f'<!-- {name}:start -->', f'<!-- {name}:end -->'
    with open(path) as f:
        content = f.read()
    pattern = re.compile(re.escape(start) + r'.*?' + re.escape(end), re.S)
    if not pattern.search(content):
        die(f'{path} has no {start} ... {end} block to update')
    new = pattern.sub(lambda m: f'{start}\n{text.strip()}\n{end}', content)
    if new != content:
        with open(path, 'w') as f:
            f.write(new)


# -------------------------------------------------------------- self-test ---

def _self_test():
    import contextlib
    import hashlib
    import io
    import tempfile

    def raises(fn, *a):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                fn(*a)
            except SystemExit as e:
                return str(e)
        return None

    def api(slug, disabled=False, **inputs):
        return {'endpoint': f'/{slug}/', 'cost_credit': 1, 'disabled': disabled, 'input': inputs}

    # Per-parameter default / type / options changes are reported.
    old_api = api('a', use_proxy={'type': 'boolean', 'default_value': 'false', 'options': ['true', 'false']},
                  n={'type': 'integer', 'default_value': '10'}, s={'type': 'string', 'default_value': ''})
    new_api = api('a', use_proxy={'type': 'boolean', 'default_value': 'true', 'options': ['true', 'false']},
                  n={'type': 'number', 'default_value': '10'},
                  s={'type': 'string', 'default_value': '', 'options': ['x', 'y']})
    mk = lambda a: {'a': ('p', a)}  # noqa: E731
    old_state = curated_state(mk(old_api), ['a'])
    new_state = curated_state(mk(new_api), ['a'])
    lines = '\n'.join(build_review(mk(new_api), ['a'], new_state, {'endpoints': {'a': 'p'}, 'curated': old_state}, 'test'))
    assert 'param `use_proxy` DEFAULT changed "false" -> "true"' in lines, lines
    assert 'param `n` TYPE changed "integer" -> "number"' in lines, lines
    assert 'param `s` OPTIONS changed' in lines, lines
    same = '\n'.join(build_review(mk(new_api), ['a'], new_state, {'endpoints': {'a': 'p'}, 'curated': new_state}, 'test'))
    assert 'no price or parameter changes' in same, same
    legacy = {k: v for k, v in old_state['a'].items() if k != 'fields'}
    lines = '\n'.join(build_review(mk(new_api), ['a'], new_state, {'endpoints': {'a': 'p'}, 'curated': {'a': legacy}}, 'test'))
    assert 'did not record per-parameter defaults' in lines, lines

    # read_index: absent -> None; unreadable / malformed -> fail.
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'idx.json')
        with contextlib.redirect_stderr(io.StringIO()):
            assert read_index(path) is None, 'absent index -> None (guard skipped with a warning)'
        with open(path, 'w') as f:
            f.write('{not json')
        assert raises(read_index, path), 'unparseable index must fail'
        with open(path, 'w') as f:
            f.write('{"endpoints": []}')
        assert raises(read_index, path), 'malformed index must fail'
        with open(path, 'w') as f:
            f.write('{"endpoints": {"a": "p"}, "curated": {}}')
        assert read_index(path)['endpoints'] == {'a': 'p'}

    # Shrink guard counts enabled endpoints only.
    prev = {'endpoints': {f'e{i}': 'p' for i in range(10)}, 'disabled': ['e0', 'e1', 'e2', 'e3', 'e4']}
    now = {f'e{i}': ('p', {'endpoint': f'e{i}'}) for i in range(5, 10)}
    for i in range(5):  # still listed but disabled: no longer callable
        now[f'e{i}'] = ('p', {'endpoint': f'e{i}', 'disabled': True})
    assert raises(check_shrink, now, prev, False) is None, 'same enabled set must pass'
    now.pop('e9'); now.pop('e8')
    assert raises(check_shrink, now, prev, False), 'losing enabled endpoints must fail'
    assert raises(check_shrink, now, {'endpoints': {f'e{i}': 'p' for i in range(10)}, 'disabled': []}, False), \
        'disabled endpoints must not count as present'

    # Catalog metadata: degraded markers fail; absent ones are tolerated.
    assert check_catalog_meta({}) is None
    assert check_catalog_meta({'catalog': {'source': 'upstream', 'unroutable': 0}}) is None
    assert raises(check_catalog_meta, {'catalog': {'source': 'upstream', 'unroutable': 2}})
    assert raises(check_catalog_meta, {'catalog': {'source': 'fallback', 'unroutable': 0}})

    # price text has no nested parentheses
    assert '(' not in price_range_text({'min_cost_credit': 1, 'max_cost_credit': 100})

    print('catalog_source self-test OK; sha256 ' + hashlib.sha256(open(__file__, 'rb').read()).hexdigest())


if __name__ == '__main__':
    if '--self-test' in sys.argv[1:]:
        _self_test()
    elif '--sha256' in sys.argv[1:]:
        import hashlib
        print(hashlib.sha256(open(__file__, 'rb').read()).hexdigest())
    else:
        die('library module; use --self-test or --sha256')
