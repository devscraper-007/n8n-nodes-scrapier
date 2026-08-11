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
assert.ok(opProp.options.length >= 12, `expected 12+ operations, got ${opProp.options.length}`);
assert.ok(opProp.options.some((o) => o.value === 'google_search'));
assert.ok(opProp.options.some((o) => o.value === 'custom_scrape'));

const queries = node.description.properties.find(
	(p) => p.name === 'queries' && p.displayOptions.show.operation.includes('google_search'),
);
assert.ok(queries, 'google_search has a queries field');
assert.strictEqual(queries.required, true);

assert.strictEqual(cred.name, 'scrapierApi');
assert.strictEqual(cred.authenticate.properties.headers['X-API-Key'], '={{$credentials.apiKey}}');
assert.ok(cred.test.request.url.endsWith('/me'), 'credential test hits /me');

console.log(`OK — ${opProp.options.length} operations, credential + node structure verified.`);
