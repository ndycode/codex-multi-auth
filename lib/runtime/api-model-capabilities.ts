import { apiBaseUrl } from "../api-region.js";
import { mapWithConcurrency } from "../concurrency.js";
import { classifyCapabilityFailure } from "./runtime-capability-failures.js";
import { createHash } from "node:crypto";
import type { ApiRouteCredential } from "../api-route-store.js";
import {
	canonicalServiceTier,
	type RouteModel,
} from "../model-route-policy.js";
import { isRecord } from "../utils.js";

const efforts = new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
/** Read the explicit model-specific statement, never surrounding examples or another model's settings. */
export function parseApiReasoningDocumentation(
	id: string,
	text: string,
): string[] {
	return parseReasoningStatement(id, text) ?? [];
}
function parseReasoningStatement(id: string, text: string): string[] | undefined {
	if (text.match(/^Model ID:\s*`([^`]+)`/m)?.[1] !== id) return undefined;
	const statement = text.match(
		/`?reasoning\.effort`?\s+supports\s*:?\s*([^\n.]+)\./i,
	)?.[1];
	if (statement === undefined) return undefined;
	const values = statement
		.replace(/`|\(default\)/g, " ")
		.split(/,|\band\b/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (
		!values.length ||
		values.length > 16 ||
		values.some(
			(v) =>
				!/^[a-z][a-z0-9_-]{0,31}$/.test(v) ||
				v === "ultra" ||
				v === "persistent",
		)
	)
		return undefined;
	return [...new Set(values)];
}
export type ProbeResult = {
	ownerEpoch?: string;
	programCheckedAt?: number;
	programRetry?: boolean;
	at: number;
	levels: string[];
	tiers: string[];
	status: Record<string, string>;
};
/** Candidates describe checks, never request defaults or granted entitlements. */
function programCandidates(route: ApiRouteCredential, id: string): string[] {
 const configured = (route.modelAccessPrograms?.[id] ?? route.accessPrograms)?.cyber;
 const candidates = [...(configured ?? []), ...(/(?:^|-)cyber(?:-|$)|daybreak-red/.test(id)
  ? ["daybreak_red"] : /^gpt-[56](?:[.-]|$)/.test(id) ? ["standard", "daybreak_blue"] : [])];
 return [...new Set(candidates)].filter(value => ["standard", "daybreak_blue", "daybreak_red"].includes(value));
}
function programsFresh(result: ProbeResult, programs: string[], now: number): boolean {
 return result.programRetry !== true && result.programCheckedAt !== undefined &&
  Number.isFinite(result.programCheckedAt) && result.programCheckedAt >= 0 && result.programCheckedAt <= 8.64e15 &&
  result.programCheckedAt <= now && result.programCheckedAt + 86400_000 > now &&
  programs.every(program => ["verified", "unsupported"].includes(result.status[`program:cyber:${program}`] ?? ""));
}
type DocumentedCapabilities = { levels: string[]; reasoningAvailable?: boolean; inputModalities?: string[]; stale?: boolean };
function probeKey(route: ApiRouteCredential, id: string): string {
	return createHash("sha256").update(route.id).update("\0").update(route.apiKey + (route.region === "us" ? "\0" + apiBaseUrl(route) : "")).update("\0").update(id).digest("hex");
}

/** Only the exact model's input declaration can enable native image attachments. */
function parseInputModalities(id: string, text: string): string[] | undefined {
	if (text.match(/^Model ID:\s*`([^`]+)`/m)?.[1] !== id) return undefined;
	const details = text.split(/^## Model details[ \t]*\r?\n/m)[1]?.split(/^## /m)[0];
	const declaration = details?.match(/^- Input modalities:[ \t]*([^\r\n]+)$/m)?.[1];
	if (!declaration) return undefined;
	const modalities = declaration.split(",").map(value => value.trim());
	if (!modalities.length || modalities.some(value => !["text", "image", "audio", "video"].includes(value))) return undefined;
	// The native coding picker currently accepts text and image inputs.
	return [...new Set(modalities.filter(value => value === "text" || value === "image"))];
}
/** Codes and params that say the key, organization or project itself lacks access. */
const CREDENTIAL_ACCESS_CODES = new Set([
	"invalid_api_key", "insufficient_permissions", "permission_denied", "unauthorized",
	"organization_deactivated", "account_deactivated", "project_not_found", "project_archived",
	"ip_not_authorized", "unsupported_country_region_territory",
]);
/**
 * A 403 either removes the credential's access ("lost"), denies the whole model
 * on this credential ("model"), denies only the probed setting ("setting"), or
 * explains nothing ("ambiguous").
 */
function classifyProbe403(data: unknown, setting: { effort?: string; tier?: string; compatibility?: boolean }): "lost" | "model" | "setting" | "ambiguous" {
	const error = isRecord(data) && isRecord(data.error) ? data.error : null;
	if (!error) return "ambiguous";
	const code = String(error.code ?? ""), param = String(error.param ?? "");
	if (CREDENTIAL_ACCESS_CODES.has(code) || ["api_key", "organization", "project"].includes(param)) return "lost";
	// Same model-level denial codes the runtime capability classifier uses.
	if (classifyCapabilityFailure(403, data) === "model") return "model";
	// Compatibility and tier probes also carry an effort, but only an effort probe
	// tests it: an effort-param 403 elsewhere explains nothing about the probed setting.
	const effortProbe = Boolean(setting.effort) && !setting.tier && !setting.compatibility;
	if (effortProbe && ["reasoning.effort", "reasoning"].includes(param)) return "setting";
	if (setting.tier && param === "service_tier") return "setting";
	if (setting.compatibility && ["tools", "tool_choice"].includes(param)) return "setting";
	return "ambiguous";
}
export class ApiModelCapabilities {
	private activeProbes = 0;
	private readonly probeWaiters: Array<() => void> = [];
	private async withProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
		if (this.probeSlot) return this.probeSlot(operation);
		if (this.activeProbes >= 4)
			await new Promise<void>((resolve) => this.probeWaiters.push(resolve));
		else this.activeProbes++;
		try {
			return await operation();
		} finally {
			const next = this.probeWaiters.shift();
			if (next) next();
			else this.activeProbes--;
		}
	}
	private readonly inFlight = new Map<string, Promise<ProbeResult>>();
	private readonly probes = new Map<string, ProbeResult>();
	private readonly cache = new Map<string, DocumentedCapabilities & { at: number }>();
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
		private readonly probeSlot?: <T>(operation: () => Promise<T>) => Promise<T>,
		// Keep public documentation across short-lived credential/model leases.
		private readonly documentationSource?: ApiModelCapabilities,
		// Scheduled checks need program evidence to last until their next run.
		private readonly programRefreshBefore?: number,
	) {}
	/** Probe results keyed by an opaque hash, for a fresh CLI process to honour the 15-minute cache. */
	exportProbes(): Array<[string, ProbeResult]> {
		return [...this.probes];
	}
	importProbes(entries: Array<[string, ProbeResult]>): void {
		for (const [key, value] of entries.slice(-1000)) {
			if (this.probes.has(key) || value.at > this.now()) continue;
			this.probes.set(key, value);
		}
	}
	async reasoning(id: string, refresh = false): Promise<string[]> {
		return (await this.documentation(id, refresh)).levels;
	}
	private async documentation(id: string, refresh = false): Promise<DocumentedCapabilities> {
		if (this.documentationSource) return this.documentationSource.documentation(id, refresh);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) return { levels: [] };
		const cached = this.cache.get(id);
		if (!refresh && cached && cached.at + 60000 > this.now())
			return cached;
		let metadata: DocumentedCapabilities = { levels: [] };
		try {
			const response = await this.fetchImpl(
				`https://developers.openai.com/api/docs/models/${encodeURIComponent(id)}.md`,
				{ redirect: "error", signal: AbortSignal.timeout(5000) },
			);
			if (!response.ok) {
				await response.body?.cancel();
				throw Error("Documentation unavailable");
			}
			const reader = response.body?.getReader();
			if (!reader) throw Error("No documentation");
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 256 * 1024) throw Error("Documentation too large");
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			const text = Buffer.concat(chunks).toString("utf8");
			const reasoning = parseReasoningStatement(id, text);
			metadata = {
				levels: reasoning ?? [],
				reasoningAvailable: reasoning !== undefined,
				inputModalities: parseInputModalities(id, text),
			};
		} catch {
			// An outage is not a capability revocation. Keep the entire last
			// successful declaration, including that its levels were authoritative.
			if (cached) {
				metadata = {
					levels: [...cached.levels],
					reasoningAvailable: cached.reasoningAvailable,
					inputModalities: cached.inputModalities,
					stale: true,
				};
			}
		}
		if (this.cache.size >= 1000)
			this.cache.delete(this.cache.keys().next().value ?? "");
		this.cache.set(id, { ...metadata, at: this.now() });
		return metadata;
	}
	private programsCoverCheck(result: ProbeResult, programs: string[]): boolean {
		return programsFresh(result, programs, this.now()) &&
			(this.programRefreshBefore === undefined || (result.programCheckedAt ?? -Infinity) + 86400_000 >= this.programRefreshBefore);
	}
	private freshProbe(route: ApiRouteCredential, id: string, old: ProbeResult | undefined): ProbeResult | undefined {
		// A probe cut short by 401/403/429 is retried after a minute, not trusted for 15.
		const freshFor = old?.status.retry === "transient" ? 60_000 : 900_000;
		const programs = programCandidates(route, id);
		const oldPrograms = old ? Object.keys(old.status).filter(name => name.startsWith("program:cyber:")) : [];
		const samePrograms = oldPrograms.length === programs.length && programs.every(program => oldPrograms.includes(`program:cyber:${program}`));
		const programCacheFresh = old && samePrograms && (programs.length
			? this.programsCoverCheck(old, programs) || ((old.programRetry === true || old.status.retry === "transient") && old.at + 60_000 > this.now())
			: old.programCheckedAt === undefined);
		if (old && old.at <= this.now() && old.at + freshFor > this.now() && programCacheFresh) return old;
		return undefined;
	}
	private reconcileReasoning(probe: ProbeResult, documented: string[], available: boolean): ProbeResult {
		if (!available) return probe;
		return { ...probe, levels: probe.levels.filter(effort => documented.includes(effort) || probe.status[`effort:${effort}`] === "verified") };
	}
	private async probe(
		route: ApiRouteCredential,
		id: string,
		documented: string[],
		force = false,
		reasoningAvailable = false,
	) {
		const key = probeKey(route, id);
		const fresh = this.freshProbe(route, id, this.probes.get(key));
		if (!force && fresh) {
			const reconciled = this.reconcileReasoning(fresh, documented, reasoningAvailable);
			this.probes.set(key, reconciled);
			return reconciled;
		}
		const running = this.inFlight.get(key);
		if (running) return running;
		const pending = this.runProbe(route, id, documented, key, force, reasoningAvailable).finally(() =>
			this.inFlight.delete(key),
		);
		this.inFlight.set(key, pending);
		return pending;
	}
	private async runProbe(
		route: ApiRouteCredential,
		id: string,
		documented: string[],
		key: string,
		force: boolean,
		reasoningAvailable: boolean,
	): Promise<ProbeResult> {
		const result: ProbeResult = {
			at: this.now(),
			levels: [...documented],
			tiers: [] as string[],
			status: {} as Record<string, string>,
		};
		let credentialUnavailable = false;
		let needsRetry = false;
		// 401/403 means this credential lost access: nothing it verified before
		// may still be advertised. A throttle (429) or transport failure is only
		// inconclusive and keeps what an earlier probe verified. Only
		// "unsupported" or "downgraded" removes a setting otherwise.
		let lostAccess = false;
		let programAuthFailure = false;
		// A model-level denial hides the model on this credential: no efforts, no tiers.
		let modelDenied = false;
		const previous = this.probes.get(key);
		const keep = (name: string, status: string): string => {
			const prior = previous?.status[name];
			return status === "unverified" && !lostAccess && !modelDenied &&
				prior !== undefined && ["verified", "unsupported", "downgraded"].includes(prior)
				? prior
				: status;
		};
		const attempt = async (setting: {
			effort?: string;
			tier?: string;
			compatibility?: boolean;
			program?: string;
		}): Promise<string> => {
			// Lost access drops everything this credential verified; a model-level
			// denial hides the model; a 403 naming the probed setting removes only it.
			// An unexplained 403 changes nothing and the probe is retried soon.
			const denied403 = (data: unknown): string => {
				const kind = classifyProbe403(data, setting);
				if (kind === "lost") { credentialUnavailable = true; lostAccess = true; return "unverified"; }
				if (kind === "model") { modelDenied = true; return "unsupported"; }
				if (kind === "setting") return "unsupported";
				credentialUnavailable = true;
				programAuthFailure = Boolean(setting.program);
				return "unverified";
			};
			return this.withProbeSlot(async () => {
				if (credentialUnavailable || modelDenied) {
					if (!modelDenied) needsRetry = true;
					return "unverified";
				}
				try {
					const response = await this.fetchImpl(
						`${apiBaseUrl(route)}/responses`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${route.apiKey}`,
								"content-type": "application/json",
							},
							redirect: "error",
							signal: AbortSignal.timeout(15000),
							body: JSON.stringify({
								model: id,
								input: "Reply OK.",
								store: false,
								max_output_tokens: 16,
								...(setting.compatibility
									? {
											tools: [
												{
													type: "function",
													name: "capability_probe",
													parameters: {
														type: "object",
														properties: {},
														required: [],
														additionalProperties: false,
													},
													strict: true,
												},
											],
											tool_choice: {
												type: "function",
												name: "capability_probe",
											},
										}
									: {}),
								...(setting.effort
									? { reasoning: { effort: setting.effort } }
									: {}),
								...(setting.tier ? { service_tier: setting.tier } : {}),
								...(setting.program ? { access_programs: {cyber: setting.program} } : {}),
							}),
						},
					);
					if ([401, 429].includes(response.status))
						credentialUnavailable = true;
					if (response.status === 429) needsRetry = true;
					if (response.status === 401) lostAccess = true;
					// Probe bodies are tiny, but an upstream error must not grow local memory unboundedly.
					const reader = response.body?.getReader();
					if (!reader) return response.status === 403 ? denied403(null) : "unverified";
					const chunks: Uint8Array[] = [];
					let bytes = 0;
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength;
							if (bytes > 256 * 1024) throw Error("Probe response too large");
							chunks.push(value);
						}
					} finally {
						await reader.cancel();
					}
					let data: unknown;
					try {
						data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch {
						return response.status === 403 ? denied403(null) : "unverified";
					}
					if (setting.program) {
						const error = isRecord(data) && isRecord(data.error) ? data.error : null;
						if ([400, 403].includes(response.status) && error &&
							(["invalid_access_program", "unsupported_access_program", "access_program_not_enabled"].includes(String(error.code)) ||
							["access_programs", "access_programs.cyber"].includes(String(error.param)))) return "unsupported";
						if (response.status === 403) { programAuthFailure = true; return denied403(data); }
						if (!response.ok) return "unverified";
						return isRecord(data) && ["completed", "incomplete"].includes(String(data.status)) && isRecord(data.access_programs) && data.access_programs.cyber === setting.program
							? "verified" : "unverified";
					}
					if (response.status === 403) return denied403(data);
					if (!response.ok) {
						if (setting.compatibility) {
							const error =
								isRecord(data) && isRecord(data.error) ? data.error : null;
							return classifyCapabilityFailure(response.status, data) ===
								"model" ||
								(response.status === 400 &&
									error &&
									["tools", "tool_choice"].includes(String(error.param)) &&
									["unsupported_parameter", "unsupported_value"].includes(
										String(error.code),
									))
								? "unsupported"
								: "unverified";
						}
						const error =
							isRecord(data) && isRecord(data.error) ? data.error : null;
						return response.status === 400 &&
							error &&
							typeof error.param === "string" &&
							["reasoning.effort", "reasoning", "service_tier"].includes(
								error.param,
							)
							? "unsupported"
							: "unverified";
					}
					if (setting.compatibility)
						return isRecord(data) &&
							Array.isArray(data.output) &&
							data.output.some(
								(item) =>
									isRecord(item) &&
									item.type === "function_call" &&
									item.name === "capability_probe",
							)
							? "verified"
							: "unverified";
					if (!setting.tier)
						return isRecord(data) &&
							isRecord(data.reasoning) &&
							data.reasoning.effort === setting.effort
							? "verified"
							: "unverified";
					if (!isRecord(data) || typeof data.service_tier !== "string")
						return "unverified";
					return canonicalServiceTier(data.service_tier) ===
						canonicalServiceTier(setting.tier)
						? "verified"
						: "downgraded";
				} catch {
					needsRetry = true;
					return "unverified";
				}
			});
		};
		{
			const checked = await Promise.all(
				[...efforts]
					.filter((effort) => !documented.includes(effort))
					.map(async (effort) => ({
						effort,
						status: await attempt({ effort }),
					})),
			);
			for (const { effort, status } of checked) {
				const effective = keep(`effort:${effort}`, status);
				result.status[`effort:${effort}`] = effective;
				// Persisted levels can originate in public documentation, without a
				// verified effort probe. Keep that scoped evidence through an
				// inconclusive retry only while current documentation is unavailable.
				if (effective === "verified" || (status === "unverified" && !reasoningAvailable && !lostAccess && !modelDenied && previous?.levels.includes(effort))) result.levels.push(effort);
			}
			const probeEstablishedReasoning = checked.some(({ status }) =>
				["verified", "unsupported", "downgraded"].includes(status),
			);
			if (!reasoningAvailable && needsRetry && probeEstablishedReasoning) {
				// Partial evidence says only that explicitly rejected efforts fail. A
				// timeout or throttle must not turn unchecked settings into denials.
				for (const { effort, status } of checked) {
					const prior = previous?.status[`effort:${effort}`];
					if (
						status === "unverified" &&
						(!previous || previous.status.retry === "transient" || prior === "unverified") &&
						!["unsupported", "downgraded"].includes(prior ?? "") &&
						!result.levels.includes(effort)
					) result.levels.push(effort);
				}
			}
		}
		const effort = result.levels.includes("low") ? "low" : result.levels[0];
		result.status.responses = keep("responses", await attempt({ compatibility: true, effort }));
		const checkedTiers = await Promise.all(
			["fast", "ultrafast"].map(async (tier) => ({
				tier,
				status: await attempt({ tier: tier === "fast" ? "priority" : tier, effort }),
			})),
		);
		for (const { tier, status } of checkedTiers) {
			const effective = keep(tier, status);
			result.status[tier] = effective;
			if (effective === "verified") result.tiers.push(tier);
		}
		const programs = programCandidates(route, id);
		const reusable = !force && previous && this.programsCoverCheck(previous, programs);
		if (programs.length && reusable && !lostAccess && !modelDenied && !programAuthFailure) {
			for (const program of programs) result.status[`program:cyber:${program}`] = previous.status[`program:cyber:${program}`] ?? "unverified";
			result.programCheckedAt = previous.programCheckedAt;
		} else if (programs.length) {
			let inconclusive = false;
			for (const program of programs) {
				const name = `program:cyber:${program}`;
				const status = await attempt({ program, effort });
				if (status === "unverified") inconclusive = true;
				result.status[name] = !force && !programAuthFailure ? keep(name, status) : status;
			}
			// Never renew old evidence after throttling, transport failure or a missing echo.
			result.programCheckedAt = inconclusive ? previous?.programCheckedAt : this.now();
			if (inconclusive) { result.status.retry = "transient"; result.programRetry = true; }
			if (programAuthFailure) {
				for (const program of programs) result.status[`program:cyber:${program}`] = "unverified";
			}
		}
		if (modelDenied) {
			result.levels = [];
			result.tiers = [];
			for (const name of Object.keys(result.status)) result.status[name] = "unsupported";
			result.status.responses = "unsupported";
			if (!lostAccess) {
				// A structured model denial conclusively denies every candidate,
				// including checks skipped after the denial. Do not retry it as a
				// transport failure merely because those POSTs were unnecessary.
				delete result.status.retry;
				delete result.programRetry;
				if (programs.length) result.programCheckedAt = this.now();
			}
		}
		if (lostAccess) {
			result.levels = [];
			result.tiers = [];
			for (const name of Object.keys(result.status)) result.status[name] = "unverified";
			result.status.credential = "unavailable";
		}
		if ((credentialUnavailable || needsRetry) && !modelDenied) result.status.retry = "transient";
		result.at = this.now();
		if (this.probes.size >= 1000)
			this.probes.delete(this.probes.keys().next().value ?? "");
		this.probes.set(key, result);
		return result;
	}
	async enrich(
		models: RouteModel[],
		refresh = false,
		route?: ApiRouteCredential,
		forceProbes = false,
		// Supplying evidence limits this call to cache reads, even when forced.
		cachedProbesOnly?: Array<[string, ProbeResult]>,
	): Promise<RouteModel[]> {
		const cached = cachedProbesOnly === undefined ? undefined : new Map(cachedProbesOnly);
		return mapWithConcurrency(models, 3, async (model) => {
						const documented = await this.documentation(model.slug, refresh);
						let levels = documented.levels;
						let probed: ProbeResult | undefined;
						let extra: Record<string, unknown> = {};
						if (route?.enabled && route.probeCapabilities) {
							probed = cached ? this.freshProbe(route, model.slug, cached.get(probeKey(route, model.slug))) : await this.probe(
								route,
								model.slug,
								levels,
								forceProbes,
								documented.reasoningAvailable === true && documented.stale !== true,
							);
							if (probed && cached) probed = this.reconcileReasoning(probed, levels, documented.reasoningAvailable === true && documented.stale !== true);
							if (probed) levels = probed.levels;
							extra = probed ? {
								service_tiers: probed.tiers.map((id) => ({
									id: id === "fast" ? "priority" : id,
									name: id === "fast" ? "Fast" : "Ultrafast",
									description:
										"Verified by an API probe; runtime capacity can still downgrade processing.",
								})),
								default_service_tier: "default",
								additional_speed_tiers: probed.tiers,
								capability_probe_status: probed.status,
								capability_checked_at: probed.at,
								program_checked_at: probed.programCheckedAt,
							} : {
								// A previously enriched model must not smuggle expired or
								// differently scoped evidence through a cache-only miss.
								service_tiers: [],
								default_service_tier: "default",
								additional_speed_tiers: [],
								capability_probe_status: undefined,
								capability_checked_at: undefined,
								program_checked_at: undefined,
							};
						}
						const effortStatuses = Object.entries(probed?.status ?? {}).filter(([name]) =>
							name.startsWith("effort:"),
						);
						const probeEstablishedReasoning =
							effortStatuses.length > 0 &&
							effortStatuses.every(([, status]) =>
								["verified", "unsupported", "downgraded"].includes(status),
							);
						// Ultra is a native orchestration mode. Codex resolves it to this
						// supported wire effort; it is not an API entitlement named "ultra".
						const multiAgentEffort =
							["max", "xhigh", "high"].find((level) =>
								levels.includes(level),
							) ?? null;
						const nativeLevels = multiAgentEffort
							? [...levels, "ultra"]
							: levels;
						return {
							...model,
							...extra,
							reasoning_levels_known:
								documented.reasoningAvailable === true || probeEstablishedReasoning,
							...(documented.inputModalities ? { input_modalities: documented.inputModalities } : {}),
							multi_agent_reasoning_effort: multiAgentEffort,
							supported_reasoning_levels: nativeLevels.map((effort) => ({
								effort,
								description:
									effort === "ultra"
										? "Proactive multi-agent mode using a supported API reasoning effort"
										: `${effort} reasoning effort`,
							})),
							default_reasoning_level: levels.includes("medium")
								? "medium"
								: (levels[0] ?? null),
						};
		});
	}
}
