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
	if (text.match(/^Model ID:\s*`([^`]+)`/m)?.[1] !== id) return [];
	const statement = text.match(
		/`?reasoning\.effort`?\s+supports\s*:?\s*([^\n.]+)\./i,
	)?.[1];
	if (!statement) return [];
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
		return [];
	return [...new Set(values)];
}
export type ProbeResult = {
	at: number;
	levels: string[];
	tiers: string[];
	status: Record<string, string>;
};
type DocumentedCapabilities = { levels: string[]; inputModalities?: string[] };

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
	if (setting.effort && ["reasoning.effort", "reasoning"].includes(param)) return "setting";
	if (setting.tier && param === "service_tier") return "setting";
	if (setting.compatibility && ["tools", "tool_choice"].includes(param)) return "setting";
	return "ambiguous";
}
export class ApiModelCapabilities {
	private activeProbes = 0;
	private readonly probeWaiters: Array<() => void> = [];
	private async withProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
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
	private readonly probes = new Map<
		string,
		{
			at: number;
			levels: string[];
			tiers: string[];
			status: Record<string, string>;
		}
	>();
	private readonly cache = new Map<string, DocumentedCapabilities & { at: number }>();
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
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
			metadata = {
				levels: parseApiReasoningDocumentation(id, text),
				inputModalities: parseInputModalities(id, text),
			};
		} catch {
			// An outage is not a capability revocation. Keep last successful evidence.
			metadata = cached ?? metadata;
		}
		if (this.cache.size >= 1000)
			this.cache.delete(this.cache.keys().next().value ?? "");
		this.cache.set(id, { ...metadata, at: this.now() });
		return metadata;
	}
	private async probe(
		route: ApiRouteCredential,
		id: string,
		documented: string[],
		force = false,
	) {
		const key = createHash("sha256")
			.update(route.id)
			.update("\0")
			.update(route.apiKey)
			.update("\0")
			.update(id)
			.digest("hex");
		const old = this.probes.get(key);
		// A probe cut short by 401/403/429 is retried after a minute, not trusted for 15.
		const freshFor = old?.status.retry === "transient" ? 60_000 : 900_000;
		if (!force && old && old.at + freshFor > this.now()) return old;
		const running = this.inFlight.get(key);
		if (running) return running;
		const pending = this.runProbe(route, id, documented, key).finally(() =>
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
	): Promise<ProbeResult> {
		const result = {
			at: this.now(),
			levels: [...documented],
			tiers: [] as string[],
			status: {} as Record<string, string>,
		};
		let credentialUnavailable = false;
		// 401/403 means this credential lost access: nothing it verified before
		// may still be advertised. A throttle (429) or transport failure is only
		// inconclusive and keeps what an earlier probe verified. Only
		// "unsupported" or "downgraded" removes a setting otherwise.
		let lostAccess = false;
		// A model-level denial hides the model on this credential: no efforts, no tiers.
		let modelDenied = false;
		const previous = this.probes.get(key);
		const keep = (name: string, status: string): string =>
			status === "unverified" && !lostAccess && !modelDenied && previous?.status[name] === "verified" ? "verified" : status;
		const attempt = async (setting: {
			effort?: string;
			tier?: string;
			compatibility?: boolean;
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
				return "unverified";
			};
			return this.withProbeSlot(async () => {
				if (credentialUnavailable || modelDenied) return "unverified";
				try {
					const response = await this.fetchImpl(
						"https://api.openai.com/v1/responses",
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
							}),
						},
					);
					if ([401, 429].includes(response.status))
						credentialUnavailable = true;
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
				if (effective === "verified") result.levels.push(effort);
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
		if (modelDenied) {
			result.levels = [];
			result.tiers = [];
			for (const name of Object.keys(result.status)) result.status[name] = "unsupported";
			result.status.responses = "unsupported";
		}
		if (credentialUnavailable && !modelDenied) result.status.retry = "transient";
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
	): Promise<RouteModel[]> {
		return mapWithConcurrency(models, 3, async (model) => {
						const documented = await this.documentation(model.slug, refresh);
						let levels = documented.levels;
						let extra: Record<string, unknown> = {};
						if (route?.enabled && route.probeCapabilities) {
							const probed = await this.probe(
								route,
								model.slug,
								levels,
								forceProbes,
							);
							levels = probed.levels;
							extra = {
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
							};
						}
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
