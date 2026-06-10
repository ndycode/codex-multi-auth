import type { ModelFamily } from "../../prompts/codex.js";
import {
	getModelCapabilities,
	getModelProfile,
	resolveNormalizedModel,
} from "../../request/helpers/model-map.js";

export interface ModelInspection {
	requested: string;
	normalized: string;
	remapped: boolean;
	promptFamily: ModelFamily;
	capabilities: ReturnType<typeof getModelCapabilities>;
}

export function inspectRequestedModel(requestedModel: string): ModelInspection {
	const normalized = resolveNormalizedModel(requestedModel);
	const profile = getModelProfile(normalized);
	return {
		requested: requestedModel,
		normalized,
		remapped: requestedModel !== normalized,
		promptFamily: profile.promptFamily,
		capabilities: getModelCapabilities(normalized),
	};
}

export function formatModelInspection(model: ModelInspection): string {
	const route = model.remapped
		? `${model.requested} -> ${model.normalized}`
		: model.normalized;
	return [
		route,
		`prompt family ${model.promptFamily}`,
		`tool search ${model.capabilities.toolSearch ? "yes" : "no"}`,
		`computer use ${model.capabilities.computerUse ? "yes" : "no"}`,
	].join(" | ");
}
