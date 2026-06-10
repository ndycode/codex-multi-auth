/**
 * Single source of truth for `config/schema/config.schema.json`.
 *
 * The JSON schema shipped under `config/schema/` is GENERATED from the zod
 * `PluginConfigSchema` in `lib/schemas.ts` so it cannot drift from the real
 * runtime config surface (audit roadmap §4.5.2).
 *
 * - Regenerate the committed file with `npm run generate:schema`
 *   (see `scripts/generate-config-schema.mjs`).
 * - Drift is a test failure: `test/config-schema-generated.test.ts`
 *   regenerates the schema in-memory and compares it to the committed file.
 *
 * @internal Generator/tooling module: deliberately NOT re-exported from
 * lib/index.ts. Its only consumers are scripts/generate-config-schema.mjs
 * (via the compiled dist output) and the drift-guard test.
 */
import { z } from "zod";
import { PluginConfigSchema } from "./schemas.js";

/** Repo-relative path of the committed, generated schema file. */
export const CONFIG_SCHEMA_RELATIVE_PATH = "config/schema/config.schema.json";

type JsonObject = Record<string, unknown>;

/**
 * Build the full JSON schema document for `config/schema/config.schema.json`.
 *
 * Structure:
 * - Root keeps the original template metadata (`$schema` draft 2020-12, `$id`,
 *   `title`) and the template root keys (`plugin`, `provider`, `model`) that
 *   the shipped `config/*.json` templates reference via `$schema`.
 * - The complete runtime plugin configuration surface is generated from
 *   `PluginConfigSchema` via zod v4's native `z.toJSONSchema()` and embedded
 *   as `$defs.pluginConfig`, referenced by the optional root `pluginConfig`
 *   property (the shape persisted in unified `settings.json`).
 *
 * `io: "input"` matches runtime semantics: `loadPluginConfig` tolerates and
 * strips unknown keys instead of rejecting them, so the generated definition
 * must not emit `additionalProperties: false`.
 *
 * Key order is the zod shape definition order, which is stable across runs,
 * so output is deterministic.
 */
export function buildConfigJsonSchema(): JsonObject {
	const pluginConfigRaw: unknown = z.toJSONSchema(PluginConfigSchema, {
		target: "draft-2020-12",
		io: "input",
	});
	// Guard before mutating: a zod behavior change returning a non-object
	// here should fail loudly, not via a confusing delete/??= throw below.
	if (
		!pluginConfigRaw ||
		typeof pluginConfigRaw !== "object" ||
		Array.isArray(pluginConfigRaw)
	) {
		throw new Error("z.toJSONSchema(PluginConfigSchema) returned a non-object");
	}
	const pluginConfig = pluginConfigRaw as JsonObject;
	// The embedded definition inherits the root document's dialect; a nested
	// `$schema` keyword would be redundant noise.
	delete pluginConfig.$schema;
	// ??= so a future .describe() on PluginConfigSchema wins over this default.
	pluginConfig.description ??=
		"Runtime plugin configuration (the `pluginConfig` section of unified settings.json, also accepted flat in CODEX_MULTI_AUTH_CONFIG_PATH overrides). Generated from PluginConfigSchema in lib/schemas.ts — do not edit by hand; run `npm run generate:schema`.";

	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://codex-multi-auth.local/schema/config.schema.json",
		title: "codex-multi-auth config template",
		description:
			"GENERATED FILE — do not edit by hand. Regenerate with `npm run generate:schema` (source: lib/config-schema.ts + PluginConfigSchema in lib/schemas.ts).",
		type: "object",
		properties: {
			plugin: {
				type: "array",
				items: { type: "string" },
			},
			provider: {
				type: "object",
				additionalProperties: true,
			},
			model: {
				type: "string",
			},
			pluginConfig: {
				$ref: "#/$defs/pluginConfig",
			},
		},
		required: ["plugin", "provider"],
		additionalProperties: true,
		$defs: {
			pluginConfig,
		},
	};
}

/**
 * Serialize the generated schema exactly as it is committed on disk:
 * 2-space indent (matching the previous handwritten file) plus a trailing
 * newline. `JSON.stringify` preserves insertion order, so the output is
 * byte-for-byte deterministic.
 */
export function renderConfigJsonSchema(): string {
	return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}
