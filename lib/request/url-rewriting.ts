/**
 * URL rewriting and proxy resolution helpers for the custom fetch implementation
 * Extracted from fetch-helpers.ts (audit roadmap §4.1.2); fetch-helpers.ts
 * re-exports the public symbols so existing importers are unchanged.
 */

import { ProxyAgent } from "undici";
import { registerCleanup } from "../shutdown.js";
import { CODEX_BASE_URL, URL_PATHS } from "../constants.js";

const CODEX_BASE_URL_OBJECT = new URL(CODEX_BASE_URL);
const CODEX_BASE_PATH_PREFIX = CODEX_BASE_URL_OBJECT.pathname.endsWith("/")
	? CODEX_BASE_URL_OBJECT.pathname.slice(0, -1)
	: CODEX_BASE_URL_OBJECT.pathname;

const DEFAULT_PROXY_PORTS: Record<string, number> = {
	"http:": 80,
	"https:": 443,
};
type ProxyDispatcher = NonNullable<RequestInit["dispatcher"]>;
const sharedProxyDispatchers = new Map<string, ProxyDispatcher>();

type ClosableDispatcher = ProxyDispatcher & {
	close?: () => Promise<void> | void;
};

export interface ProxyCompatibleRequestInit extends RequestInit {
	agent?: unknown;
}

/**
 * Extracts URL string from various request input types
 * @param input - Request input (string, URL, or Request object)
 * @returns URL string
 */
export function extractRequestUrl(input: Request | string | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Rewrites OpenAI API URLs to Codex backend URLs
 * @param url - Original URL
 * @returns Rewritten URL for Codex backend
 */
export function rewriteUrlForCodex(url: string): string {
	const parsedUrl = new URL(url);
	const rewrittenPath = parsedUrl.pathname.includes(URL_PATHS.RESPONSES)
		? parsedUrl.pathname.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES)
		: parsedUrl.pathname;
	const normalizedPath =
		rewrittenPath === CODEX_BASE_PATH_PREFIX ||
		rewrittenPath.startsWith(`${CODEX_BASE_PATH_PREFIX}/`)
			? rewrittenPath
			: `${CODEX_BASE_PATH_PREFIX}${rewrittenPath.startsWith("/") ? rewrittenPath : `/${rewrittenPath}`}`;

	parsedUrl.protocol = CODEX_BASE_URL_OBJECT.protocol;
	parsedUrl.username = "";
	parsedUrl.password = "";
	parsedUrl.host = CODEX_BASE_URL_OBJECT.host;
	parsedUrl.pathname = normalizedPath;

	return parsedUrl.toString();
}

function hasOwnEnvKey(env: NodeJS.ProcessEnv, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(env, key);
}

function resolveProxyEnvValue(
	env: NodeJS.ProcessEnv,
	lowerKey: string,
	upperKey: string,
): string | undefined {
	if (hasOwnEnvKey(env, lowerKey)) {
		const value = env[lowerKey]?.trim();
		return value ? value : undefined;
	}

	const value = env[upperKey]?.trim();
	return value ? value : undefined;
}

function parseNoProxyEntries(noProxyValue: string): Array<{ hostname: string; port: number }> {
	return noProxyValue
		.split(/[,\s]/)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const parsed = entry.match(/^(.+):(\d+)$/);
			const hostname = parsed?.[1] ?? entry;
			const portText = parsed?.[2];
			return {
				hostname: hostname.toLowerCase(),
				port: portText ? Number.parseInt(portText, 10) : 0,
			};
		});
}

function shouldBypassProxyForUrl(url: URL, noProxyValue: string | undefined): boolean {
	if (!noProxyValue) return false;
	if (noProxyValue === "*") return true;

	const hostname = url.host.replace(/:\d*$/, "").toLowerCase();
	const port = Number.parseInt(url.port, 10) || DEFAULT_PROXY_PORTS[url.protocol] || 0;

	for (const entry of parseNoProxyEntries(noProxyValue)) {
		if (entry.hostname === "*") return true;
		if (entry.port && entry.port !== port) continue;

		if (!/^[.*]/.test(entry.hostname)) {
			if (hostname === entry.hostname) {
				return true;
			}
			continue;
		}

		if (hostname.endsWith(entry.hostname.replace(/^\*/, ""))) {
			return true;
		}
	}

	return false;
}

export function resolveProxyUrlForRequest(
	url: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return undefined;
	}

	const httpProxy = resolveProxyEnvValue(env, "http_proxy", "HTTP_PROXY");
	const httpsProxy = resolveProxyEnvValue(env, "https_proxy", "HTTPS_PROXY");
	if (!httpProxy && !httpsProxy) {
		return undefined;
	}

	const noProxy = resolveProxyEnvValue(env, "no_proxy", "NO_PROXY");
	if (shouldBypassProxyForUrl(parsed, noProxy)) {
		return undefined;
	}

	return parsed.protocol === "https:"
		? (httpsProxy ?? httpProxy)
		: httpProxy;
}

function getSharedProxyDispatcher(proxyUrl: string): ProxyDispatcher {
	const existing = sharedProxyDispatchers.get(proxyUrl);
	if (existing) {
		return existing;
	}

	const dispatcher = new ProxyAgent(proxyUrl) as unknown as ProxyDispatcher;
	sharedProxyDispatchers.set(proxyUrl, dispatcher);
	return dispatcher;
}

export async function closeSharedProxyDispatchers(): Promise<void> {
	while (sharedProxyDispatchers.size > 0) {
		const dispatchers = [...sharedProxyDispatchers.values()] as ClosableDispatcher[];
		sharedProxyDispatchers.clear();

		await Promise.allSettled(
			dispatchers.map(async (dispatcher) => {
				if (typeof dispatcher.close === "function") {
					await dispatcher.close();
				}
			}),
		);
	}
}

registerCleanup(closeSharedProxyDispatchers);

export function applyProxyCompatibleInit(
	url: string,
	init?: ProxyCompatibleRequestInit,
	env: NodeJS.ProcessEnv = process.env,
): ProxyCompatibleRequestInit {
	const resolvedInit = init ?? {};
	if (resolvedInit.dispatcher || resolvedInit.agent) {
		return resolvedInit;
	}

	const proxyUrl = resolveProxyUrlForRequest(url, env);
	if (!proxyUrl) {
		return resolvedInit;
	}

	return {
		...resolvedInit,
		dispatcher: getSharedProxyDispatcher(proxyUrl),
	};
}
