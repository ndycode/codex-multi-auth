import { isRecord } from "../utils.js";
import type { CatalogModel } from "./account-model-catalog.js";
const contextLimits = ["context_window", "max_context_window", "auto_compact_token_limit"] as const;
const canonicalTier = (value: string) => value === "priority" ? "fast" : value;
/** Aggregate complete source records so advertised controls never invent a pair. */
export function mergeCatalogModels(models: readonly CatalogModel[]): CatalogModel | undefined {
    const first = models[0];
    if (!first) return undefined;
    let result = { ...first };
    for (const [field, key] of [["supported_reasoning_levels", "effort"], ["service_tiers", "id"]] as const) {
        const options = new Map<string, unknown>();
        for (const model of models)
            for (const option of Array.isArray(model[field]) ? model[field] : []) {
                if (isRecord(option) && typeof option[key] === "string")
                    options.set(field === "service_tiers" ? canonicalTier(option[key]) : option[key], option);
            }
        if (options.size) result[field] = [...options.values()];
    }
    const efforts = Array.isArray(result.supported_reasoning_levels)
        ? result.supported_reasoning_levels.flatMap(level => isRecord(level) && typeof level.effort === "string" ? [level.effort] : []) : [];
    if (Array.isArray(result.service_tiers)) {
        // Native clients expose independent effort/speed controls, not a pair matrix.
        // Every selectable pair therefore needs a witness in an original catalog.
        result.service_tiers = result.service_tiers.filter(tier => {
            if (!isRecord(tier) || typeof tier.id !== "string") return false;
            const id = tier.id;
            return (efforts.length ? efforts : [undefined]).every(effort => models.some(model => supportsCatalogSettings(model, effort, id)));
        });
    }
    if (typeof result.default_service_tier === "string" && !["default", "auto"].includes(result.default_service_tier) &&
        !supportsCatalogSettings(result, undefined, result.default_service_tier)) result.default_service_tier = "default";
    for (const model of models.slice(1)) result = clampCatalogContext(result, model);
    return result;
}
/** Two-source convenience; multi-account callers must retain all original records. */
export function mergeCatalogModel(a: CatalogModel, b: CatalogModel): CatalogModel {
    return mergeCatalogModels([a, b]) ?? a;
}
export function clampCatalogContext(a: CatalogModel, b: CatalogModel): CatalogModel {
    const result = { ...a };
    // Context is not a selectable setting sent on requests. Advertise the safe
    // shared limit instead of letting the first account overstate another's limit.
    for (const field of contextLimits) {
        if (typeof a[field] === "number" && typeof b[field] === "number")
            result[field] = Math.min(a[field], b[field]);
        else
            delete result[field];
    }
    return result;
}
export function supportsCatalogSettings(model: CatalogModel, effort?: string, tier?: string): boolean {
    if (effort && (!Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.some(level => isRecord(level) && level.effort === effort)))
        return false;
    if (tier && tier !== "default" && tier !== "auto" && (!Array.isArray(model.service_tiers) || !model.service_tiers.some(level => isRecord(level) && typeof level.id === "string" && canonicalTier(level.id) === canonicalTier(tier))))
        return false;
    return true;
}
