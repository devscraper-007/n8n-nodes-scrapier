'use strict';

// Offline structural checks on the compiled output. Run after `npm run build`.

const assert = require('assert');

const { Scrapier } = require('../dist/nodes/Scrapier/Scrapier.node.js');
const { ScrapierApi } = require('../dist/credentials/ScrapierApi.credentials.js');

const node = new Scrapier();
const cred = new ScrapierApi();

assert.strictEqual(node.description.name, 'scrapier');
assert.strictEqual(node.description.credentials[0].name, 'scrapierApi');
assert.strictEqual(typeof node.execute, 'function');

const opProp = node.description.properties.find((p) => p.name === 'operation');
// The operation list is generated: curated operations (catalog.json) plus Custom Scrape.
const generated = require('../nodes/Scrapier/catalog.json');
assert.ok(generated.length >= 5, `catalog.json has curated operations, got ${generated.length}`);
assert.strictEqual(opProp.options.length, generated.length + 1, 'every generated operation plus Custom Scrape');
for (const op of generated) {
	assert.ok(opProp.options.some((o) => o.value === op.key), `${op.key} is exposed`);
}
assert.ok(!/\d\+ more|\d+ operations/.test(node.description.description), 'no hand-typed counts in the node description');
assert.ok(opProp.options.some((o) => o.value === 'google_search'));
assert.ok(opProp.options.some((o) => o.value === 'youtube_search_full'));
assert.ok(opProp.options.some((o) => o.value === 'custom_scrape'));
// Not in API v2.
assert.ok(!opProp.options.some((o) => o.value === 'youtube_search'));
assert.ok(!opProp.options.some((o) => o.value === 'google_map_reviews'));

// v2 billing: 1 call = cost_credit, never "per row".
for (const o of opProp.options) {
	if (o.value === 'custom_scrape') continue;
	assert.ok(/per successful call/.test(o.description), `${o.value} states per-call pricing`);
	assert.ok(!/per row/i.test(o.description), `${o.value} has no per-row pricing`);
}

// v2 is synchronous: no webhook / row-splitting options remain.
const propNames = node.description.properties.map((p) => p.name);
assert.ok(!propNames.includes('webhookUrl'), 'webhookUrl option removed');
assert.ok(!propNames.includes('splitRows'), 'splitRows option removed');

// google_search pages by number (`page`) and has no cursor; the other
// curated operations take a `cursor` token.
const fieldsOf = (op) => node.description.properties.filter(
	(p) => p.displayOptions && p.displayOptions.show && p.displayOptions.show.operation
		&& p.displayOptions.show.operation.includes(op),
);
const gsFields = fieldsOf('google_search');
assert.ok(gsFields.some((p) => p.name === 'page'), 'google_search exposes a page input');
assert.ok(!gsFields.some((p) => p.name === 'cursor'), 'google_search has no cursor');
for (const op of opProp.options.map((o) => o.value).filter((v) => v !== 'custom_scrape' && v !== 'google_search')) {
	assert.ok(fieldsOf(op).some((p) => p.name === 'cursor'), `${op} exposes a cursor`);
}

const queries = node.description.properties.find(
	(p) => p.name === 'queries' && p.displayOptions.show.operation.includes('google_search'),
);
assert.ok(queries, 'google_search has a queries field');
assert.strictEqual(queries.required, true);

// Credit text must come from the catalog's cost_credit, never a baked
// default (amazon-product, amazon-search and youtube-search-full were once
// all baked as "1 credit" from a stale snapshot). Structure is always
// checked; the number itself is cross-checked against the app's endpoint
// snapshot when ENDPOINTS_JSON points at a saved copy of the catalog. Prices are not pinned here: a price change must not fail a
// publish.
function snapshotCredits() {
	const fs = require('fs');
	const candidates = [process.env.ENDPOINTS_JSON].filter(Boolean);
	const file = candidates.find((p) => !/^https?:/.test(p) && fs.existsSync(p));
	if (!file) return null;
	const out = {};
	for (const p of JSON.parse(fs.readFileSync(file, 'utf8')).endpoints) {
		for (const a of p.apis) out[a.endpoint.replace(/^\/+|\/+$/g, '')] = a.cost_credit;
	}
	return out;
}

{
	const snapshot = snapshotCredits();
	for (const op of opProp.options.filter((o) => o.value !== 'custom_scrape')) {
		const m = /(\d+) credits? per successful call/.exec(op.description);
		assert.ok(m, `${op.value} description states a credit price: ${op.description}`);
		const slug = op.value.replace(/_/g, '-');
		if (snapshot && slug in snapshot) {
			assert.strictEqual(Number(m[1]), snapshot[slug], `${op.value} credit text matches cost_credit`);
		}
	}
}

assert.strictEqual(cred.name, 'scrapierApi');
assert.strictEqual(cred.authenticate.properties.headers['X-API-Key'], '={{$credentials.apiKey}}');
assert.ok(cred.test.request.url.endsWith('/me'), 'credential test hits /me');
assert.strictEqual(cred.test.request.baseURL, 'https://proxy.scrapier.io/api/v2');
assert.ok(cred.documentationUrl.includes('/api/v2/'), 'docs URL points at v2');

// Runtime: stub the n8n execute context and check v2 response handling.
function makeCtx(params, response, { continueOnFail = false } = {}) {
	const calls = [];
	return {
		calls,
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'Scrapier', type: 'scrapier', typeVersion: 1, parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (_cred, opts) => {
				calls.push(opts);
				return response;
			},
		},
	};
}

(async () => {
	// Success: page object becomes one item, next_cursor preserved.
	const page = { results: [{ title: 'a' }, { title: 'b' }], next_cursor: 'tok123' };
	let ctx = makeCtx(
		{ operation: 'google_search', queries: 'pizza', cursor: '' },
		{ statusCode: 200, headers: {}, body: { success: true, data: page } },
	);
	let out = await node.execute.call(ctx);
	assert.strictEqual(ctx.calls[0].url, 'https://proxy.scrapier.io/api/v2/google-search/');
	assert.strictEqual(ctx.calls[0].method, 'POST');
	assert.strictEqual(ctx.calls[0].body.queries, 'pizza');
	assert.ok(!('cursor' in ctx.calls[0].body), 'empty cursor not sent');
	assert.ok(!('webhook_url' in ctx.calls[0].body), 'no webhook_url sent');
	assert.strictEqual(out[0].length, 1);
	assert.deepStrictEqual(out[0][0].json, page);

	// Array data: one item per element.
	ctx = makeCtx(
		{ operation: 'custom_scrape', customEndpoint: '/zillow-search/', customParams: '{"cursor":"c1"}' },
		{ statusCode: 200, headers: {}, body: { success: true, data: [{ a: 1 }, { a: 2 }] } },
	);
	out = await node.execute.call(ctx);
	assert.strictEqual(ctx.calls[0].url, 'https://proxy.scrapier.io/api/v2/zillow-search/');
	assert.strictEqual(ctx.calls[0].body.cursor, 'c1');
	assert.strictEqual(out[0].length, 2);

	// Custom Scrape: the picker is used when the typed slug is empty; typed wins.
	ctx = makeCtx(
		{ operation: 'custom_scrape', customEndpoint: '', customEndpointPicker: 'zillow-search', customParams: '{}' },
		{ statusCode: 200, headers: {}, body: { success: true, data: { ok: true } } },
	);
	await node.execute.call(ctx);
	assert.strictEqual(ctx.calls[0].url, 'https://proxy.scrapier.io/api/v2/zillow-search/');
	ctx = makeCtx(
		{ operation: 'custom_scrape', customEndpoint: 'reddit-posts', customEndpointPicker: 'zillow-search', customParams: '{}' },
		{ statusCode: 200, headers: {}, body: { success: true, data: { ok: true } } },
	);
	await node.execute.call(ctx);
	assert.strictEqual(ctx.calls[0].url, 'https://proxy.scrapier.io/api/v2/reddit-posts/');
	ctx = makeCtx(
		{ operation: 'custom_scrape', customEndpoint: '', customEndpointPicker: '', customParams: '{}' },
		{ statusCode: 200, headers: {}, body: { success: true, data: {} } },
	);
	await assert.rejects(node.execute.call(ctx), /Endpoint Slug is empty/);
	assert.strictEqual(ctx.calls.length, 0, 'no request without a slug');

	// Catalog dropdown: fails soft when the catalog is unreachable...
	const getOptions = node.methods.loadOptions.getCatalogEndpoints;
	let opts = await getOptions.call({ helpers: { httpRequest: async () => { throw new Error('network'); } } });
	assert.strictEqual(opts.length, 1, 'only the type-it-yourself hint when the catalog is down');
	assert.strictEqual(opts[0].value, '');
	// ...lists enabled endpoints from the public catalog (no API key), and caches.
	const catalogBody = { endpoints: [
		{ platform: 'zillow', apis: [
			{ endpoint: '/zillow-search/', name: 'Zillow Search', cost_credit: 2 },
			{ endpoint: '/zillow-old/', name: 'Old', cost_credit: 1, disabled: true },
		] },
		{ platform: 'airbnb', apis: [{ endpoint: '/airbnb-listings/', name: 'Airbnb Listing Search', cost_credit: 1 }] },
	] };
	let optCalls = 0;
	opts = await getOptions.call({ helpers: { httpRequest: async (o) => {
		optCalls++;
		assert.strictEqual(o.url, 'https://proxy.scrapier.io/api/v2/endpoints');
		assert.ok(!o.headers, 'public catalog needs no key');
		return catalogBody;
	} } });
	assert.deepStrictEqual(opts.map((o) => o.value), ['', 'airbnb-listings', 'zillow-search']);
	assert.ok(/2 credits per successful call/.test(opts[2].description));
	opts = await getOptions.call({ helpers: { httpRequest: async () => { optCalls++; throw new Error('network'); } } });
	assert.strictEqual(optCalls, 1, 'second open is served from the cache');
	assert.strictEqual(opts.length, 3, 'cached list survives a later outage');

	// Default parameters: a number field whose catalog default is null must be
	// unset ('' in the UI) and must NOT be sent. Otherwise e.g. Amazon Product
	// would send price_min:0 / price_max:0 and quietly filter everything out.
	const nullNumberFields = [];
	for (const op of generated) {
		const defaults = {};
		const numberFieldsWithoutDefault = new Set();
		for (const f of op.fields) {
			const prop = fieldsOf(op.key).find((p) => p.name === f.name);
			assert.ok(prop, `${op.key}.${f.name} is exposed`);
			defaults[f.name] = prop.default;
			if (f.type === 'number' && (f.default === null || f.default === undefined)) {
				numberFieldsWithoutDefault.add(f.name);
				nullNumberFields.push(`${op.key}.${f.name}`);
				assert.strictEqual(prop.default, '', `${op.key}.${f.name} has no catalog default, so the UI default is empty`);
			}
		}
		const c = makeCtx(
			{ ...defaults, operation: op.key },
			{ statusCode: 200, headers: {}, body: { success: true, data: {} } },
		);
		await node.execute.call(c);
		for (const name of numberFieldsWithoutDefault) {
			assert.ok(!(name in c.calls[0].body), `${op.key}: ${name} (no catalog default) is not sent with default parameters`);
		}
		// Numeric fields that DO have a catalog default keep sending it.
		for (const f of op.fields) {
			if (f.type === 'number' && typeof f.default === 'number') {
				assert.strictEqual(c.calls[0].body[f.name], f.default, `${op.key}.${f.name} sends its catalog default`);
			}
		}
	}
	assert.ok(nullNumberFields.length > 0, 'at least one number field without a default is covered (amazon_product price_min/price_max)');
	// An explicit 0 is still a value the user chose, and is sent.
	ctx = makeCtx(
		{ operation: 'amazon_product', price_min: 0 },
		{ statusCode: 200, headers: {}, body: { success: true, data: {} } },
	);
	await node.execute.call(ctx);
	assert.strictEqual(ctx.calls[0].body.price_min, 0, 'an explicit 0 is sent');

	// Failure: throws with the API's error message.
	const failBody = { success: false, error: 'Invalid cursor' };
	ctx = makeCtx(
		{ operation: 'google_search', queries: 'pizza' },
		{ statusCode: 400, headers: {}, body: failBody },
	);
	await assert.rejects(node.execute.call(ctx), /Invalid cursor/);

	// success:false on a 200 is still a failure.
	ctx = makeCtx(
		{ operation: 'google_search', queries: 'pizza' },
		{ statusCode: 200, headers: {}, body: failBody },
	);
	await assert.rejects(node.execute.call(ctx), /Invalid cursor/);

	// continueOnFail: error becomes an item.
	ctx = makeCtx(
		{ operation: 'google_search', queries: 'pizza' },
		{ statusCode: 402, headers: {}, body: { success: false, error: 'Insufficient credits' } },
		{ continueOnFail: true },
	);
	out = await node.execute.call(ctx);
	assert.deepStrictEqual(out[0][0].json, { error: 'Insufficient credits' });

	console.log(`OK — ${opProp.options.length} operations, credential, node structure and v2 runtime verified.`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
