import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import { loadApiRoutes, saveApiRoutes, type ApiRouteCredential } from "../lib/api-route-store.js";
import { runApiLoginMenu } from "../lib/codex-manager/api-login-menu.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function route(): ApiRouteCredential {
	return {
		id: "fixture",
		label: "Fixture",
		kind: "api",
		apiKey: "fixture",
		enabled: true,
		priority: 9,
		visibleModels: ["fixture"],
	};
}

it("offers and persists literal ultra as an operator-declared API effort", async () => {
	const choices = [
		"fixture",
		"metadata",
		"model:fixture",
		"toggle:ultra",
		"save",
		"back",
	];
	const save = vi.fn(async (routes: ApiRouteCredential[]) => routes);
	await runApiLoginMenu({
		load: async () => [route()],
		save,
		log: vi.fn(),
		select: async (items) => {
			const choice = choices.shift();
			return items.some((item) => item.value === choice) ? (choice ?? null) : null;
		},
	});
	expect(save.mock.calls[0]?.[0]?.[0]?.modelReasoningLevels).toEqual({
		fixture: ["ultra"],
	});
});
it("does not replace a declared literal ultra effort before the API request", async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "api-literal-ultra-"));
	try {
		const file = join(root, "routes.json");
		await fs.writeFile(
			file,
			JSON.stringify({
				version: 3,
				routes: [
					{
						...route(),
						modelReasoningLevels: { fixture: ["max", "ultra"] },
					},
				],
			}),
		);
		const routes = await loadApiRoutes(file);
		const requests: unknown[] = [];
		const runtime = new ApiModelRuntime(async (url, init) => {
			if (String(url).endsWith("/models"))
				return Response.json({ data: [{ id: "fixture" }] });
			requests.push(JSON.parse(String(init?.body)));
			return Response.json({ output: [] });
		});
		const [catalog] = await runtime.catalogs(routes);
		expect(catalog?.models[0]).toMatchObject({
			multi_agent_reasoning_effort: null,
			supported_reasoning_levels: [
				expect.objectContaining({ effort: "max" }),
				expect.objectContaining({ effort: "ultra" }),
			],
		});
		expect(
			await runtime.request(
				"api/fixture",
				{ reasoning: { effort: "ultra" } },
				routes,
			),
		).toMatchObject({ status: 200 });
		expect(requests).toEqual([
			expect.objectContaining({ reasoning: { effort: "ultra" } }),
		]);
	} finally {
		await removeWithRetry(root, { recursive: true, force: true });
	}
});
