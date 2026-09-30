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
assert.ok(opProp.options.length >= 11, `expected 11+ operations, got ${opProp.options.length}`);
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

const cursor = node.description.properties.find(
	(p) => p.name === 'cursor' && p.displayOptions.show.operation.includes('google_search'),
);
assert.ok(cursor, 'google_search exposes a pagination cursor');

const queries = node.description.properties.find(
	(p) => p.name === 'queries' && p.displayOptions.show.operation.includes('google_search'),
);
assert.ok(queries, 'google_search has a queries field');
assert.strictEqual(queries.required, true);

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
