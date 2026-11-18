import { fetch as undiciFetch } from "undici";
import {
	applyProxyCompatibleInit,
	extractRequestUrl,
	type ProxyCompatibleRequestInit,
} from "./url-rewriting.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

// Transport selection contract, in precedence order:
//   1. An implementation registered via setProxyFetchImpl (embedding contract;
//    works regardless of when the host installs it).
//   2. A global fetch replaced after this module loaded, or a test double.
//   3. A global fetch installed before module load — honored when it is
//    distinguishable from the platform fetch (Node's built-in is named
//    "fetch"); hosts needing guaranteed interception use setProxyFetchImpl.
//   4. The package's Undici fetch, but only when the request carries a proxy
//    dispatcher: Node 22's built-in fetch rejects the Undici 8 handler
//    contract, so a proxied call needs the matching implementation.
//   5. The ambient global fetch for ordinary direct requests.
const initialGlobalFetch = globalThis.fetch;
let overrideFetch: typeof globalThis.fetch | null = null;

export function setProxyFetchImpl(
	impl: typeof globalThis.fetch | null,
): void {
	overrideFetch = impl;
}

function isTestDouble(fetchImpl: typeof globalThis.fetch): boolean {
	const candidate = fetchImpl as typeof fetchImpl & {
		_isMockFunction?: boolean;
		mock?: unknown;
	};
	return candidate._isMockFunction === true || candidate.mock !== undefined;
}

function isPlatformFetch(fetchImpl: typeof globalThis.fetch): boolean {
	return fetchImpl.name === "fetch" && !isTestDouble(fetchImpl);
}

export function fetchWithProxy(
	input: FetchInput,
	init?: FetchInit,
): ReturnType<typeof globalThis.fetch> {
	const url = extractRequestUrl(input as Request | string | URL);
	const proxiedInit = applyProxyCompatibleInit(
		url,
		init as ProxyCompatibleRequestInit | undefined,
	);
	const currentGlobalFetch = globalThis.fetch;
	const baseFetch =
		overrideFetch ??
		(currentGlobalFetch !== initialGlobalFetch || !isPlatformFetch(currentGlobalFetch)
			? currentGlobalFetch
			: proxiedInit.dispatcher
				? undiciFetch
				: currentGlobalFetch);

	return (baseFetch as typeof globalThis.fetch)(input, proxiedInit as RequestInit);
}
