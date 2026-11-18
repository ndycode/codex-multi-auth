import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadApiRoutes } from "../lib/api-route-store.js";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

it("uses a credential-scoped full model profile without changing its route identity", async () => {
	const profile = {
		slug: "ignored-profile-slug",
		display_name: "Fixture full profile",
		description: "Fixture description",
		prefer_websockets: true,
		supports_experimental_context: false,
		support_verbosity: true,
		default_verbosity: "low",
		apply_patch_tool_type: "freeform",
		web_search_tool_type: "text_and_image",
		input_modalities: ["text", "image"],
		supports_image_detail_original: true,
		supports_parallel_tool_calls: true,
		tool_mode: "code_mode_only",
		multi_agent_version: "v2",
		multi_agent_reasoning_effort: "xhigh",
		use_responses_lite: true,
		node_repl_auto_review_required: true,
		node_repl_disabled: false,
		requires_sandboxed_review: true,
		context_window: 272_000,
		max_context_window: 872_000,
		shell_type: "shell_command",
		minimal_client_version: "0.153.0",
		supports_search_tool: true,
		supports_reasoning_summary_parameter: true,
		supports_reasoning_summaries: true,
		experimental_supported_tools: ["fixture_async", "clock"],
		model_messages: { instructions_template: "Fixture instructions", tools: "Fixture tools" },
		supported_reasoning_levels: [{ effort: "ultra", description: "Fixture ultra" }],
	};
	const root = await fs.mkdtemp(join(tmpdir(), "api-full-profile-"));
	try {
		const file = join(root, "routes.json");
		await fs.writeFile(file, JSON.stringify({
			version: 3,
			routes: [{
				id: "fixture-route",
				label: "fixture-route",
				kind: "api",
				region: "us",
				apiKey: "fixture",
				enabled: true,
				priority: 9,
				visibleModels: ["fixture-model"],
				modelProfiles: { "fixture-model": profile },
			}],
		}));
		const routes = await loadApiRoutes(file);
		const runtime = new ApiModelRuntime(async () => Response.json({ data: [{ id: "fixture-model" }] }));
		const [catalog] = await runtime.catalogs(routes, false, false, true);
		const model = catalog?.models[0];
		for (const [key, value] of Object.entries(profile)) {
			if (key !== "slug") expect(model?.[key]).toEqual(value);
		}
		expect(model?.slug).toBe("fixture-model");
	} finally {
		await removeWithRetry(root, { recursive: true, force: true });
	}
});
