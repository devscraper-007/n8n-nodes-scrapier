import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IN8nHttpFullResponse,
	JsonObject,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import catalog from './catalog.json';

const BASE_URL = 'https://proxy.scrapier.io/api/v2';

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
		description: 'Call any Scrapier endpoint by its slug',
		action: 'Custom scrape any endpoint',
	},
];

const fieldProperties: INodeProperties[] = operations.flatMap((op) =>
	op.fields.map((field): INodeProperties => {
		let type: INodeProperties['type'] = 'string';
		let defaultValue: string | number | boolean = field.default ?? '';
		if (field.type === 'number') {
			type = 'number';
			defaultValue = typeof field.default === 'number' ? field.default : 0;
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

const customProperties: INodeProperties[] = [
	{
		displayName: 'Endpoint Slug',
		name: 'customEndpoint',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. zillow-search',
		description:
			'Any endpoint from the catalog at https://proxy.scrapier.io/api/v2/endpoints',
		displayOptions: { show: { operation: ['custom_scrape'] } },
	},
	{
		displayName: 'Parameters (JSON)',
		name: 'customParams',
		type: 'json',
		default: '{}',
		required: true,
		description:
			"The endpoint's input parameters as a JSON object. To fetch the next page, include \"cursor\" set to the previous response's next_cursor.",
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
			'Scrape Google, Amazon, Instagram, TikTok, LinkedIn and 20+ more platforms as structured data',
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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;

				let slug: string;
				const body: IDataObject = {};

				if (operation === 'custom_scrape') {
					slug = String(this.getNodeParameter('customEndpoint', i))
						.trim()
						.replace(/^\/+|\/+$/g, '');
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
