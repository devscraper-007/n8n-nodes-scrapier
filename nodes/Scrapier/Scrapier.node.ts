import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import catalog from './catalog.json';

const BASE_URL = 'https://proxy.scrapier.io/api/v1';

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
			'Any endpoint from the catalog at https://proxy.scrapier.io/api/v1/endpoints',
		displayOptions: { show: { operation: ['custom_scrape'] } },
	},
	{
		displayName: 'Parameters (JSON)',
		name: 'customParams',
		type: 'json',
		default: '{}',
		required: true,
		description: "The endpoint's input parameters as a JSON object",
		displayOptions: { show: { operation: ['custom_scrape'] } },
	},
];

const commonProperties: INodeProperties[] = [
	{
		displayName: 'Webhook URL',
		name: 'webhookUrl',
		type: 'string',
		default: '',
		description:
			'Optional. For async scrapes, Scrapier POSTs the finished job result to this URL (e.g. an n8n Webhook node URL) instead of you polling.',
	},
	{
		displayName: 'Split Rows Into Items',
		name: 'splitRows',
		type: 'boolean',
		default: true,
		description:
			'Whether to output one n8n item per scraped row. When disabled, the raw API response is returned as a single item.',
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
			...commonProperties,
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

				const webhookUrl = this.getNodeParameter('webhookUrl', i, '') as string;
				if (webhookUrl) body.webhook_url = webhookUrl;

				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'scrapierApi',
					{
						method: 'POST',
						url: `${BASE_URL}/${slug}/`,
						body,
						json: true,
					},
				)) as IDataObject;

				const splitRows = this.getNodeParameter('splitRows', i, true) as boolean;
				const rows = response?.data;
				if (splitRows && Array.isArray(rows)) {
					for (const row of rows) {
						returnData.push({
							json: row as IDataObject,
							pairedItem: { item: i },
						});
					}
				} else {
					returnData.push({ json: response, pairedItem: { item: i } });
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
