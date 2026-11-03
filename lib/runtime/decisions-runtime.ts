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
import { readErrorBody } from "../request/stream-failover-runtime.js";
import { isRecord } from "../utils.js";
import { extractUsageTokenCounts } from "../usage/usage-extraction.js";
import type { UsageTokenCounts } from "../usage/types.js";
import { ApiRateBackoff } from "./api-rate-backoff.js";
import { classifyCapabilityFailure } from "./runtime-capability-failures.js";

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
const PERMANENT_QUOTA_CODES = [
	"insufficient_quota",
	"billing_hard_limit_reached",
	"billing_not_active",
	"usage_limit_reached",
];
/** How one credential's rejection steers the rest of the request. */
type Rejection = "unsupported" | "credential" | "rate_limited" | "final";
// A 404 marks the credential unsupported only when it names the model or the
// endpoint, or names nothing (non-JSON, unknown URL). One caller's missing
// input must not disable the credential for every caller.
function notFoundNamesRoute(error: Record<string, unknown>): boolean {
	if (
		error.param === "model" ||
		classifyCapabilityFailure(404, { error }) === "model"
	)
		return true;
	const absent = (value: unknown) => value === undefined || value === null;
	return (
		absent(error.param) &&
		(absent(error.code) || error.code === "unsupported_endpoint")
	);
}
function classifyRejection(
	status: number,
	error: Record<string, unknown>,
): Rejection {
	const named = (code: string) => error.code === code || error.type === code;
	if (status === 405 || status === 501) return "unsupported";
	if (status === 404)
		return notFoundNamesRoute(error) ? "unsupported" : "final";
	// Authentication and permanent quota reject the key before inference runs,
	// so trying another key cannot replay a decision.
	if (
		status === 401 ||
		status === 403 ||
		(status === 429 && PERMANENT_QUOTA_CODES.some(named))
	)
		return "credential";
	if (status === 429 && named("rate_limit_exceeded")) return "rate_limited";
	return "final";
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
					models: c.models
						.filter(
							(m) =>
								Array.isArray(m.supported_endpoints) &&
								m.supported_endpoints.includes("/v1/decisions"),
						)
						.map((model) => ({
							...model,
							// Responses/tools probes say nothing about Decisions support.
							// Keep credential availability and all other route metadata.
							capability_probe_status: isRecord(model.capability_probe_status)
								? { ...model.capability_probe_status, responses: undefined }
								: model.capability_probe_status,
						})),
				})),
			);
			let region: string | undefined;
			let last = failure(503, "decisions_endpoint_unavailable");
			const attempts = new Map<string, number>();
			const rejected = new Set<string>();
			for (;;) {
				let minimumWait = Infinity;
				for (const candidate of resolved.candidates) {
					const credential = eligible.find((r) => r.id === candidate.id);
					if (!credential) continue;
					const key = this.backoff.key(
						credential,
						`decisions:${resolved.upstreamModel}`,
					);
					if ((this.unsupported.get(key) ?? 0) > this.now()) continue;
					if (
						region !== undefined &&
						region !== (credential.region ?? "global")
					)
						continue;
					region ??= credential.region ?? "global";
					if (rejected.has(key) || (attempts.get(key) ?? 0) >= 3) continue;
					{
						if (controller.signal.aborted) throw Error("deadline");
						const admission = this.backoff.acquire(key);
						if (admission.waitMs) {
							minimumWait = Math.min(minimumWait, admission.waitMs);
							continue;
						}
						attempts.set(key, (attempts.get(key) ?? 0) + 1);
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
							const text = response.ok
								? await readBody(response, controller.signal)
								: await abortable(
										readErrorBody(response, 5000, 65536),
										controller.signal,
									);
							let data: unknown;
							try {
								data = JSON.parse(text);
							} catch {
								// Error status is authoritative even for empty or HTML bodies.
								data = undefined;
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
							const rejection = classifyRejection(response.status, source);
							// A rejected pool key is not the caller's credential; a 401
							// relayed through the bridge would read as a bad local token.
							last =
								rejection === "credential" && response.status !== 429
									? failure(503, "decisions_pool_unavailable")
									: Response.json(
											{ error },
											{
												status: response.status,
												headers: retryAfter ? { "retry-after": retryAfter } : {},
											},
										);
							if (rejection === "unsupported") {
								if (this.unsupported.size >= 512) {
									const oldest = this.unsupported.keys().next().value;
									if (oldest) this.unsupported.delete(oldest);
								}
								this.unsupported.set(key, this.now() + 300_000);
								continue;
							}
							if (rejection === "credential") {
								rejected.add(key);
								continue;
							}
							if (rejection === "rate_limited") {
								const waitMs = this.backoff.penalize(
									key,
									apiRetryDelayMs(data, this.now(), response.headers),
								);
								if ((attempts.get(key) ?? 0) < 3)
									minimumWait = Math.min(minimumWait, waitMs);
								continue;
							}
							return last; // No replay for ambiguous 5xx or provider validation errors.
						} finally {
							admission.release(success);
						}
					}
				}
				if (!Number.isFinite(minimumWait)) return last;
				if (minimumWait >= deadline - this.now())
					return Response.json(
						{
							error: {
								code: "rate_limit_exceeded",
								message:
									"Eligible Decisions credentials are temporarily rate limited. Retry after the indicated delay.",
								retry_after_ms: Math.ceil(minimumWait),
							},
						},
						{
							status: 429,
							headers: {
								"retry-after": String(Math.max(1, Math.ceil(minimumWait / 1000))),
							},
						},
					);
				// Scan every same-region candidate before waiting; waits consume time,
				// never the bounded number of actual inference sends.
				await new Promise<void>((resolve, reject) => {
					const cancel = () => {
						clearTimeout(wait);
						reject(Error("cancelled"));
					};
					const wait = setTimeout(() => {
						controller.signal.removeEventListener("abort", cancel);
						resolve();
					}, minimumWait);
					controller.signal.addEventListener("abort", cancel, { once: true });
				});
			}
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
