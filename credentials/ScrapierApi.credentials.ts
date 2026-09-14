import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ScrapierApi implements ICredentialType {
	name = 'scrapierApi';

	displayName = 'Scrapier API';

	documentationUrl = 'https://proxy.scrapier.io/api/v1/endpoints';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your Scrapier API key (starts with sk_live_). Find it in the Scrapier dashboard under API Keys.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://proxy.scrapier.io/api/v1',
			url: '/me',
		},
	};
}
