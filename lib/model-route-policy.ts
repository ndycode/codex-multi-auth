import { mergeCatalogModel, mergeCatalogModels } from "./runtime/catalog-capabilities.js";
import { isRecord } from "./utils.js";
/** Model selection is the explicit routing signal; never infer a privacy route from prompt text. */
export type ModelRouteKind = "oauth" | "api" | "zdr";
export type RouteModel = Record<string, unknown> & { slug: string };
export interface RouteCatalog {
	id: string;
	kind: ModelRouteKind;
	priority: number;
	enabled: boolean;
	models: RouteModel[];
	/** API credentials expose nothing until the user chooses an allowlist. */
	visibleModels: string[] | null;
}
export interface ResolvedModelRoute {
	kind: ModelRouteKind;
	upstreamModel: string;
	candidates: RouteCatalog[];
	serviceTier?: string;
}
export function parseModelRoute(model: string): {
	kind: ModelRouteKind;
	upstreamModel: string;
	serviceTier?: string;
} {
	if (!model || model.length > 256 || /[\u0000-\u0020\u007f]/.test(model))
		throw new Error("Invalid route model");
	let kind: ModelRouteKind = "oauth";
	for (const candidate of ["api", "zdr"] as const)
		if (model.startsWith(`${candidate}/`)) {
			kind = candidate;
			model = model.slice(candidate.length + 1);
			break;
		}
	let serviceTier: string | undefined;
	if (model.startsWith("speed/")) {
		const match = /^speed\/([A-Za-z0-9._-]{1,64})\/(.+)$/.exec(model);
		if (!match?.[1] || !match[2]) throw new Error("Invalid speed route");
		serviceTier = match[1];
		model = match[2];
	}
	if (!model || /^(api|zdr|speed)\//.test(model))
		throw new Error("Invalid route model");
	return {
		kind,
		upstreamModel: model,
		...(serviceTier ? { serviceTier } : {}),
	};
}
export function modelServiceTiers(
	model: RouteModel,
): Array<{ id: string; name: string; description: string }> {
	if (!Array.isArray(model.service_tiers)) return [];
	return model.service_tiers.filter(
		(tier): tier is { id: string; name: string; description: string } =>
			isRecord(tier) &&
			typeof tier.id === "string" &&
			/^[A-Za-z0-9._-]{1,64}$/.test(tier.id) &&
			typeof tier.name === "string" &&
			tier.name.length <= 100 &&
			!/[\x00-\x1f\x7f]/.test(tier.name) &&
			typeof tier.description === "string",
	);
}
export function canonicalServiceTier(tier: string): string {
	return tier === "priority" ? "fast" : tier;
}
export function supportsModelSettings(
	model: RouteModel,
	reasoningEffort?: string,
	serviceTier?: string,
): boolean {
	return (
		(!reasoningEffort ||
			Array.isArray(model.supported_reasoning_levels) &&
			model.supported_reasoning_levels.some(
				(l) => isRecord(l) && l.effort === reasoningEffort,
			)) &&
		(!serviceTier ||
			serviceTier === "default" ||
			serviceTier === "auto" ||
			modelServiceTiers(model).some(
				(t) => canonicalServiceTier(t.id) === canonicalServiceTier(serviceTier),
			))
	);
}
function visible(catalog: RouteCatalog, model: RouteModel): boolean {
	if (
		(isRecord(model.capability_probe_status) &&
			model.capability_probe_status.responses === "unsupported") ||
		!catalog.enabled ||
		!model.slug ||
		/^(api|zdr|speed)\//.test(model.slug)
	)
		return false;
	return (
		catalog.kind === "oauth" ||
		catalog.visibleModels?.includes(model.slug) === true
	);
}
export function resolveModelRoute(
	model: string,
	catalogs: RouteCatalog[],
	settings: { reasoningEffort?: string; serviceTier?: string } = {},
): ResolvedModelRoute {
	const parsed = parseModelRoute(model);
	if (
		parsed.serviceTier &&
		settings.serviceTier &&
		canonicalServiceTier(parsed.serviceTier) !==
			canonicalServiceTier(settings.serviceTier)
	)
		throw new Error("Conflicting speed selection");
	const serviceTier = parsed.serviceTier ?? settings.serviceTier;
	const candidates = catalogs
		.filter(
			(c) =>
				c.kind === parsed.kind &&
				c.models.some(
					(m) =>
						m.slug === parsed.upstreamModel &&
						visible(c, m) &&
						supportsModelSettings(m, settings.reasoningEffort, serviceTier),
				),
		)
		.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	return { ...parsed, ...(serviceTier ? { serviceTier } : {}), candidates };
}
export function buildVisibleModelUnion(catalogs: RouteCatalog[]): RouteModel[] {
	const models = new Map<string, RouteModel>();
    const sources = new Map<string, RouteModel[]>();
	for (const catalog of [...catalogs].sort((a, b) => a.priority - b.priority)) {
		for (const model of catalog.models) {
			if (!visible(catalog, model)) continue;
			const prefix = catalog.kind === "oauth" ? "" : `${catalog.kind}/`;
			const name = `${catalog.kind === "oauth" ? "" : `${catalog.kind.toUpperCase()} · `}${typeof model.display_name === "string" ? model.display_name : model.slug}`;
			const slug = prefix + model.slug;
            const group = sources.get(slug) ?? [];
            group.push({...model, ...(Array.isArray(model.service_tiers) ? {service_tiers: modelServiceTiers(model)} : {})});
            sources.set(slug, group);
			const existing = models.get(slug);
			const entry =
				(existing ? mergeCatalogModel(existing, model) : undefined) ??
				(catalog.kind === "oauth"
					? { ...model }
					: { ...model, slug, display_name: name });
			models.set(slug, entry);
			const programs = new Map<string, Set<string>>();
			for (const source of [entry.available_access_programs, model.available_access_programs]) {
				if (!isRecord(source)) continue;
				for (const [category, values] of Object.entries(source)) {
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(category) || !Array.isArray(values)) continue;
					const merged = programs.get(category) ?? new Set<string>();
					for (const value of values) if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) merged.add(value);
					programs.set(category, merged);
				}
			}
			if (programs.size) entry.available_access_programs = Object.fromEntries([...programs].map(([category, values]) => [category, [...values]]));

		}
	}
	for (const [slug, group] of sources) {
        const entry = models.get(slug), merged = mergeCatalogModels(group);
        if (!entry || !merged) continue;
        entry.supported_reasoning_levels = merged.supported_reasoning_levels;
        if (merged.default_service_tier !== undefined) entry.default_service_tier = merged.default_service_tier === "fast" ? "priority" : merged.default_service_tier;
        if (Array.isArray(merged.service_tiers)) entry.service_tiers = modelServiceTiers(merged).map(tier => ({...tier, id: canonicalServiceTier(tier.id) === "fast" ? "priority" : tier.id}));
    }
    return [...models.values()];
}

/** Whitelist capability metadata; never persist model instructions or arbitrary fields. */
export function modelEntitlements(model: RouteModel) {
	const safe = (v: unknown): v is string =>
		typeof v === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(v);
	return {
		model: model.slug,
		...(typeof model.capability_checked_at === "number"
			? { checkedAt: model.capability_checked_at }
			: {}),
		...(isRecord(model.capability_probe_status)
			? {
					probes: Object.fromEntries(
						Object.entries(model.capability_probe_status).filter(
							(
								entry,
							): entry is [
								string,
								"verified" | "unsupported" | "unverified" | "downgraded",
							] =>
								/^(responses|fast|ultrafast|effort:(none|minimal|low|medium|high|xhigh|max|ultra))$/.test(
									entry[0],
								) &&
								[
									"verified",
									"unsupported",
									"unverified",
									"downgraded",
								].includes(String(entry[1])),
						),
					),
				}
			: {}),
		serviceTiers: modelServiceTiers(model).map((t) => ({
			id: t.id,
			name: t.name,
		})),
		reasoningLevels: Array.isArray(model.supported_reasoning_levels)
			? model.supported_reasoning_levels.flatMap((v) =>
					isRecord(v) && safe(v.effort) ? [v.effort] : [],
				)
			: [],
		accessPrograms: isRecord(model.available_access_programs)
			? Object.entries(model.available_access_programs).flatMap(
					([category, values]) =>
						safe(category) && Array.isArray(values)
							? values.filter(safe).map((v) => `${category}:${v}`)
							: [],
				)
			: [],
	};
}
