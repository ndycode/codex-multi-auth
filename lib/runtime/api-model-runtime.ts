import { ClientCancellationError } from "../request/client-cancellation.js";
import { mapWithConcurrency } from "../concurrency.js";
import {
	RuntimeCapabilityFailures,
	classifyCapabilityFailure,
} from "./runtime-capability-failures.js";
import { readErrorBody } from "../request/stream-failover-runtime.js";
import { createHash } from "node:crypto";
import type { ApiRouteCredential } from "../api-route-store.js";
import {
	resolveModelRoute,
	parseModelRoute,
	type RouteCatalog,
	type RouteModel,
	modelEntitlements,
} from "../model-route-policy.js";
import { isRecord } from "../utils.js";

/** Endpoint-family exclusions, not a fixed allowlist of text model releases.
 * Model ID discovery alone does not prove Responses/tool compatibility. */
export function isNonResponsesModel(id: string): boolean {
	return (
		/(?:^|[-_])(?:tts|whisper|embedding|moderation|transcribe|transcription|realtime|audio|image|sora)(?:[-_]|$)/i.test(
			id,
		) ||
		/^(?:dall-e|babbage|davinci)(?:-|$)/i.test(id) ||
		/(?:^|-)live(?:-|$)/i.test(id)
	);
}

/** Conservative native-picker metadata: discovery proves an ID, not optional tool capabilities. */
export function apiPickerModel(id: string): RouteModel {
	return {
		slug: id,
		display_name: id,
		description:
			"API model; optional capabilities are not advertised by model discovery.",
		supported_reasoning_levels: [],
		default_reasoning_level: null,
		shell_type: "shell_command",
		visibility: "list",
		supported_in_api: true,
		priority: 0,
		availability_nux: null,
		upgrade: null,
		model_messages: {
			instructions_template:
				"You are a coding assistant. Follow the user instructions and supplied tool definitions.",
		},
		support_verbosity: false,
		default_verbosity: null,
		apply_patch_tool_type: null,
		truncation_policy: { mode: "bytes", limit: 10000 },
		experimental_supported_tools: [],
		input_modalities: ["text"],
		supports_reasoning_summary_parameter: false,
		use_responses_lite: false,
	};
}
/** Apply current credential policy, never metadata inherited from another credential or old config. */
function withAccessPrograms(model: RouteModel, route: ApiRouteCredential): RouteModel {
 const result = {...model};
 delete result.available_access_programs;
 const override = route.modelAccessPrograms && Object.hasOwn(route.modelAccessPrograms, model.slug)
  ? route.modelAccessPrograms[model.slug] : undefined;
 const programs = override ?? route.accessPrograms;
 if (programs) result.available_access_programs = structuredClone(programs);
 return result;
}
export async function boundedJson(
	response: Response,
	max = 8 * 1024 * 1024,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw Error("Empty model catalog");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) throw Error("Model catalog too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export interface ApiCatalogStatus {
	id: string;
	kind: "api" | "zdr";
	label: string;
	priority: number;
	checkedAt: number;
	error: boolean;
	availableModels: string[];
	visibleModels: string[];
	entitlements: ReturnType<typeof modelEntitlements>[];
}
export class ApiModelRuntime {
	private readonly discoveryUpdates = new Map<string, Promise<ApiRouteCredential>>();
	lastPersistenceError: string | null = null;
	private readonly failures = new RuntimeCapabilityFailures(() => this.now());
	private readonly visibility = new Map<string, string[]>();
	private readonly snapshots = new Map<string, RouteCatalog>();
	private activeKeys = new Set<string>();
	cachedCatalogs(): RouteCatalog[] {
		return [...this.snapshots]
			.filter(([key]) => this.activeKeys.has(key))
			.map(([, catalog]) => catalog);
	}
	private readonly cache = new Map<
		string,
		{ at: number; models: RouteModel[]; error: boolean }
	>();
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
		private readonly updateDiscovery?: (
			route: ApiRouteCredential,
			models: string[],
		) => Promise<ApiRouteCredential>,
		private readonly enrichModels?: (
			models: RouteModel[],
			refresh: boolean,
			route: ApiRouteCredential,
			forceProbes: boolean,
		) => Promise<RouteModel[]>,
		private readonly onCatalogUpdated?: () => void,
	) {}
	private key(route: ApiRouteCredential): string {
		return createHash("sha256")
			.update(route.id)
			.update("\0")
			.update(route.apiKey)
			.digest("hex");
	}
	async catalogs(
		routes: ApiRouteCredential[],
		refresh = false,
		forceProbes = false,
		waitForCapabilities = true,
		waitForPersistence = true,
        requestKind?: "oauth" | "api" | "zdr",
	): Promise<RouteCatalog[]> {
		this.activeKeys = new Set(routes.map((route) => this.key(route)));
		return mapWithConcurrency(requestKind ? routes.filter(route => route.kind === requestKind) : routes, 3, async (route) => {
					const key = this.key(route),
						cached = this.cache.get(key);
					if (
						route.enabled &&
						(refresh ||
							!cached ||
							cached.at + (cached.error ? 5000 : 5 * 60_000) <= this.now())
					) {
						let models: RouteModel[] = [];
						let error = false;
						try {
							const response = await this.fetchImpl(
								"https://api.openai.com/v1/models",
								{
									method: "GET",
									headers: { authorization: `Bearer ${route.apiKey}` },
									redirect: "error",
									signal: AbortSignal.timeout(15000),
								},
							);
							if (!response.ok) {
								await response.body?.cancel();
								throw Error("API catalog unavailable");
							}
							const value = await boundedJson(response);
							if (
								!isRecord(value) ||
								!Array.isArray(value.data) ||
								value.data.length > 10000
							)
								throw Error("Invalid API catalog");
							models = value.data.flatMap((m) =>
								isRecord(m) &&
								typeof m.id === "string" &&
								/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(m.id) &&
								!isNonResponsesModel(m.id)
									? [
											{
												...apiPickerModel(m.id),
												...cached?.models.find((old) => old.slug === m.id),
											},
										]
									: [],
							);
						} catch {
							error = true;
						}
						if (this.cache.size >= 100)
							this.cache.delete(this.cache.keys().next().value ?? "");
						this.cache.set(key, { at: this.now(), models, error });
					}
					const entry = this.cache.get(key);
					if (route.enabled && entry && !entry.error && this.updateDiscovery) {
						let pending = this.discoveryUpdates.get(key);
						if (!pending) {
							pending = this.updateDiscovery(route, entry.models.map(m => m.slug));
							this.discoveryUpdates.set(key, pending);
							void pending.then(() => {this.lastPersistenceError = null;}, () => {this.lastPersistenceError = "api_catalog_persistence_failed";}).finally(() => {this.discoveryUpdates.delete(key);});
						}
						if (waitForPersistence) {
							try {route = await pending;} catch { /* Keep the explicit policy read for this request; discovery cannot expand it. */ }
						}
					}

					this.visibility.set(key, route.visibleModels);
					const snapshot: RouteCatalog = {
						id: route.id,
						kind: route.kind,
						enabled: route.enabled,
						priority: route.priority,
						models: (entry?.models ?? []).map(model => withAccessPrograms(model, route)),
						visibleModels: route.visibleModels,
					};
					this.snapshots.set(key, snapshot);
					if (route.enabled && entry && !entry.error && this.enrichModels && (!requestKind || !cached || cached.error)) {
						const pending = this.enrichModels(
							entry.models.filter((m) => route.visibleModels.includes(m.slug)),
							refresh,
                            requestKind ? {...route, probeCapabilities:false} : route,
							forceProbes,
						).then((enriched) => {
							const byId = new Map(enriched.map((m) => [m.slug, m]));
							snapshot.models = entry.models.map((m) => withAccessPrograms(byId.get(m.slug) ?? m, route));
							// The caller receives its own completed result; only the newest refresh may replace the shared cache.
							if (
								this.cache.get(key) !== entry ||
								this.snapshots.get(key) !== snapshot ||
								!this.activeKeys.has(key)
							)
								return;
							entry.models = snapshot.models;
							this.onCatalogUpdated?.();
						});
						if (waitForCapabilities) await pending;
						else
							void pending.catch(() => {
								entry.error = true;
							});
					}
					return snapshot;
		});
	}
	statuses(routes: ApiRouteCredential[]): ApiCatalogStatus[] {
		return routes.map((r) => {
			const c = this.cache.get(this.key(r));
			return {
				id: r.id,
				kind: r.kind,
				label: r.label,
				priority: r.priority,
				checkedAt: c?.at ?? 0,
				error: c?.error ?? true,
				availableModels: c?.models.map((m) => m.slug) ?? [],
				entitlements: (c?.models ?? [])
					.filter((m) =>
						(this.visibility.get(this.key(r)) ?? r.visibleModels).includes(
							m.slug,
						),
					)
					.map(model => modelEntitlements(withAccessPrograms(model, r))),
				visibleModels: (
					this.visibility.get(this.key(r)) ?? r.visibleModels
				).filter((id) => c?.models.some((m) => m.slug === id)),
			};
		});
	}
	async request(
		alias: string,
		body: Record<string, unknown>,
		routes: ApiRouteCredential[],
		signal?: AbortSignal,
		onAttempt?: (credentialIndex: number) => void,
	): Promise<Response> {
		let route;
		try {
			if (isNonResponsesModel(parseModelRoute(alias).upstreamModel))
				return this.failure(
					400,
					"model_requires_other_endpoint",
					"This model uses a media, audio, embedding, or legacy endpoint and cannot serve a Codex Responses turn. Select a text/coding model.",
				);
			route = resolveModelRoute(alias, await this.catalogs(routes, false, false, true, false, parseModelRoute(alias).kind), {
				serviceTier:
					typeof body.service_tier === "string" ? body.service_tier : undefined,
				reasoningEffort:
					isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
						? body.reasoning.effort
						: undefined,
			});
		} catch {
			return this.failure(400, "invalid_model_route");
		}
		if (route.kind === "oauth")
			return this.failure(400, "explicit_api_model_required");
		// Until connection-affinity support exists, never guess the owner of server-side response state.
		if (body.background === true || body.conversation)
			return this.failure(400, "stateful_api_route_unsupported");
		if (body.previous_response_id)
			return this.failure(400, "previous_response_not_found");
		const payload: Record<string, unknown> = {
			...body,
			model: route.upstreamModel,
			store: false,
		};
		if (route.serviceTier) payload.service_tier = route.serviceTier;
		delete payload.client_metadata;
		let lastStatus = 503;
		let lastRejection: Response | undefined;
		for (const candidate of route.candidates) {
			const credential = routes.find((r) => r.id === candidate.id);
			if (!credential) continue;
			const effort =
				isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
					? body.reasoning.effort
					: undefined;
			if (
				!this.failures.supports(
					this.key(credential),
					route.upstreamModel,
					effort,
					route.serviceTier,
				)
			)
				continue;
			if (signal?.aborted) throw new ClientCancellationError();
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(abort, 60000);
			try {
				onAttempt?.(routes.indexOf(credential));
				const response = await this.fetchImpl(
					"https://api.openai.com/v1/responses",
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${credential.apiKey}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(payload),
						redirect: "error",
						signal: controller.signal,
					},
				);
				lastStatus = response.status;
				lastRejection = undefined;
				if (response.ok) {
					const headers = new Headers();
					for (const name of [
						"content-type",
						"cache-control",
						"x-request-id",
						"retry-after",
					]) {
						const value = response.headers.get(name);
						if (value) headers.set(name, value);
					}
					return new Response(response.body, {
						status: response.status,
						headers,
					});
				}
				const errorBody = await readErrorBody(response, 5000, 65536);
				let data: unknown;
				try {
					data = JSON.parse(errorBody);
				} catch {
					data = null;
				}
				const rejection = classifyCapabilityFailure(response.status, data);
				const source = isRecord(data) && isRecord(data.error) ? data.error : {};
                const sanitized: Record<string,string> = {message:"Upstream rejected the API request.",code:"api_request_rejected"};
                for (const field of ["code","type","param"]) {
                    const value=source[field];
                    if (typeof value === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(value)) sanitized[field]=value;
                }
                if (rejection) {
                    lastRejection = Response.json({error:sanitized},{status:response.status});
					this.failures.record(
						this.key(credential),
						route.upstreamModel,
						rejection,
						effort,
						route.serviceTier,
					);
					continue;
				}
				if (![401, 403, 429, 500, 502, 503, 504].includes(response.status)) {
                    return Response.json({error:sanitized},{status:response.status});
                }
			} catch (error) {
                if (error instanceof ClientCancellationError) throw error;
				if (signal?.aborted) throw new ClientCancellationError();
				lastStatus = 502;
				lastRejection = undefined;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		}
		if (lastRejection) return lastRejection;
		// A 401/403 here belongs to the API key, not the desktop login; the native
		// client must not read an exhausted credential pool as a bad login.
		return this.failure(lastStatus === 401 || lastStatus === 403 ? 503 : lastStatus, "model_route_pool_unavailable");
	}
	recordStreamFailure(credential: ApiRouteCredential, alias: string, body: Record<string, unknown>, error: unknown): void {
		const route = parseModelRoute(alias);
		if (route.kind !== credential.kind) return;
		const rejection = classifyCapabilityFailure(400, error);
		if (!rejection) return;
		const effort = isRecord(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
		const tier = route.serviceTier ?? (typeof body.service_tier === "string" ? body.service_tier : undefined);
		this.failures.record(this.key(credential), route.upstreamModel, rejection, effort, tier);
	}
	private failure(
		status: number,
		code: string,
		message = "No eligible credential could serve the selected API model route. No other pool was used.",
	): Response {
		return Response.json(
			{
				error: {
					code,
					message,
				},
			},
			{ status },
		);
	}
}
