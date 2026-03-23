export async function normalizeRequestInit(
	requestInput: Request | string | URL,
	requestInit: RequestInit | undefined,
): Promise<RequestInit | undefined> {
	if (requestInit) return requestInit;
	if (!(requestInput instanceof Request)) return requestInit;

	const method = requestInput.method || "GET";
	const normalized: RequestInit = {
		method,
		headers: new Headers(requestInput.headers),
	};

	if (method !== "GET" && method !== "HEAD") {
		try {
			const bodyText = await requestInput.clone().text();
			if (bodyText) {
				normalized.body = bodyText;
			}
		} catch {
			// Body may be unreadable; proceed without it.
		}
	}

	return normalized;
}

export async function parseRequestBodyFromInit(
	body: unknown,
	logWarn: (message: string) => void,
): Promise<Record<string, unknown>> {
	if (!body) return {};

	try {
		if (typeof body === "string") {
			return JSON.parse(body) as Record<string, unknown>;
		}

		if (body instanceof Uint8Array) {
			return JSON.parse(new TextDecoder().decode(body)) as Record<
				string,
				unknown
			>;
		}

		if (body instanceof ArrayBuffer) {
			return JSON.parse(
				new TextDecoder().decode(new Uint8Array(body)),
			) as Record<string, unknown>;
		}

		if (ArrayBuffer.isView(body)) {
			const view = new Uint8Array(
				body.buffer,
				body.byteOffset,
				body.byteLength,
			);
			return JSON.parse(new TextDecoder().decode(view)) as Record<
				string,
				unknown
			>;
		}

		if (typeof Blob !== "undefined" && body instanceof Blob) {
			return JSON.parse(await body.text()) as Record<string, unknown>;
		}
	} catch {
		logWarn("Failed to parse request body, using empty object");
	}

	return {};
}
