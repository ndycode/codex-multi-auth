import { z } from "zod";
import type { ApiRouteCredential } from "../api-route-store.js";
import { apiBaseUrl } from "../api-region.js";
import {
	parseModelRoute,
	resolveModelRoute,
	type RouteCatalog,
} from "../model-route-policy.js";
import { ClientCancellationError } from "../request/client-cancellation.js";
import { apiRetryDelayMs } from "../request/api-retry-delay.js";
import { isRecord } from "../utils.js";
import { extractUsageTokenCounts } from "../usage/usage-extraction.js";
import type { UsageTokenCounts } from "../usage/types.js";
import { ApiRateBackoff } from "./api-rate-backoff.js";

const instructions = z.union([
	z.string(),
	z.array(z.record(z.string(), z.unknown())).min(1),
]);
const common = { name: z.string().optional(), instructions };
const question = z.discriminatedUnion("type", [
	z.object({ ...common, type: z.literal("predicate") }),
	z.object({
		...common,
		type: z.literal("choice"),
		choices: z
			.array(
				z.object({
					value: z.union([z.string(), z.boolean()]),
					description: z.string().optional(),
				}),
			)
			.min(2)
			.max(2000),
	}),
	z.object({
		...common,
		type: z.literal("score"),
		levels: z
			.array(
				z.object({ label: z.string(), description: z.string().optional() }),
			)
			.min(2)
			.max(10),
	}),
]);
const requestSchema = z
	.object({
		model: z.string().min(1),
		input: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
		questions: z.array(question).min(1).max(400),
		prompt_cache_key: z.string().max(64).nullable().optional(),
		prompt_cache_options: z
			.record(z.string(), z.unknown())
			.nullable()
			.optional(),
		safety_identifier: z.string().max(128).nullable().optional(),
	})
	.strict();
export type DecisionsRequest = z.infer<typeof requestSchema>;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Decisions request aborted"));
		if (signal.aborted) {
			void promise.catch(() => undefined);
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
async function readBody(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > 8 * 1024 * 1024) throw Error("Decision response too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function failure(status: number, code: string): Response {
	return Response.json(
		{
			error: {
				code,
				message: "Decisions request could not be served by the selected route.",
			},
		},
		{ status },
	);
}

/** Endpoint-specific routing. ID discovery never grants Decisions capability. */
export class DecisionsRuntime {
	private readonly usage = new WeakMap<Response, UsageTokenCounts>();
	usageFor(response: Response): UsageTokenCounts | null {
		return this.usage.get(response) ?? null;
	}
	private readonly backoff: ApiRateBackoff;
	private readonly unsupported = new Map<string, number>();
	constructor(
		private readonly fetchImpl: typeof fetch,
		private readonly catalogs: (
			routes: ApiRouteCredential[],
		) => Promise<RouteCatalog[]>,
		private readonly now = Date.now,
		private readonly timeoutMs = 60_000,
	) {
		this.backoff = new ApiRateBackoff(now);
	}
	async request(
		body: unknown,
		routes: ApiRouteCredential[],
		signal?: AbortSignal,
		onAttempt?: (index: number) => void,
	): Promise<Response> {
		const parsed = requestSchema.safeParse(body);
		if (!parsed.success) return failure(400, "invalid_decisions_request");
		let selection;
		try {
			selection = parseModelRoute(parsed.data.model);
		} catch {
			return failure(400, "invalid_model_route");
		}
		if (!["api", "zdr"].includes(selection.kind) || selection.serviceTier)
			return failure(400, "explicit_decisions_api_route_required");
		if (signal?.aborted) throw new ClientCancellationError();
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, this.timeoutMs);
		const deadline = this.now() + this.timeoutMs;
		try {
			const eligible = routes.filter(
				(r) => r.enabled && r.kind === selection.kind,
			);
			const catalogs = await abortable(
				this.catalogs(eligible),
				controller.signal,
			);
			const resolved = resolveModelRoute(
				parsed.data.model,
				catalogs.map((c) => ({
					...c,
					models: c.models.filter(
						(m) =>
							Array.isArray(m.supported_endpoints) &&
							m.supported_endpoints.includes("/v1/decisions"),
					),
				})),
			);
			let region: string | undefined;
			let last = failure(503, "decisions_endpoint_unavailable");
			for (const candidate of resolved.candidates) {
				const credential = eligible.find((r) => r.id === candidate.id);
				if (!credential) continue;
				const key = this.backoff.key(
					credential,
					`decisions:${resolved.upstreamModel}`,
				);
				if ((this.unsupported.get(key) ?? 0) > this.now()) continue;
				if (region !== undefined && region !== (credential.region ?? "global"))
					continue;
				region ??= credential.region ?? "global";
				for (let tries = 0; tries < 3; tries++) {
					if (controller.signal.aborted) throw Error("deadline");
					const admission = this.backoff.acquire(key);
					if (admission.waitMs) {
						if (admission.waitMs >= deadline - this.now())
							return last.status === 429
								? last
								: failure(429, "rate_limit_exceeded");
						await new Promise<void>((resolve, reject) => {
							const cancel = () => {
								clearTimeout(wait);
								reject(Error("cancelled"));
							};
							const wait = setTimeout(() => {
								controller.signal.removeEventListener("abort", cancel);
								resolve();
							}, admission.waitMs);
							controller.signal.addEventListener("abort", cancel, {
								once: true,
							});
						});
						continue;
					}
					let success = false;
					try {
						onAttempt?.(routes.indexOf(credential));
						const response = await abortable(
							this.fetchImpl(`${apiBaseUrl(credential)}/decisions`, {
								method: "POST",
								headers: {
									authorization: `Bearer ${credential.apiKey}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({
									...(body as DecisionsRequest),
									model: resolved.upstreamModel,
								}),
								redirect: "error",
								signal: controller.signal,
							}),
							controller.signal,
						);
						const text = await readBody(response, controller.signal);
						let data: unknown;
						try {
							data = JSON.parse(text);
						} catch {
							return failure(502, "invalid_decisions_response");
						}
						if (response.ok) {
							if (
								!isRecord(data) ||
								!Array.isArray(data.answers) ||
								!isRecord(data.usage)
							)
								return failure(502, "invalid_decisions_response");
							success = true;
							const result = new Response(text, {
								status: response.status,
								headers: {
									"content-type": "application/json",
									...(response.headers.get("x-request-id")
										? {
												"x-request-id":
													response.headers.get("x-request-id") ?? "",
											}
										: {}),
								},
							});
							const counts = extractUsageTokenCounts(data.usage);
							if (counts) this.usage.set(result, counts);
							return result;
						}
						const source =
							isRecord(data) && isRecord(data.error) ? data.error : {};
						const error: Record<string, string> = {
							code: "decisions_request_rejected",
							message: "Upstream rejected the Decisions request.",
						};
						for (const field of ["code", "type", "param"]) {
							const value = source[field];
							if (
								typeof value === "string" &&
								/^[A-Za-z0-9_.]{1,80}$/.test(value)
							)
								error[field] = value;
						}
						const retryAfter = response.headers.get("retry-after");
						last = Response.json(
							{ error },
							{
								status: response.status,
								headers: retryAfter ? { "retry-after": retryAfter } : {},
							},
						);
						if (
							response.status === 404 ||
							response.status === 405 ||
							response.status === 501
						) {
							if (this.unsupported.size >= 512) {
								const oldest = this.unsupported.keys().next().value;
								if (oldest) this.unsupported.delete(oldest);
							}
							this.unsupported.set(key, this.now() + 300_000);
							break;
						}
						if (
							response.status === 429 &&
							(source.code === "rate_limit_exceeded" ||
								source.type === "rate_limit_exceeded") &&
							![
								"insufficient_quota",
								"billing_hard_limit_reached",
								"billing_not_active",
								"usage_limit_reached",
							].some((code) => source.code === code || source.type === code)
						) {
							this.backoff.penalize(
								key,
								apiRetryDelayMs(data, this.now(), response.headers),
							);
							continue;
						}
						return last; // No replay for ambiguous 5xx or provider validation errors.
					} finally {
						admission.release(success);
					}
				}
			}
			return last;
		} catch {
			if (signal?.aborted) throw new ClientCancellationError();
			return failure(
				controller.signal.aborted ? 504 : 502,
				controller.signal.aborted
					? "decisions_deadline_exceeded"
					: "decisions_transport_failed",
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}
}
