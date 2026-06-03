import { DEFAULT_MODEL } from "./request/helpers/model-map.js";

export type IntegrationSnippetKind = "opencode" | "openclaw" | "python" | "curl" | "env";

export interface IntegrationSnippetInput {
	baseUrl?: string;
	model?: string;
	envVar?: string;
}

export interface IntegrationSnippet {
	kind: IntegrationSnippetKind;
	title: string;
	body: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:1456/v1";
const DEFAULT_ENV_VAR = "CODEX_MULTI_AUTH_LOCAL_KEY";

function normalizeInput(input: IntegrationSnippetInput = {}): Required<IntegrationSnippetInput> {
	return {
		baseUrl: input.baseUrl?.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL,
		model: input.model?.trim() || DEFAULT_MODEL,
		envVar: input.envVar?.trim() || DEFAULT_ENV_VAR,
	};
}

export function generateIntegrationSnippet(
	kind: IntegrationSnippetKind,
	input: IntegrationSnippetInput = {},
): IntegrationSnippet {
	const options = normalizeInput(input);
	if (kind === "env") {
		return {
			kind,
			title: "Environment",
			body: `${options.envVar}=cma_local_replace_me\nOPENAI_BASE_URL=${options.baseUrl}\nOPENAI_API_KEY=$${options.envVar}\n`,
		};
	}
	if (kind === "curl") {
		return {
			kind,
			title: "curl",
			body: [
				`curl ${options.baseUrl}/responses \\`,
				`  -H "Authorization: Bearer $${options.envVar}" \\`,
				'  -H "Content-Type: application/json" \\',
				`  -d '{"model":"${options.model}","input":"Say hello from the local bridge."}'`,
				"",
			].join("\n"),
		};
	}
	if (kind === "python") {
		return {
			kind,
			title: "Python",
			body: [
				"import os",
				"from openai import OpenAI",
				"",
				"client = OpenAI(",
				`    api_key=os.environ["${options.envVar}"],`,
				`    base_url="${options.baseUrl}",`,
				")",
				"",
				"response = client.responses.create(",
				`    model="${options.model}",`,
				'    input="Say hello from the local bridge.",',
				")",
				"print(response.output_text)",
				"",
			].join("\n"),
		};
	}
	if (kind === "opencode") {
		return {
			kind,
			title: "OpenCode",
			body: JSON.stringify(
				{
					provider: {
						openai: {
							options: {
								apiKey: `$${options.envVar}`,
								baseURL: options.baseUrl,
							},
							models: {
								[options.model]: {
									name: `${options.model} via codex-multi-auth`,
								},
							},
						},
					},
				},
				null,
				2,
			),
		};
	}
	return {
		kind,
		title: "OpenClaw",
		body: JSON.stringify(
			{
				providers: {
					openai: {
						apiKey: `$${options.envVar}`,
						baseURL: options.baseUrl,
						defaultModel: options.model,
					},
				},
			},
			null,
			2,
		),
	};
}

export function generateIntegrationSnippets(
	kinds: IntegrationSnippetKind[] = ["opencode", "openclaw", "python", "curl", "env"],
	input: IntegrationSnippetInput = {},
): IntegrationSnippet[] {
	return kinds.map((kind) => generateIntegrationSnippet(kind, input));
}
