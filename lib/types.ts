import type { Auth, Provider, Model } from "@codex-ai/sdk";

export type {
	PluginConfigFromSchema as PluginConfig,
	AccountIdSourceFromSchema as AccountIdSource,
	TokenSuccessFromSchema as TokenSuccess,
	TokenFailureFromSchema as TokenFailure,
	TokenResultFromSchema as TokenResult,
	TokenFailureReasonFromSchema as TokenFailureReason,
} from "./schemas.js";

export interface UserConfig {
	global: ConfigOptions;
	models: {
		[modelName: string]: {
			options?: ConfigOptions;
			variants?: Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>;
			[key: string]: unknown;
		};
	};
}

export interface ConfigOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	promptCacheRetention?: PromptCacheRetention;
	include?: string[];
}

export type PromptCacheRetention =
	| "5m"
	| "1h"
	| "24h"
	| "7d"
	| (string & {});

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed";
}

export interface ToolParametersSchema {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
}

export interface ToolFunction {
	name: string;
	description?: string;
	parameters?: ToolParametersSchema;
	[key: string]: unknown;
}

export interface FunctionToolDefinition {
	type: "function";
	function: ToolFunction;
	defer_loading?: boolean;
	[key: string]: unknown;
}

export interface ToolSearchToolDefinition {
	type: "tool_search";
	max_num_results?: number;
	search_context_size?: "low" | "medium" | "high";
	filters?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface RemoteMcpToolDefinition {
	type: "mcp";
	server_label?: string;
	server_url?: string;
	connector_id?: string;
	headers?: Record<string, string>;
	allowed_tools?: string[];
	require_approval?: "never" | "always" | "auto" | Record<string, unknown>;
	defer_loading?: boolean;
	[key: string]: unknown;
}

export interface ComputerUseToolDefinition {
	type: "computer" | "computer_use_preview";
	display_width?: number;
	display_height?: number;
	environment?: string;
	[key: string]: unknown;
}

export interface ToolNamespaceDefinition {
	type: "namespace";
	name?: string;
	description?: string;
	tools?: RequestToolDefinition[];
	[key: string]: unknown;
}

export type RequestToolDefinition =
	| FunctionToolDefinition
	| ToolSearchToolDefinition
	| RemoteMcpToolDefinition
	| ComputerUseToolDefinition
	| ToolNamespaceDefinition
	| {
			type?: string;
			[key: string]: unknown;
	  };

export type TextFormatConfig =
	| {
			type: "text";
			[key: string]: unknown;
	  }
	| {
			type: "json_object";
			[key: string]: unknown;
	  }
	| {
			type: "json_schema";
			name?: string;
			description?: string;
			schema?: Record<string, unknown>;
			strict?: boolean;
			[key: string]: unknown;
	  }
	| {
			type: string;
			[key: string]: unknown;
	  };

export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

export interface PKCEPair {
	challenge: string;
	verifier: string;
}

export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

export interface ParsedAuthInput {
	code?: string;
	state?: string;
}

/**
 * JWT payload with ChatGPT account info
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		email?: string;
		chatgpt_user_email?: string;
	};
	organizations?: unknown;
	orgs?: unknown;
	accounts?: unknown;
	workspaces?: unknown;
	teams?: unknown;
	email?: string;
	preferred_username?: string;
	[key: string]: unknown;
}


/**
 * Message input item
 */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Request body structure
 */
export interface RequestBody {
	model: string;
	background?: boolean;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: RequestToolDefinition[];
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
		format?: TextFormatConfig;
	};
	include?: string[];
	providerOptions?: {
		openai?: Partial<ConfigOptions> & { store?: boolean; include?: string[] };
		[key: string]: unknown;
	};
	/** Stable key to enable prompt-token caching on Codex backend */
	prompt_cache_key?: string;
	/** Retention mode for server-side prompt cache entries */
	prompt_cache_retention?: PromptCacheRetention;
	/** Resume a prior Responses API turn without resending the full transcript */
	previous_response_id?: string;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

/**
 * SSE event data structure
 */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/**
 * Cache metadata for Codex instructions
 */
export interface CacheMetadata {
        etag: string | null;
        tag: string;
        lastChecked: number;
        url: string;
}

/**
 * GitHub release data
 */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

// Re-export SDK types for convenience
export type { Auth, Provider, Model };

export type OAuthAuthDetails = Extract<Auth, { type: "oauth" }>;

