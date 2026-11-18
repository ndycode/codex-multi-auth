import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadApiRoutes, type ApiRouteCredential } from "../lib/api-route-store.js";
import { runApiLoginMenu } from "../lib/codex-manager/api-login-menu.js";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function route(id = "fixture"): ApiRouteCredential {
	return {
		id,
		label: id,
		kind: "api",
		region: "us",
		apiKey: "fixture",
		enabled: true,
		priority: 9,
		visibleModels: ["fixture"],
	};
}

it("offers and saves a declared image input capability", async () => {
	const choices = [
		"fixture",
		"metadata",
		"model:fixture",
		"image_input",
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
	expect(save.mock.calls[0]?.[0]?.[0]).toMatchObject({
		modelInputModalities: { fixture: ["text", "image"] },
	});
});

it("uses the declared input capability when documentation is unavailable", async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "api-declared-image-"));
	try {
		const file = join(root, "routes.json");
		await fs.writeFile(
			file,
			JSON.stringify({
				version: 3,
				routes: [
					{
						...route("declared"),
						modelInputModalities: { fixture: ["text", "image"] },
					},
					route("default"),
				],
			}),
		);
		const routes = await loadApiRoutes(file);
		const runtime = new ApiModelRuntime(
			async () => Response.json({ data: [{ id: "fixture" }] }),
			Date.now,
			undefined,
			async (models) => models.map((model) => ({ ...model, input_modalities: ["text"] })),
		);
		const catalogs = await runtime.catalogs(routes, false, false, true);
		expect(catalogs[0]?.models[0]).toMatchObject({
			input_modalities: ["text", "image"],
			capability_metadata_source: "operator",
		});
		expect(catalogs[1]?.models[0]?.input_modalities).toEqual(["text"]);
	} finally {
		await removeWithRetry(root, { recursive: true, force: true });
	}
});
