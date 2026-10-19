import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	JsonObject,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import catalog from './catalog.json';

const BASE_URL = 'https://proxy.scrapier.io/api/v2';
const CATALOG_URL = `${BASE_URL}/endpoints`;
const CATALOG_TTL_MS = 10 * 60 * 1000;
// After a failed fetch, do not retry for a minute (each open of the dropdown would
// otherwise wait out the timeout again); the last good list is served meanwhile.
const CATALOG_RETRY_AFTER_FAILURE_MS = 60 * 1000;
const CATALOG_TIMEOUT_MS = 5000;
// Endpoint slugs are lowercase words joined by - or _. Anything else (path
// separators, query/fragment characters, '..', whitespace) must never be
// interpolated into the request URL.
const SLUG_PATTERN = /^[a-z0-9_-]+$/;

/** Normalise and validate a typed or picked slug; throws a message safe to show. */
function normaliseSlug(input: string): string {
	const slug = input.trim().replace(/^\/+|\/+$/g, '');
	if (!slug) return '';
	if (!SLUG_PATTERN.test(slug)) {
		throw new Error(
			`Invalid endpoint slug "${slug.slice(0, 60)}": use only lowercase letters, digits, "-" and "_" (no "/", "..", "?", "#" or spaces), e.g. zillow-search. The slug list is at https://proxy.scrapier.io/api/v2/endpoints`,
		);
	}
	return slug;
}

interface CatalogField {
	name: string;
	label: string;
	type: string;
	required: boolean;
	description: string;
	default: string | number | boolean | null;
}

interface CatalogOperation {
	key: string;
	slug: string;
	label: string;
	description: string;
	fields: CatalogField[];
}

const operations = catalog as CatalogOperation[];

const operationOptions: INodePropertyOptions[] = [
	...operations.map((op) => ({
		name: op.label,
		value: op.key,
		description: op.description,
		action: op.label,
	})),
	{
		name: 'Custom Scrape (Any Endpoint)',
		value: 'custom_scrape',
		description:
			'Call any current or future Scrapier endpoint by its slug (catalog: GET /api/v2/endpoints)',
		action: 'Custom scrape any endpoint',
	},
];

const fieldProperties: INodeProperties[] = operations.flatMap((op) =>
	op.fields.map((field): INodeProperties => {
		let type: INodeProperties['type'] = 'string';
		let defaultValue: string | number | boolean = field.default ?? '';
		if (field.type === 'number') {
			type = 'number';
			// No catalog default -> leave the field empty. execute() skips empty values, so
			// the parameter is not sent at all (a 0 here would be sent as price_min: 0).
			defaultValue = typeof field.default === 'number' ? field.default : '';
		} else if (field.type === 'boolean') {
			type = 'boolean';
			defaultValue = field.default === true;
		}
		return {
			displayName: field.label,
			name: field.name,
			type,
			default: defaultValue,
			required: field.required || undefined,
			description: field.description || undefined,
			displayOptions: { show: { operation: [op.key] } },
		};
	}),
);

// The public catalog is the source of truth for which endpoints exist. Fetched
// lazily for the "Pick From Catalog" dropdown, cached briefly, and never
// required: if it cannot be loaded the user just types the slug.
interface CatalogEndpoint {
	endpoint?: string;
	name?: string;
	cost_credit?: number;
	disabled?: boolean;
}
let catalogCache: { at: number; options: INodePropertyOptions[] } | undefined;
let catalogFailedAt: number | undefined;

function catalogToOptions(payload: unknown): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [];
	const platforms = (payload as { endpoints?: unknown })?.endpoints;
	if (!Array.isArray(platforms)) return options;
	for (const platform of platforms as Array<{ platform?: string; apis?: CatalogEndpoint[] }>) {
		for (const api of platform?.apis ?? []) {
			const slug = String(api?.endpoint ?? '').replace(/^\/+|\/+$/g, '');
			if (!slug || api.disabled || !SLUG_PATTERN.test(slug)) continue;
			const credits = typeof api.cost_credit === 'number' ? api.cost_credit : undefined;
			options.push({
				name: `${platform.platform ?? ''}: ${api.name || slug}`,
				value: slug,
				description:
					credits === undefined
						? slug
						: `${slug} (${credits} credit${credits === 1 ? '' : 's'} per successful call)`,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

const customProperties: INodeProperties[] = [
	{
		displayName: 'Pick From Catalog',
		name: 'customEndpointPicker',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getCatalogEndpoints' },
		default: '',
		description:
			'Every current endpoint, loaded live from the public catalog (GET https://proxy.scrapier.io/api/v2/endpoints). Used when Endpoint Slug below is empty. If the list does not load, type the slug instead.',
		displayOptions: { show: { operation: ['custom_scrape'] } },
	},
	{
		displayName: 'Endpoint Slug',
		name: 'customEndpoint',
		type: 'string',
		default: '',
		placeholder: 'e.g. zillow-search',
		description:
			'Any endpoint slug, including endpoints added after this node was released. The full list with prices and parameters is at https://proxy.scrapier.io/api/v2/endpoints. Overrides Pick From Catalog when set.',
		displayOptions: { show: { operation: ['custom_scrape'] } },
	},
	{
		displayName: 'Parameters (JSON)',
		name: 'customParams',
		type: 'json',
		default: '{}',
		required: true,
		description:
			"The endpoint's input parameters as a JSON object (see the endpoint's input schema in the catalog). To fetch the next page, include \"cursor\" set to the previous response's next_cursor.",
		displayOptions: { show: { operation: ['custom_scrape'] } },
	},
];

export class Scrapier implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Scrapier',
		name: 'scrapier',
		icon: 'file:scrapier.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Scrape Google, Amazon, Instagram, TikTok, LinkedIn and many more platforms as structured data',
		defaults: { name: 'Scrapier' },
		inputs: ['main' as NodeConnectionType],
		outputs: ['main' as NodeConnectionType],
		credentials: [{ name: 'scrapierApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: operationOptions,
				default: operations[0]?.key ?? 'custom_scrape',
			},
			...fieldProperties,
			...customProperties,
		],
	};

	methods = {
		loadOptions: {
			async getCatalogEndpoints(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const empty: INodePropertyOptions = {
					name: '- Type the slug in Endpoint Slug -',
					value: '',
				};
				const now = Date.now();
				if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
					return [empty, ...catalogCache.options];
				}
				// On a failure, prefer the last good (stale) list over nothing.
				const fallback = (): INodePropertyOptions[] =>
					catalogCache
						? [empty, ...catalogCache.options]
						: [{ ...empty, name: '- Catalog unavailable: type the slug in Endpoint Slug -' }];
				if (catalogFailedAt !== undefined && now - catalogFailedAt < CATALOG_RETRY_AFTER_FAILURE_MS) {
					return fallback();
				}
				try {
					const payload = await this.helpers.httpRequest({
						method: 'GET',
						url: CATALOG_URL,
						json: true,
						timeout: CATALOG_TIMEOUT_MS,
					});
					const options = catalogToOptions(payload);
					if (options.length === 0) {
						catalogFailedAt = Date.now();
						return fallback();
					}
					catalogCache = { at: Date.now(), options };
					catalogFailedAt = undefined;
					return [empty, ...options];
				} catch {
					// Fail soft: the dropdown is a convenience, free text always works.
					catalogFailedAt = Date.now();
					return fallback();
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;

				let slug: string;
				const body: IDataObject = {};

				if (operation === 'custom_scrape') {
					const typed = String(this.getNodeParameter('customEndpoint', i, '') ?? '');
					const picked = String(this.getNodeParameter('customEndpointPicker', i, '') ?? '');
					try {
						slug = normaliseSlug(typed) || normaliseSlug(picked);
					} catch (e) {
						throw new NodeOperationError(this.getNode(), (e as Error).message, { itemIndex: i });
					}
					if (!slug) {
						throw new NodeOperationError(
							this.getNode(),
							'Endpoint Slug is empty. Type a slug (e.g. zillow-search) or pick one from the catalog: https://proxy.scrapier.io/api/v2/endpoints',
							{ itemIndex: i },
						);
					}
					const raw = this.getNodeParameter('customParams', i);
					const params = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
					if (params && typeof params === 'object') {
						Object.assign(body, params as IDataObject);
					}
				} else {
					const op = operations.find((o) => o.key === operation);
					if (!op) {
						throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
							itemIndex: i,
						});
					}
					slug = op.slug;
					for (const field of op.fields) {
						const value = this.getNodeParameter(field.name, i);
						if (value === '' || value === undefined || value === null) continue;
						body[field.name] = value as string | number | boolean;
					}
				}

				// v2 scrapes are synchronous: one call returns one page of results.
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'scrapierApi',
					{
						method: 'POST',
						url: `${BASE_URL}/${slug}/`,
						body,
						json: true,
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
					},
				)) as IN8nHttpFullResponse;

				const statusCode = response.statusCode;
				const payload = (
					response.body && typeof response.body === 'object' ? response.body : {}
				) as IDataObject;

				if (statusCode < 200 || statusCode >= 300 || payload.success !== true) {
					const message =
						typeof payload.error === 'string' && payload.error
							? payload.error
							: `Scrapier request failed (HTTP ${statusCode})`;
					throw new NodeApiError(this.getNode(), payload as JsonObject, {
						message,
						httpCode: String(statusCode),
						itemIndex: i,
					});
				}

				// `data` is the page object (results under an endpoint-specific key,
				// plus `next_cursor`). Emit it as one item so `next_cursor` can drive a
				// pagination loop; an array `data` becomes one item per element.
				const data = payload.data;
				if (Array.isArray(data)) {
					for (const row of data) {
						returnData.push({
							json: (row && typeof row === 'object' ? row : { value: row }) as IDataObject,
							pairedItem: { item: i },
						});
					}
				} else {
					returnData.push({
						json: (data && typeof data === 'object' ? data : { data }) as IDataObject,
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
