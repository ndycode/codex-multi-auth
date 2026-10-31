import { apiBaseUrl } from "../api-region.js";
import { ClientCancellationError } from "../request/client-cancellation.js";
import { mapWithConcurrency } from "../concurrency.js";
import {
	RuntimeCapabilityFailures,
	classifyCapabilityFailure,
} from "./runtime-capability-failures.js";
import { readErrorBody } from "../request/stream-failover-runtime.js";
import { apiRetryDelayMs } from "../request/api-retry-delay.js";
import { ApiRateBackoff } from "./api-rate-backoff.js";
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
		reasoning_levels_known: false,
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
function withRouteMetadata(model: RouteModel, route: ApiRouteCredential): RouteModel {
	const profile = route.modelProfiles?.[model.slug];
	const result: RouteModel = profile
		? { ...model, ...structuredClone(profile), slug: model.slug, capability_metadata_source: "operator" }
		: { ...model };
	const inputModalities = route.modelInputModalities?.[model.slug];
	if (inputModalities) {
		result.input_modalities = [...new Set(inputModalities)];
		result.capability_metadata_source = "operator";
	}
	delete result.available_access_programs;
	const override =
		route.modelAccessPrograms &&
		Object.hasOwn(route.modelAccessPrograms, model.slug)
			? route.modelAccessPrograms[model.slug]
			: undefined;
	const programs = override ?? route.accessPrograms;
	if (programs) result.available_access_programs = structuredClone(programs);
	const declared = route.modelReasoningLevels?.[model.slug];
	if (declared) {
		const levels = [...new Set(declared)];
		const literalUltra = levels.includes("ultra");
		const multiAgent =
			literalUltra ? null : (["max", "xhigh", "high"] as const).find((level) =>
				levels.includes(level),
			) ?? null;
		result.reasoning_levels_known = true;
		result.capability_metadata_source = "operator";
		result.multi_agent_reasoning_effort = multiAgent;
		result.supported_reasoning_levels = [
			...levels,
			...(multiAgent && !literalUltra ? ["ultra"] : []),
		].map((effort) => ({
			effort,
			description:
				effort === "ultra"
					? "Operator-declared multi-agent mode using a supported API reasoning effort"
					: `Operator-declared ${effort} reasoning effort`,
		}));
		result.default_reasoning_level = levels.includes("medium")
			? "medium"
			: (levels[0] ?? null);
	}
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
export interface ApiCatalogFailure {
 kind: "http" | "timeout" | "network" | "invalid_catalog";
 status?: number;
 retryAt?: number;
}
export interface ApiCatalogStatus {
	id: string;
	kind: "api" | "zdr" | "psp";
	label: string;
	priority: number;
	checkedAt: number;
	error: boolean;
 failure?: ApiCatalogFailure;
 lastSuccessfulAt?: number;
	availableModels: string[];
	visibleModels: string[];
	entitlements: ReturnType<typeof modelEntitlements>[];
}
export class ApiModelRuntime {
	private discoveryQueue: Promise<void> = Promise.resolve();
 private nextDiscoveryAt = 0;
 private readonly discoveryInFlight = new Map<string, Promise<void>>();
 private readonly discoveryStrikes = new Map<string, number>();
 private readonly discoveryUpdates = new Map<string, Promise<ApiRouteCredential>>();
	lastPersistenceError: string | null = null;
	private readonly failures = new RuntimeCapabilityFailures(() => this.now());
	private readonly rateBackoff = new ApiRateBackoff(() => this.now());
	private readonly responseAdmissions = new WeakMap<Response, (success: boolean) => void>();
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
		{ at: number; models: RouteModel[]; error: boolean; failure?: ApiCatalogFailure; lastSuccessfulAt?: number }
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
		private readonly admissionWaitMs = 30_000,
	) {}
	private key(route: ApiRouteCredential): string {
		return createHash("sha256")
			.update(route.id)
			.update("\0")
			.update(route.apiKey + (route.region === "us" ? "\0" + apiBaseUrl(route) : ""))
			.digest("hex");
	}
 private async refreshCatalog(route: ApiRouteCredential, refresh: boolean): Promise<void> {
  const key = this.key(route);
  const current = this.cache.get(key);
  // Warm traffic and callers observing a cooldown never queue behind a slow refresh.
  if (!route.enabled || (current?.failure?.retryAt && current.failure.retryAt > this.now()) || (!refresh && current && !current.error && current.at + 300_000 > this.now())) return;
  const existing = this.discoveryInFlight.get(key);
  if (existing) return existing;
  // Serialize start slots, not network completion: an unhealthy endpoint must
  // not hold every other credential behind its 15-second timeout.
  const start = this.discoveryQueue.then(async () => {
   const wait = this.nextDiscoveryAt - this.now();
   if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
   this.nextDiscoveryAt = this.now() + 250;
  });
  this.discoveryQueue = start.catch(() => undefined);
  const job = start.then(async () => {
   const cached = this.cache.get(key);
   if (!route.enabled || (cached?.failure?.retryAt && cached.failure.retryAt > this.now()) || (!refresh && cached && !cached.error && cached.at + 300_000 > this.now())) return;

					if (
						route.enabled &&
						(!cached?.failure?.retryAt || cached.failure.retryAt <= this.now()) &&
                        (refresh ||
							!cached ||
							cached.at + (cached.error ? 5000 : 5 * 60_000) <= this.now())
					) {
						let models: RouteModel[] = [];
                        let retryDelay = 0;
						let error = false;
 let failure: ApiCatalogFailure | undefined;
 let receivedResponse = false;
						try {
							const response = await this.fetchImpl(
								`${apiBaseUrl(route)}/models`,
								{
									method: "GET",
									headers: { authorization: `Bearer ${route.apiKey}` },
									redirect: "error",
									signal: AbortSignal.timeout(15000),
								},
							);
							receivedResponse = true;
							if (!response.ok) {
 failure = {kind: "http", status: response.status};
 retryDelay = apiRetryDelayMs(null, this.now(), response.headers);
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
						} catch (cause) {
 failure ??= {kind: cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError") ? "timeout" : receivedResponse ? "invalid_catalog" : "network"};
							error = true;
						}
						if (this.cache.size >= 100 && !this.cache.has(key)) {
                            const oldest = this.cache.keys().next().value ?? "";
                            this.cache.delete(oldest);
                            this.discoveryStrikes.delete(oldest);
                        }
						const strikes = error ? (this.discoveryStrikes.get(key) ?? 0) + 1 : 0;
                        if (error) this.discoveryStrikes.set(key, strikes); else this.discoveryStrikes.delete(key);
                        if (failure) failure.retryAt = Math.min(8.64e15, this.now() + Math.max(retryDelay, Math.min(300_000, 30_000 * 2 ** Math.min(strikes - 1, 4))));
                        // Preserve display/routing evidence only for transient failures, never lost authorization.
                        const transient = failure && (failure.kind !== "http" || failure.status === 429 || (failure.status ?? 0) >= 500);
                        if (transient) models = cached?.models ?? [];
                        this.cache.set(key, { at: this.now(), models, error, failure, lastSuccessfulAt: error ? cached?.lastSuccessfulAt : this.now() });
					}

  });
  this.discoveryInFlight.set(key, job);
  try { await job; } finally { if (this.discoveryInFlight.get(key) === job) this.discoveryInFlight.delete(key); }
 }

	async catalogs(
		routes: ApiRouteCredential[],
		refresh = false,
		forceProbes = false,
		waitForCapabilities = true,
		waitForPersistence = true,
        requestKind?: "oauth" | "api" | "zdr" | "psp",
        updateActiveKeys = true,
	): Promise<RouteCatalog[]> {
		if (updateActiveKeys) this.activeKeys = new Set(routes.map((route) => this.key(route)));
		return mapWithConcurrency(requestKind ? routes.filter(route => route.kind === requestKind) : routes, 3, async (route) => {
					const key = this.key(route),
						cached = this.cache.get(key);
                    await this.refreshCatalog(route, refresh);
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
						models: (entry?.models ?? []).map(model => withRouteMetadata(model, route)),
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
							const discoveredModels = entry.models.map((m) => byId.get(m.slug) ?? m);
							snapshot.models = discoveredModels.map((m) =>
								withRouteMetadata(m, route),
							);
							// The caller receives its own completed result; only the newest refresh may replace the shared cache.
							if (
								this.cache.get(key) !== entry ||
								this.snapshots.get(key) !== snapshot ||
								!this.activeKeys.has(key)
							)
								return;
							entry.models = discoveredModels;
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
 failure: c?.failure,
 lastSuccessfulAt: c?.lastSuccessfulAt,
				availableModels: c?.models.map((m) => m.slug) ?? [],
				entitlements: (c?.models ?? [])
					.filter((m) =>
						(this.visibility.get(this.key(r)) ?? r.visibleModels).includes(
							m.slug,
						),
					)
					.map(model => modelEntitlements(withRouteMetadata(model, r))),
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
		await Promise.resolve();
        if (signal?.aborted) throw new ClientCancellationError();
        this.activeKeys = new Set(routes.map(credential => this.key(credential)));
		let route;
		try {
			if (isNonResponsesModel(parseModelRoute(alias).upstreamModel))
				return this.failure(
					400,
					"model_requires_other_endpoint",
					"This model uses a media, audio, embedding, or legacy endpoint and cannot serve a Codex Responses turn. Select a text/coding model.",
				);
            const settings = {
				serviceTier:
					typeof body.service_tier === "string" ? body.service_tier : undefined,
				reasoningEffort:
					isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
						? body.reasoning.effort
						: undefined,
            };
            // Resolve current policy against fresh evidence before waiting for
            // unrelated cold catalogs. Never reuse an old policy snapshot.
            const warmCatalogs: RouteCatalog[] = routes.flatMap(credential => {
                const cached = this.cache.get(this.key(credential));
                if (!credential.enabled || !cached || cached.error || cached.at + 300_000 <= this.now()) return [];
                return [{ id: credential.id, kind: credential.kind, enabled: credential.enabled,
                    priority: credential.priority, visibleModels: credential.visibleModels,
                    models: cached.models.map(model => withRouteMetadata(model, credential)) }];
            });
            route = resolveModelRoute(alias, warmCatalogs, settings);
            if (!route.candidates.length) {
                route = resolveModelRoute(alias, await this.catalogs(routes, false, false, true, false, parseModelRoute(alias).kind), settings);
            }
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
		let selectedRegion: "global" | "us" | undefined;
		const attemptedKeys = new Set<string>();
		const admissionDeadline = performance.now() + Math.max(0, Math.min(60_000, this.admissionWaitMs));
		let waits = 0;
        let discoveredBackups = false;
        const pendingBackups = new Map<string, Promise<{id: string; catalogs: RouteCatalog[]}>>();
		for (;;) {
		let retryWaitMs = Infinity;
		let deferred = false;
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
			const candidateRegion = credential.region ?? "global";
			if (selectedRegion !== undefined && selectedRegion !== candidateRegion)
				continue;
			selectedRegion ??= candidateRegion;
			if (signal?.aborted) throw new ClientCancellationError();
			const rateKey = this.rateBackoff.key(credential, route.upstreamModel);
			// Accepted or ambiguous sends are never replayed. Only a confirmed
			// temporary 429 below releases this per-request exclusion.
			if (attemptedKeys.has(rateKey)) continue;
			const admission = this.rateBackoff.acquire(rateKey);
			if (admission.waitMs > 0) {
				retryWaitMs = Math.min(retryWaitMs, admission.waitMs);
				deferred = true;
				continue;
			}
			attemptedKeys.add(rateKey);
			let accepted = false;
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(abort, 60000);
			try {
				onAttempt?.(routes.indexOf(credential));
				const response = await this.fetchImpl(
					`${apiBaseUrl(credential)}/responses`,
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
					const forwarded = new Response(response.body, {
						status: response.status,
						headers,
					});
					this.responseAdmissions.set(forwarded, admission.release);
					accepted = true;
					return forwarded;
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
				if (response.status === 429) {
					const permanent = ["insufficient_quota", "billing_hard_limit_reached", "billing_not_active", "usage_limit_reached"].some(code => source.code === code || source.type === code);
					if (permanent) {
						lastRejection = Response.json({error:sanitized},{status:429});
					} else {
						retryWaitMs = Math.min(retryWaitMs, this.rateBackoff.penalize(rateKey, apiRetryDelayMs(data, this.now(), response.headers)));
						attemptedKeys.delete(rateKey);
						deferred = true;
					}
					continue;
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
				if (!accepted) admission.release(false);
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		}
        // The warm fast path must not turn a partial catalog into an exhausted
        // pool. Discover omitted backups once, without crossing pool or region.
        if (!discoveredBackups) {
            discoveredBackups = true;
            const backups = routes.filter(credential => credential.enabled &&
                credential.kind === route.kind &&
                (selectedRegion === undefined || (credential.region ?? "global") === selectedRegion) &&
                !route.candidates.some(candidate => candidate.id === credential.id));
            for (const backup of backups) {
                // A subset lookup must never replace the configured catalog set.
                const pending = this.catalogs([backup], false, false, true, false, route.kind, false)
                    .then(catalogs => ({id: backup.id, catalogs}), () => ({id: backup.id, catalogs: []}));
                pendingBackups.set(backup.id, pending);
            }
        }
        if (pendingBackups.size) {
            const remaining = admissionDeadline - performance.now();
            if (remaining > 0) {
                const ready = await this.waitForBackup(
                    Promise.race(pendingBackups.values()),
                    Math.min(remaining, deferred ? retryWaitMs : Infinity), signal);
                if (ready) {
                    pendingBackups.delete(ready.id);
                    const resolved = resolveModelRoute(alias, ready.catalogs, {
                        serviceTier: route.serviceTier,
                        reasoningEffort: isRecord(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined,
                    });
                    route.candidates.push(...resolved.candidates);
                }
                // Retry recovery as soon as its cooldown expires, even if no
                // catalog completed. Discovery cannot extend admission time.
                continue;
            }
        }

		if (deferred && Number.isFinite(retryWaitMs) && waits < 32 && retryWaitMs <= admissionDeadline - performance.now()) {
			waits++;
			await this.waitForAdmission(retryWaitMs, signal);
			continue;
		}
		if (Number.isFinite(retryWaitMs)) return Response.json({error:{code:"rate_limit_exceeded", message:"Eligible API credentials are temporarily rate limited. Retry after the indicated delay.", retry_after_ms:Math.ceil(retryWaitMs)}}, {status:429, headers:{"retry-after":String(Math.max(1,Math.ceil(retryWaitMs/1000)))}});
		if (lastRejection) return lastRejection;
		// A 401/403 here belongs to the API key, not the desktop login; the native
		// client must not read an exhausted credential pool as a bad login.
		return this.failure(lastStatus === 401 || lastStatus === 403 ? 503 : lastStatus, "model_route_pool_unavailable");
		}
	}
    private waitForBackup<T>(pending: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
        if (signal?.aborted) return Promise.reject(new ClientCancellationError());
        return new Promise((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
            const abort = () => { cleanup(); reject(new ClientCancellationError()); };
            const timer = setTimeout(() => { cleanup(); resolve(undefined); }, Math.max(0, ms));
            signal?.addEventListener("abort", abort, {once:true});
            void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        });
    }
	private waitForAdmission(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new ClientCancellationError());
		return new Promise((resolve, reject) => {
			const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new ClientCancellationError()); };
			const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(1, ms));
			signal?.addEventListener("abort", abort, {once:true});
		});
	}
	/** Called by the forwarding owner after recording the stream's terminal outcome. */
	completeRequest(response: Response, success: boolean): void {
		const release = this.responseAdmissions.get(response);
		this.responseAdmissions.delete(response);
		release?.(success);
	}
	recordStreamFailure(credential: ApiRouteCredential, alias: string, body: Record<string, unknown>, error: unknown): void {
		const route = parseModelRoute(alias);
		if (route.kind !== credential.kind) return;
		if (isRecord(error) && isRecord(error.error) && error.error.code === "rate_limit_exceeded") {
			this.rateBackoff.penalize(this.rateBackoff.key(credential, route.upstreamModel), apiRetryDelayMs(error, this.now()));
			return;
		}
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
